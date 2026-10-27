"""危险操作的人工确认（HITL）。

前端在每次运行的 `configurable` 里传一个权限档位（`manual` / `normal` / `auto`，
见 `web/src/lib/permissions.ts`），后端在这里把它翻译成「这条命令要不要先问人」。

拦住的方式是给 `create_deep_agent` 传 `interrupt_on={...}`：命中时
LangChain 的 `HumanInTheLoopMiddleware` 抛 `interrupt()`，图挂起，等前端把
approve / edit / reject 的决定用 `command.resume` 送回来，图才继续。

**为什么不能只靠提示词**：deepagents 是 "trust the LLM" 模型，agent 不会自我
约束。提示词里那句「破坏性命令先问用户」只是一句建议，模型可以不听——边界必须
在工具层强制执行。

## 三档怎么定的

| 档位 | 行为 |
|---|---|
| `auto` | 不确认，直接执行（用户明确选择了不被打断） |
| `manual` | **每一条**执行命令、以及每一次删文件都确认——命令会做什么你事先不知道 |
| `normal` | 只有命中「危险模式」的命令才确认（默认） |

`normal` 档原本设想由 AI 审核这次操作是否危险再决定要不要问（前端文案里写过），
本期没做：AI 审核要额外一次模型调用，判断标准也没法复现，出了问题说不清是谁
该负责。改成固定规则——命中就是命中，不命中就不命中，行为可预期。

**`normal` 是过滤器，不是安全边界**：它只看命令字符串，绕得开（`find -delete`、
`python -c "shutil.rmtree(...)"`、先 `write_file` 写个脚本再 `execute` 它）。
真正要确定性就切 `manual`。

## 为什么档位要记进 state

框架的 `when` 谓词**在恢复时会再跑一次**，而且框架明确要求「同一次调用必须给出
同样的答案」。档位要是只从运行配置里读，恢复时前端回传的值一变，结论就变：

- 变成 `auto` → 谓词返回 False → 用户的「拒绝」被跳过，**被拒绝的命令照样执行**
  （框架文档原话：the reviewer's answer is skipped and the tool runs, even if
  they rejected it）
- 变成 `manual` → 多出/少掉待确认的调用 → decisions 数量对不上 → 框架抛
  `ValueError`，整轮跑挂

所以 `PermissionLevelMiddleware` 在**开跑前**把档位写进图状态（checkpoint 里的
私有字段）。恢复时 `before_agent` 不会重跑（实测），state 里留着的就是发起这轮
运行时的那一档，谓词读它而不是读客户端回传的值。
"""

from __future__ import annotations

import json
import os
import re
from collections.abc import Callable
from typing import Annotated, Any, NotRequired

from langchain.agents.middleware import InterruptOnConfig
from langchain.agents.middleware.types import AgentMiddleware, AgentState, PrivateStateAttr
from langchain.tools.tool_node import ToolCallRequest
from langchain_core.runnables import RunnableConfig
from langchain_core.tools import BaseTool

from stupid_code.graph.paths import (
    MEMORY_FILENAME,
    USER_MEMORY_SOURCE,
    user_memory_path,
)
from stupid_code.graph.workspace import WorkspaceError, configurable_of, current_workspace

PERMISSIONS_KEY = "permissions"
"""`configurable` 里的 key，与前端 `web/src/lib/permissions.ts` 的 PERMISSIONS_KEY 一致。"""

DEFAULT_PERMISSION_LEVEL = "normal"
"""前端没传（或传了不认识的值）时的默认档位。"""

LEVEL_MANUAL = "manual"
LEVEL_NORMAL = "normal"
LEVEL_AUTO = "auto"
VALID_LEVELS = (LEVEL_MANUAL, LEVEL_NORMAL, LEVEL_AUTO)

PERMISSION_LEVEL_STATE_KEY = "scode_permission_level"
"""图状态里记「这一轮用的权限档位」的 key。私有字段（不进输出 state，但进 checkpoint）。"""

