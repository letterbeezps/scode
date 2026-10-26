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

import re
from typing import Annotated, Any, NotRequired

from langchain.agents.middleware import InterruptOnConfig
from langchain.agents.middleware.types import AgentMiddleware, AgentState, PrivateStateAttr
from langchain.tools.tool_node import ToolCallRequest
from langchain_core.runnables import RunnableConfig

from stupid_code.graph.workspace import WorkspaceError, current_workspace

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
        return {PERMISSION_LEVEL_STATE_KEY: permission_level(_configurable_of(config))}

    async def abefore_agent(
        self,
        state: Any,
        runtime: Any,
        config: RunnableConfig,
    ) -> dict[str, Any] | None:
        """异步路径：同上（不碰文件系统，没有 blockbuster 风险）。"""
        return self.before_agent(state, runtime, config)


def _configurable_of(config: RunnableConfig | None) -> dict[str, Any] | None:
    """从一份 runnable config 里取 configurable。"""
    if not isinstance(config, dict):
        return None
    configurable = config.get("configurable")
    return configurable if isinstance(configurable, dict) else None


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


def build_interrupt_on() -> dict[str, InterruptOnConfig]:
    """给 `create_deep_agent` 的 interrupt_on 配置。

    拦两个工具：

    - `execute`：执行 shell 命令。`normal` 档只拦命中危险模式的，`manual` 档
      每条都拦。
    - `delete`：删文件/删目录（目录是递归的）。只在 `manual` 档拦。

    **不拦文件写入类工具**（`write_file` / `edit_file`）：那是 code agent 的
    日常，动辄就拦等于没法干活；真正不可逆的是删除和 shell 命令。

    `execute` 允许 `edit` 决策：用户可以在确认卡片上把命令改完再执行，
    不用「拒绝 → 模型重写 → 再问」地绕一圈。**改完的命令不会再过一遍危险
    模式判定**——那是用户自己敲的，他比你清楚。
    """
    return {
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
    }
