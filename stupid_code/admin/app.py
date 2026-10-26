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

from starlette.applications import Starlette
from starlette.routing import Mount, Route

from stupid_code.admin.models import (
    create,
    delete,
    get_one,
    list_all,
    update,
)
from stupid_code.admin.workspaces import pick_workspace

# 用 Mount 把 admin/ 前缀的所有路由打包成一个子 app，
# 与 langgraph 内置路由并行；不冲突。
admin_routes = Starlette(routes=[
    Route("/models", list_all, methods=["GET"]),
    Route("/models", create, methods=["POST"]),
    Route("/models/{id}", get_one, methods=["GET"]),
    Route("/models/{id}", update, methods=["PUT"]),
    Route("/models/{id}", delete, methods=["DELETE"]),
])

app = Starlette(routes=[
    Mount("/admin", app=admin_routes),
    # 弹系统文件浏览窗口选工作空间：前端工作空间选择器的数据源。
    # 挂在根路径是因为前端契约如此。
    Route("/workspaces/pick", pick_workspace, methods=["POST"]),
])
