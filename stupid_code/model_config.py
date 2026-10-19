"""config.toml 的加载、校验与模型构建。

配置文件在项目根的 conf/config.toml（与代码分离，不入库），
格式见同目录的 config.example.toml。
模型选择顺序：[models].default → [models].recent → 报错。
协议只支持 anthropic / openai，第三方端点通过 base_url 接入。
模型在 agent.py 导入时构建一次，改配置需重启服务。
"""

import os
import tomllib
import tomli_w
from pathlib import Path
from typing import Any

from langchain.chat_models import BaseChatModel, init_chat_model

SUPPORTED_PROTOCOLS = ("anthropic", "openai")
# 本文件位于 stupid_code/，上一级即项目根，配置统一放根下 conf/ 目录
# （model_config.py 若被挪进子目录，这里要改成 .parents[1]）
_CONF_DIR = Path(__file__).resolve().parent.parent / "conf"
_CONFIG_FILENAME = "config.toml"


class ConfigError(Exception):
    """配置缺失或不合法。message 面向用户，可直接展示。"""


def config_path() -> Path:
    return _CONF_DIR / _CONFIG_FILENAME


def load_config() -> dict[str, Any]:
    path = config_path()
    if not path.is_file():
        raise ConfigError(
            f"找不到 {path}。请复制 conf/config.example.toml 为 conf/config.toml 并填入供应商信息。"
        )
    with path.open("rb") as fp:
        try:
            return tomllib.load(fp)
        except tomllib.TOMLDecodeError as exc:
            raise ConfigError(f"config.toml 语法错误：{exc}") from exc


def _pick_model_spec(models: dict[str, Any]) -> str:
    """default 优先；缺省回退 recent（recent 后续由模型切换功能写回，本期只读）。"""
    spec = models.get("default") or models.get("recent")
    if not isinstance(spec, str) or ":" not in spec:
        raise ConfigError(
            '[models] 里 default 与 recent 至少设置一个，'
            '格式为 "供应商名:模型名"，如 "minimax:MiniMax-M3"'
        )
    return spec


def _require_api_key(provider_name: str, provider: dict[str, Any]) -> str:
    """api_key 必填、明文写在 conf/config.toml（该文件已 gitignore，不入库）。

    必填是为了 fail-fast：缺 key 在配置阶段就报错，
    而不是等到首轮对话收到 401 才发现。本项目不再使用 .env。
    """
    api_key = provider.get("api_key")
    if not isinstance(api_key, str) or not api_key:
        raise ConfigError(
            f"供应商 {provider_name} 缺少 api_key，请在 [models.providers.{provider_name}] 段明文填写"
        )
    return api_key


def build_model(config: dict[str, Any]) -> BaseChatModel:
    models = config.get("models")
    if not isinstance(models, dict):
        raise ConfigError("config.toml 缺少 [models] 段")

    spec = _pick_model_spec(models)
    provider_name, _, model_id = spec.partition(":")
    provider_name = provider_name.strip()
    model_id = model_id.strip()
    if not provider_name or not model_id:
        raise ConfigError(f'模型标识 {spec!r} 不合法，应为 "供应商名:模型名"')

    providers = models.get("providers")
    if not isinstance(providers, dict) or not providers:
        raise ConfigError("config.toml 缺少 [models.providers.<供应商名>] 段")
    provider = providers.get(provider_name)
    if not isinstance(provider, dict):
        raise ConfigError(
            f"模型 {spec} 引用的供应商 {provider_name!r} 未配置，"
            f"需要 [models.providers.{provider_name}] 段"
        )

    protocol = provider.get("protocol")
    if protocol not in SUPPORTED_PROTOCOLS:
        raise ConfigError(
            f"供应商 {provider_name} 的 protocol 只支持 "
            f"{' / '.join(SUPPORTED_PROTOCOLS)}，当前为 {protocol!r}"
        )

    allowed = provider.get("models")
    if not isinstance(allowed, list) or not allowed:
        raise ConfigError(f"供应商 {provider_name} 的 models 列表缺失或为空")
    if model_id not in allowed:
        raise ConfigError(
            f"模型 {model_id!r} 不在供应商 {provider_name} 的 models 列表里，"
            f"可用：{'、'.join(str(m) for m in allowed)}"
        )

    kwargs: dict[str, Any] = {}
    base_url = provider.get("base_url")
    if base_url:
        kwargs["base_url"] = base_url
    kwargs["api_key"] = _require_api_key(provider_name, provider)

    # init_chat_model 按 protocol 懒加载对应集成包：
    # anthropic → langchain-anthropic，openai → langchain-openai
    return init_chat_model(model_id, model_provider=protocol, **kwargs)


