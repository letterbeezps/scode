"""后端文件路径约定（项目级记忆、用户级记忆、全局 skill）。

| 内容 | 虚拟路径 | 真实位置 | 跟着谁走 |
|---|---|---|---|
| 项目级记忆 | `/.scode-memory.md` | `<工作空间>/.scode-memory.md` | 工作空间 |
| 用户级记忆 | `/user-memory/memory.md` | `$SCODE_HOME/memory.md` | 用户 |
| 全局 skill | `/user-skills/<名字>/SKILL.md` | `$SCODE_HOME/.agents/skills/` | 用户 |

这个模块是这些路径的**单一事实源**：backend 要用它建路由，memory / skill
中间件要用它读文件，permissions 要用它判断「写的是不是记忆文件」。它只做
字符串与环境变量运算，**不读文件系统**，所以可以在事件循环里安全调用。

`$SCODE_HOME` 默认是 `~/.scode`。容器里把它指向宿主挂载目录，用户级记忆和
全局 skill 就能跨容器存活；它跟 `SCODE_WORKSPACE`（agent 干活的地方）不是
一回事。
"""

from __future__ import annotations

import os
from pathlib import Path

SCODE_HOME_ENV = "SCODE_HOME"
"""用户级目录的环境变量名。默认 `~/.scode`。"""

USER_MEMORY_DIRNAME = ".scode"
"""用户级目录的默认名字。"""

USER_MEMORY_FILENAME = "memory.md"
"""用户级记忆文件名。"""

USER_MEMORY_ROUTE = "/user-memory/"
"""用户级记忆的虚拟路径前缀。

主 backend 把文件操作路由到 `$SCODE_HOME`，agent 就能用
`write_file("/user-memory/memory.md", ...)` 写用户级记忆。
"""

MEMORY_FILENAME = ".scode-memory.md"
"""项目级记忆文件名。点开头 = 本地状态文件，通常进 .gitignore。"""

PROJECT_MEMORY_SOURCE = f"/{MEMORY_FILENAME}"
"""项目级记忆的虚拟路径，以工作空间为根解析。"""

USER_MEMORY_SOURCE = f"{USER_MEMORY_ROUTE}{USER_MEMORY_FILENAME}"
"""用户级记忆的虚拟路径，走主 backend 的同名路由。"""

GLOBAL_SKILLS_ROUTE = "/user-skills/"
"""全局 skill 的虚拟路径前缀。

主 backend 把文件操作路由到 `$SCODE_HOME/.agents/skills/`，agent 就能用
`read_file("/user-skills/<skill>/SKILL.md", ...)` 读全局 skill 的全文。
"""

GLOBAL_SKILLS_DIRNAME = ".agents"
"""全局 skill 目录在 `$SCODE_HOME` 下的名字。"""

GLOBAL_SKILLS_SUBDIR = "skills"
"""全局 skill 目录下存放 skill 的子目录名。"""


def scode_home_dir() -> Path:
    """用户级目录：`$SCODE_HOME`，没设就是 `~/.scode`。

    `expanduser()` / `Path.home()` 都是纯字符串与环境变量运算，不 stat 磁盘。
    """
    raw = os.environ.get(SCODE_HOME_ENV, "").strip()
    if raw:
        return Path(raw).expanduser()
    return Path.home() / USER_MEMORY_DIRNAME


def user_memory_dir() -> Path:
    """用户级记忆目录。目录不存在也没关系，第一次写入时框架会建父目录。"""
    return scode_home_dir()


def user_memory_path() -> Path:
    """用户级记忆文件的全路径。"""
    return user_memory_dir() / USER_MEMORY_FILENAME


def global_skills_dir() -> Path:
    """全局 skill 目录：`$SCODE_HOME/.agents/skills`。"""
    return scode_home_dir() / GLOBAL_SKILLS_DIRNAME / GLOBAL_SKILLS_SUBDIR
