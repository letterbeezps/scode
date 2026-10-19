# 003 模型配置管理接口

## 目标

给 agent server 新增管理 `conf/config.toml` 中模型配置的 HTTP 接口。利用 langgraph_cli 原生的 `http.app` 挂载机制，加载一个自己写的 Starlette 子应用，提供模型的查询 / 新增 / 修改 / 删除。

### 成功标准

- `langgraph.json` 加 `http.app` 字段后，`uv run scode` 仍能启动并就绪
- `GET /admin/models` 返回所有供应商及其模型列表（key 脱敏）
- `POST /admin/models`、`PUT /admin/models/{provider}`、`DELETE /admin/models/{provider}` 能正确修改 `conf/config.toml`，下次启动新配置生效
- 修改文件不破坏示例文件 `conf/config.example.toml`

### 本期不做

- 模型热切换：改完 config.toml 后，正在运行的 graph 仍用旧模型实例；新配置需重启 `scode` 才生效
- 鉴权：本期接口对外暴露，仅监听 127.0.0.1 已是边界
- 前端管理 UI：仅后端接口
- `default` / `recent` 字段的切换：本期改 providers 段，不动 `[models]` 顶层选择字段（这部分留给后续的"模型切换"特性）

### 关键取舍

- **用 Starlette 不用 FastAPI**：CRUD 接口不依赖 Pydantic 验体，FastAPI 是冗余依赖；Starlette 已在 langgraph_api 间接依赖里
- **挂载机制**：`langgraph.json` 的 `http.app` 字段已被 `langgraph_api.api.load_custom_app()` 支持，源码在 `langgraph_api/api/__init__.py:226`——指向 `./admin_app.py:app`，文件里的 `app` 变量必须是 `Starlette` 实例
- **路径前缀**：所有路由在 `/admin/models` 下，避开 langgraph 内置的 `/ok`、`/assistants`、`/threads`、`/runs`、`/store`、`/cron`、`/info`、`/metrics` 等前缀
- **TOML 写回**：用 `tomli_w` 序列化（保留类型，不保留注释），写临时文件 + `os.replace` 原子替换，避免半截写入
- **key 脱敏**：`GET` 默认返回 `sk-***XXXX`（末 4 位），加 `?reveal=true` 返回完整 key（明确意图）
- **不缓存**：每个请求实时读盘——CRUD 写入刚发生就能在下次 GET 看到
- **不热重载**：改完 toml 不影响当前 graph，需重启 `scode` 生效（响应里返回 `restart_required: true` 提示）

---

## 1. 文件清单

新增 2 个：`stupid_code/admin_app.py`（Starlette app + 路由）、`stupid_code/admin_models.py`（CRUD 逻辑）；修改 2 个：`stupid_code/langgraph.json`（加 `http.app`）、`stupid_code/config.py`（抽出 helpers 供复用）。新增依赖：`tomli_w>=2.0`。

### 1.1 `stupid_code/langgraph.json`（修改）

```json
{
  "dependencies": ["."],
  "graphs": {
    "code_agent": "./agent.py:graph"
  },
  "http": {
    "app": "./admin_app.py:app"
  }
}
```

`http.app` 由 `langgraph_api.api.load_custom_app()` 解析：格式 `"path/to/file.py:variable"`，文件路径相对 `langgraph.json` 所在目录，variable 必须是 `Starlette` 实例。

### 1.2 `stupid_code/config.py`（修改：抽出 helpers）

复用现有 `load_config` / `build_model` 不动，新增一个 **保存** 函数和若干公共校验函数，把 `_require_api_key`/`_pick_model_spec` 等也公开：

