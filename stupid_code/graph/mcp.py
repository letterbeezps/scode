"""MCP 工具的加载：把 conf/mcp.json 里配的服务器变成 agent 能用的工具。

## 思路：协议交给 SDK，只补 SDK 不管的两件事

MCP 协议本身一行都不手写：

- `langchain-mcp-adapters` 的 `MultiServerMCPClient` 负责连服务器、取工具清单、
  把 MCP 工具转成 LangChain 工具。http / sse / stdio / websocket 四种传输都支持，
  我们只是把 `conf/mcp.json` 的内容翻译成它要的连接参数字典。
- `mcp`（官方 Python SDK）是 adapter 的底层依赖——stdio 子进程的管道、
  streamable-http 的握手、会话初始化都在它那里。

所以我们只做两件 SDK 不做的事：

**① 改名。** adapter 造的工具名就是服务器给的名字（`search` 之类）。两个服务器
撞名时，工具会在 `bind_tools` 阶段互相盖掉，模型最后只能调到一个。
项目约定用 `mcp__{服务器}__{工具}`（Claude Code 那套）；项目自带的参考资料
（`.agents/skills/ecosystem-primer/SKILL.md`）里也写着 agent 要认
`mcp__docs-langchain__*`——名字对不上，agent 会以为 MCP 没接上，转而自己拿
`execute` 去 curl MCP 端点（实测过，能 work 但绕一大圈）。

**② 兜住传输层失败，并在调用期重试一次。** adapter 把话说得很清楚：MCP 服务器
自己报的错（`isError=True`）会变成 `status="error"` 的 ToolMessage，但**传输层
失败一律往上抛**——一次网络抖动就会让整轮 run 变成 internal error
（实测 `anyio.BrokenResourceError`）。这里用 adapter 公开的 `tool_interceptors`
扩展点接住它：瞬时失败重试一次，仍失败就构造一个 `isError=True` 的
`CallToolResult`——adapter 会把它转成错误 ToolMessage，模型看得见「这个工具
没调通」，可以换个工具重试或者告诉用户原因，整轮对话不会崩。

## 代价：改 conf/mcp.json 要重启后端

工具在建图时取一次，交给 `create_deep_agent(tools=[...])`，于是它们就是
**普通工具**——注册在框架的 ToolNode 里，模型调用时框架自己执行。
不需要中间件：既不用在 `wrap_model_call` 里往 `request.tools` 注入，
也不用在 `wrap_tool_call` 里覆盖工具对象。

（另一条路是运行期注入：中间件在每次模型调用前把工具挂进 `request.tools`。
改配置不用重启，但要多一个中间件和 `wrap_model_call` / `wrap_tool_call`
两套钩子。框架留这条路（见 langchain/agents/factory.py 的
`DYNAMIC_TOOL_ERROR_TEMPLATE`），本项目选了简单的那条。）

## 只能异步调用

adapter 造的工具只填了 `coroutine`（`func` 是 None）。框架在 Agent Server 里
全程走异步执行路径，没有问题；但本地脚本的 `graph.invoke()` 是同步的，
调用 MCP 工具会抛 `NotImplementedError`——本项目没有同步调用场景，不额外补壳。
"""

from __future__ import annotations

import asyncio
import logging
import re
from collections.abc import Awaitable, Callable, Coroutine
from concurrent.futures import ThreadPoolExecutor
from typing import Any, TypeVar

import httpx
from langchain_core.tools import BaseTool
from langchain_mcp_adapters.client import MultiServerMCPClient
from langchain_mcp_adapters.interceptors import (
    MCPToolCallRequest,
    MCPToolCallResult,
)
from mcp.types import CallToolResult, TextContent

from stupid_code.config.mcp import load_connections
from stupid_code.config.model import ConfigError

logger = logging.getLogger(__name__)

T = TypeVar("T")

_MAX_TOOL_NAME = 64
"""工具名长度上限。Anthropic 那边是 64 个字符，超了直接被 API 拒。"""

_NAME_UNSAFE = re.compile(r"[^A-Za-z0-9_-]")

_LOAD_TIMEOUT = 12.0
"""单个服务器的**总**加载预算（秒），不是每次尝试的预算。

这个限时**真的会生效**：`asyncio.wait_for` 到点就把这次加载取消掉。
（早先的一版只在「两次重试之间」看一眼时间戳，一个挂死的服务器照样能把
后端启动拖过 launcher 的 60 秒就绪超时——那个限时是假的。）

服务器之间是**并行**加载的，所以总耗时约等于单个服务器的预算，
不是各服务器预算之和。
"""

_LOAD_RETRIES = 2
"""取工具连不上时的额外重试次数（不含第一次）。

公网 MCP 端点会抖：实测纯 httpx 打 docs.langchain.com/mcp 10 次失败 1 次
（CDN 在 TLS 握手阶段直接掐连接，报 `ConnectError(EndOfStream())`），跟 SDK 无关。
一次就放弃的话，这一轮对话里这个服务器的工具整个没了，用户会觉得
「配了 MCP 但好像没生效」。

重试只在**非超时**的失败上发生（退避 0.5 秒、1 秒），且总耗时仍受
`_LOAD_TIMEOUT` 约束。超时不重试：干等 12 秒等不到的东西，再等也等不到。
"""