def load_model() -> BaseChatModel:
    return build_model(load_config())


def save_config(config: dict[str, Any]) -> None:
    """原子写回 conf/config.toml。先写临时文件再 os.replace，
    避免半截写入导致下一次启动解析失败。注释会丢失（tomli_w 不保留注释）。"""
    path = config_path()
    path.parent.mkdir(parents=True, exist_ok=True)
    tmp = path.with_suffix(".toml.tmp")
    with tmp.open("wb") as fp:
        tomli_w.dump(config, fp)
    os.replace(tmp, path)


def _mask(key: str | None) -> str | None:
    """api_key 脱敏：长度 ≤4 显示 ****，否则显示末 4 位。"""
    if not key:
        return None
    if len(key) <= 4:
        return "****"
    return f"***{key[-4:]}"


def _parse_model_id(model_id: str) -> tuple[str, str]:
    """解析 'provider:model' 为 (provider, model_name)。
    与 conf/config.toml 里 [models].default = "minimax:MiniMax-M3" 的格式对齐。"""
    if ":" not in model_id:
        raise ConfigError(f'模型 ID {model_id!r} 不合法，应为 "供应商名:模型名"')
    provider, _, model_name = model_id.partition(":")
    provider = provider.strip()
    model_name = model_name.strip()
    if not provider or not model_name:
        raise ConfigError(f'模型 ID {model_id!r} 不合法，应为 "供应商名:模型名"')
    return provider, model_name


def list_models(config: dict[str, Any], reveal: bool = False) -> list[dict[str, Any]]:
    """扁平化返回所有模型，每个模型自带全部连接字段。
    toml 内部按 provider 分组避免 key/base_url 重复，接口层不暴露该结构。"""
    providers = config.get("models", {}).get("providers", {})
    out = []
    for prov_name, p in providers.items():
        for model_name in p.get("models", []):
            out.append({
                "id": f"{prov_name}:{model_name}",
                "name": model_name,
                "provider": prov_name,
                "protocol": p.get("protocol"),
                "display_name": p.get("display_name"),
                "base_url": p.get("base_url"),
                "api_key": p.get("api_key") if reveal else _mask(p.get("api_key")),
            })
    return out


def get_model(config: dict[str, Any], model_id: str, reveal: bool = False) -> dict[str, Any] | None:
    """按 'provider:model' 取单个模型详情。不存在返回 None。"""
    provider_name, model_name = _parse_model_id(model_id)
    p = config.get("models", {}).get("providers", {}).get(provider_name)
    if p is None or model_name not in p.get("models", []):
        return None
    return {
        "id": model_id,
        "name": model_name,
        "provider": provider_name,
        "protocol": p.get("protocol"),
        "display_name": p.get("display_name"),
        "base_url": p.get("base_url"),
        "api_key": p.get("api_key") if reveal else _mask(p.get("api_key")),
    }