# 危险模式：命中任意一条就认为「这条命令不可逆 / 影响系统 / 会拉远程代码执行」。
# 每条带一句人话说明，前端确认卡片直接展示，用户不用猜为什么被拦。
DANGEROUS_PATTERNS: tuple[tuple[re.Pattern[str], str], ...] = (
    (re.compile(r"\brm\b\s+-[a-zA-Z]*[rf]"), "删除文件（rm 带 r/f 参数）"),
    (re.compile(r"\bdd\s+if="), "磁盘级写入（dd）"),
    (re.compile(r"\bmkfs\b|\bfdisk\b|\bdiskutil\b"), "磁盘/分区操作"),
    (re.compile(r":\(\)\s*\{"), "fork 炸弹"),
    (re.compile(r"\bshutdown\b|\breboot\b|\bhalt\b"), "关机或重启"),
    (re.compile(r"\bsudo\b|\bsu\b\s+-"), "提权执行"),
    (re.compile(r"\bchmod\b\s+(-R\s+)?777\b"), "放宽权限（chmod 777）"),
    (re.compile(r"\bchown\b[^\n|;&]*\broot\b"), "把属主改成 root"),
    (re.compile(r"\bgit\s+push\b[^\n|;&]*(-f\b|--force)"), "强制推送（git push --force）"),
    (re.compile(r"\bgit\s+reset\s+--hard\b"), "丢弃本地改动（git reset --hard）"),
    (re.compile(r"\bgit\s+clean\b[^\n|;&]*-[a-zA-Z]*f"), "删除未跟踪文件（git clean -f）"),
    (re.compile(r"\b(curl|wget)\b[^\n|]*\|\s*(ba|z|k|d)?sh\b"), "下载并执行远程脚本"),
    # 重定向到系统目录。注意 `2>/dev/null` 这种丢弃输出的写法满地都是，
    # 不能算「写入系统目录」——否则几乎每条命令都会被拦，拦截就失去意义了。
    (re.compile(r">\s*/(etc|usr|bin|sbin|System|Library|boot|dev)(?!/(null|stdout|stderr|fd)\b)"), "写入系统目录"),
    (re.compile(r"\bkill(all)?\s+-9\b|\bkillall\b"), "强杀进程"),
    (re.compile(r"\bhistory\s+-c\b"), "清空命令历史"),
)


class PermissionState(AgentState):
    """图状态：记下这一轮运行用的权限档位。"""

    scode_permission_level: NotRequired[Annotated[str, PrivateStateAttr]]


class PermissionLevelMiddleware(AgentMiddleware[Any, Any, Any]):
    """开跑前把权限档位记进 state，让 `when` 谓词有个稳定的判据。

    **为什么不能只读运行配置**：框架的 `when` 谓词在恢复时会再跑一次，且要求
    给出同样的答案。档位只从配置里读的话，恢复时客户端回传的值一变，结论就变
    （详见模块 docstring）。记进 state 之后，恢复时 `before_agent` 不会重跑
    （实测），state 里留的就是发起这轮运行时的那一档。

    子 agent 也要挂这个中间件：子 agent 的 `when` 谓词读的是**子 agent 的**
    state，不是父图的。
    """

    state_schema = PermissionState

    def before_agent(
        self,
        state: Any,
        runtime: Any,
        config: RunnableConfig,
    ) -> dict[str, Any] | None:
        """同步路径：记下这一轮的档位。"""
        return {PERMISSION_LEVEL_STATE_KEY: permission_level(configurable_of(config))}

    async def abefore_agent(
        self,
        state: Any,
        runtime: Any,
        config: RunnableConfig,
    ) -> dict[str, Any] | None:
        """异步路径：同上（不碰文件系统，没有 blockbuster 风险）。"""
        return self.before_agent(state, runtime, config)


def permission_level(configurable: dict[str, Any] | None) -> str:
    """从运行的 configurable 里取权限档位，取不到就按默认档走。"""
    if not isinstance(configurable, dict):
        return DEFAULT_PERMISSION_LEVEL
    raw = configurable.get(PERMISSIONS_KEY)
    if isinstance(raw, str) and raw in VALID_LEVELS:
        return raw
    return DEFAULT_PERMISSION_LEVEL


def dangerous_reason(command: str) -> str | None:
    """命令命中危险模式时返回原因，没命中返回 None。"""
    if not command:
        return None
    for pattern, reason in DANGEROUS_PATTERNS:
        if pattern.search(command):
            return reason
    return None


def is_dangerous_command(command: str) -> bool:
    """命令是否命中危险模式。"""
    return dangerous_reason(command) is not None


def _command_of(request: ToolCallRequest) -> str:
    args = request.tool_call.get("args")
    if not isinstance(args, dict):
        return ""
    command = args.get("command")
    return command if isinstance(command, str) else ""


