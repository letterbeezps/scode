"""agent 的长期记忆：工作空间根目录的 `.scode-memory.md`。

用 deepagents 的 `MemoryMiddleware`，通过 `create_deep_agent` 的 **middleware 参数**
挂上去，不用它自带的 `memory` 参数——两者最终是同一个中间件，但显式挂载能自己
决定 backend 与 sources（`memory=` 只能用框架默认的 backend）。

工作空间 = 运行 `uv run scode` 时所在的目录：launcher 把 langgraph 子进程的 cwd
设成它，graph 也就在那儿被导入，所以 `Path.cwd()` 就是工作空间。
`.scode-memory.md` 不存在就创建一份带模板的。

**为什么不用 `AGENTS.md`**：deepagents 的默认约定是读 `AGENTS.md`，但那通常是
"写给编码 agent 看的项目约定"（本项目根目录那份就是），跟"agent 自己攒的长期
记忆"是两回事，混在一起会把开发者的项目说明当成 agent 的记忆注入进去。换成
独立文件名后两者的语义就分开了。

三个要注意的点：

1. **只在会话开始时读一次**。MemoryMiddleware 的 before_agent 钩子见到 state 里
   已经有 `memory_contents` 就不重复读——改了文件要开新会话才生效。
2. **和 agent 的文件工具指向同一个真实文件**。中间件自己持有一个以工作空间
   为根的 FilesystemBackend，agent 的 `write_file` / `edit_file` 走
   `graph/backend.py` 那个 CompositeBackend（真实磁盘）——两边解析出来的真实
   路径都是 `<工作空间>/.scode-memory.md`，所以"把新知识写进记忆文件"是真的
   能落盘，框架记忆提示词里那句"可以调用 edit_file 保存新知识"到这才成立。
   （早先用 StateBackend 时，agent 的写操作只改虚拟 FS，记忆文件永远不变。）
3. **文件操作锁在工作空间内**。backend 用 `virtual_mode=True`，路径越不出
   工作空间根。
"""

from __future__ import annotations

from pathlib import Path

from deepagents.backends.filesystem import FilesystemBackend
from deepagents.middleware.memory import MemoryMiddleware

from stupid_code.graph.backend import workspace_dir

MEMORY_FILENAME = ".scode-memory.md"
"""记忆文件名。点开头 = 本地状态文件，不属于项目代码，通常进 .gitignore。"""


class MemorySetupError(Exception):
    """记忆文件准备失败。message 面向用户，可直接展示。"""


# 虚拟路径：以 backend 的 root_dir（工作空间）为根解析成真实文件。
# virtual_mode=True（默认）会把越界路径挡在 root 之外，这里只读一个文件，不给 agent 暴露。
_MEMORY_SOURCE = f"/{MEMORY_FILENAME}"

_TEMPLATE = f"""# {MEMORY_FILENAME}

这是 agent 自己的长期记忆。每次新会话开始时，agent 会把本文件的内容读进上下文。
写给 agent 看的内容用中文，命令、路径、标识符保持原样。

（这个文件和项目里的 `AGENTS.md` 是两回事：那份是写给编码 agent 看的项目约定。）

## 项目约定

（这个项目需要 agent 一直知道的规则：代码风格、目录约定、命名习惯……）

## 常用命令

（构建、测试、启动这类 agent 可能要执行的命令。）

## 经验与坑

（踩过的坑、试过但行不通的做法——写下来是为了别再踩第二遍。）

## 杂项

（暂时归不了类但值得记住的事。）
"""


def memory_path() -> Path:
    """记忆文件在工作空间里的真实路径。"""
    return workspace_dir() / MEMORY_FILENAME


def ensure_memory_file() -> Path:
    """确保工作空间里有记忆文件，不存在就用模板创建一份。返回文件路径。"""
    path = memory_path()
    if path.exists():
        return path
    try:
        path.write_text(_TEMPLATE, encoding="utf-8")
    except OSError as exc:
        raise MemorySetupError(
            f"创建记忆文件 {path} 失败：{exc}。"
            "工作空间不可写时 agent 无法保存长期记忆，请检查目录权限。"
        ) from exc
    return path


def build_memory_middleware() -> MemoryMiddleware:
    """构造 MemoryMiddleware：读工作空间根的记忆文件。

    中间件是通过 `backend.download_files()` 读源文件的，默认 StateBackend 里
    没有真实文件，读出来是空的，所以这里给它一个 FilesystemBackend。

    不用主 agent 那个 CompositeBackend：记忆只需要"工作空间里那一个文件"，
    自己拿一个以工作空间为根的 FilesystemBackend 更直白。两者解析出来的
    真实路径是同一个（`<工作空间>/.scode-memory.md`），所以 agent 用
    `write_file` / `edit_file` 写进这个文件的内容，下次开新会话就会被读进来。
    """
    ensure_memory_file()
    backend = FilesystemBackend(
        root_dir=workspace_dir(),
        virtual_mode=True,
    )
    return MemoryMiddleware(
        backend=backend,
        sources=[_MEMORY_SOURCE],
        # 与框架自己挂 MemoryMiddleware 时的行为一致：给记忆块加缓存断点，
        # 记忆内容变了也不会把整个前缀缓存打穿
        add_cache_control=True,
    )
