"""模型 CRUD 的请求处理函数。

每个函数接收 Starlette Request，返回 Response。
配置层的 ConfigError 在处理器内捕获并转成 400。

注意：langgraph dev 装了 blockbuster，async 函数里直接调同步阻塞 IO
（os.mkdir / open / os.replace 等）会被拦截报 500。
本模块所有同步 IO（load_config / save_config）都用 asyncio.to_thread 包到线程里跑。

接口细粒度是「模型」——每个模型自带全部连接字段（protocol/provider/base_url/api_key）。
toml 内部按 provider 分组只是为了避免重复写 key/base_url，接口层不暴露该结构。
"""

from __future__ import annotations

import asyncio

from starlette.requests import Request
from starlette.responses import JSONResponse

from stupid_code.config.model import (
    ConfigError,
    add_model,
    delete_model,
    get_model,
    list_models,
    load_config,
    save_config,
    update_model,
)


async def list_all(request: Request) -> JSONResponse:
    """GET /admin/models — 列出全部模型（扁平数组），key 默认脱敏"""
    reveal = request.query_params.get("reveal") == "true"
    config = await asyncio.to_thread(load_config)
    items = list_models(config, reveal=reveal)
    return JSONResponse({
        "default": config.get("models", {}).get("default"),
        "recent": config.get("models", {}).get("recent"),
        "models": items,
        "restart_required": True,
    })


async def get_one(request: Request) -> JSONResponse:
    """GET /admin/models/{id} — 单个模型详情，id 格式 'provider:model'"""
    model_id = request.path_params["id"]
    reveal = request.query_params.get("reveal") == "true"
    config = await asyncio.to_thread(load_config)
    try:
        item = get_model(config, model_id, reveal=reveal)
    except ConfigError as exc:
        return JSONResponse({"error": str(exc)}, status_code=400)
    if item is None:
        return JSONResponse({"error": f"模型 {model_id!r} 不存在"}, status_code=404)
    return JSONResponse(item)


async def create(request: Request) -> JSONResponse:
    """POST /admin/models — 新增模型。
    body 必含 name/protocol/provider/api_key，base_url / display_name 可选。
    若 provider 不存在则自动创建供应商段。
    """
    try:
        body = await request.json()
    except Exception as exc:
        return JSONResponse({"error": f"请求体不是合法 JSON：{exc}"}, status_code=400)

    async def _do() -> tuple[int, str | None, str | None]:
        config = await asyncio.to_thread(load_config)
        try:
            model_id = add_model(config, body)
            await asyncio.to_thread(save_config, config)
        except ConfigError as exc:
            return 400, None, str(exc)
        return 201, model_id, None

    status, model_id, err = await _do()
    if status != 201:
        return JSONResponse({"error": err}, status_code=status)
    return JSONResponse(
        {"id": model_id, "created": True, "restart_required": True},
        status_code=201,
    )


async def update(request: Request) -> JSONResponse:
    """PUT /admin/models/{id} — 改模型属性。
    可改：protocol、base_url、api_key、display_name。
    model_name 自身不可改（要改请删后增）。
    返回 co_affected：受影响的其他同级模型 id 列表
    （toml 按 provider 分组，连接字段属于整个供应商段）。
    """
    model_id = request.path_params["id"]
    try:
        body = await request.json()
    except Exception as exc:
        return JSONResponse({"error": f"请求体不是合法 JSON：{exc}"}, status_code=400)

    async def _do() -> tuple[int, str | None, list[str] | None]:
        config = await asyncio.to_thread(load_config)
        try:
            ok, co_affected = update_model(config, model_id, body)
            if not ok:
                return 404, f"模型 {model_id!r} 不存在", None
            await asyncio.to_thread(save_config, config)
        except ConfigError as exc:
            return 400, str(exc), None
        return 200, None, co_affected

    status, err, co_affected = await _do()
    if status != 200:
        return JSONResponse({"error": err}, status_code=status)
    return JSONResponse({
        "id": model_id,
        "updated": True,
        "co_affected": co_affected,
        "restart_required": True,
    })


async def delete(request: Request) -> JSONResponse:
    """DELETE /admin/models/{id} — 删模型。
    若该供应商变空则自动删除整个供应商段，保持 toml 一致性。
    返回 remaining：剩余同级模型 id 列表。
    """
    model_id = request.path_params["id"]

    async def _do() -> tuple[int, str | None, list[str] | None]:
        config = await asyncio.to_thread(load_config)
        try:
            ok, remaining = delete_model(config, model_id)
            if not ok:
                return 404, f"模型 {model_id!r} 不存在", None
            await asyncio.to_thread(save_config, config)
        except ConfigError as exc:
            return 400, str(exc), None
        return 200, None, remaining

    status, err, remaining = await _do()
    if status != 200:
        return JSONResponse({"error": err}, status_code=status)
    return JSONResponse({
        "id": model_id,
        "deleted": True,
        "remaining_peers": remaining,
        "restart_required": True,
    })