def _level_of(request: ToolCallRequest) -> str:
    """这一轮用的权限档位。

    **优先读 state 里记的那个**（开跑时 `PermissionLevelMiddleware` 写下的），
    读不到才退回运行配置。理由见模块 docstring：谓词在恢复时会再跑一次，
    必须给出同样的答案。
    """
    state = request.state or {}
    recorded = state.get(PERMISSION_LEVEL_STATE_KEY)
    if isinstance(recorded, str) and recorded in VALID_LEVELS:
        return recorded
    return permission_level(request.runtime.config.get("configurable"))


def should_interrupt(request: ToolCallRequest) -> bool:
    """`execute` 的 `interrupt_on` when 谓词：这次调用要不要先问人。

    判据看运行期传进来的权限档位：
    - `auto`：不拦
    - `manual`：每条命令都拦
    - `normal`：命中危险模式才拦
    """
    level = _level_of(request)
    if level == LEVEL_AUTO:
        return False
    if level == LEVEL_MANUAL:
        return True
    return is_dangerous_command(_command_of(request))


def should_interrupt_delete(request: ToolCallRequest) -> bool:
    """`delete` 的 `interrupt_on` when 谓词：只有 `manual` 档拦。

    **为什么 `delete` 也要拦**：`delete` 删目录是**递归**的（框架的工具说明
    写得很清楚：「Deleting a directory removes it and everything inside it」），
    跟 `rm -rf` 等价。但 `delete` 是文件工具、不走 `execute`，光拦 `execute`
    的话，模型换个工具就把确认绕过去了——「危险操作走人工确认」这个承诺就漏了。

    只在 `manual` 档拦：删文件是 code agent 的日常，`normal` 档拦它太吵。
    """
    return _level_of(request) == LEVEL_MANUAL


def _file_path_of(request: ToolCallRequest) -> str:
    """这次文件工具调用写的是哪个路径（`write_file` / `edit_file` 的 `file_path`）。"""
    args = request.tool_call.get("args")
    if not isinstance(args, dict):
        return ""
    path = args.get("file_path")
    return path if isinstance(path, str) else ""


def memory_scope_of(path: str) -> str | None:
    """这个路径属于哪个记忆作用域；不是记忆文件就返回 `None`。

    `user` = 用户级（`~/.scode/memory.md`，跨所有工作空间共用）
    `project` = 项目级（`<工作空间>/.scode-memory.md`，只对这个项目有效）

    **纯字符串判断，不碰文件系统**——见 `is_memory_path` 的说明。
    """
    if not path:
        return None
    if path == USER_MEMORY_SOURCE:
        return "user"
    # 项目级：文件名匹配——任何工作空间下的 .scode-memory.md 都算。
    # 用户级文件名是 memory.md，两者不会撞。
    if os.path.basename(path) == MEMORY_FILENAME:
        return "project"
    # 用户级：精确等于 $SCODE_HOME/memory.md。放最后，因为 expanduser
    # 理论上可能抛异常——那也不该把前面已经判出来的项目级一起丢掉。
    try:
        if os.path.expanduser(path) == str(user_memory_path()):
            return "user"
    except Exception:  # noqa: BLE001 —— 判据不能把整轮 run 带崩
        return None
    return None


def is_memory_path(path: str) -> bool:
    """这个路径是不是 agent 的长期记忆文件。

    **纯字符串判断，不碰文件系统**。`when` 谓词跑在工具调用链上，而
    `langgraph dev` 装了 blockbuster——事件循环里的同步 FS 调用（`os.stat` /
    `os.readlink`）会被拦下来，整个 run 挂掉。判据必须只靠字符串。

    认这几种写法：

    - 虚拟路径 `/.scode-memory.md`（项目级）、`/user-memory/memory.md`（用户级）
    - 宿主绝对路径：文件名是 `.scode-memory.md`——软链形态、真实形态都认
      （哪个工作空间都一样）
    - 用户级绝对路径：精确等于 `$SCODE_HOME/memory.md`（`~` 展开后）

    最后一条**不按文件名匹配**：`memory.md` 太通用，项目里随便一个
    `memory.md` 都不该被当成用户级记忆。
    """
    return memory_scope_of(path) is not None


