"""conf/mcp.json 的加载、校验与 MCP 连接参数构建。

配置文件在项目根的 conf/mcp.json（与代码分离），格式跟 Claude Code / Cursor
那一套一致：

```json
{
  "mcpServers": {
    "docs-langchain": {"type": "http", "url": "https://docs.langchain.com/mcp"},
    "local-fs": {
      "type": "stdio",
      "command": "npx",
      "args": ["-y", "@modelcontextprotocol/server-filesystem", "."]
    }
  }
}
```

## 两种主要传输

- **http**（streamable-http）：`url` + 可选 `headers` / `timeout` /
  `sse_read_timeout` / `terminate_on_close`
- **stdio**：`command` + `args` + 可选 `env` / `cwd` / `encoding` /
  `encoding_error_handler`——启动一个子进程，用它的 stdin/stdout 说 MCP 协议

另外认 `sse` 和 `websocket`（adapter 原生支持，可选字段更少）。

## 只收 JSON 能表达的字段

adapter 的连接参数里还有 `auth`（`httpx.Auth` 对象）、`httpx_client_factory`
（可调用对象）、`session_kwargs`（里面通常是回调函数）——这些是 Python 对象，
JSON 表达不了，所以配置层不认。需要 OAuth / 自定义 httpx 客户端时得改代码，
不是改 `conf/mcp.json`。

## 字段校验交给 pydantic

项目本来就依赖 pydantic，用它声明每种传输能有哪些字段、字段是什么类型：

- `extra="forbid"` → 写错的字段当场报出来（`"type": "stio"` 这种手误会
  当场被指出来，而不是悄悄退化成「什么都没配」）
- 类型不对也当场报，不用等到模型调用工具时才炸

每个模型的字段集照着 adapter 的连接参数字典写，但**只收 JSON 能表达的
那些**（见上一节）；多出来的只有 `description`——那是给界面看的元信息
（Claude Desktop / VS Code 那种配置里常见），agent 用不上，认了但忽略。

## 密钥不写死在文件里

连接参数里的**任何字符串**都可以写 `${VAR}`——`url`、`command`、`args`、
`cwd`、`env` 的值、`headers` 的值，加载时统一从**进程环境**展开：

```json
{"type": "http", "url": "https://example.com/mcp",
 "headers": {"Authorization": "Bearer ${MCP_TOKEN}"}}
```

变量不存在时**原样保留** `${VAR}`——宁可可读，也不要悄悄把一段占位符变成
空字符串（`Authorization` 变成空值，报错的地方很难找）。

## 校验策略

文件不存在 = 不配任何 MCP 服务器（跟 conf/subagents.toml 一个处理方式）。
语法错误、顶层结构不对一律抛 ConfigError。

**单个服务器配错只跳它自己**，其余照常——早先是一把梭，一个服务器写错
整个 MCP 都没了（连能用的那几个也一起废掉，界面上还看不出来）。
跳过的那个会在日志里报一句为什么。
"""

from __future__ import annotations

import json
import logging
import os
import re
from pathlib import Path
from typing import Any, Literal, cast

from pydantic import BaseModel, ConfigDict, Field, ValidationError, field_validator

from stupid_code.config.model import ConfigError

logger = logging.getLogger(__name__)

# 本文件位于 stupid_code/config/，往上两级才是项目根，配置统一放根下 conf/ 目录
# （再往下挪目录时要同步改这里的层数）
_CONF_DIR = Path(__file__).resolve().parents[2] / "conf"
_MCP_FILENAME = "mcp.json"

# 用户写的传输名 → langchain-mcp-adapters 认识的 transport 取值
_TRANSPORT_ALIASES = {
    "http": "http",
    "streamable_http": "http",
    "streamable-http": "http",
    "sse": "sse",
    "stdio": "stdio",
    "websocket": "websocket",
}

