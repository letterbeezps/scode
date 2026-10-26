"""agent 的文件与命令后端。

主 agent 用 **CompositeBackend**，默认 backend 是 **LocalShellBackend**：
文件操作直接落在真实磁盘（工作空间），`execute` 工具直接在本机跑 shell。
这是"真实 backend"的意思——之前默认的 StateBackend 是虚拟文件系统，
agent 的 `write_file` / `edit_file` 写的是内存里的副本，落不了盘，
长期记忆文件也因此写不进去。

    backend = CompositeBackend(
        default=LocalShellBackend(...),   # 真实磁盘 + 本机 shell
        routes={"/tmp/": StateBackend()}, # 例外：临时区走虚拟 FS，不落盘
    }

用 CompositeBackend 而不是直接用 LocalShellBackend，是为了让"哪部分路径走哪种
存储"这件事写在配置里而不是散落在各处。现在有两条 route：

- `/tmp/` → StateBackend：临时区走虚拟 FS，不在用户磁盘上留垃圾。
- `/user-memory/` → `~/.scode/`：用户级记忆。**这是工作空间之外的一条写路径**，
  但只覆盖这一个目录——agent 写用户级记忆就得走它。

## agent 自己的产物落在哪儿

deepagents 会往 backend 里写三样东西（对话历史、超大工具结果、二进制块），
写哪儿由 `CompositeBackend.artifacts_root` 说了算，默认是 `/`——也就是直接落在
工作空间根目录，冒出三个顶层目录。本项目把它设成 `/.scode`，收成一个隐藏目录
（见 `ARTIFACTS_ROOT`）。

注意产物路径**必须在工作空间里**：工具消息里就是这么告诉 agent 的
"结果太大，存到这个路径，你可以 read_file 读回来"，路径出了工作空间的
`virtual_mode` 边界就读不回来了，eviction 会退化成"存了但读不到"。

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

## 根目录是运行期定的，不是建图时定的

前端按任务选工作空间，同一张图要服务不同项目目录的对话，所以根目录不能
在建图时写死。框架的 `FilesystemBackend` 把根目录存在 `self.cwd` 里，
所有路径解析都从它出发（`_resolve_path`、glob/grep 的搜索根、
`LocalShellBackend.execute` 的 shell cwd）。

所以这里把 `cwd` 做成 property：取值时读当前运行的 `configurable`
（见 `graph/workspace.py`）。这样一次工具调用落在哪个目录，取决于这一轮
对话选了哪个工作空间，而不是后端启动时在哪个目录。

用 property 而不是"运行期换 backend 实例"有两个原因：backend 实例在建图时
就注册进框架的工具里了，运行期换不了；而且同一时刻可能有多个对话在跑，
property 背后是 contextvar，天然按运行隔离，改共享实例的属性则会串目录。
"""

from __future__ import annotations

from pathlib import Path
from typing import Any, cast

from deepagents import SubAgent
from deepagents.backends.composite import CompositeBackend
from deepagents.backends.filesystem import FilesystemBackend
from deepagents.backends.local_shell import LocalShellBackend
from deepagents.backends.protocol import GlobResult, GrepResult, LsResult
from deepagents.backends.state import StateBackend
from deepagents.middleware.filesystem import (
    FilesystemMiddleware,
    FilesystemPermission,
    FsToolName,
)

from stupid_code.graph.memory_home import USER_MEMORY_ROUTE, user_memory_dir
from stupid_code.graph.permissions import PermissionLevelMiddleware
from stupid_code.graph.workspace import (
    current_workspace,
    current_workspace_root,
    default_workspace,
)

ARTIFACTS_ROOT = "/.scode"
"""agent 自己的中间产物在工作空间里的落点（虚拟路径）。

deepagents 会把三类东西写进 backend：

| 内容 | 路径（`artifacts_root` 为 `/` 时的默认值） |
|---|---|
| 被压缩掉的对话历史 | `/conversation_history/<session_id>.md` |
| 超大的工具结果（eviction） | `/large_tool_results/<tool_call_id>` |
| 二进制内容块（默认关着） | `/blobs/<sha256>` |

**默认是工作空间根目录**——也就是直接落在用户的项目里，冒出三个顶层目录。本项目
把它们收拢到 `/.scode/` 下：一个隐藏目录、一条 gitignore 规则，而且跟项目已有的
`.scode-memory.md` 命名一致。

**必须留在工作空间里**：agent 要能 `read_file` 把落盘的内容读回来（工具消息里就是
这么告诉它的）。挪到工作空间外面的话路径出了 `virtual_mode` 的边界，eviction 就
变成「存了但读不到」。
"""