def should_interrupt_memory(request: ToolCallRequest) -> bool:
    """写记忆文件时要不要先问人。

    **为什么记忆写入也要拦**：它是唯一一条「影响未来所有会话」的写路径。
    代码写错了改掉就行；记忆写错了会一直影响后面每一个会话——用户级的那条
    还会跟着你到每一个项目——而且没人会知道它是什么时候、为什么写错的。
    详见 `docs/backend/PROGRESS.md` 的「006 · agent 长期记忆」。

    **档位**：`normal` 和 `manual` 都拦，`auto` 不拦（`auto` 的语义就是
    「不要打断我」）。记忆写入不像 `execute` 那样频繁，代价可以接受。

    **判据只看路径**，不看内容——内容每次调用都不一样，恢复时会给出不同
    答案，框架会直接抛 `ValueError`（decisions 数量对不上）。
    """
    level = _level_of(request)
    if level == LEVEL_AUTO:
        return False
    return is_memory_path(_file_path_of(request))


def _describe_memory(tool_call: dict[str, Any], state: Any, runtime: Any) -> str:
    """写记忆的确认卡片说明：写哪个文件、什么作用域、影响多大、内容是什么。"""
    args = tool_call.get("args")
    if not isinstance(args, dict):
        args = {}
    path = args.get("file_path")
    path = path if isinstance(path, str) else "（路径未知）"
    scope = memory_scope_of(path)

    if scope == "user":
        scope_text = "**用户级**（`~/.scode/memory.md`）—— 跨所有工作空间共用"
        impact = "它会跟着你到**每一个**项目。"
    else:
        scope_text = "**项目级**（工作空间根的 `.scode-memory.md`）—— 只对这个项目有效"
        impact = "它只影响**当前这个项目**。"

    parts = [
        "这条命令会写入 agent 的**长期记忆**——之后每个会话开始时，"
        "这段内容都会作为系统提示词的一部分发给大模型。",
        "",
        f"文件：`{path}`",
        f"作用域：{scope_text}",
        "",
        impact,
        "写错了不会立刻生效（当前会话读的是会话开始时的快照），但"
        "**下个会话就会生效**，而且没人会提醒你。",
    ]

    # 预览要写进去的内容。write_file 是 content，edit_file 是 new_string。
    content = args.get("content")
    if not isinstance(content, str):
        content = args.get("new_string")
    if isinstance(content, str) and content.strip():
        preview = content if len(content) <= 600 else content[:600] + "…"
        parts.extend(["", "内容：", preview])

    return "\n".join(parts)


def _workspace_hint() -> str:
    """工作目录（给确认卡片显示）。

    命令是相对路径时，它在哪执行取决于工作空间——用户得知道是哪一层目录。
    """
    try:
        return str(current_workspace())
    except (WorkspaceError, ValueError, RuntimeError):
        return ""


def _describe_execute(tool_call: dict[str, Any], state: Any, runtime: Any) -> str:
    """`execute` 的确认卡片说明：命令 + 命中的危险原因 + 工作目录。"""
    args = tool_call.get("args")
    command = args.get("command") if isinstance(args, dict) else None
    if not isinstance(command, str):
        command = ""
    parts = ["这条命令会在你的机器上真的执行。"]
    reason = dangerous_reason(command)
    if reason:
        parts.append(f"命中危险模式：{reason}")
    workspace = _workspace_hint()
    if workspace:
        parts.append(f"工作目录：{workspace}")
    return "\n\n".join(parts)


def _describe_delete(tool_call: dict[str, Any], state: Any, runtime: Any) -> str:
    """`delete` 的确认卡片说明：删什么 + 不可撤销。"""
    args = tool_call.get("args")
    path = args.get("file_path") if isinstance(args, dict) else None
    if not isinstance(path, str) or not path:
        path = "（路径未知）"
    parts = [f"这条命令会永久删除 `{path}`，不可撤销。"]
    parts.append("删目录会连里面的内容一起删掉。")
    workspace = _workspace_hint()
    if workspace:
        parts.append(f"工作目录：{workspace}")
    return "\n\n".join(parts)


def should_interrupt_mcp(request: ToolCallRequest) -> bool:
    """MCP 工具的 `interrupt_on` when 谓词：`manual` 档下拦所有写到服务器的调用。

    **只在 `manual` 档拦**：`normal` 是「只拦已知危险模式」的过滤器，MCP 工具
    的行为由服务器定义，没有可复现的「危险模式」可匹配；`manual` 才是用户明确
    要求「每一步都先问我」的档位。`auto` 档不拦。

    **只读工具在建图时就被排除在 `interrupt_on` 之外了**（`readOnlyHint is True`），
    所以这个谓词不用再看工具元数据——`when` 在 batched 模式下拿到的
    `ToolCallRequest.tool` 是 None（见框架的 `InterruptOnConfig.when` 文档）。
    """
    return _level_of(request) == LEVEL_MANUAL