_DEFAULT_HTTP_TIMEOUT = 8.0
"""http / sse 的连接超时默认值（秒）。用户没写 `timeout` 时用这个。

它对应 httpx 客户端的 connect / write / pool 预算（adapter 会拼成
`httpx.Timeout(timeout, read=sse_read_timeout)`），**不是启动预算**——
启动的总限时由 `graph/mcp.py` 的 `_LOAD_TIMEOUT` 用 `asyncio.wait_for` 保证。
本项目每个服务器只建一条长会话，所以这个值作用于**建立会话 / 会话断开后重连**
时的连接预算；读取超时（`sse_read_timeout`）另算。

比 adapter 的默认 30 秒短：8 秒足够完成 TLS 握手，又不至于让一个挂死的
公网端点在每次建会话 / 重连时卡太久。
"""

_ENV_REF = re.compile(r"\$\{([^}]+)\}")

_ERROR_HINTS = {
    "missing": "缺少这个字段",
    "extra_forbidden": "不认识的字段",
    "string_type": "必须是字符串",
    "list_type": "必须是数组",
    "dict_type": "必须是对象",
    "float_type": "必须是数字",
    "float_parsing": "必须是数字",
    "bool_type": "必须是布尔值",
    "bool_parsing": "必须是布尔值",
    "too_short": "不能为空",
    "string_too_short": "不能为空",
}
"""pydantic 的错误类型 → 中文说法。"""


def _check_http_url(value: str) -> str:
    """http / sse 的地址必须带 http(s) 协议头。"""
    if not value.startswith(("http://", "https://")):
        raise ValueError(f"url 必须以 http:// 或 https:// 开头，当前是 {value!r}")
    return value


def _check_ws_url(value: str) -> str:
    """websocket 的地址必须带 ws 协议头。"""
    if not value.startswith(("ws://", "wss://")):
        raise ValueError(f"url 必须以 ws:// 或 wss:// 开头，当前是 {value!r}")
    return value


def _check_seconds(value: Any) -> Any:
    """超时必须是「秒数」。

    pydantic 的宽松模式会把 `true` 当成 1.0、把 `"8"` 当成 8.0。
    两种都不是用户想写的意思（`timeout: true` 会变成 1 秒超时），
    所以在转换之前就拦下来。
    """
    if isinstance(value, bool) or not isinstance(value, (int, float)):
        raise ValueError("必须是数字（秒）")
    return value


class _UrlServer(BaseModel):
    """http / sse 共同的字段。

    两者只有 `terminate_on_close` 的差别（http 有，sse 没有），所以共用一份
    字段声明，差异交给子类。
    """

    model_config = ConfigDict(extra="forbid", str_strip_whitespace=True)

    url: str = Field(min_length=1)
    headers: dict[str, str] | None = None
    timeout: float | None = None
    sse_read_timeout: float | None = None
    description: str | None = None

    _check_url = field_validator("url")(_check_http_url)
    _check_timeout = field_validator("timeout", "sse_read_timeout", mode="before")(
        _check_seconds
    )


class _HttpServer(_UrlServer):
    """http（streamable-http）传输。"""

    terminate_on_close: bool | None = None


class _SseServer(_UrlServer):
    """sse 传输。比 http 少一个 terminate_on_close。"""


class _StdioServer(BaseModel):
    """stdio 传输：启动一个子进程，用 stdin/stdout 说 MCP 协议。"""

    model_config = ConfigDict(extra="forbid", str_strip_whitespace=True)

    command: str = Field(min_length=1)
    args: list[str] = Field(default_factory=list)
    env: dict[str, str] | None = None
    cwd: str | None = Field(default=None, min_length=1)
    encoding: str | None = Field(default=None, min_length=1)
    encoding_error_handler: Literal["strict", "ignore", "replace"] | None = None
    description: str | None = None


class _WebsocketServer(BaseModel):
    """websocket 传输。adapter 只认 url。"""

    model_config = ConfigDict(extra="forbid", str_strip_whitespace=True)

    url: str = Field(min_length=1)
    description: str | None = None

    _check_url = field_validator("url")(_check_ws_url)


_MODELS: dict[str, type[BaseModel]] = {
    "stdio": _StdioServer,
    "http": _HttpServer,
    "sse": _SseServer,
    "websocket": _WebsocketServer,
}


