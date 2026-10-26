"""用户级记忆的家目录。

项目级记忆跟着**工作空间**走（`<工作空间>/.scode-memory.md`），用户级记忆跟着
**用户**走——跨所有工作空间共用一份。后者放在 `~/.scode/memory.md`：
跟工作空间无关，所以放在用户主目录，而不是某个项目里。

## 为什么要单独一个模块

用户级记忆的落点被两个地方用到：

- `graph/backend.py`：给主 backend 加一条 `/user-memory/` 路由，agent 才能用
  `write_file` 把用户级记忆写回去。
- `graph/memory.py`：记忆中间件要读它。

而 `memory.py` 已经 import 了 `backend.py`（要用 `WorkspaceFilesBackend`），
所以常量不能定义在 `memory.py` 里——那会变成循环 import。放这里，两边都
import 它，谁也不依赖谁。

## 目录位置

`$SCODE_HOME`，没设就是 `~/.scode`。

环境变量是给容器用的：容器里的 `~` 是容器用户的家目录，容器一重建就空了。
挂一个宿主目录进来并把 `SCODE_HOME` 指过去，用户级记忆就能跨容器存活
（见 `docker-compose.yml` 的 `SCODE_HOME` 卷）。

跟 `SCODE_WORKSPACE`（工作空间）不是一个东西：那个是 agent 干活的地方，
这个是 agent 记住用户的地方。
"""

from __future__ import annotations

import os
from pathlib import Path

SCODE_HOME_ENV = "SCODE_HOME"
"""用户级记忆目录的环境变量名。默认 `~/.scode`。"""

USER_MEMORY_DIRNAME = ".scode"
"""用户级记忆目录名（`$SCODE_HOME` 下的那一层）。"""

USER_MEMORY_FILENAME = "memory.md"
"""用户级记忆文件名。"""

USER_MEMORY_ROUTE = "/user-memory/"
"""虚拟路径前缀。

主 backend 按这个前缀把文件操作路由到用户级记忆目录，agent 就能用
`write_file("/user-memory/memory.md", ...)` 写用户级记忆——跟它写项目级记忆
用同一个工具，不用额外教一套。

**注意**：这个前缀是**公开给模型的**。加了这条路由，agent 的文件工具就能写
工作空间之外的 `~/.scode/` 目录（只有这一个目录）。这是「用户级记忆」这个
功能本身要求的权限面，见 AGENTS.md 的安全姿态一节。
"""


def user_memory_dir() -> Path:
    """用户级记忆目录：`$SCODE_HOME`，没设就是 `~/.scode`。

    **不读文件系统**：`expanduser()` 和 `Path.home()` 都是纯字符串/环境变量
    操作，不 stat 磁盘——所以在事件循环里调用也安全（blockbuster 只拦真正的
    同步 FS 调用）。

    目录**不存在也没关系**：框架的 `FilesystemBackend.write` 会自己建父目录
    （`resolved_path.parent.mkdir(parents=True, exist_ok=True)`），所以第一次
    写记忆的时候目录才出现——跟项目级记忆「不自动创建文件」是同一个态度，
    不往用户主目录里凭空塞东西。
    """
    raw = os.environ.get(SCODE_HOME_ENV, "").strip()
    if raw:
        return Path(raw).expanduser()
    return Path.home() / USER_MEMORY_DIRNAME


def user_memory_path() -> Path:
    """用户级记忆文件的全路径（`$SCODE_HOME/memory.md`）。"""
    return user_memory_dir() / USER_MEMORY_FILENAME