```python
# 追加到 config.py 末尾

import tomli_w


def save_config(config: dict[str, Any]) -> None:
    """原子写回 conf/config.toml。先写临时文件再 os.replace，
    避免半截写入导致下一次启动解析失败。注释会丢失（tomli_w 不保留注释）。"""
    path = config_path()
    path.parent.mkdir(parents=True, exist_ok=True)
    tmp = path.with_suffix(".toml.tmp")
    with tmp.open("wb") as fp:
        tomli_w.dump(config, fp)
    os.replace(tmp, path)


def list_providers(config: dict[str, Any]) -> list[dict[str, Any]]:
    """返回所有供应商概要：[{name, protocol, display_name, base_url, models, has_api_key}]"""
    providers = config.get("models", {}).get("providers", {})
    out = []
    for name, p in providers.items():
        out.append({
            "name": name,
            "protocol": p.get("protocol"),
            "display_name": p.get("display_name"),
            "base_url": p.get("base_url"),
            "models": p.get("models", []),
            "has_api_key": bool(p.get("api_key")),
        })
    return out


def get_provider(config: dict[str, Any], name: str) -> dict[str, Any] | None:
    raw = config.get("models", {}).get("providers", {}).get(name)
    return raw


def set_provider(config: dict[str, Any], name: str, body: dict[str, Any]) -> None:
    """新建或覆写一个供应商配置。body 必含 protocol/models/api_key，可选 display_name/base_url。
    校验失败抛 ConfigError（HTTP 层捕获后转 400）。"""
    if not isinstance(body, dict):
        raise ConfigError("请求体必须是 JSON 对象")
    protocol = body.get("protocol")
    if protocol not in SUPPORTED_PROTOCOLS:
        raise ConfigError(
            f"protocol 只支持 {' / '.join(SUPPORTED_PROTOCOLS)}，当前为 {protocol!r}"
        )
    models = body.get("models")
    if not isinstance(models, list) or not models:
        raise ConfigError("models 必须是非空字符串数组")
    api_key = body.get("api_key")
    if not isinstance(api_key, str) or not api_key:
        raise ConfigError(f"api_key 必填（供应商 {name}）")

    config.setdefault("models", {}).setdefault("providers", {})[name] = {
        "protocol": protocol,
        "display_name": body.get("display_name"),
        "base_url": body.get("base_url"),
        "api_key": api_key,
        "models": models,
    }


def delete_provider(config: dict[str, Any], name: str) -> bool:
    """删除供应商；返回是否真的删了（用于 200/404 区分）。"""
    providers = config.get("models", {}).get("providers", {})
    return providers.pop(name, None) is not None
```

### 1.3 `stupid_code/admin_models.py`（新建）

```python
"""模型配置 CRUD 的请求处理函数。

每个函数接收 Starlette Request，返回 Response。
错误用 ConfigError 抛，路由层捕获后转 400。
"""

from __future__ import annotations

import tomllib
from typing import Any

from starlette.requests import Request
from starlette.responses import JSONResponse

from stupid_code.config import (
    ConfigError,
    build_model,
    delete_provider,
    get_provider,
    list_providers,
    load_config,
    save_config,
    set_provider,
)


def _mask(key: str | None) -> str | None:
    if not key:
        return None
    if len(key) <= 4:
        return "****"
    return f"***{key[-4:]}"


async def list_models(request: Request) -> JSONResponse:
    """GET /admin/models — 所有供应商及其模型，key 默认脱敏"""
    reveal = request.query_params.get("reveal") == "true"
    config = load_config()
    items = list_providers(config)
    if not reveal:
        for it in items:
            # list_providers 返回里没有 raw key，但 get_provider 才有
            provider = get_provider(config, it["name"]) or {}
            it["api_key_masked"] = _mask(provider.get("api_key"))
    return JSONResponse({
        "default": config.get("models", {}).get("default"),
        "recent": config.get("models", {}).get("recent"),
        "providers": items,
        "restart_required": True,
    })


async def get_model(request: Request) -> JSONResponse:
    """GET /admin/models/{provider} — 单个供应商详情"""
    name = request.path_params["provider"]
    config = load_config()
    provider = get_provider(config, name)
    if provider is None:
        return JSONResponse({"error": f"供应商 {name!r} 不存在"}, status_code=404)
    reveal = request.query_params.get("reveal") == "true"
    out = {**provider}
    if not reveal:
        out["api_key"] = _mask(out.get("api_key"))
    return JSONResponse(out)


async def create_model(request: Request) -> JSONResponse:
    """POST /admin/models — 新增供应商。已存在返回 409。"""
    try:
        body = await request.json()
    except Exception as exc:
        return JSONResponse({"error": f"请求体不是合法 JSON：{exc}"}, status_code=400)

    name = body.pop("name", None) if isinstance(body, dict) else None
    if not name or not isinstance(name, str):
        return JSONResponse({"error": "请求体需要顶层 name 字段（供应商名）"}, status_code=400)

    config = load_config()
    if get_provider(config, name) is not None:
        return JSONResponse({"error": f"供应商 {name!r} 已存在，请用 PUT 修改"}, status_code=409)

    try:
        set_provider(config, name, body)
        save_config(config)
    except ConfigError as exc:
        return JSONResponse({"error": str(exc)}, status_code=400)

    return JSONResponse({"name": name, "created": True, "restart_required": True}, status_code=201)


async def update_model(request: Request) -> JSONResponse:
    """PUT /admin/models/{provider} — 覆写已存在的供应商。"""
    name = request.path_params["provider"]
    try:
        body = await request.json()
    except Exception as exc:
        return JSONResponse({"error": f"请求体不是合法 JSON：{exc}"}, status_code=400)

    config = load_config()
    if get_provider(config, name) is None:
        return JSONResponse({"error": f"供应商 {name!r} 不存在"}, status_code=404)

    try:
        set_provider(config, name, body)
        save_config(config)
    except ConfigError as exc:
        return JSONResponse({"error": str(exc)}, status_code=400)

    return JSONResponse({"name": name, "updated": True, "restart_required": True})


async def delete_model(request: Request) -> JSONResponse:
    """DELETE /admin/models/{provider} — 删除供应商。"""
    name = request.path_params["provider"]
    config = load_config()
    try:
        deleted = delete_provider(config, name)
        if not deleted:
            return JSONResponse({"error": f"供应商 {name!r} 不存在"}, status_code=404)
        save_config(config)
    except ConfigError as exc:
        return JSONResponse({"error": str(exc)}, status_code=400)

    return JSONResponse({"name": name, "deleted": True, "restart_required": True})
```