def mcp_path() -> Path:
    """conf/mcp.json 的路径。"""
    return _CONF_DIR / _MCP_FILENAME


def load_mcp_config() -> dict[str, Any]:
    """读 conf/mcp.json 的原始内容。文件不存在返回空 dict（不配任何 MCP 服务器）。"""
    path = mcp_path()
    if not path.is_file():
        return {}
    try:
        raw = path.read_text(encoding="utf-8")
    except OSError as exc:
        raise ConfigError(f"读取 {path} 失败：{exc}") from exc
    try:
        data = json.loads(raw)
    except json.JSONDecodeError as exc:
        raise ConfigError(
            f"mcp.json 语法错误（第 {exc.lineno} 行第 {exc.colno} 列）：{exc.msg}"
        ) from exc
    if not isinstance(data, dict):
        raise ConfigError("mcp.json 顶层必须是对象")
    return data


def build_connections(config: dict[str, Any]) -> dict[str, dict[str, Any]]:
    """把 mcp.json 的内容转成 MultiServerMCPClient 认识的连接参数。

    返回 {服务器名: 连接参数}。连接参数的形状由 langchain-mcp-adapters 规定
    （见它的 sessions.py）：stdio 要 command + args，http / sse 要 url。

    **逐个服务器校验**：某一个写错了只跳它自己，其余照常。
    早先是一把梭——一个服务器配错，整个 MCP 都没了（连能用的那几个也一起废掉），
    界面上还看不出来。
    """
    if not config:
        return {}

    servers = config.get("mcpServers")
    if servers is None:
        raise ConfigError('mcp.json 缺少 "mcpServers" 段')
    if not isinstance(servers, dict):
        raise ConfigError('mcp.json 的 "mcpServers" 必须是对象')

    connections: dict[str, dict[str, Any]] = {}
    for name, spec in servers.items():
        try:
            connections[name] = _build_connection(name, spec)
        except ConfigError as exc:
            logger.warning("MCP 服务器 %r 配置不合法，跳过它：%s", name, exc)
    return connections


def load_connections() -> dict[str, dict[str, Any]]:
    """读文件 + 校验，一步到位拿到连接参数。"""
    return build_connections(load_mcp_config())


def _build_connection(name: str, spec: Any) -> dict[str, Any]:
    """校验并转换单个服务器配置。"""
    where = f"mcp.json 的服务器 {name!r}"
    if not isinstance(spec, dict):
        raise ConfigError(f"{where} 必须是对象")

    # 先展开 ${VAR} 再做传输判断和 pydantic 校验：这样 type / url / command /
    # cwd 里的占位符也能用，而且校验看到的是真实值（缺变量时原样保留，
    # 报错信息里能认出来）
    expanded = _expand_env_deep(spec)
    transport = _resolve_transport(expanded, where)
    payload = {
        k: v for k, v in expanded.items() if k not in ("type", "transport")
    }
    model = _validate(_MODELS[transport], payload, where)

    if transport == "stdio":
        return _stdio_connection(model)
    if transport == "websocket":
        return _websocket_connection(model)
    return _http_connection(model, transport)


def _resolve_transport(spec: dict[str, Any], where: str) -> str:
    """定传输方式：先看 type / transport，没写就按字段推断。"""
    declared = [spec[key] for key in ("type", "transport") if spec.get(key) is not None]

    if not declared:
        if "command" in spec:
            return "stdio"
        if "url" in spec:
            return "http"
        raise ConfigError(
            f"{where} 没有 type，既没有 command 也没有 url，没法判断传输方式"
        )

    resolved: list[str] = []
    for raw in declared:
        if not isinstance(raw, str):
            raise ConfigError(f"{where} 的 type / transport 必须是字符串")
        key = raw.strip().lower()
        if key not in _TRANSPORT_ALIASES:
            raise ConfigError(
                f"{where} 的 type {raw!r} 不支持，只支持 "
                f"{' / '.join(sorted(_TRANSPORT_ALIASES))}"
            )
        resolved.append(_TRANSPORT_ALIASES[key])

    if len(set(resolved)) > 1:
        raise ConfigError(
            f"{where} 的 type 与 transport 指向不同的传输方式：{'、'.join(resolved)}"
        )
    return resolved[0]