def add_model(config: dict[str, Any], body: dict[str, Any]) -> str:
    """新增模型。body 必含 name/protocol/provider/base_url/api_key，display_name 可选。
    返回新建模型 id（'provider:model'）。

    语义：
    - provider 不存在 → 创建新段，body 提供的连接字段全部落进去
    - provider 已存在 → 把 name 加到该 provider 的 models[] 列表
      连接字段（protocol/base_url）与现有不一致时报 ConfigError，避免静默覆盖；
      要改用 PUT。同名模型已存在报 ConfigError。
    """
    if not isinstance(body, dict):
        raise ConfigError("请求体必须是 JSON 对象")

    name = body.get("name")
    if not isinstance(name, str) or not name:
        raise ConfigError("name 必填（模型名）")

    protocol = body.get("protocol")
    if protocol not in SUPPORTED_PROTOCOLS:
        raise ConfigError(
            f"protocol 只支持 {' / '.join(SUPPORTED_PROTOCOLS)}，当前为 {protocol!r}"
        )

    provider_name = body.get("provider")
    if not isinstance(provider_name, str) or not provider_name:
        raise ConfigError("provider 必填（供应商名）")

    base_url = body.get("base_url")
    api_key = body.get("api_key")
    if not isinstance(api_key, str) or not api_key:
        raise ConfigError(f"api_key 必填（模型 {name}）")

    providers = config.setdefault("models", {}).setdefault("providers", {})
    existing = providers.get(provider_name)

    if existing is None:
        # 新建供应商段
        providers[provider_name] = {
            "protocol": protocol,
            "display_name": body.get("display_name"),
            "base_url": base_url,
            "api_key": api_key,
            "models": [name],
        }
        return f"{provider_name}:{name}"

    # 已存在的供应商段：连接字段必须一致
    if existing.get("protocol") != protocol:
        raise ConfigError(
            f"供应商 {provider_name!r} 已存在且 protocol={existing.get('protocol')!r}，"
            f"与请求 {protocol!r} 不一致"
        )
    if base_url and existing.get("base_url") and base_url != existing.get("base_url"):
        raise ConfigError(
            f"供应商 {provider_name!r} 已存在且 base_url={existing.get('base_url')!r}，"
            f"与请求 {base_url!r} 不一致（要改用 PUT）"
        )
    models_list = existing.setdefault("models", [])
    if name in models_list:
        raise ConfigError(f"模型 {provider_name}:{name} 已存在")
    models_list.append(name)
    return f"{provider_name}:{name}"


def update_model(
    config: dict[str, Any], model_id: str, body: dict[str, Any]
) -> tuple[bool, list[str]]:
    """改模型属性。可改：protocol、base_url、api_key、display_name。
    model_name 自身不可改（要改请删后增）。

    返回 (是否成功, 受影响的其他同级模型 id 列表)。
    注意：toml 按 provider 分组，这些字段属于整个供应商段，所以会
    影响该供应商下所有同级模型——co_affected 列出它们让用户知情。
    """
    provider_name, model_name = _parse_model_id(model_id)
    providers = config.get("models", {}).get("providers", {})
    p = providers.get(provider_name)
    if p is None or model_name not in p.get("models", []):
        return False, []

    if not isinstance(body, dict):
        raise ConfigError("请求体必须是 JSON 对象")

    if "protocol" in body:
        if body["protocol"] not in SUPPORTED_PROTOCOLS:
            raise ConfigError(
                f"protocol 只支持 {' / '.join(SUPPORTED_PROTOCOLS)}，当前为 {body['protocol']!r}"
            )
        p["protocol"] = body["protocol"]
    if "base_url" in body:
        p["base_url"] = body["base_url"]
    if "api_key" in body:
        if not isinstance(body["api_key"], str) or not body["api_key"]:
            raise ConfigError("api_key 不能为空")
        p["api_key"] = body["api_key"]
    if "display_name" in body:
        p["display_name"] = body["display_name"]

    co_affected = [f"{provider_name}:{m}" for m in p.get("models", []) if m != model_name]
    return True, co_affected


def delete_model(config: dict[str, Any], model_id: str) -> tuple[bool, list[str]]:
    """删模型。返回 (是否删除, 剩余同级模型 id 列表)。

    若删除后该供应商 models[] 为空，自动删除整个供应商段，保持 toml 一致性。
    """
    provider_name, model_name = _parse_model_id(model_id)
    providers = config.get("models", {}).get("providers", {})
    p = providers.get(provider_name)
    if p is None:
        return False, []
    models_list = p.get("models", [])
    if model_name not in models_list:
        return False, []
    models_list.remove(model_name)
    co_remaining = [f"{provider_name}:{m}" for m in models_list]
    if not models_list:
        # 该供应商段已空，自动清理
        providers.pop(provider_name, None)
        co_remaining = []
    return True, co_remaining