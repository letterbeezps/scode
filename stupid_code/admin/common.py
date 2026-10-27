"""admin 路由共用的小工具：解析请求里的工作空间、统一错误响应。"""

from __future__ import annotations

import asyncio
from pathlib import Path

from starlette.requests import Request
from starlette.responses import JSONResponse

from stupid_code.graph.workspace import (
    WorkspaceError,
    default_workspace,
    resolve_workspace_path,
)


async def resolve_workspace(raw: str) -> Path:
    """解析一个工作空间字符串；空串用后端默认工作空间。

    解析要读文件系统，走线程——langgraph dev 的 blockbuster 会拦事件循环里的
    同步 FS 调用。
    """
    raw = raw.strip()
    if not raw:
        return default_workspace()
    return await asyncio.to_thread(resolve_workspace_path, raw)


async def workspace_from_query(request: Request) -> Path:
    """读 `?workspace=<绝对路径>`。"""
    return await resolve_workspace(request.query_params.get("workspace") or "")


def workspace_error(exc: WorkspaceError) -> JSONResponse:
    """工作空间不合法时的统一 400 响应。"""
    return JSONResponse({"error": str(exc)}, status_code=400)