def _is_read_only_mcp_tool(tool: BaseTool) -> bool:
    """MCP 工具是否声明了只读。

    `readOnlyHint` 是**服务器自己声明的**（MCP 工具注解），不是可信边界：
    声明只读不等于真的只读。这里只用它决定「要不要打扰用户」——不声明就按
    有副作用处理。
    """
    metadata = tool.metadata or {}
    return metadata.get("readOnlyHint") is True


def _mcp_server_of(tool: BaseTool) -> str:
    """工具属于哪个 MCP 服务器（`graph/mcp.py` 加载时写进 metadata）。"""
    metadata = tool.metadata or {}
    server = metadata.get("mcp_server")
    return server if isinstance(server, str) else "unknown"


def _describe_mcp(server: str) -> Callable[[dict[str, Any], Any, Any], str]:
    """MCP 工具的确认卡片说明：来自哪个服务器 + 完整参数。"""

    def describe(tool_call: dict[str, Any], state: Any, runtime: Any) -> str:
        args = tool_call.get("args")
        rendered = (
            json.dumps(args, ensure_ascii=False, indent=2, default=str) if args else "{}"
        )
        if len(rendered) > 1200:
            rendered = f"{rendered[:1200]}\n…（参数过长，已截断）"
        return (
            f"这个工具来自 MCP 服务器 `{server}`，调用会在服务器上真的执行。"
            f"\n\n参数：\n{rendered}"
        )

    return describe


def build_interrupt_on(
    mcp_tools: list[BaseTool] | None = None,
) -> dict[str, InterruptOnConfig]:
    """给 `create_deep_agent` 的 interrupt_on 配置。

    拦四类工具：

    - `execute`：执行 shell 命令。`normal` 档只拦命中危险模式的，`manual` 档
      每条都拦。
    - `delete`：删文件/删目录（目录是递归的）。只在 `manual` 档拦。
    - **非只读的 MCP 工具**：只在 `manual` 档拦。写文件、发消息、改数据库这类
      副作用不经过 shell，光拦 `execute` 就等于留了另一扇门。
    - **写记忆文件**（`write_file` / `edit_file`）：`normal` 和 `manual` 档都拦，
      但**只拦目标是记忆文件的那次调用**——写代码不受影响。

    **不拦文件写入类工具**（`write_file` / `edit_file`）：那是 code agent 的
    日常，动辄就拦等于没法干活；真正不可逆的是删除和 shell 命令。
    **例外是写记忆**——那是唯一一条「影响未来所有会话」的写路径（见
    `should_interrupt_memory`）。

    **MCP 工具不给 `edit` 决策**：参数结构由服务器定义，改错一个字段可能比
    拒绝更糟；要改就让模型重发一次，顺便再过一遍 schema 校验。

    `execute` 允许 `edit` 决策：用户可以在确认卡片上把命令改完再执行，
    不用「拒绝 → 模型重写 → 再问」地绕一圈。**改完的命令不会再过一遍危险
    模式判定**——那是用户自己敲的，他比你清楚。

    **写记忆也不给 `edit` 决策**：前端能改的只是 `file_path`（路径），
    改路径不等于改内容——用户改完路径，写进去的还是原来那段内容，纯误导。
    要改内容就拒绝，然后在对话里说清楚，让模型重写。
    """
    interrupt_on: dict[str, InterruptOnConfig] = {
        "execute": {
            "allowed_decisions": ["approve", "edit", "reject"],
            "when": should_interrupt,
            "description": _describe_execute,
        },
        "delete": {
            "allowed_decisions": ["approve", "reject"],
            "when": should_interrupt_delete,
            "description": _describe_delete,
        },
        # 写记忆：注册在工具名上，但谓词只看路径——写普通文件返回 False，
        # 不拦。只有目标是记忆文件的那次调用才挂起。
        "write_file": {
            "allowed_decisions": ["approve", "reject"],
            "when": should_interrupt_memory,
            "description": _describe_memory,
        },
        "edit_file": {
            "allowed_decisions": ["approve", "reject"],
            "when": should_interrupt_memory,
            "description": _describe_memory,
        },
    }

    for tool in mcp_tools or []:
        if _is_read_only_mcp_tool(tool):
            continue
        interrupt_on[tool.name] = {
            "allowed_decisions": ["approve", "reject"],
            "when": should_interrupt_mcp,
            "description": _describe_mcp(_mcp_server_of(tool)),
        }

    return interrupt_on
