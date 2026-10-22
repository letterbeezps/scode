"""危险操作的人工确认（HITL）。

前端在每次运行的 `configurable` 里传一个权限档位（`manual` / `normal` / `auto`，
见 `web/src/lib/permissions.ts`），后端在这里把它翻译成「这条命令要不要先问人」。

拦住的方式是给 `create_deep_agent` 传 `interrupt_on={"execute": ...}`：命中时
LangChain 的 `HumanInTheLoopMiddleware` 抛 `interrupt()`，图挂起，等前端把
approve / reject 的决定用 `command.resume` 送回来，图才继续。

**为什么不能只靠提示词**：deepagents 是 "trust the LLM" 模型，agent 不会自我
约束。提示词里那句「破坏性命令先问用户」只是一句建议，模型可以不听——边界必须
在工具层强制执行。

## 三档怎么定的

| 档位 | 行为 |
|---|---|
| `auto` | 不确认，直接执行（用户明确选择了不被打断） |
| `manual` | **每一条**执行命令都确认——命令会做什么你事先不知道 |
| `normal` | 只有命中「危险模式」的命令才确认（默认） |

`normal` 档原本设想由 AI 审核这次操作是否危险再决定要不要问（前端文案里写过），
本期没做：AI 审核要额外一次模型调用，判断标准也没法复现，出了问题说不清是谁
该负责。改成固定规则——命中就是命中，不命中就不命中，行为可预期。
"""

from __future__ import annotations

import re
from typing import Any

from langchain.agents.middleware import InterruptOnConfig
from langchain.tools.tool_node import ToolCallRequest

PERMISSIONS_KEY = "permissions"
"""`configurable` 里的 key，与前端 `web/src/lib/permissions.ts` 的 PERMISSIONS_KEY 一致。"""

DEFAULT_PERMISSION_LEVEL = "normal"
"""前端没传（或传了不认识的值）时的默认档位。"""

LEVEL_MANUAL = "manual"
LEVEL_NORMAL = "normal"
LEVEL_AUTO = "auto"
VALID_LEVELS = (LEVEL_MANUAL, LEVEL_NORMAL, LEVEL_AUTO)

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


def should_interrupt(request: ToolCallRequest) -> bool:
    """`interrupt_on` 的 when 谓词：这次调用要不要先问人。

    判据只看运行期传进来的权限档位：
    - `auto`：不拦
    - `manual`：每条命令都拦
    - `normal`：命中危险模式才拦

    **恢复时会再跑一次这个谓词**，所以它必须对同一次调用给出同样的答案——
    档位来自运行配置，前端恢复时会把同一个档位原样带回来（见 api/run.ts 的
    resumeRun），因此结论稳定。
    """
    level = permission_level(request.runtime.config.get("configurable"))
    if level == LEVEL_AUTO:
        return False
    if level == LEVEL_MANUAL:
        return True
    return is_dangerous_command(_command_of(request))


def _describe(tool_call: dict[str, Any], state: Any, runtime: Any) -> str:
    """确认卡片上显示的说明：命令 + 命中的危险原因。"""
    args = tool_call.get("args")
    command = args.get("command") if isinstance(args, dict) else None
    if not isinstance(command, str):
        command = ""
    reason = dangerous_reason(command)
    head = "这条命令会在你的机器上真的执行。"
    if reason:
        return f"{head}\n\n命中危险模式：{reason}"
    return head


def build_interrupt_on() -> dict[str, InterruptOnConfig]:
    """给 `create_deep_agent` 的 interrupt_on 配置。

    只拦 `execute`（执行命令）：文件写入类工具是 code agent 的日常，动辄就拦
    等于没法干活；真正不可逆的是 shell 命令。
    """
    return {
        "execute": {
            "allowed_decisions": ["approve", "reject"],
            "when": should_interrupt,
            "description": _describe,
        }
    }
