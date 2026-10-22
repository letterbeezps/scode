"""agent 的长期记忆：工作空间根目录的 AGENTS.md。

用 deepagents 的 `MemoryMiddleware`，通过 `create_deep_agent` 的 **middleware 参数**
挂上去，不用它自带的 `memory` 参数——两者最终是同一个中间件，但显式挂载能自己
决定 backend 与 sources（`memory=` 只能用框架默认的 backend）。

工作空间 = 运行 `uv run scode` 时所在的目录：launcher 把 langgraph 子进程的 cwd
设成它，graph 也就在那儿被导入，所以 `Path.cwd()` 就是工作空间。
AGENTS.md 不存在就创建一份带模板的。

两个要注意的点：

1. **只在会话开始时读一次**。MemoryMiddleware 的 before_agent 钩子见到 state 里
   已经有 `memory_contents` 就不重复读——改了 AGENTS.md 要开新会话才生效。
2. **只用 FilesystemBackend 读这一个文件**。deepagents 默认给 agent 的文件工具
   用的还是 StateBackend（虚拟文件系统，不落磁盘），所以 agent 的 `edit_file`
   写不进真实的 AGENTS.md——内存提示词里虽然写着"可以调用 edit_file 保存新知识"，
   但在接真实磁盘 backend 之前，那句话是不成立的。
"""
from __future__ import annotations

from pathlib import Path

from deepagents.backends.filesystem import FilesystemBackend
from deepagents.middleware.memory import MemoryMiddleware

MEMORY_FILENAME = "AGENTS.md"
"""记忆文件名。deepagents 的约定就是 AGENTS.md（与 Claude Code 等工具一致）。"""


class MemorySetupError(Exception):
    """记忆文件准备失败。message 面向用户，可直接展示。"""


# 虚拟路径：以 backend 的 root_dir（工作空间）为根解析成真实文件。
# virtual_mode=True（默认）会把越界路径挡在 root 之外，这里只读一个文件，不给 agent 暴露。
_MEMORY_SOURCE = f"/{MEMORY_FILENAME}"

_TEMPLATE = f"""# {MEMORY_FILENAME}

这是 agent 的长期记忆。每次新会话开始时，agent 会把本文件的内容读进上下文。
写给 agent 看的内容用中文，命令、路径、标识符保持原样。

## 项目约定

（这个项目需要 agent 一直知道的规则：代码风格、目录约定、命名习惯……）

## 常用命令

（构建、测试、启动这类 agent 可能要执行的命令。）

## 经验与坑

（踩过的坑、试过但行不通的做法——写下来是为了别再踩第二遍。）

## 杂项

（暂时归不了类但值得记住的事。）
"""


def workspace_dir() -> Path:
    """工作空间目录 = 当前进程 cwd。

    launcher 起 langgraph 子进程时把 cwd 设成用户的工作空间，graph 也在那个
    进程里导入，所以这里拿到的就是工作空间。
    """
    return Path.cwd()


def memory_path() -> Path:
    """记忆文件在工作空间里的真实路径。"""
    return workspace_dir() / MEMORY_FILENAME


def ensure_memory_file() -> Path:
    """确保工作空间里有 AGENTS.md，不存在就用模板创建一份。返回文件路径。"""
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
    """构造 MemoryMiddleware：读工作空间根的 AGENTS.md。

    backend 用 FilesystemBackend（虚拟模式，路径限定在工作空间内），
    因为 MemoryMiddleware 是通过 backend.download_files() 读源文件的——
    默认的 StateBackend 里没有真实文件，读出来是空的。
    """
    ensure_memory_file()
    backend = FilesystemBackend(root_dir=workspace_dir(), virtual_mode=True)
    return MemoryMiddleware(
        backend=backend,
        sources=[_MEMORY_SOURCE],
        # 与框架自己挂 MemoryMiddleware 时的行为一致：给记忆块加缓存断点，
        # 记忆内容变了也不会把整个前缀缓存打穿
        add_cache_control=True,
    )
