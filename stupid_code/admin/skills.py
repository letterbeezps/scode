"""skill 清单接口。

agent 能用的 skill 有两个来源：

- **全局**：`~/.scode/.agents/skills/`（`$SCODE_HOME` 可改），跨所有工作空间
- **项目级**：`<工作空间>/.agents/skills/`，只对当前工作空间有效

这个接口把两个来源的 skill 都列出来，给前端的斜杠菜单用——用户在输入框敲
`/` 就能看到并勾选本次对话要用哪些 skill。

## 为什么单独一个接口

skill 的**发现**逻辑已经在 `graph/skills.py` 里了（跟 agent 用的是同一套
backend、同一套源），这里不重新实现一遍——直接用同一个中间件读，避免两边
看到的不一致（比如同名 skill 谁覆盖谁）。

## 并发

所有文件系统操作都走 `asyncio.to_thread`：`langgraph dev` 装了 blockbuster，
事件循环里的同步 FS 调用会被拦下来。
"""

from __future__ import annotations

import asyncio
from pathlib import Path
from typing import Any

from deepagents.backends.composite import CompositeBackend
from deepagents.backends.filesystem import FilesystemBackend
from deepagents.middleware.skills import SkillsMiddleware
from starlette.requests import Request
from starlette.responses import JSONResponse

from stupid_code.graph.paths import GLOBAL_SKILLS_ROUTE, global_skills_dir
from stupid_code.graph.skills import PROJECT_SKILLS_SOURCE, skill_sources
from stupid_code.graph.workspace import (
    WorkspaceError,
    default_workspace,
    resolve_workspace_path,
)

SCOPE_USER = "user"
SCOPE_PROJECT = "project"


def _backend_for(workspace: Path) -> CompositeBackend:
    """给指定工作空间造一个能读两个 skill 源的 backend。

    **不能直接用主 backend**：主 backend 的根目录是**运行期属性**（跟着当前
    那轮对话的工作空间走），而这个接口是独立请求，没有运行上下文——得把
    工作空间显式传进去。

    两边的行为一致：同样的源、同样的路由，只是根目录给死了。
    """
    return CompositeBackend(
        default=FilesystemBackend(root_dir=workspace, virtual_mode=True),
        routes={
            GLOBAL_SKILLS_ROUTE: FilesystemBackend(
                root_dir=global_skills_dir(),
                virtual_mode=True,
            ),
        },
    )


def _scope_of(path: str) -> str:
    """这个 skill 来自哪个作用域。"""
    return SCOPE_USER if path.startswith(GLOBAL_SKILLS_ROUTE) else SCOPE_PROJECT


def _source_of(path: str) -> str:
    """这个 skill 来自哪个源目录。"""
    if path.startswith(GLOBAL_SKILLS_ROUTE):
        return GLOBAL_SKILLS_ROUTE
    return PROJECT_SKILLS_SOURCE


async def _list(workspace: Path) -> list[dict[str, Any]]:
    """读出两个源里的全部 skill。

    复用 agent 那边的中间件：同一套 backend、同一套源、同样的「同名后者
    覆盖前者」规则——避免界面上看到的和 agent 实际拿到的不一致。

    **backend 的构造必须走线程**：`FilesystemBackend.__init__` 里有一句
    `Path(root_dir).resolve()`，会 stat 磁盘；在事件循环里直接调会被
    blockbuster 拦下来（`BlockingError: Blocking call to os.readlink`），
    整个请求 500。
    """
    middleware = await asyncio.to_thread(
        lambda: SkillsMiddleware(
            backend=_backend_for(workspace),
            sources=skill_sources(),
        )
    )
    update = await middleware.abefore_agent({}, None, {})  # type: ignore[arg-type]
    metadata = (update or {}).get("skills_metadata") or []

    out: list[dict[str, Any]] = []
    for skill in metadata:
        path = skill.get("path", "")
        out.append({
            "name": skill.get("name", ""),
            "description": skill.get("description", ""),
            "scope": _scope_of(path),
            "source": _source_of(path),
            "path": path,
        })
    return out


async def read_skills(request: Request) -> JSONResponse:
    """GET /admin/skills?workspace=<绝对路径> — 列出可用的 skill。

    `workspace` 可以不给——不给就是后端默认工作空间。
    """
    workspace = (request.query_params.get("workspace") or "").strip()
    try:
        root = (
            await asyncio.to_thread(resolve_workspace_path, workspace)
            if workspace
            else default_workspace()
        )
    except WorkspaceError as exc:
        return JSONResponse({"error": str(exc)}, status_code=400)

    try:
        skills = await _list(root)
    except OSError as exc:
        return JSONResponse({"error": f"读 skill 目录失败：{exc}"}, status_code=500)

    return JSONResponse({
        "workspace": str(root),
        "skills": skills,
    })
