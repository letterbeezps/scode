"""工作空间：这一轮运行，agent 在哪个目录里干活。

前端通过 run 的 `context.workspace` 传绝对路径；没传就用 `SCODE_WORKSPACE`
或后端启动目录。文件工具和 shell 的 cwd 都跟着它走。

根目录不能在建图时定死：同一张图要服务不同项目的 thread，所以 backend 的
`cwd` 是 property。解析/校验要读文件系统，必须在线程里做；
每轮 `before_agent` 重新校验并刷新缓存，HITL 恢复不经过 `before_agent`，
所以模型调用前还要补一次缓存。

细节见 AGENTS.md 第 17 条、`docs/backend/backend.md` §3.14。
"""

from __future__ import annotations

import asyncio
import os
from collections.abc import Awaitable, Callable
from pathlib import Path
from typing import Any, NamedTuple

from langchain.agents.middleware.types import AgentMiddleware, ModelRequest, ModelResponse
from langchain_core.messages import SystemMessage
from langchain_core.runnables import RunnableConfig
from langgraph.config import get_config

from stupid_code.graph.run_context import run_context_of

WORKSPACE_KEY = "workspace"
"""平台镜像进 `configurable` 的 key；工具热路径从那里读工作空间。"""


class WorkspaceError(ValueError):  # noqa: N818 —— 名字是历史原因，别改，文档和前端都按它来
    """工作空间不合法（不存在、不是目录）。

    message 面向用户，可以直接展示。

    **要继承 `ValueError` 而不是裸 `Exception`**：平台的 SSE `error` 事件只把
    内置异常（ValueError / TypeError / RuntimeError 等）的 `str(exc)` 透传出去，
    其它异常统一打码成 "An internal error occurred"（见 `langgraph_api/serde.py`
    的 `_orjson_default`）。裸 Exception 会让用户只看到一句 "An internal error
    occurred"，完全不知道是工作空间的问题。
    """


_default_workspace: Path | None = None
"""默认工作空间缓存。第一次调用时算出来（要读文件系统），之后一直用。"""


def default_workspace() -> Path:
    """后端启动时的工作空间：环境变量优先，否则进程 cwd。

    launcher 起 langgraph 子进程时把 cwd 设成了工作空间（`SCODE_WORKSPACE`
    或运行 scode 时所在的目录），所以这里拿到的就是它。

    **结果被缓存**：算它要读文件系统（`os.getcwd` / `os.stat`），而
    langgraph dev 的 blockbuster 会拦下事件循环里的同步 FS 调用
    （见模块 docstring）。第一次调用发生在建图阶段（导入时，不在事件循环里），
    之后都是缓存命中。
    """
    global _default_workspace
    if _default_workspace is None:
        raw = os.environ.get("SCODE_WORKSPACE", "").strip()
        if raw:
            candidate = Path(raw).expanduser()
            if candidate.is_dir():
                _default_workspace = candidate.resolve()
        if _default_workspace is None:
            _default_workspace = Path.cwd().resolve()
    return _default_workspace


class WorkspacePaths(NamedTuple):
    """一个工作空间的两种路径形态。

    - `resolved`：真实路径（软链已展开）。**文件系统工具的根目录用这个**，
      越界检查要拿真实位置比。
    - `given`：用户给的那条路径（`~` 展开、`.`/`..` 归一化，但**不展开软链**）。

    为什么要两个：模型手里可能有任一种形态的绝对路径。系统提示词里给的是
    `resolved`，但用户在对话里打的是 `given`（比如手打 `/tmp/proj`，而真实
    路径是 `/private/tmp/proj`——macOS 上 `/tmp` 是软链）。

    拿 `resolved` 去剥 `given` 形态的前缀会失配，`relative_to` 直接抛
    ValueError → 前缀剥不掉 → 框架把绝对路径当虚拟路径 → 文件落到
    `<工作空间>/tmp/proj/...` 这种嵌套目录里，**还不报错**（实测踩到）。
    """

    resolved: Path
    given: Path

    def candidates(self) -> tuple[Path, ...]:
        """剥前缀时依次尝试的根目录（去重）。"""
        if self.given == self.resolved:
            return (self.resolved,)
        return (self.resolved, self.given)


