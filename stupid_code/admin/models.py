"""模型 CRUD 的请求处理函数。

每个函数接收 Starlette Request，返回 Response。
配置层的 ConfigError 在处理器内捕获并转成 400；模型不存在（NotFoundError）
转成 404。

注意：langgraph dev 装了 blockbuster，async 函数里直接调同步阻塞 IO
（os.mkdir / open / os.replace 等）会被拦截报 500。
本模块所有同步 IO（load_config / save_config）都用 asyncio.to_thread 包到线程里跑。

接口细粒度是「模型」——每个模型自带全部连接字段（protocol/provider/base_url/api_key）。
toml 内部按 provider 分组只是为了避免重复写 key/base_url，接口层不暴露该结构。
"""

from __future__ import annotations

import asyncio
from collections.abc import Callable
from typing import Any, TypeVar

from starlette.requests import Request
from starlette.responses import JSONResponse

from stupid_code.config.model import (
    ConfigError,
    NotFoundError,
    add_model,
    delete_model,
    get_model,
    list_models,
    load_config,
    save_config,
    update_model,
)

T = TypeVar("T")


async def _mutate(
    fn: Callable[[dict[str, Any]], T],
) -> tuple[T | None, ConfigError | None]:
    """加载配置 → 调 fn → 存回配置。

    fn 抛 ConfigError 时**不落盘**（写坏了就别动用户的配置文件），错误原样
    交给调用方转 400 / 404。

    `load_config` 的错误故意不在这里拦——配置文件缺失/损坏不是「请求写错了」，
    跟原来一样冒上去变成 500。
    """
    config = await asyncio.to_thread(load_config)
    try:
        result = fn(config)
    except ConfigError as exc:
        return None, exc
    await asyncio.to_thread(save_config, config)
    return result, None


async def _read_json(request: Request) -> tuple[Any, JSONResponse | None]:
    """读 JSON 请求体。解析失败返回 (None, 400 响应)。

    **不校验 body 是不是对象**——那件事交给配置层（`add_model` / `update_model`
    自己会抛 ConfigError），顺序跟原来一样：先查模型在不在，再看 body 合不合法。
    """
    try:
        return await request.json(), None
    except Exception as exc:  # noqa: BLE001 —— 任何解析失败都是「body 不是 JSON」
        return None, JSONResponse(
            {"error": f"请求体不是合法 JSON：{exc}"}, status_code=400
        )


def _status_of(err: ConfigError) -> int:
    """配置层报错的 HTTP 状态码：模型不存在是 404，其余是 400。"""
    return 404 if isinstance(err, NotFoundError) else 400


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
        return JSONResponse({"error": str(exc)}, status_code=_status_of(exc))
    return JSONResponse(item)


async def create(request: Request) -> JSONResponse:
    """POST /admin/models — 新增模型。
    body 必含 name/protocol/provider/api_key，base_url / display_name 可选。
    若 provider 不存在则自动创建供应商段。
    """
    body, err = await _read_json(request)
    if err is not None:
        return err

    model_id, err = await _mutate(lambda config: add_model(config, body))
    if err is not None:
        return JSONResponse({"error": str(err)}, status_code=_status_of(err))
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
    body, err = await _read_json(request)
    if err is not None:
        return err

    co_affected, err = await _mutate(
        lambda config: update_model(config, model_id, body)
    )
    if err is not None:
        return JSONResponse({"error": str(err)}, status_code=_status_of(err))
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

    remaining, err = await _mutate(lambda config: delete_model(config, model_id))
    if err is not None:
        return JSONResponse({"error": str(err)}, status_code=_status_of(err))
    return JSONResponse({
        "id": model_id,
        "deleted": True,
        "remaining_peers": remaining,
        "restart_required": True,
    })
