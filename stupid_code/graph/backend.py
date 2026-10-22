"""agent 的文件与命令后端。

主 agent 用 **CompositeBackend**，默认 backend 是 **LocalShellBackend**：
文件操作直接落在真实磁盘（工作空间），`execute` 工具直接在本机跑 shell。
这是"真实 backend"的意思——之前默认的 StateBackend 是虚拟文件系统，
agent 的 `write_file` / `edit_file` 写的是内存里的副本，落不了盘，
长期记忆文件也因此写不进去。

    backend = CompositeBackend(
        default=LocalShellBackend(...),   # 真实磁盘 + 本机 shell
        routes={"/tmp/": StateBackend()}, # 例外：临时区走虚拟 FS，不落盘
    )

用 CompositeBackend 而不是直接用 LocalShellBackend，是为了让"哪部分路径走哪种
存储"这件事写在配置里而不是散落在各处：现在只有 `/tmp/` 一条例外，以后要加
"某个目录走 langgraph store 跨会话持久化"之类的规则，加一条 route 就行。

## 为什么要区分主 agent 和子 agent 的 backend

框架有一条硬限制（deepagents 0.7.28，`middleware/filesystem.py`）：

> backend 支持命令执行（实现 `SandboxBackendProtocol`）时，
> `FilesystemMiddleware` 不接受 `permissions`——直接抛 `NotImplementedError`。

理由是站得住的：`execute` 能用 shell 绕过任何文件权限（`echo x > file`），
所以"工具层拦住写操作"这件事在有 shell 的情况下根本不成立。框架不愿意给你
一个假的保证，索性报错。

我们主 agent 的 backend 有 shell，但 `conf/subagents.toml` 里的 `reviewer`
声明了 `permissions`（只读）。两件事直接冲突——不处理的话图在建的时候
就炸了。处理办法见 `build_restricted_backend()`：给声明了 permissions 的
子 agent 换一个**没有 shell** 的 backend，权限就真的拦得住。
"""

from __future__ import annotations

from pathlib import Path
from typing import Any, cast

from deepagents import SubAgent
from deepagents.backends.composite import CompositeBackend
from deepagents.backends.filesystem import FilesystemBackend
from deepagents.backends.local_shell import LocalShellBackend
from deepagents.backends.state import StateBackend
from deepagents.middleware.filesystem import (
    FilesystemMiddleware,
    FilesystemPermission,
    FsToolName,
)


def workspace_dir() -> Path:
    """工作空间目录 = 当前进程 cwd。

    launcher 起 langgraph 子进程时把 cwd 设成用户的工作空间，graph 也在那个
    进程里导入，所以这里拿到的就是工作空间。
    """
    return Path.cwd()


def build_backend() -> CompositeBackend:
    """主 agent 的 backend：真实磁盘 + 本机 shell。

    - `virtual_mode=True`：文件工具的路径锁在工作空间内（`/` 就是工作空间根），
      挡掉 `..` 和 `~` 越界。注意这只管文件操作——shell 不受这个限制。
    - `inherit_env=True`：shell 继承当前进程的环境变量。默认是空环境，
      PATH 是空的，`uv` / `python` / `node` 这些全都找不到。
    - `/tmp/` 路由到 StateBackend：临时产物走虚拟 FS，不在用户磁盘上留垃圾。
    """
    return CompositeBackend(
        default=LocalShellBackend(
            root_dir=workspace_dir(),
            virtual_mode=True,
            inherit_env=True,
        ),
        routes={
            "/tmp/": StateBackend(),
        },
    )


def build_restricted_backend() -> FilesystemBackend:
    """给声明了 `permissions` 的子 agent 用的 backend：真实磁盘，但没有 shell。

    没有 shell，`permissions` 才拦得住（见模块 docstring 里框架那条限制）。
    文件操作仍然落在真实磁盘上——子 agent 要读的就是用户工作空间里的真文件。
    """
    return FilesystemBackend(
        root_dir=workspace_dir(),
        virtual_mode=True,
    )


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


def apply_permission_backend(spec: SubAgent) -> SubAgent:
    """把声明了 `permissions` 的子 agent 规格改成"无 shell"版本。

    为什么要改：框架在 backend 支持命令执行时拒绝 `permissions`
    （`NotImplementedError`），而主 agent 的 backend 有 shell。这类子 agent
    如果原样把 `permissions` 留在规格里，deepagents 建图时就会直接抛错。

    改法：把 `permissions` 从规格里摘出来，挪进一个自带的 FilesystemMiddleware
    ——这个中间件用 `build_restricted_backend()`（真实磁盘、无 shell），
    所以权限规则依然在工具层被强制执行。规格里按名字替换中间件是 deepagents
    支持的做法（同名中间件原地替换，见 `graph._apply_custom_middleware`）。

    顺带把 `mode="interrupt"` 的权限规则翻译成 `interrupt_on`（框架本来也是
    这么做的，见 `deepagents.graph._build_interrupt_on_from_permissions`）：
    子 agent 规格里的 `interrupt_on` 优先级更高，和框架的合并规则一致。
    """
    permissions = spec.get("permissions")
    if not permissions:
        return spec

    new_spec: dict[str, Any] = dict(spec)
    new_spec.pop("permissions", None)

    # 中间件和 interrupt 判定用同一个 backend 实例：后者要靠它解析符号链接，
    # 否则链接指向的路径不在规则的匹配范围内，interrupt 就拦不住
    restricted = build_restricted_backend()

    middleware = list(spec.get("middleware", []))
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
        new_spec["interrupt_on"] = {**fs_interrupts, **spec.get("interrupt_on", {})}

    return cast("SubAgent", new_spec)


def interrupt_on_from_permissions(
    permissions: list[FilesystemPermission],
    backend: CompositeBackend | FilesystemBackend | None = None,
) -> dict[str, Any]:
    """把 `mode="interrupt"` 的权限规则翻译成 `interrupt_on` 配置。

    框架的 `FilesystemMiddleware` 自己不认识 HITL——它只强制 deny 规则；
    interrupt 模式的规则要由建图那层翻译成 `interrupt_on`，才会挂上
    `HumanInTheLoopMiddleware`。我们把 permissions 从规格里挪进了自己的中间件，
    就得自己补这一步。

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
