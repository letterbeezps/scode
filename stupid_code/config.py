"""config.toml 的加载、校验与模型构建。

配置文件在项目根的 conf/config.toml（与代码分离，不入库），
格式见同目录的 config.example.toml。
模型选择顺序：[models].default → [models].recent → 报错。
协议只支持 anthropic / openai，第三方端点通过 base_url 接入。
模型在 agent.py 导入时构建一次，改配置需重启服务。
"""

import tomllib
from pathlib import Path
from typing import Any

from langchain.chat_models import BaseChatModel, init_chat_model

SUPPORTED_PROTOCOLS = ("anthropic", "openai")
# 本文件位于 stupid_code/，上一级即项目根，配置统一放根下 conf/ 目录
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