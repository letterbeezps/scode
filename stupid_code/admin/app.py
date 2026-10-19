"""挂载到 langgraph dev 的 Starlette 子应用。

langgraph.json 里 http.app 指向本文件:app。
app 必须是 Starlette 实例（FastAPI 也接受，本期不依赖 FastAPI）。
所有管理路由挂在 /admin/models 前缀，避开 langgraph 内置路径。

接口细粒度是「模型」——每个模型自带 protocol/provider/base_url/api_key。
toml 内部按 provider 分组避免重复写 key/base_url，接口层不暴露该结构。
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
])