def _workspace_relative(key: str) -> str | None:
    """这个 key 是不是「工作空间里的宿主绝对路径」？是的话返回相对工作空间的部分。

    返回 None 表示不是（那它是虚拟路径，或者工作空间之外的绝对路径）。

    **对着两种路径形态各试一次**：工作空间根的 `resolved`（软链已展开）和
    `given`（用户给的那条）。macOS 上 `/tmp` → `/private/tmp` 是软链，用户
    手打 `/tmp/proj` 时，只有 `given` 形态能匹配上；反过来，模型拿系统提示词
    里的真实路径来，只有 `resolved` 形态能匹配上。两种都试才不会失配——
    失配的后果是前缀剥不掉，文件落进工作空间里的嵌套目录，**还不报错**。

    `/` 单独放行：它是虚拟根（`ls("/")` 要保留 composite 的聚合行为）。
    """
    path = Path(key)
    if not path.is_absolute() or path == Path("/"):
        return None
    for root in current_workspace_root().candidates():
        try:
            return path.relative_to(root).as_posix()
        except ValueError:
            continue
    return None


class _WorkspaceRoot:
    """让 backend 的根目录跟着「当前运行的工作空间」走。

    框架里所有路径解析都从 `self.cwd` 出发，所以改这一个属性就够：
    文件工具的路径、`execute` 的 shell cwd、glob/grep 的搜索根。

    `cwd` 在框架里本来是个普通实例属性，这里换成 property：属性查找时
    类上的数据描述符优先于实例 `__dict__`，所以父类 `__init__` 里那句
    `self.cwd = ...` 会落到下面的 setter（被忽略），而每次读取拿到的都是
    当前运行的工作空间。
    """

    @property
    def cwd(self) -> Path:
        """当前运行的工作空间（读不到就退回后端默认工作空间）。"""
        return current_workspace()

    @cwd.setter
    def cwd(self, value: Path) -> None:
        """父类构造时会给 `cwd` 赋值，这里忽略。

        真正的根目录由 `current_workspace()` 在每次使用时决定，
        构造时传进来的 `root_dir` 只在建图阶段有意义（那时还没有运行上下文，
        读到的就是默认工作空间）。
        """

    def _resolve_path(self, key: str) -> Path:
        """把模型给的路径解析成真实文件。

        框架的 `virtual_mode` 语义：`/foo` → `<工作空间>/foo`（虚拟路径，
        `/` 是工作空间根）。但模型看到系统提示词里的**绝对路径**之后，
        有时会把绝对路径直接传给文件工具（`/Users/me/proj/src/x.py`）——
        框架会把它当虚拟路径处理，于是文件落到
        `<工作空间>/Users/me/proj/src/x.py` 这种奇怪的地方，**还不报错**。

        这里把「以工作空间绝对路径开头」的写法先剥掉前缀，两种写法指向同一个
        文件。剥不掉的（工作空间之外的绝对路径）交回框架按虚拟路径处理——
        它出不去工作空间，只是落到工作空间内的同名子目录里。

        **要对着两种路径形态剥**（`resolved` 真实路径 + `given` 用户给的那条）：
        macOS 上 `/tmp` 是软链（真实路径 `/private/tmp`），用户可能打的是
        `/tmp/proj` 而工作空间根是 `/private/tmp/proj`。只拿 `resolved` 去比，
        `relative_to` 直接失配 → 前缀剥不掉 → 文件落进嵌套目录，还不报错。

        用 `Path.is_absolute()` 而不是 `startswith("/")`：Windows 的盘符路径
        （`C:\\...`）也是绝对路径，只认 `/` 的话前缀永远剥不掉。
        """
        relative = _workspace_relative(key)
        if relative is not None:
            return super()._resolve_path(f"/{relative}")
        return super()._resolve_path(key)


