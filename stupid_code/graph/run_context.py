"""一次 run 的结构化上下文（`create_deep_agent(context_schema=RunContext)`）。

前端每次运行通过 `context` 传四个任务参数，不再塞进无类型的
`configurable` 字典。`context` 是 run 级、不可变的输入：同一 thread 的
下一次 run 可以换一套值（换工作空间、档位、模型、skill）。

Agent Server 会按这个 schema 过滤 context，未声明的 key 会被丢掉；
`runtime.context` 在 Python 侧被强转成 `RunContext` 实例，中间件直接读字段。

注意：`thread_id` 不在这里——它是 LangGraph 的保留配置，仍在
`configurable` / 平台请求参数里。

细节见 `docs/backend/backend.md` §3.17、AGENTS.md 第 8 条。
"""

from __future__ import annotations

from dataclasses import dataclass, field
from typing import Any


@dataclass
class RunContext:
    """一次 run 的任务参数。

    字段默认值都要有：本地调用（或旧客户端）可能完全不传 context，
    这时各模块按自己的默认行为走——默认工作空间、`normal` 档、默认模型、
    不钉任何 skill。
    """

    workspace: str = ""
    """工作空间绝对路径；空串 = 用后端默认工作空间。"""

    permissions: str = ""
    """权限档位；空串或未知值由 `permissions.permission_level()` 回落到默认档。"""

    model: str | None = None
    """选中的模型 id（`供应商名:模型名`）；None = 不切换，用建图时的默认模型。"""

    skills: list[str] = field(default_factory=list)
    """本次 run 勾选的 skill 名字（保持前端给的顺序）。"""


_CONTEXT_FIELDS = frozenset(RunContext.__dataclass_fields__)


def run_context_of(runtime: Any) -> RunContext:
    """把 `runtime.context` 归一成 `RunContext`。

    主 agent 声明了 `context_schema`，拿到的就是 `RunContext` 实例；
    但 fork 子 agent 的图没有这个 schema，`runtime.context` 可能是普通 dict。
    两种情况都兼容，拿不到就用全默认值（等价于「什么都没传」）。
    """
    context = getattr(runtime, "context", None)
    if isinstance(context, RunContext):
        return context
    if isinstance(context, dict):
        fields = {k: v for k, v in context.items() if k in _CONTEXT_FIELDS}
        return RunContext(**fields)
    return RunContext()
