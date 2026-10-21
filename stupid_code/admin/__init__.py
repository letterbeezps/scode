"""管理端 HTTP 接口。

挂在 langgraph dev 的 /admin 前缀下（见 langgraph.json 的 http.app），
与 langgraph 内置路由并行、互不冲突。契约见 ../API.md「模型管理」。

    app.py     Starlette 子应用与路由表
    models.py  /admin/models 五个端点的请求处理

只做「读写 conf/config.toml」这一件事：模型实例本身是 graph/agent.py 导入时
构建的，改完配置必须重启 scode 才生效，所以每个写操作的响应都带
restart_required: true。
"""
