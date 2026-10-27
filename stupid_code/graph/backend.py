"""agent 的文件与命令后端。

主 agent 用 **CompositeBackend**，默认 backend 是 **LocalShellBackend**：
文件操作直接落在真实磁盘（工作空间），`execute` 工具直接在本机跑 shell。
这是"真实 backend"的意思——之前默认的 StateBackend 是虚拟文件系统，
agent 的 `write_file` / `edit_file` 写的是内存里的副本，落不了盘，
长期记忆文件也因此写不进去。

    backend = CompositeBackend(
        default=LocalShellBackend(...),   # 真实磁盘 + 本机 shell
        routes={"/user-memory/": FilesystemBackend(...)},  # 例外：用户级记忆目录
    }

用 CompositeBackend 而不是直接用 LocalShellBackend，是为了让"哪部分路径走哪种
存储"这件事写在配置里而不是散落在各处。现在有两条 route：

- `/user-memory/` → `~/.scode/`：用户级记忆。**这是工作空间之外的一条写路径**，
  但只覆盖这一个目录——agent 写用户级记忆就得走它。
- `/user-skills/` → `~/.scode/.agents/skills/`：全局 skill，**只读**。

两条 route 都是**虚拟名**——`/user-memory`、`/user-skills` 在磁盘上并不存在。
所以它们永远不会跟模型传进来的宿主绝对路径撞上：路由按虚拟前缀匹配，而真实
路径里不会出现这两个前缀。

（早先还有第三条 `/tmp/` → StateBackend 的路由，给 agent 一个会话内的临时区。
它已经删了。那条路由是唯一可能跟宿主绝对路径撞上的（macOS 的 `/tmp` 是软链、
Linux 的 `mktemp -d` 默认就在那儿），为了防它得额外套一层守卫类；而它提供的
「会话内临时区」跟项目自己的产物策略（收在 `<工作空间>/.scode/`）也是重复的。
详见 `docs/backend/PROGRESS.md` 的「020 · 删掉 `/tmp/` 路由」。）

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
就炸了。本模块只提供 `build_restricted_backend()`（无 shell 的 backend），
具体的子 agent 策略在 `graph/subagent_policy.py` 里组装。

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

from deepagents.backends.composite import CompositeBackend
from deepagents.backends.filesystem import FilesystemBackend
from deepagents.backends.local_shell import LocalShellBackend

from stupid_code.graph.paths import (
    GLOBAL_SKILLS_ROUTE,
    USER_MEMORY_ROUTE,
    global_skills_dir,
    user_memory_dir,
)
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
        path = Path(key)
        # `/` 单独放行：它是虚拟根（`ls("/")` 要保留 composite 的聚合行为）。
        if path.is_absolute() and path != Path("/"):
            for root in current_workspace_root().candidates():
                try:
                    relative = path.relative_to(root).as_posix()
                except ValueError:
                    continue
                return super()._resolve_path(f"/{relative}")
        return super()._resolve_path(key)


class WorkspaceShellBackend(_WorkspaceRoot, LocalShellBackend):
    """真实磁盘 + 本机 shell，根目录跟着当前运行的工作空间走。"""


class WorkspaceFilesBackend(_WorkspaceRoot, FilesystemBackend):
    """真实磁盘、没有 shell，根目录同样跟着当前运行的工作空间走。"""


def build_backend() -> CompositeBackend:
    """主 agent 的 backend：真实磁盘 + 本机 shell。

    - `virtual_mode=True`：文件工具的路径锁在工作空间内（`/` 就是工作空间根），
      挡掉 `..` 和 `~` 越界。注意这只管文件操作——shell 不受这个限制。
    - `inherit_env=True`：shell 继承当前进程的环境变量。默认是空环境，
      PATH 是空的，`uv` / `python` / `node` 这些全都找不到。
    - `/user-memory/` 路由到用户级记忆目录（`~/.scode/`）：agent 用
      `write_file("/user-memory/memory.md", ...)` 就能写用户级记忆，跟写项目级
      记忆用同一个工具。**这是工作空间之外的一条写路径**，只覆盖这一个目录。
    - `/user-skills/` 路由到全局 skill 目录（`~/.scode/.agents/skills/`）：agent
      用 `read_file("/user-skills/<skill>/SKILL.md", ...)` 就能读全局 skill 的
      全文。**这是工作空间之外的另一条路径**，同样只覆盖这一个目录。
    - `artifacts_root`：deepagents 自己往 backend 里写产物时用的根路径，
      见 `ARTIFACTS_ROOT`。
    """
    return CompositeBackend(
        default=WorkspaceShellBackend(
            root_dir=default_workspace(),
            virtual_mode=True,
            inherit_env=True,
        ),
        routes={
            USER_MEMORY_ROUTE: FilesystemBackend(
                root_dir=user_memory_dir(),
                virtual_mode=True,
            ),
            GLOBAL_SKILLS_ROUTE: FilesystemBackend(
                root_dir=global_skills_dir(),
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
    return CompositeBackend(
        default=WorkspaceFilesBackend(
            root_dir=default_workspace(),
            virtual_mode=True,
        ),
        routes={},
        artifacts_root=ARTIFACTS_ROOT,
    )