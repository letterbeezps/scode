"""子 agent 策略：在 backend 之上组装权限、HITL 和工具边界。

`graph/backend.py` 只负责「造什么 backend」；这里负责「子 agent 该用哪套策略」。
把它单独放一层，是为了让 backend 不反向依赖 permissions / memory / skills，
也让 `graph/agent.py` 的组装逻辑有一个明确的落点。

三条策略：

1. **继承父级的 `interrupt_on`**。框架的默认语义是「子 agent 规格里写了
   `interrupt_on` 就整体替换父级的」——`fixer` 声明了 `write_file` /
   `edit_file` 的确认之后，`execute` 的人工确认就静默没了。这里显式合并
   （规格里同名的键优先，和框架合并文件权限的规则一致）。
2. **声明了 `permissions` 的子 agent 不继承 MCP 工具**。它的「只读」是靠
   无 shell 的 `FilesystemBackend` 保证的，而 MCP 工具完全不经过那层
   ——继承过来等于给了它另一条写路径。
3. **声明了 `permissions` 的子 agent 换成无 shell 的 backend**。框架在 backend
   支持命令执行时拒绝 `permissions`（`NotImplementedError`），而主 agent 的
   backend 有 shell；把 permissions 挪进一个自带 `FilesystemMiddleware`，
   用 `build_restricted_backend()` 保证规则真的拦得住。

顺带把 `mode="interrupt"` 的权限规则翻译成 `interrupt_on`（框架的
`FilesystemMiddleware` 自己不认 HITL）。
"""

from __future__ import annotations

from typing import Any, cast

from deepagents import SubAgent
from deepagents.backends.composite import CompositeBackend
from deepagents.backends.filesystem import FilesystemBackend
from deepagents.middleware.filesystem import (
    FilesystemMiddleware,
    FilesystemPermission,
    FsToolName,
)

from stupid_code.graph.backend import build_restricted_backend
from stupid_code.graph.permissions import PermissionLevelMiddleware

# 受限子 agent 的文件工具白名单：去掉 execute。
# 它的 backend 本来就没有 shell，留着 execute 只会让模型调一个必然报错的工具。
_FS_TOOLS_WITHOUT_EXECUTE: list[FsToolName] = [
    "ls",
    "read_file",
    "write_file",
    "edit_file",
    "delete",
    "glob",
    "grep",
]


def apply_subagent_policies(
    spec: SubAgent,
    *,
    default_interrupt_on: dict[str, Any] | None = None,
) -> SubAgent:
    """把主 agent 的安全策略收紧到子 agent 规格上。

    做三件事：

    1. 继承父级的 `interrupt_on`（规格里同名的键优先）。
    2. 每个子 agent 挂一份 `PermissionLevelMiddleware`——子 agent 的 HITL 谓词
       读的是**子 agent 自己的** state，父图记的档位它看不到。
    3. 声明了 `permissions` 的子 agent：摘掉 `permissions`、清空 MCP 工具、
       换成无 shell 的 `FilesystemMiddleware`，并把 `mode="interrupt"` 的规则
       翻译成 `interrupt_on`。

    实现细节和框架的合并规则见模块 docstring。
    """
    new_spec: dict[str, Any] = dict(spec)

    if default_interrupt_on:
        new_spec["interrupt_on"] = {
            **default_interrupt_on,
            **new_spec.get("interrupt_on", {}),
        }

    middleware = list(new_spec.get("middleware", []))
    middleware.append(PermissionLevelMiddleware())

    permissions = new_spec.get("permissions")
    if not permissions:
        new_spec["middleware"] = middleware
        return cast("SubAgent", new_spec)

    new_spec.pop("permissions", None)
    # 只读子 agent 不继承 MCP 工具（见模块 docstring 第 2 条）
    new_spec["tools"] = []

    # 中间件和 interrupt 判定用同一个 backend 实例：后者要靠它解析符号链接，
    # 否则链接指向的路径不在规则的匹配范围内，interrupt 就拦不住
    restricted = build_restricted_backend()

    middleware.append(
        FilesystemMiddleware(
            backend=restricted,
            _permissions=list(permissions),
            tools=_FS_TOOLS_WITHOUT_EXECUTE,
        )
    )
    new_spec["middleware"] = middleware

    fs_interrupts = interrupt_on_from_permissions(list(permissions), restricted)
    if fs_interrupts:
        # 规格里显式写的 interrupt_on 优先（和框架的合并规则一致）
        new_spec["interrupt_on"] = {
            **fs_interrupts,
            **new_spec.get("interrupt_on", {}),
        }

    return cast("SubAgent", new_spec)


def interrupt_on_from_permissions(
    permissions: list[FilesystemPermission],
    backend: CompositeBackend | FilesystemBackend | None = None,
) -> dict[str, Any]:
    """把 `mode="interrupt"` 的权限规则翻译成 `interrupt_on` 配置。

    框架的 `FilesystemMiddleware` 只强制 deny 规则；interrupt 模式的规则要由
    建图层翻译成 `interrupt_on`，才会挂上 `HumanInTheLoopMiddleware`。我们把
    permissions 从规格里挪进了自己的中间件，就得自己补这一步。

    backend 传进去是为了让判定能解析符号链接（框架的 `when` 谓词靠它拿到
    链接的真实目标）——不给的话，链接出去的路径可能绕开规则的匹配范围。

    框架的实现放在私有模块 `deepagents.middleware._fs_interrupt` 里（没有公开
    入口），所以这里 import 失败时不能静默降级——权限该拦没拦是安全问题，
    必须让加载直接失败。
    """
    if not any(p.mode == "interrupt" for p in permissions):
        return {}

    try:
        from deepagents.middleware._fs_interrupt import (  # noqa: PLC0415
            _build_interrupt_on_from_permissions,
        )
    except ImportError as exc:  # pragma: no cover - 框架版本变了才会走到
        raise RuntimeError(
            "deepagents 的私有模块 deepagents.middleware._fs_interrupt 不存在了，"
            "无法把 mode='interrupt' 的 permissions 翻译成 interrupt_on。"
            "要么改用 interrupt_on 字段，要么换 deepagents 版本。"
        ) from exc

    return dict(_build_interrupt_on_from_permissions(permissions, backend))