_resolved_cache: dict[str, WorkspacePaths] = {}
"""原始路径 -> 解析后的工作空间（两种形态）。

解析（`resolve()` 展开软链、`exists()` / `is_dir()` 校验）要读文件系统，
在事件循环里会被 blockbuster 拦下。所以解析结果缓存起来：每轮运行开跑前
（在线程里）重新校验一次并刷新缓存，热路径（backend 取根目录）只读缓存，
不碰文件系统。

**必须有刷新这一步**：只缓存首次结果的话，目录被删 / 被替换后
`before_agent` 会永远缓存命中，"工作空间不合法就失败"就成了空话。
"""


def _normalize_workspace(raw: str) -> WorkspacePaths:
    """把用户给的路径归一化成真实存在的目录。**会读文件系统。**

    - `~` 展开成用户主目录
    - 解析符号链接（`resolve()`）：软链目录必须指向真实位置，否则
      `virtual_mode` 的越界检查会拿软链路径跟真实路径比，判断失准
      （macOS 上 /tmp → /private/tmp 就是这种软链）
    - 必须存在且是目录

    路径不存在时**不静默退回默认工作空间**——那等于把 agent 的写操作
    落到一个用户没选过的目录里，比报错危险得多。
    """
    text = raw.strip()
    if not text:
        raise WorkspaceError("工作空间路径为空")

    path = Path(text).expanduser()
    try:
        resolved = path.resolve()
    except OSError as exc:  # 软链循环之类的
        raise WorkspaceError(f"工作空间路径无法解析：{text}（{exc}）") from exc

    if not resolved.exists():
        raise WorkspaceError(f"工作空间不存在：{resolved}")
    if not resolved.is_dir():
        raise WorkspaceError(f"工作空间不是目录：{resolved}")
    # given 形态：只做纯字符串归一化（`normpath` 收掉 `.` / `..`），
    # 不碰文件系统、不展开软链
    given = Path(os.path.normpath(str(path)))
    return WorkspacePaths(resolved=resolved, given=given)


def resolve_workspace_path(raw: str) -> Path:
    """解析并缓存一个工作空间路径。**会读文件系统**（缓存未命中时）。

    缓存命中时直接返回、**不再校验**——热路径（每次工具调用取根目录）用这个；
    开跑前的严格校验走 `_validate_workspace()`，它每轮都会重新读文件系统。

    同步版：只能在事件循环之外调用（或经 `asyncio.to_thread`）。
    """
    cached = _resolved_cache.get(raw)
    if cached is not None:
        return cached.resolved
    root = _normalize_workspace(raw)
    _resolved_cache[raw] = root
    return root.resolved


def configurable_of(config: RunnableConfig | None) -> dict[str, Any] | None:
    """从一份 runnable config 里取 `configurable` 字典。

    Agent Server 会把 run 的 `context` 镜像进这里（见 `current_workspace_paths`），
    所以工具热路径和本地脚本仍能从 config 拿到任务参数。中间件优先读
    `runtime.context`，只有拿不到 Runtime 的地方才用这个。
    拿不到（建图阶段、本地脚本）返回 None。
    """
    if not isinstance(config, dict):
        return None
    configurable = config.get("configurable")
    return configurable if isinstance(configurable, dict) else None


def workspace_from_configurable(configurable: Any) -> str | None:
    """从运行的 configurable 里取工作空间路径。

    返回 None 表示「前端没选」——调用方据此退回默认工作空间。
    """
    if not isinstance(configurable, dict):
        return None
    raw = configurable.get(WORKSPACE_KEY)
    if isinstance(raw, str) and raw.strip():
        return raw.strip()
    return None


def raw_workspace_of(runtime: Any) -> str | None:
    """`context.workspace` 的原始值；空串/非字符串表示前端没选。"""
    raw = run_context_of(runtime).workspace
    if isinstance(raw, str) and raw.strip():
        return raw.strip()
    return None


def workspace_of(runtime: Any) -> Path:
    """从一次 run 的 context 里解析工作空间。

    前端选了就用它（校验不通过就抛 WorkspaceError，不静默改道）；
    没选就用默认工作空间。
    """
    raw = raw_workspace_of(runtime)
    if raw is None:
        return default_workspace()
    return resolve_workspace_path(raw)