class WorkspaceShellBackend(_WorkspaceRoot, LocalShellBackend):
    """真实磁盘 + 本机 shell，根目录跟着当前运行的工作空间走。"""


class WorkspaceFilesBackend(_WorkspaceRoot, FilesystemBackend):
    """真实磁盘、没有 shell，根目录同样跟着当前运行的工作空间走。"""


class WorkspaceCompositeBackend(CompositeBackend):
    """CompositeBackend + 「工作空间绝对路径优先走 default」的守卫。

    路由是按**虚拟前缀**匹配的，而且发生在 default backend 剥掉工作空间前缀
    之前。工作空间本身位于 `/tmp/...` 时（Linux 的 `mktemp -d` 默认就在那儿），
    模型传进来的宿主绝对路径 `/tmp/ws/x.py` 会被 `/tmp/` 路由吃掉，写进
    `StateBackend`——文件不落盘、还报成功。

    所以路由前先判断 key 是不是「以当前工作空间绝对路径开头」：是的话一律交给
    default backend（它会把前缀剥掉）。不在工作空间下的虚拟 `/tmp/...` 仍然走
    `StateBackend`，临时产物的语义不变。
    """

    @staticmethod
    def _is_workspace_path(key: str) -> bool:
        """这个 key 是不是当前工作空间里的宿主绝对路径。

        `/` 单独放行：它是虚拟根，`ls("/")` 要保留 composite 的聚合行为。
        """
        return _workspace_relative(key) is not None

    def _get_backend_and_key(self, key: str) -> tuple[Any, str]:
        if self._is_workspace_path(key):
            return self.default, key
        return super()._get_backend_and_key(key)

    def ls(self, path: str) -> LsResult:
        if self._is_workspace_path(path):
            return self._coerce_ls_result(self.default.ls(path))
        return super().ls(path)

    async def als(self, path: str) -> LsResult:
        if self._is_workspace_path(path):
            return self._coerce_ls_result(await self.default.als(path))
        return await super().als(path)

    def grep(
        self,
        pattern: str,
        path: str | None = None,
        glob: str | None = None,
        *,
        max_count: int | None = None,
    ) -> GrepResult:
        if path is not None and self._is_workspace_path(path):
            return self._grep_backend(self.default, pattern, path, glob, max_count)
        return super().grep(pattern, path, glob, max_count=max_count)

    async def agrep(
        self,
        pattern: str,
        path: str | None = None,
        glob: str | None = None,
        *,
        max_count: int | None = None,
    ) -> GrepResult:
        if path is not None and self._is_workspace_path(path):
            return await self._agrep_backend(self.default, pattern, path, glob, max_count)
        return await super().agrep(pattern, path, glob, max_count=max_count)

    def glob(self, pattern: str, path: str | None = None) -> GlobResult:
        if path is not None and self._is_workspace_path(path):
            return self.default.glob(pattern, path)
        return super().glob(pattern, path)

    async def aglob(self, pattern: str, path: str | None = None) -> GlobResult:
        if path is not None and self._is_workspace_path(path):
            return await self.default.aglob(pattern, path)
        return await super().aglob(pattern, path)


def build_backend() -> CompositeBackend:
    """主 agent 的 backend：真实磁盘 + 本机 shell。

    - `virtual_mode=True`：文件工具的路径锁在工作空间内（`/` 就是工作空间根），
      挡掉 `..` 和 `~` 越界。注意这只管文件操作——shell 不受这个限制。
    - `inherit_env=True`：shell 继承当前进程的环境变量。默认是空环境，
      PATH 是空的，`uv` / `python` / `node` 这些全都找不到。
    - `/tmp/` 路由到 StateBackend：临时产物走虚拟 FS，不在用户磁盘上留垃圾。
      工作空间自己的绝对路径（比如 `/tmp/ws/x`）不会被这条路由吃掉，见
      `WorkspaceCompositeBackend`。
    - `/user-memory/` 路由到用户级记忆目录（`~/.scode/`）：agent 用
      `write_file("/user-memory/memory.md", ...)` 就能写用户级记忆，跟写项目级
      记忆用同一个工具。**这是工作空间之外的一条写路径**，只覆盖这一个目录。
    - `artifacts_root`：deepagents 自己往 backend 里写产物时用的根路径，
      见 `ARTIFACTS_ROOT`。
    """
    return WorkspaceCompositeBackend(
        default=WorkspaceShellBackend(
            root_dir=default_workspace(),
            virtual_mode=True,
            inherit_env=True,
        ),
        routes={
            "/tmp/": StateBackend(),
            USER_MEMORY_ROUTE: FilesystemBackend(
                root_dir=user_memory_dir(),
                virtual_mode=True,
            ),
        },
        artifacts_root=ARTIFACTS_ROOT,
    )