_LOAD_RETRY_BACKOFF = 0.5
"""加载重试退避基数（秒）：第 n 次重试等 n × 这个值。"""

_CALL_RETRIES = 1
"""工具**调用**期的额外重试次数。

加载成功不等于每次调用都通——adapter 默认每次调用新建一个会话，同样的
网络抖动在调用期一样会遇到。一次就够：模型自己也会在收到错误后重试，
这里只是把「一次抖动就失败」的概率压低。
"""

_CALL_RETRY_BACKOFF = 0.3
"""调用重试退避（秒）。"""


def load_mcp_tools() -> list[BaseTool]:
    """把 conf/mcp.json 里配的 MCP 服务器变成工具列表。

    在 `graph/agent.py` 导入时调用一次——**改 conf/mcp.json 要重启后端**。

    什么都不该让后端起不来：
    - 配置文件不存在 → 空列表
    - 配置写错了 → 空列表（记一条 warning）
    - 服务器连不上 → 少它那几个工具，其余照常
    """
    try:
        connections = load_connections()
    except ConfigError as exc:
        logger.warning("MCP 配置不合法，不挂 MCP 工具：%s", exc)
        return []
    if not connections:
        return []

    # tool_interceptors 是 adapter 的公开扩展点：传输层失败在这里兜，
    # 不用去改每个工具对象的 coroutine / handle_tool_error
    client = MultiServerMCPClient(
        connections,
        tool_interceptors=[_retry_transport],
    )
    names = list(connections)
    try:
        loaded = _run_sync(lambda: _load_servers(client, names))
    except Exception as exc:  # noqa: BLE001 — 加载失败不该让后端起不来
        logger.warning("MCP 工具加载失败：%s", _describe(exc))
        return []

    tools: list[BaseTool] = []
    seen: dict[str, str] = {}
    for server, server_tools in loaded.items():
        for tool in server_tools:
            qualified = _qualified_name(server, tool.name)
            owner = seen.get(qualified)
            if owner is not None:
                # 字符替换和截断都可能把两个不同的名字撞成一个。撞名时
                # 后挂上去的会在 bind_tools 里盖掉前一个，这里直接跳过并报出来
                logger.warning(
                    "MCP 工具重名，跳过 %r：服务器 %r 与 %r 撞名",
                    qualified,
                    owner,
                    server,
                )
                continue
            seen[qualified] = server
            tool.name = qualified
            tools.append(tool)

    logger.info(
        "MCP 工具已加载：%d 个（来自 %d 个服务器）", len(tools), len(loaded)
    )
    return tools


async def _load_servers(
    client: MultiServerMCPClient,
    names: list[str],
) -> dict[str, list[BaseTool]]:
    """并行连所有服务器，逐个隔离：谁挂了就少谁的工具，其余照常。

    **为什么逐个调 `get_tools(server_name=...)`**：不带 server_name 的
    `get_tools()` 内部是 `asyncio.gather`，一个服务器失败整批都炸，
    而且抛出来的异常盖住了「是谁挂了」。

    **为什么并行**：服务器之间互不依赖，串行的话 N 个服务器要花 N 倍时间。
    """
    results = await asyncio.gather(
        *(_load_one(client, name) for name in names),
        return_exceptions=True,
    )
    loaded: dict[str, list[BaseTool]] = {}
    for name, result in zip(names, results):
        if isinstance(result, BaseException):
            logger.warning(
                "MCP 服务器 %r 连不上，跳过它的工具：%s",
                name,
                _describe(result),
            )
            continue
        loaded[name] = result
    return loaded


async def _load_one(client: MultiServerMCPClient, name: str) -> list[BaseTool]:
    """连一个 MCP 服务器取它的工具，失败重试几次。

    `_LOAD_TIMEOUT` 是**总预算**：每次尝试都用「剩余时间」当超时，
    所以退避、重试全都算在这 12 秒里。超时立刻放弃（重试不会让它变快）。
    """
    loop = asyncio.get_running_loop()
    deadline = loop.time() + _LOAD_TIMEOUT
    last_exc: Exception | None = None

    for attempt in range(_LOAD_RETRIES + 1):
        remaining = deadline - loop.time()
        if remaining <= 0:
            break
        try:
            return await asyncio.wait_for(
                client.get_tools(server_name=name),
                timeout=remaining,
            )
        except Exception as exc:  # noqa: BLE001 — 重试完再抛出去
            last_exc = exc
            if not _retryable(exc) or attempt >= _LOAD_RETRIES:
                break
            pause = min(
                _LOAD_RETRY_BACKOFF * (attempt + 1),
                max(0.0, deadline - loop.time()),
            )
            await asyncio.sleep(pause)

    assert last_exc is not None  # 循环至少跑过一次
    raise last_exc


