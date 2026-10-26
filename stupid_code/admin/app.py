"""挂载到 langgraph dev 的 Starlette 子应用。

langgraph.json 里 http.app 指向本文件:app。
app 必须是 Starlette 实例（FastAPI 也接受，本期不依赖 FastAPI）。
管理路由挂在 /admin/models 前缀，避开 langgraph 内置路径。

**`/workspaces/pick` 挂在根路径**，不在 /admin 下面：前端的工作空间选择器
按契约直接调 `POST /workspaces/pick`（见 web/src/api/workspace.ts），
路径前缀是前端定死的，后端照着实现——`/admin` 是后端自己的命名空间，
前端并没有按它来。

`/admin/models` 的接口细粒度是「模型」——每个模型自带全部连接字段，
toml 内部按 provider 分组只是为了避免重复写 key / base_url，接口层不暴露该结构。
"""

from contextlib import asynccontextmanager

from starlette.applications import Starlette
from starlette.routing import Mount, Route

from stupid_code.admin.memory import read_memory, write_memory
from stupid_code.admin.models import (
    create,
    delete,
    get_one,
    list_all,
    update,
)
from stupid_code.admin.workspaces import pick_workspace
from stupid_code.graph.mcp import close_mcp_sessions


@asynccontextmanager
async def lifespan(app: Starlette):
    """应用关停时把 MCP 长会话收掉。

    会话的 `async with` 在各自的 worker 任务里，必须由那个任务自己退出
    （anyio 的 cancel scope 不能跨任务关闭）。`close_mcp_sessions()` 会取消
    worker 任务并等它们收尾。不挂这个钩子也不会留下僵尸进程——服务关停会
    取消所有任务——但显式关闭的日志更干净，子进程也更早退出。
    """
    yield
    await close_mcp_sessions()


# 用 Mount 把 admin/ 前缀的所有路由打包成一个子 app，
# 与 langgraph 内置路由并行；不冲突。
admin_routes = Starlette(routes=[
    Route("/models", list_all, methods=["GET"]),
    Route("/models", create, methods=["POST"]),
    Route("/models/{id}", get_one, methods=["GET"]),
    Route("/models/{id}", update, methods=["PUT"]),
    Route("/models/{id}", delete, methods=["DELETE"]),
    # 记忆的读写（用户级 + 项目级）——给前端的记忆面板用
    Route("/memory", read_memory, methods=["GET"]),
    Route("/memory", write_memory, methods=["PUT"]),
])

app = Starlette(
    routes=[
        Mount("/admin", app=admin_routes),
        # 弹系统文件浏览窗口选工作空间：前端工作空间选择器的数据源。
        # 挂在根路径是因为前端契约如此。
        Route("/workspaces/pick", pick_workspace, methods=["POST"]),
    ],
    lifespan=lifespan,
)
