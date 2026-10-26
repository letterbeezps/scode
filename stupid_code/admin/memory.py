"""记忆的读写接口。

agent 的长期记忆有两份（见 `graph/memory.py`）：

| 作用域 | 真实文件 | 跟着谁走 |
|---|---|---|
| 用户级 | `~/.scode/memory.md` | 用户（跨所有工作空间） |
| 项目级 | `<工作空间>/.scode-memory.md` | 项目 |

这个接口把两份都暴露出来：**看**（GET）和**改**（PUT）。

## 为什么要有这个接口

记忆文件是磁盘上的 markdown，但网页版用户看不见它——想看一眼或改一个字都得
开终端翻工作空间。有了这个接口，记忆面板（前端 `components/memory/`）就能
直接把内容显示出来、编辑完写回去。

agent 自己写记忆走的是文件工具（`write_file("/user-memory/memory.md", ...)`），
跟这个接口写的是同一批文件，两条路互不干扰。

## 并发与一致性

这个接口直接读写文件，**不经过 agent 的会话状态**。所以：

- 改完记忆，**当前会话读不到**——记忆是会话开始时读一次的（框架机制）。
  要生效得开新会话。
- agent 在会话里写记忆的同时你在这里改，会互相覆盖（后写的赢）。
  这是「两个都是普通文件写者」的必然结果，不是 bug。
"""

from __future__ import annotations

import asyncio
from pathlib import Path

from starlette.requests import Request
from starlette.responses import JSONResponse

from stupid_code.graph.memory_home import MEMORY_FILENAME, user_memory_path
from stupid_code.graph.workspace import (
    WorkspaceError,
    default_workspace,
    resolve_workspace_path,
)

SCOPES = ("user", "project")
"""记忆的作用域：用户级 / 项目级。"""


def _read(path: Path) -> tuple[bool, str]:
    """读一个记忆文件。返回 (是否存在, 内容)。

    文件不存在不是错误——记忆本来就是可选的。
    """
    if not path.exists():
        return False, ""
    return True, path.read_text(encoding="utf-8")


def _write(path: Path, content: str) -> int:
    """写一个记忆文件，返回写入的字节数。

    父目录不存在就建（用户级记忆的 `~/.scode/` 平时是空的）。
    """
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(content, encoding="utf-8")
    return len(content.encode("utf-8"))


def _project_memory_path(workspace: str) -> Path:
    """项目级记忆的完整路径。

    工作空间没给就用后端默认工作空间——跟 agent 的行为一致（没选工作空间
    = 用后端启动时的目录，见 `graph/workspace.py`）。
    """
    root = resolve_workspace_path(workspace) if workspace else default_workspace()
    return root / MEMORY_FILENAME


async def _resolve(workspace: str) -> Path:
    """解析工作空间并返回项目级记忆的路径。**会读文件系统，走线程。**

    工作空间不合法时抛 `WorkspaceError`（继承 ValueError，message 面向用户）。
    """
    return await asyncio.to_thread(_project_memory_path, workspace)


async def read_memory(request: Request) -> JSONResponse:
    """GET /admin/memory?workspace=<绝对路径> — 读两份记忆。

    `workspace` 可以不给——不给就是后端默认工作空间。
    """
    workspace = (request.query_params.get("workspace") or "").strip()
    try:
        project_path = await _resolve(workspace)
    except WorkspaceError as exc:
        return JSONResponse({"error": str(exc)}, status_code=400)

    user_path = user_memory_path()
    try:
        user_exists, user_content = await asyncio.to_thread(_read, user_path)
        project_exists, project_content = await asyncio.to_thread(_read, project_path)
    except OSError as exc:
        return JSONResponse({"error": f"读记忆文件失败：{exc}"}, status_code=500)

    return JSONResponse({
        "workspace": str(project_path.parent),
        "user": {
            "scope": "user",
            "path": str(user_path),
            "exists": user_exists,
            "content": user_content,
        },
        "project": {
            "scope": "project",
            "path": str(project_path),
            "exists": project_exists,
            "content": project_content,
        },
    })


async def write_memory(request: Request) -> JSONResponse:
    """PUT /admin/memory — 写一份记忆。

    body: `{"scope": "user"|"project", "content": "...", "workspace": "<绝对路径>"}`

    `workspace` 只在写项目级记忆时需要（用户级的不看工作空间）。
    内容写空字符串 = 清空这个文件（文件留在原地，只是没内容了）。
    """
    try:
        body = await request.json()
    except Exception as exc:  # noqa: BLE001 —— 任何解析失败都是「body 不是 JSON」
        return JSONResponse({"error": f"请求体不是合法 JSON：{exc}"}, status_code=400)

    if not isinstance(body, dict):
        return JSONResponse({"error": "请求体必须是 JSON 对象"}, status_code=400)

    scope = body.get("scope")
    if scope not in SCOPES:
        return JSONResponse(
            {"error": f"scope 只能是 {' / '.join(SCOPES)}，收到 {scope!r}"},
            status_code=400,
        )

    content = body.get("content")
    if not isinstance(content, str):
        return JSONResponse({"error": "content 必须是字符串"}, status_code=400)

    workspace = body.get("workspace")
    if workspace is not None and not isinstance(workspace, str):
        return JSONResponse({"error": "workspace 必须是字符串"}, status_code=400)
    workspace = (workspace or "").strip()

    if scope == "user":
        path = user_memory_path()
    else:
        try:
            path = await _resolve(workspace)
        except WorkspaceError as exc:
            return JSONResponse({"error": str(exc)}, status_code=400)

    try:
        size = await asyncio.to_thread(_write, path, content)
    except OSError as exc:
        return JSONResponse({"error": f"写记忆文件失败：{exc}"}, status_code=500)

    return JSONResponse({
        "scope": scope,
        "path": str(path),
        "bytes": size,
        "exists": True,
    })