async def _retry_transport(
    request: MCPToolCallRequest,
    handler: Callable[[MCPToolCallRequest], Awaitable[MCPToolCallResult]],
) -> MCPToolCallResult:
    """工具调用期的传输层兜底：瞬时失败重试一次，最终失败转成错误结果。

    返回 `CallToolResult(isError=True)` 而不是抛异常：adapter 会把它转成
    `status="error"` 的 ToolMessage，模型能看到失败原因（抛异常会让整轮
    run 变成 internal error）。
    """
    last_exc: Exception | None = None
    for attempt in range(_CALL_RETRIES + 1):
        try:
            return await handler(request)
        except Exception as exc:  # noqa: BLE001 — 重试完再兜底
            last_exc = exc
            if not _retryable(exc) or attempt >= _CALL_RETRIES:
                break
            await asyncio.sleep(_CALL_RETRY_BACKOFF * (attempt + 1))

    assert last_exc is not None
    logger.warning(
        "MCP 工具 %r（服务器 %r）调用失败：%s",
        request.name,
        request.server_name,
        _describe(last_exc),
    )
    return CallToolResult(
        isError=True,
        content=[
            TextContent(
                type="text",
                text=(
                    f"MCP 工具 {request.name}（服务器 {request.server_name}）"
                    f"调用失败：{_describe(last_exc)}"
                ),
            )
        ],
    )


def _retryable(exc: BaseException) -> bool:
    """这次失败值不值得重试。

    超时不重试：时间预算已经烧掉了，再等一次只会更慢。连接被掐断
    （`ConnectError` / `BrokenResourceError`）是典型值得重试的瞬时故障。
    """
    return not isinstance(_root(exc), (TimeoutError, httpx.TimeoutException))


def _root(exc: BaseException) -> BaseException:
    """剥到异常链最里层。

    anyio 的 TaskGroup 会把底层异常包进 `ExceptionGroup`，直接打印只看到
    「unhandled errors in a TaskGroup (1 sub-exception)」——看不出是网络问题、
    是超时、还是服务器返回了 401。这里一层层剥到最里面那个异常。
    """
    root = exc
    while isinstance(root, BaseExceptionGroup) and root.exceptions:
        root = root.exceptions[0]
    return root


def _describe(exc: BaseException) -> str:
    """把异常说成人话（根因 + 类型）。"""
    root = _root(exc)
    if root is exc:
        return f"{type(exc).__name__}: {exc}"
    return f"{type(root).__name__}: {root}"


def _qualified_name(server: str, tool: str) -> str:
    """工具名按约定加前缀：``mcp__{服务器}__{工具}``。

    **为什么不用 adapter 自带的 `tool_name_prefix`**：它拼的是
    ``{服务器}_{工具}``（单下划线），跟项目自带的参考资料
    （``.agents/skills/ecosystem-primer/SKILL.md``）里写的
    ``mcp__docs-langchain__*`` 对不上——agent 读的是那份说明，
    名字对不上它会以为 MCP 没接上。

    加前缀还顺带解决跟内置工具（``read_file`` / ``execute`` / ``task``…）
    以及别的服务器重名的问题。名字同时要满足供应商的字符集
    （只允许字母、数字、下划线、连字符）。
    """
    server_part = _NAME_UNSAFE.sub("_", server)
    suffix = _NAME_UNSAFE.sub("_", tool)
    name = f"mcp__{server_part}__{suffix}"
    if len(name) <= _MAX_TOOL_NAME:
        return name
    # 超长：先砍服务器段（留一点辨识度），再砍工具名
    keep_server = min(len(server_part), 24)
    head = f"mcp__{server_part[:keep_server]}__"
    return f"{head}{suffix[:_MAX_TOOL_NAME - len(head)]}"


def _run_sync(make_coro: Callable[[], Coroutine[Any, Any, T]]) -> T:
    """在同步路径上把一个异步调用跑完。

    分两种情况：

    - **当前线程没有事件循环**（普通脚本、建图时加载工具）：直接
      `asyncio.run()`——最常见，零额外开销。
    - **当前线程有事件循环**（在 async 函数里调同步 API）：`asyncio.run`
      在这里是非法的（它自己会抛 "cannot be called from a running event loop"，
      强行跑还会跟外层 loop 打架）。**换个线程跑**：那个线程自带一个空 loop，
      `asyncio.run` 在里面完全合法。

    代价：第二种情况会**阻塞调用方的 loop** 直到跑完。但调用方本来就在用同步
    API 阻塞自己的 loop（整个 `graph.invoke()` 都是阻塞的），多这一段不改变性质。

    `make_coro` 是**工厂**而不是协程：只有确定要跑的时候才造协程，
    免得造出来却没 await（Python 会吐 "coroutine was never awaited" 警告）。
    """
    try:
        asyncio.get_running_loop()
    except RuntimeError:
        # 当前线程没有事件循环 → 直接就地跑
        return asyncio.run(make_coro())

    # 当前线程有事件循环 → 挪到独立线程跑（那边的 loop 是空的）
    with ThreadPoolExecutor(max_workers=1) as pool:
        return pool.submit(lambda: asyncio.run(make_coro())).result()