def current_workspace() -> Path:
    """当前运行的工作空间（从 runnable 上下文读）。

    取不到就退回默认工作空间——比如建图阶段、或者本地脚本直接调工具
    （不在 runnable 上下文里，`get_config()` 会抛 RuntimeError）。

    这条路径是**热路径**（每次工具调用都会取根目录），所以不能读文件系统：
    解析结果由中间件在每轮开跑前校验并缓存好（见 `_validate_workspace`）。
    缓存未命中时仍会解析一次并校验——那条路只能在事件循环之外跑（由调用方
    保证走线程），否则 `Path.resolve()` 展开软链会撞上 blockbuster。
    运行中途目录被删掉不会每次工具调用都重新 stat，热路径看到的是缓存。

    实现就是 `current_workspace_paths().resolved`——两者在所有分支上等价
    （实测过），别再各写一份。
    """
    return current_workspace_paths().resolved


def current_workspace_paths() -> WorkspacePaths:
    """当前运行的工作空间（两种路径形态）。

    热路径用：每次工具调用都要拿根目录来剥绝对路径前缀。
    跟 `current_workspace()` 一样不读文件系统——解析结果由中间件在每轮开跑前
    校验并缓存好（见 `_validate_workspace`）。

    **这里读 `configurable` 是平台的镜像**：Agent Server 会把 run 的 `context`
    复制进 `configurable`（`langgraph_api/models/run.py`），所以工具热路径不用
    拿 Runtime 也能看到同一个工作空间。本地直接调工具时没有 context，就按
    默认工作空间走。
    """
    try:
        config = get_config()
    except RuntimeError:
        resolved = default_workspace()
        return WorkspacePaths(resolved=resolved, given=resolved)
    raw = workspace_from_configurable(configurable_of(config))
    if raw is None:
        resolved = default_workspace()
        return WorkspacePaths(resolved=resolved, given=resolved)
    cached = _resolved_cache.get(raw)
    if cached is not None:
        return cached
    # 缓存未命中：解析一次（只能在事件循环之外跑，由调用方保证走线程）
    root = _normalize_workspace(raw)
    _resolved_cache[raw] = root
    return root


_WORKSPACE_PROMPT_TEMPLATE = """## 当前工作空间

这一轮的工作空间是 `{workspace}`。

- 文件工具用的是**虚拟路径**：`/` 就是工作空间的根，`/src/main.py` 指的就是
  `{workspace}/src/main.py`。
- `execute` 跑 shell 时，命令的**工作目录**就是这个目录，相对路径按它解析。
  shell 里的**绝对路径是磁盘真实路径**，不是文件工具那套虚拟路径；需要绝对
  路径时用 `{workspace}/...`，或者直接用相对路径。
- 不要去动工作空间之外的文件；确实需要时先跟用户说一声。
"""
"""写进系统提示词的工作空间说明。"""


def _refresh_workspace(raw: str) -> Path:
    """重新校验一个工作空间并刷新缓存。**会读文件系统。**"""
    try:
        root = _normalize_workspace(raw)
    except WorkspaceError:
        # 已经失效的路径不能留在缓存里：后面的热路径会把它当成合法工作空间
        _resolved_cache.pop(raw, None)
        raise
    _resolved_cache[raw] = root
    return root.resolved


def _validate_workspace(runtime: Any) -> Path:
    """开跑前校验工作空间（同步版）。**每轮都真的读文件系统。**

    前端没选就没什么好校验的，直接用默认工作空间。
    """
    raw = raw_workspace_of(runtime)
    if raw is None:
        return default_workspace()
    return _refresh_workspace(raw)


async def _avalidate_workspace(runtime: Any) -> Path:
    """开跑前校验工作空间（异步版：文件系统操作走线程）。"""
    raw = raw_workspace_of(runtime)
    if raw is None:
        return default_workspace()
    return await asyncio.to_thread(_refresh_workspace, raw)


def ensure_workspace_cached(runtime: Any) -> None:
    """缓存未命中时解析一次；命中时什么都不做。

    正常运行的缓存由 `before_agent` 每轮刷新，这条兜底是给 **HITL 恢复**
    这类不经过 `before_agent` 的路径用的：恢复时前端可能带着新的工作空间，
    第一次解析不能放在事件循环里（`Path.resolve()` 展开软链会触发
    blockbuster 的 BlockingError）。
    """
    raw = raw_workspace_of(runtime)
    if raw is None or raw in _resolved_cache:
        return
    _refresh_workspace(raw)


