"""agent 的长期记忆：工作空间根目录的 `.scode-memory.md`。

用 deepagents 的 `MemoryMiddleware`，通过 `create_deep_agent` 的 **middleware 参数**
挂上去，不用它自带的 `memory` 参数——两者最终是同一个中间件，但显式挂载能自己
决定 backend 与 sources（`memory=` 只能用框架默认的 backend）。

工作空间 = **这一轮运行选的那个目录**（前端通过 `configurable["workspace"]` 传，
后端没收到就用启动时的默认工作空间）。agent 的文件工具和这里的记忆中间件
用的是同一个 backend，所以两边解析出来的真实路径始终一致。

记忆文件是**可选**的：**不会自动创建**（避免往用户选的项目里凭空塞文件），
第一次保存记忆时由 agent 用 `write_file` 建出来。

**为什么不用 `AGENTS.md`**：deepagents 的默认约定是读 `AGENTS.md`，但那通常是
"写给编码 agent 看的项目约定"（本项目根目录那份就是），跟"agent 自己攒的长期
记忆"是两回事，混在一起会把开发者的项目说明当成 agent 的记忆注入进去。换成
独立文件名后两者的语义就分开了。

三个要注意的点：

1. **同一工作空间内只在会话开始时读一次**。MemoryMiddleware 的 before_agent
   钩子见到 state 里已经有 `memory_contents` 就不重复读——改了文件要开新会话
   才生效。**换工作空间会重新读**：`WorkspaceMemoryMiddleware` 在 state 里记了
   "上次读的是哪个工作空间"，变了就把 `memory_contents` 摘掉逼框架重读，否则
   会拿 A 项目的记忆去指导 B 项目的活。
2. **和 agent 的文件工具指向同一个真实文件**。中间件自己持有一个以工作空间
   为根的 FilesystemBackend，agent 的 `write_file` / `edit_file` 走
   `graph/backend.py` 那个 CompositeBackend（真实磁盘）——两边解析出来的真实
   路径都是 `<工作空间>/.scode-memory.md`。文件不会自动创建，所以
   `WorkspaceMemoryMiddleware.modify_request` 会追加一段说明，告诉模型不存在时
   先用 `write_file`；框架记忆提示词里那句"可以调用 edit_file 保存新知识"只在
   文件已存在时直接成立。（早先用 StateBackend 时，agent 的写操作只改虚拟 FS，
   记忆文件永远不变。）
3. **文件操作锁在工作空间内**。backend 用 `virtual_mode=True`，路径越不出
   工作空间根。
"""

from __future__ import annotations

from pathlib import Path
from typing import Annotated, Any, NotRequired

from deepagents.middleware.memory import MemoryMiddleware, MemoryState
from langchain.agents.middleware.types import ModelRequest, PrivateStateAttr
from langchain_core.messages import SystemMessage
from langchain_core.runnables import RunnableConfig

from stupid_code.graph.backend import WorkspaceFilesBackend
from stupid_code.graph.workspace import default_workspace, workspace_of

MEMORY_FILENAME = ".scode-memory.md"
"""记忆文件名。点开头 = 本地状态文件，不属于项目代码，通常进 .gitignore。"""


# 虚拟路径：以 backend 的 root_dir（工作空间）为根解析成真实文件。
# virtual_mode=True（默认）会把越界路径挡在 root 之外，这里只读一个文件，不给 agent 暴露。
_MEMORY_SOURCE = f"/{MEMORY_FILENAME}"

_MEMORY_FILE_NOTE = """## 长期记忆文件

长期记忆文件是 `/.scode-memory.md`（工作空间根目录，**不会自动创建**）。

- 文件不存在：用 `write_file` 写第一条记忆；已存在：用 `edit_file` 追加。
- 没有值得长期保留的内容就不要创建它。
"""
"""追加到记忆块前面的说明：文件是可选的，不存在时自己创建。"""


class WorkspaceMemoryState(MemoryState):
    """在框架的 MemoryState 上记一个「上次读的是哪个工作空间」。

    工作空间是按消息切换的，而框架只在 state 里没有 `memory_contents` 时读一次。
    没有这个字段，换了工作空间之后还会继续注入旧目录的记忆。
    """

    memory_workspace: NotRequired[Annotated[str, PrivateStateAttr]]