def _validate(
    model: type[BaseModel], payload: dict[str, Any], where: str
) -> BaseModel:
    """用 pydantic 校验字段，把错误翻译成人话。"""
    try:
        return model.model_validate(payload)
    except ValidationError as exc:
        raise ConfigError(f"{where} 配置不合法：{_format_errors(exc)}") from exc


def _format_errors(exc: ValidationError) -> str:
    """把 pydantic 的错误列表拼成一句中文。"""
    parts: list[str] = []
    for err in exc.errors():
        if err["type"] == "value_error":
            # 自己抛的 ValueError，消息本身已经是完整的人话
            # （pydantic 会在前面加一句 "Value error, "，去掉它）
            original = err.get("ctx", {}).get("error")
            message = str(original) if original is not None else str(err["msg"])
            parts.append(message.removeprefix("Value error, "))
            continue
        field = "、".join(str(x) for x in err["loc"]) or "整个配置"
        parts.append(f"{field}：{_ERROR_HINTS.get(err['type'], err['msg'])}")
    return "；".join(parts)


def _stdio_connection(model: BaseModel) -> dict[str, Any]:
    """stdio 连接参数。"""
    spec = cast(_StdioServer, model)
    connection: dict[str, Any] = {
        "transport": "stdio",
        "command": spec.command,
        "args": list(spec.args),
    }
    if spec.env is not None:
        connection["env"] = dict(spec.env)
    if spec.cwd is not None:
        connection["cwd"] = spec.cwd
    if spec.encoding is not None:
        connection["encoding"] = spec.encoding
    if spec.encoding_error_handler is not None:
        connection["encoding_error_handler"] = spec.encoding_error_handler
    return connection


def _http_connection(model: BaseModel, transport: str) -> dict[str, Any]:
    """http / sse 连接参数。"""
    spec = cast(_HttpServer | _SseServer, model)
    connection: dict[str, Any] = {"transport": transport, "url": spec.url}

    if spec.headers is not None:
        connection["headers"] = dict(spec.headers)
    if spec.timeout is not None:
        connection["timeout"] = float(spec.timeout)
    if spec.sse_read_timeout is not None:
        connection["sse_read_timeout"] = float(spec.sse_read_timeout)
    if transport == "http" and spec.terminate_on_close is not None:
        connection["terminate_on_close"] = spec.terminate_on_close

    # 连接超时的默认值：建图时加载 MCP 服务器是同步阻塞的，
    # adapter 的默认 30 秒太宽——一个连不上的服务器能把后端启动拖过
    # launcher 的 60 秒就绪超时。读取超时（sse_read_timeout）不动，
    # 那关系到「服务器多久才回话」，跟连得上连不上是两回事。
    connection.setdefault("timeout", _DEFAULT_HTTP_TIMEOUT)
    return connection


def _websocket_connection(model: BaseModel) -> dict[str, Any]:
    """websocket 连接参数。adapter 的 WebsocketConnection 只认 url。"""
    spec = cast(_WebsocketServer, model)
    return {"transport": "websocket", "url": spec.url}


def _expand_env_deep(value: Any) -> Any:
    """递归展开值里的 `${VAR}`（字典的键不动）。"""
    if isinstance(value, str):
        return _expand_env_refs(value)
    if isinstance(value, list):
        return [_expand_env_deep(item) for item in value]
    if isinstance(value, dict):
        return {key: _expand_env_deep(item) for key, item in value.items()}
    return value


def _expand_env_refs(value: str) -> str:
    """把 ${VAR} 换成进程环境里的值。

    变量不存在时**原样保留** `${VAR}`：宁可留个能看懂的占位符，
    也不要悄悄把它变成空字符串（报错的地方会很难找）。
    """
    return _ENV_REF.sub(lambda m: os.environ.get(m.group(1), m.group(0)), value)