def build_restricted_backend() -> CompositeBackend:
    """给声明了 `permissions` 的子 agent 用的 backend：真实磁盘，但没有 shell。

    没有 shell，`permissions` 才拦得住（见模块 docstring 里框架那条限制）。
    文件操作仍然落在真实磁盘上——子 agent 要读的就是用户工作空间里的真文件。

    **为什么不是裸的 `FilesystemBackend`**：框架读 `artifacts_root` 的条件是
    `isinstance(backend, CompositeBackend)`，裸的 `FilesystemBackend` 拿不到这个
    属性，产物就会退回 `/` 根目录（`<工作空间>/large_tool_results/` 之类），
    和主 agent 的落点分叉。套一层没有路由的 CompositeBackend 就能统一到
    `ARTIFACTS_ROOT`，行为上跟裸 FilesystemBackend 完全一致（没有路由 → 一律走
    default）。

    框架自己也是这么处理权限路径的：`deepagents/middleware/filesystem.py` 里
    `_resolve_real_path()` 显式认 `CompositeBackend`（先路由再解析软链），
    所以 `interrupt_on` 谓词的软链解析不受影响。
    """
    return WorkspaceCompositeBackend(
        default=WorkspaceFilesBackend(
            root_dir=default_workspace(),
            virtual_mode=True,
        ),
        routes={},
        artifacts_root=ARTIFACTS_ROOT,
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


def apply_subagent_policies(
    spec: SubAgent,
    *,
    default_interrupt_on: dict[str, Any] | None = None,
) -> SubAgent:
    """把主 agent 的安全策略收紧到子 agent 规格上。

    做两件事：

    1. **继承父级的 `interrupt_on`**。框架的默认语义是「子 agent 规格里写了
       `interrupt_on` 就整体替换父级的」——`fixer` 声明了 `write_file` /
       `edit_file` 的确认之后，`execute` 的人工确认就静默没了。这里显式合并
       （规格里同名的键优先，和框架合并文件权限的规则一致）。
    2. **声明了 `permissions` 的子 agent 不继承 MCP 工具**。它的「只读」是靠
       无 shell 的 `FilesystemBackend` 保证的，而 MCP 工具完全不经过那一层
       ——继承过来等于给了它另一条写路径（服务器给什么它就能做什么）。
       主 agent 传给 `create_deep_agent` 的 `tools` 只有 MCP 工具，所以
       `tools = []` 就是「不接 MCP」；文件工具来自 FilesystemMiddleware，
       不受影响。

    声明了 `permissions` 的子 agent 还要换成“无 shell”版本：

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
    new_spec: dict[str, Any] = dict(spec)

    if default_interrupt_on:
        new_spec["interrupt_on"] = {
            **default_interrupt_on,
            **new_spec.get("interrupt_on", {}),
        }

    # 子 agent 的 HITL 谓词读的是**子 agent 自己的** state，父图记的档位它看不到。
    # 所以每个子 agent 都要自己挂一份记录中间件，档位才稳（见 permissions.py）。
    middleware = list(new_spec.get("middleware", []))
    middleware.append(PermissionLevelMiddleware())

    permissions = new_spec.get("permissions")
    if not permissions:
        new_spec["middleware"] = middleware
        return cast("SubAgent", new_spec)

    new_spec.pop("permissions", None)
    # 只读子 agent 不继承 MCP 工具（见 docstring 第 2 条）
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