class WorkspaceMemoryMiddleware(MemoryMiddleware):
    """读当前工作空间的长期记忆，并在换工作空间时重读。

    框架的 MemoryMiddleware 读到「文件不存在」就当没记忆（跳过）。记忆文件
    **不会自动创建**（见模块 docstring），所以这里不再负责建文件；只在
    `modify_request` 里告诉模型：不存在时用 `write_file` 创建。

    框架的 before_agent 只在**第一次**读（state 里已有 memory_contents 就跳过）。
    所以这里还要处理「换了工作空间」：把上次读的工作空间记进 state，变了就把
    `memory_contents` 摘掉逼框架重读；同一工作空间内不重复读（改了文件要开
    新会话才生效）。
    """

    state_schema = WorkspaceMemoryState

    def before_agent(
        self,
        state: Any,
        runtime: Any,
        config: RunnableConfig,
    ) -> dict[str, Any] | None:
        """同步路径：让框架读记忆（换了工作空间就重读）。"""
        workspace = workspace_of(config)
        update = super().before_agent(
            self._state_for_load(state, str(workspace)), runtime, config
        )
        return self._with_workspace_marker(update, workspace)

    async def abefore_agent(
        self,
        state: Any,
        runtime: Any,
        config: RunnableConfig,
    ) -> dict[str, Any] | None:
        """异步路径：同上；框架自己的文件读取走线程。"""
        workspace = workspace_of(config)
        update = await super().abefore_agent(
            self._state_for_load(state, str(workspace)), runtime, config
        )
        return self._with_workspace_marker(update, workspace)

    def modify_request(self, request: ModelRequest[Any]) -> ModelRequest[Any]:
        """记忆文件缺失时补一段「不会自动创建」的说明。

        只在该目录还没有记忆内容时加；已经读过记忆就不重复占 token。
        放在 super 之前是为了让框架加的记忆块（带 prompt-cache 断点）仍然是
        最后一个块。
        """
        contents = (request.state or {}).get("memory_contents") or {}
        if contents.get(_MEMORY_SOURCE):
            return super().modify_request(request)

        blocks = list(request.system_message.content_blocks) if request.system_message else []
        blocks.append({"type": "text", "text": _MEMORY_FILE_NOTE})
        request = request.override(system_message=SystemMessage(content_blocks=blocks))
        return super().modify_request(request)

    @staticmethod
    def _state_for_load(state: Any, workspace: str) -> Any:
        """换工作空间时把 `memory_contents` 摘掉，逼框架重新读。

        框架只判断 key 在不在；不摘掉的话换目录后仍会沿用旧记忆。
        """
        if "memory_contents" not in state:
            return state
        if state.get("memory_workspace") == workspace:
            return state
        return {key: value for key, value in state.items() if key != "memory_contents"}

    @staticmethod
    def _with_workspace_marker(
        update: dict[str, Any] | None,
        workspace: Path,
    ) -> dict[str, Any] | None:
        """框架真的读了记忆时，记下这份记忆来自哪个工作空间。"""
        if update is None:
            return None
        return {**update, "memory_workspace": str(workspace)}


def build_memory_middleware() -> MemoryMiddleware:
    """构造 MemoryMiddleware：读工作空间根的记忆文件。

    中间件是通过 `backend.download_files()` 读源文件的，默认 StateBackend 里
    没有真实文件，读出来是空的，所以这里给它一个 FilesystemBackend。

    不用主 agent 那个 CompositeBackend：记忆只需要"工作空间里那一个文件"，
    自己拿一个以工作空间为根的 FilesystemBackend 更直白。两者解析出来的
    真实路径是同一个（`<工作空间>/.scode-memory.md`），所以 agent 用
    `write_file` / `edit_file` 写进这个文件的内容，下次开新会话就会被读进来。

    backend 的根目录是**运行期**跟着工作空间走的（`WorkspaceFilesBackend`），
    所以这一轮选了哪个项目目录，记忆就从哪个目录读。

    这里**不创建**记忆文件：文件是可选的，agent 真的写记忆时才由它自己建
    （见模块 docstring）。
    """
    backend = WorkspaceFilesBackend(
        root_dir=default_workspace(),
        virtual_mode=True,
    )
    return WorkspaceMemoryMiddleware(
        backend=backend,
        sources=[_MEMORY_SOURCE],
        # 与框架自己挂 MemoryMiddleware 时的行为一致：给记忆块加缓存断点，
        # 记忆内容变了也不会把整个前缀缓存打穿
        add_cache_control=True,
    )