### 1.4 `stupid_code/admin_app.py`（新建）

```python
"""挂载到 langgraph dev 的 Starlette 子应用。

langgraph.json 里 http.app 指向本文件:app。
app 必须是 Starlette 实例（FastAPI 也接受，本期不依赖 FastAPI）。
所有管理路由挂在 /admin/models 前缀，避开 langgraph 内置路径。
"""

from starlette.applications import Starlette
from starlette.routing import Mount, Route

from stupid_code.admin_models import (
    create_model,
    delete_model,
    get_model,
    list_models,
    update_model,
)

# 用 Mount 把 admin/ 前缀的所有路由打包成一个子 app，
# 与 langgraph 内置路由并行；不冲突。
admin_routes = Starlette(routes=[
    Route("/models", list_models, methods=["GET"]),
    Route("/models", create_model, methods=["POST"]),
    Route("/models/{provider}", get_model, methods=["GET"]),
    Route("/models/{provider}", update_model, methods=["PUT"]),
    Route("/models/{provider}", delete_model, methods=["DELETE"]),
])

app = Starlette(routes=[
    Mount("/admin", app=admin_routes),
])
```

### 1.5 `pyproject.toml`（修改）

```diff
 #model
 "langchain-anthropic>=1.7.6",
 "pydantic>=2.14.1",
 "langchain-openai>=1.6.6",
+"tomli-w>=1.0",
```

### 1.6 `stupid_code/README.md`（同步）

文件表加 `admin_app.py`、`admin_models.py` 两行；注意小节加：

> - `langgraph.json` 的 `http.app` 字段指向 `admin_app.py:app`。本期实现的 `/admin/models` 接口需要新配置生效时，仍需重启 `scode`（运行中的 graph 不热重载）。

---

## 2. 接口语义

| 方法 | 路径 | 功能 | 请求体 | 响应 |
|---|---|---|---|---|
| GET | `/admin/models` | 列出全部供应商及模型 | — | `{default, recent, providers: [{name, protocol, display_name, base_url, models, has_api_key, api_key_masked}], restart_required}` |
| GET | `/admin/models/{provider}` | 单个供应商详情 | — | 同上 providers 元素，含 `api_key`（默认脱敏） |
| POST | `/admin/models` | 新增供应商 | `{name, protocol, display_name?, base_url?, api_key, models}` | `201 {name, created, restart_required}` |
| PUT | `/admin/models/{provider}` | 覆写供应商 | `{protocol, display_name?, base_url?, api_key, models}` | `200 {name, updated, restart_required}` |
| DELETE | `/admin/models/{provider}` | 删除供应商 | — | `200 {name, deleted, restart_required}` |

`api_key_masked` 形如 `sk-***XXXX`（末 4 位，长度 ≤4 时显示 `****`）。

## 3. 验证

### 步骤 0：依赖同步

```bash
cd /Users/1token/Desktop/project/stupid-code
uv sync
```