class WorkspaceMiddleware(AgentMiddleware[Any, Any, Any]):
    """把「这一轮的工作空间」钉死，并告诉模型它在哪。

    两件事：

    1. **开跑前校验**：每轮运行都重新校验前端选的工作空间（存在、是目录、
       软链已展开），不合法就让这一轮失败（错误信息是「工作空间不存在：xxx」），
       而不是等 agent 写文件时才报一句看不懂的错。**不能只缓存首次结果**：
       目录之后被删掉的话 `before_agent` 会一直缓存命中，校验就失去意义。
    2. **告诉模型**：把绝对路径写进系统提示词。文件工具给模型的是虚拟路径，
       模型不知道它对应磁盘上的哪个目录；写进提示词它才能在回答里说清楚
       「我在哪个项目里干活」，跑 shell 时也知道相对路径的基准在哪。

    **同步和异步两个钩子都要实现**：框架按「类有没有覆写 before_agent /
    abefore_agent」决定是否建这个节点，异步路径（langgraph dev 走的就是它）
    只实现同步版会退化成在事件循环里跑同步函数。工作空间从 `runtime.context`
    读（结构化字段），不再从 `configurable` 字典里取。

    **异步路径必须把文件系统操作丢到线程里**：langgraph dev 装了 blockbuster，
    事件循环里直接读文件系统（`os.readlink` / `os.stat`）会抛 BlockingError，
    整个 run 挂掉。所以校验走 `_avalidate_workspace()`（内部 to_thread）。

    **模型调用前补一次缓存兜底**：HITL 恢复（`command.resume`）从挂起点继续，
    不会再经过 `before_agent`。万一恢复时带了新的工作空间，第一次解析必须
    在线程里做——所以 `awrap_model_call` 在缓存未命中时会补一次 to_thread。
    """

    def before_agent(
        self,
        state: Any,
        runtime: Any,
        config: RunnableConfig,
    ) -> dict[str, Any] | None:
        """开跑前校验工作空间。不合法就抛 WorkspaceError（面向用户）。"""
        _validate_workspace(runtime)
        return None

    async def abefore_agent(
        self,
        state: Any,
        runtime: Any,
        config: RunnableConfig,
    ) -> dict[str, Any] | None:
        """异步路径：校验丢线程里（blockbuster 会拦事件循环里的同步 FS 调用）。"""
        await _avalidate_workspace(runtime)
        return None

    def wrap_model_call(
        self,
        request: ModelRequest[Any],
        handler: Callable[[ModelRequest[Any]], ModelResponse[Any]],
    ) -> ModelResponse[Any]:
        """同步路径：补齐缓存，把工作空间写进系统提示词再交给 handler。"""
        ensure_workspace_cached(request.runtime)
        return handler(self._with_workspace(request))

    async def awrap_model_call(
        self,
        request: ModelRequest[Any],
        handler: Callable[[ModelRequest[Any]], Awaitable[ModelResponse[Any]]],
    ) -> ModelResponse[Any]:
        """异步路径：缓存未命中时在线程里解析，再注入提示词。"""
        raw = raw_workspace_of(request.runtime)
        if raw is not None and raw not in _resolved_cache:
            await asyncio.to_thread(_refresh_workspace, raw)
        return await handler(self._with_workspace(request))

    def _with_workspace(self, request: ModelRequest[Any]) -> ModelRequest[Any]:
        """在系统提示词后面追加一段工作空间说明。"""
        try:
            workspace = workspace_of(request.runtime)
        except WorkspaceError:
            # 工作空间不合法：校验钩子会报错，这里不重复制造异常
            return request

        text = _WORKSPACE_PROMPT_TEMPLATE.format(workspace=workspace)
        blocks = list(request.system_message.content_blocks) if request.system_message else []
        if blocks:
            text = f"\n\n{text}"
        blocks.append({"type": "text", "text": text})
        return request.override(system_message=SystemMessage(content_blocks=blocks))