期望：`tomli-w` 进入 resolved packages。

### 步骤 1：启动

```bash
uv run scode
```

期望：两条 ✅ 就绪提示正常出现。如果失败，看 langgraph dev 日志，一般是 `admin_app.py` 导入路径不对。

### 步骤 2：列表查询

```bash
curl -s http://127.0.0.1:2024/admin/models | python3 -m json.tool
```

期望：返回 `default` / `recent` / `providers` 数组（minimax + deepseek 两条），每个供应商的 `api_key_masked` 形如 `***XXXX`。

### 步骤 3：详情查询 + key 脱敏

```bash
curl -s http://127.0.0.1:2024/admin/models/minimax | python3 -m json.tool
curl -s "http://127.0.0.1:2024/admin/models/minimax?reveal=true" | python3 -m json.tool
```

期望：第一条返回脱敏 key；第二条返回完整 key。

### 步骤 4：新增

```bash
curl -s -X POST http://127.0.0.1:2024/admin/models \
  -H 'Content-Type: application/json' \
  -d '{
    "name": "moonshot",
    "protocol": "openai",
    "display_name": "Moonshot",
    "base_url": "https://api.moonshot.cn/v1",
    "api_key": "sk-test-moonshot",
    "models": ["moonshot-v1-8k", "moonshot-v1-32k"]
  }' | python3 -m json.tool
```

期望：201 响应；再 GET 能查到 moonshot。

### 步骤 5：修改

```bash
curl -s -X PUT http://127.0.0.1:2024/admin/models/moonshot \
  -H 'Content_protocol: application/json' \
  -d '{
    "protocol": "openai",
    "display_name": "Moonshot AI",
    "base_url": "https://api.moonshot.cn/v1",
    "api_key": "sk-test-moonshot-v2",
    "models": ["moonshot-v1-8k", "moonshot-v1-32k", "moonshot-v1-128k"]
  }' | python3 -m json.tool
```

期望：200 响应；再 GET `display_name` 已更新为 "Moonshot AI"。

### 步骤 6：删除

```bash
curl -s -X DELETE http://127.0.0.1:2024/admin/models/moonshot | python3 -m json.tool
curl -s http://127.0.0.1:2024/admin/models/moonshot -i | head -1
```

期望：第一条 200 `{deleted: true}`；第二条 404。

### 步骤 7:回归 001/002

停止按钮、刷新恢复历史、config.toml 模型加载都正常。

## 4. 常见问题

| 现象 | 怎么办 |
|---|---|
| 启动报 `Object 'app' in module ... is not a Starlette` | `admin_app.py` 里没有名为 `app` 的 Starlette 实例 |
| 404 同路径 langgraph 内置路由 | 路由前缀用 `/admin`，避开 `/assistants` 等 |
| 改完接口但重启 scode 后配置丢了 | 看 `conf/config.toml.tmp` 是否还在；`os.replace` 应该是原子的，丢的概率极低 |
| `api_key_masked` 总是 `****` | 实际 key 长度 ≤4；改用真 key 测试 |
| POST 返回 400 ConfigError | 按 error 文案改 body |

---

## 5. 已验证的事实

- `langgraph.json` 支持 `http.app` 字段（值格式 `"path:variable"`），由 `langgraph_api/api/__init__.py:226 load_custom_app()` 解析；变量必须是 `Starlette` 或 `FastAPI` 实例（源码 `api/__init__.py:251`、`server.py:191`）
- user_router 成为顶层 app，其 routes 与 langgraph 内置 routes 混在同一棵路由树；内置路径有 `/ok`、`/assistants/*`、`/threads/*`、`/runs/*`、`/store/*`、`/cron/*`、`/info`、`/metrics`、`/openapi.json`、`/docs`、`/redoc`
- `http.app` 在 langgraph_cli 的 `--config` 加载流程中的处理位置：`config.HTTP_CONFIG.get("app")`（`api/__init__.py:277`）
- starlette 通过 langgraph_api 间接安装，无需在 pyproject 显式声明

## 6. 待核实

- `tomli-w` 的输出格式（缩进、字符串引号风格）是否便于人工查看/编辑；不便捷也无妨，但需确认能正确 round-trip（写后读不能丢信息）
- 模型构建是在 `agent.py` 导入时执行一次， grâce 002 已确认；改完 toml 调 `build_model(load_config())` 拿新实例的可行性，写实施时实测