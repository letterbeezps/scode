"""MCP 工具的加载：把 conf/mcp.json 里配的服务器变成 agent 能用的工具。

## 思路：协议交给 SDK，只补 SDK 不管的三件事

MCP 协议本身一行都不手写：

- `langchain-mcp-adapters` 的 `MultiServerMCPClient` 负责连服务器、取工具清单、
  把 MCP 工具转成 LangChain 工具。http / sse / stdio / websocket 四种传输都支持，
  我们只是把 `conf/mcp.json` 的内容翻译成它要的连接参数字典。
- `mcp`（官方 Python SDK）是 adapter 的底层依赖——stdio 子进程的管道、
  streamable-http 的握手、会话初始化都在它那里。

所以我们只做三件 SDK 不做的事：

**① 改名。** adapter 造的工具名就是服务器给的名字（`search` 之类）。两个服务器
撞名时，工具会在 `bind_tools` 阶段互相盖掉，模型最后只能调到一个。
项目约定用 `mcp__{服务器}__{工具}`（Claude Code 那套）；项目自带的参考资料
（`.agents/skills/ecosystem-primer/SKILL.md`）里也写着 agent 要认
`mcp__docs-langchain__*`——名字对不上，agent 会以为 MCP 没接上，转而自己拿
`execute` 去 curl MCP 端点（实测过，能 work 但绕一大圈）。

**② 每个服务器一条长会话。** adapter 的 `client.get_tools()` 默认**每次工具
调用新建一个会话**（文档原话："A new session will be created for each tool
call"）：stdio 每次 fork 一个新子进程，http 每次重新握手。对无状态服务器
（文档搜索）只是慢一点，对**有状态服务器**（`server-memory` 的知识图谱、
浏览器、REPL）等于每次调用都重置——写进去的实体下一次就读不到了。

所以不直接用 `get_tools()` 造好的工具，而是：

- 建图时用一个**临时会话**列工具清单（拿 schema 和描述），列完就关
- 工具对象绑到一个 `_SessionProxy`（鸭子类型的 `ClientSession`，adapter 只用
  它的 `call_tool()`）
- 第一次真正调用时才在**运行事件循环**上开持久会话，之后一直复用
- 传输层失败就丢掉这条会话，下一次调用（或重试）重新建

**③ 兜住传输层失败，并在调用期重试一次。** adapter 把话说得很清楚：MCP 服务器
自己报的错（`isError=True`）会变成 `status="error"` 的 ToolMessage，但**传输层
失败一律往上抛**——一次网络抖动就会让整轮 run 变成 internal error
（实测 `anyio.BrokenResourceError`）。这里用 adapter 公开的 `tool_interceptors`
扩展点接住它：瞬时失败重试一次（重试会触发重新建会话），仍失败就构造一个
`isError=True` 的 `CallToolResult`——adapter 会把它转成错误 ToolMessage，模型
看得见「这个工具没调通」，可以换个工具重试或者告诉用户原因，整轮对话不会崩。

## 代价：改 conf/mcp.json 要重启后端

工具名和 schema 在建图时取一次，交给 `create_deep_agent(tools=[...])`，于是它们
就是**普通工具**——注册在框架的 ToolNode 里，模型调用时框架自己执行。
不需要中间件：既不用在 `wrap_model_call` 里往 `request.tools` 注入，
也不用在 `wrap_tool_call` 里覆盖工具对象。

（另一条路是运行期注入：中间件在每次模型调用前把工具挂进 `request.tools`。
改配置不用重启，但要多一个中间件和 `wrap_model_call` / `wrap_tool_call`
两套钩子。框架留这条路（见 langchain/agents/factory.py 的
`DYNAMIC_TOOL_ERROR_TEMPLATE`），本项目选了简单的那条。）

## 会话的生命周期与边界

- 所有会话都跑在一个**专用的 MCP 线程**上（daemon，第一次调用时启动）：MCP SDK
  基于 anyio，会话的 cancel scope 必须由建立它的任务退出；把它放在独立线程的
  事件循环里，主服务的循环关停不会去并发取消这些内部任务，也不会卡住
  `asyncio.run()` 的收尾。工具调用通过 `run_coroutine_threadsafe` 送过去。
- **同一服务器的调用是串行的**（每个服务器一个 worker 任务 + 队列）：有状态
  服务器（浏览器、REPL）并发操作会互相踩；MCP 客户端通常也是按顺序用一条连接。
- 会话是**进程级共享**的，不按 thread 区分：不同对话看到的是同一个服务器状态。
  这是有意的（MCP 服务器本来就该像「一个外部服务」），单用户项目够用。
- 应用关停时 `admin/app.py` 的 lifespan 调 `close_mcp_sessions()`：取消 worker
  任务、等会话退出、再停掉 MCP 线程。不调用也不会留下僵尸进程（线程是 daemon，
  stdio 子进程随父进程退出），但显式关闭的日志更干净。

## 只能异步调用

adapter 造的工具只填了 `coroutine`（`func` 是 None）。框架在 Agent Server 里
全程走异步执行路径，没有问题；但本地脚本的 `graph.invoke()` 是同步的，
调用 MCP 工具会抛 `NotImplementedError`——本项目没有同步调用场景，不额外补壳。
"""

from __future__ import annotations

import asyncio
import logging
import re
import threading
from collections.abc import Awaitable, Callable, Coroutine
from dataclasses import dataclass
from typing import Any

import httpx
from langchain_core.tools import BaseTool
from langchain_mcp_adapters.client import MultiServerMCPClient
from langchain_mcp_adapters.interceptors import (
    MCPToolCallRequest,
    MCPToolCallResult,
)
from langchain_mcp_adapters.tools import convert_mcp_tool_to_langchain_tool
from mcp import ClientSession
from mcp.types import CallToolResult, TextContent

from stupid_code.config.mcp import load_connections
from stupid_code.config.model import ConfigError

logger = logging.getLogger(__name__)

_MAX_TOOL_NAME = 64
"""工具名长度上限。Anthropic 那边是 64 个字符，超了直接被 API 拒。"""

_NAME_UNSAFE = re.compile(r"[^A-Za-z0-9_-]")

_MAX_LIST_PAGES = 1000
"""列工具清单时的分页上限（和 adapter 内部一致），防止服务器分页异常死循环。"""

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

加载成功不等于每次调用都通——持久会话也可能被服务器/网络掐断。一次就够：
模型自己也会在收到错误后重试，这里只是把「一次抖动就失败」的概率压低。
重试时 `_SessionHub` 已经丢掉了坏会话，所以第二次调用走的是新连接。
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
        # 所有 MCP 的异步工作都在专用线程的循环上跑：这里从主线程提交并等结果。
        # 不能直接 asyncio.run——langgraph dev 是在自己的事件循环里导入图的。
        thread = _MCPThread.get(client)
        loaded = thread.run(
            _load_servers(client, names),
            timeout=_LOAD_TIMEOUT + 5.0,
        )
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
            # 服务器名和只读标注记进 metadata：权限层要据此决定要不要人工确认
            metadata = dict(tool.metadata or {})
            metadata["mcp_server"] = server
            tool.metadata = metadata
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

    **为什么逐个调 `client.session(server_name)`**：不带 server_name 的
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
    """连一个 MCP 服务器取工具清单，失败重试几次。

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
                _list_server_tools(client, name),
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

    if last_exc is None:
        # 预算是负数（比如事件循环被别的同步代码占住了），一次都没试成
        raise TimeoutError(
            f"MCP 服务器 {name!r} 的加载预算（{_LOAD_TIMEOUT:g} 秒）在第一次尝试前就耗尽了"
        )
    raise last_exc


async def _list_server_tools(
    client: MultiServerMCPClient,
    name: str,
) -> list[BaseTool]:
    """用一个临时会话列工具清单，然后把工具绑到持久会话的代理上。

    临时会话只用来拿 schema / 描述，列完就关（stdio 子进程也随之退出）；
    真正的连接由第一次工具调用时的 `_SessionHub` 建立并长期保留。
    """
    async with client.session(name) as session:
        raw_tools = await _list_all_tools(session)

    proxy = _SessionProxy(name, client)
    return [
        # session 参数传的是 _SessionProxy：adapter 只调用它的 call_tool()，
        # 不会碰别的属性。这样 adapter 的 schema / 结果转换 / 错误处理全都保留，
        # 只是「每次调用新建会话」换成了「复用同一条会话」。
        convert_mcp_tool_to_langchain_tool(
            proxy,  # type: ignore[arg-type]
            tool,
            callbacks=client.callbacks,
            tool_interceptors=client.tool_interceptors,
            server_name=name,
            handle_tool_errors=client.handle_tool_errors,
        )
        for tool in raw_tools
    ]


async def _list_all_tools(session: ClientSession) -> list[Any]:
    """按 MCP 分页规范把工具清单列完。"""
    tools: list[Any] = []
    cursor: str | None = None
    for _ in range(_MAX_LIST_PAGES):
        page = await session.list_tools(cursor=cursor)
        tools.extend(page.tools)
        cursor = page.nextCursor
        if not cursor:
            return tools
    raise RuntimeError(
        f"列 MCP 工具清单超过 {_MAX_LIST_PAGES} 页，疑似服务器分页异常"
    )


@dataclass
class _MCPCall:
    """一次排队等服务器执行的调用。worker 任务负责填这个 future。"""

    name: str
    args: dict[str, Any]
    progress_callback: Any
    future: asyncio.Future[CallToolResult]


class _ServerWorker:
    """一个服务器一条会话 + 一个专属任务。

    **为什么要有专属任务**：MCP SDK 的 stdio 会话内部用 anyio 的 TaskGroup，
    它的 cancel scope 必须**在建立它的同一个任务里退出**。如果会话在工具调用的
    任务里建立、却在别的任务（事件循环收尾、lifespan 关闭钩子）里关闭，
    anyio 会抛「Attempted to exit cancel scope in a different task」。

    所以会话的 `async with` 放在这个 worker 任务里，所有调用排队送进来；
    关闭时取消这个任务，`async with` 就在同一个任务里正常退出。

    一个服务器串行执行（队列天然串行），有状态服务器不会被并发调用踩乱。
    """

    def __init__(self, client: MultiServerMCPClient, server: str) -> None:
        self._client = client
        self._server = server
        self._queue: asyncio.Queue[_MCPCall] = asyncio.Queue()
        self._task: asyncio.Task[None] | None = None

    def ensure_task(self) -> None:
        """懒启动 worker 任务（在首次调用所在的事件循环上）。"""
        if self._task is None or self._task.done():
            self._task = asyncio.create_task(
                self._run(), name=f"mcp-session-{self._server}"
            )

    async def call(
        self,
        name: str,
        args: dict[str, Any],
        *,
        progress_callback: Any = None,
    ) -> CallToolResult:
        """排队等 worker 执行，结果通过 future 送回来。"""
        self.ensure_task()
        future: asyncio.Future[CallToolResult] = (
            asyncio.get_running_loop().create_future()
        )
        await self._queue.put(
            _MCPCall(
                name=name,
                args=args,
                progress_callback=progress_callback,
                future=future,
            )
        )
        return await future

    async def close(self) -> None:
        """取消 worker 任务，让会话在它自己的任务里关掉。"""
        task = self._task
        if task is None or task.done():
            return
        task.cancel()
        try:
            await task
        except asyncio.CancelledError:
            pass

    async def _run(self) -> None:
        """worker 主循环：等一个调用 → 建会话 → 连续服务队列里的调用。

        会话失效（传输层异常）就让 `async with` 退出、当前调用拿到异常，
        然后等下一次调用再重连。
        """
        while True:
            call = await self._queue.get()
            await self._serve_session(call)

    async def _serve_session(self, first: _MCPCall) -> None:
        """用一条新会话服务 `first` 以及紧随其后的排队调用。"""
        call = first
        try:
            async with self._client.session(self._server) as session:
                logger.info("MCP 服务器 %r 的长会话已建立", self._server)
                while True:
                    if not call.future.cancelled():
                        try:
                            result = await session.call_tool(
                                call.name,
                                call.args,
                                progress_callback=call.progress_callback,
                            )
                        except Exception as exc:  # noqa: BLE001 — 转给调用方
                            if not call.future.done():
                                call.future.set_exception(exc)
                            # 会话多半已不可用：退出 async with，等下一次调用重连
                            raise
                        if not call.future.done():
                            call.future.set_result(result)
                    call = await self._queue.get()
        except asyncio.CancelledError:
            # 关闭：把手上这个和队列里没跑的调用一起收掉
            self._cancel_calls(call)
            raise
        except Exception as exc:  # noqa: BLE001 — 一条坏会话不该弄死 worker
            if not call.future.done():
                call.future.set_exception(exc)
            logger.warning(
                "MCP 服务器 %r 的会话失效，下次调用会重连：%s",
                self._server,
                _describe(exc),
            )

    def _cancel_calls(self, pending: _MCPCall) -> None:
        if not pending.future.done():
            pending.future.cancel()
        while not self._queue.empty():
            call = self._queue.get_nowait()
            if not call.future.done():
                call.future.cancel()


class _SessionProxy:
    """鸭子类型的 `ClientSession`：只实现 adapter 会用到的 `call_tool()`。

    adapter 的 `convert_mcp_tool_to_langchain_tool()` 在 `session` 不为 None 时
    直接调用 `session.call_tool(...)`，不会新建会话，也不会访问别的属性。
    用它把「工具对象」和「持久会话」解耦：工具可以在建图时造好（schema 固定），
    会话等到第一次真正调用时再在专用 MCP 线程上建立。
    """

    def __init__(self, server: str, client: MultiServerMCPClient) -> None:
        self._server = server
        self._client = client

    async def call_tool(
        self,
        name: str,
        arguments: dict[str, Any],
        *,
        progress_callback: Any = None,
    ) -> CallToolResult:
        """把调用送到专用 MCP 线程，等它把结果送回来。"""
        thread = _MCPThread.current()
        if thread is None or not thread.usable(self._client):
            # 第一次调用才启动线程；启动要等 ready 事件，别阻塞事件循环
            thread = await asyncio.to_thread(_MCPThread.get, self._client)
        future = thread.submit(
            self._server,
            name,
            arguments,
            progress_callback,
        )
        return await asyncio.wrap_future(future)


class _SessionHub:
    """MCP 专用线程的事件循环上所有 MCP 服务器的长会话。

    每个服务器一个 `_ServerWorker`（一条会话 + 专属任务），第一次调用时建立，
    之后一直复用；调用失败会话就退出，下一次调用重新建。
    """

    def __init__(self, client: MultiServerMCPClient) -> None:
        self._client = client
        self._workers: dict[str, _ServerWorker] = {}

    async def call_tool(
        self,
        server: str,
        name: str,
        arguments: dict[str, Any],
        *,
        progress_callback: Any = None,
    ) -> CallToolResult:
        """交给该服务器的 worker 执行。"""
        worker = self._workers.get(server)
        if worker is None:
            worker = _ServerWorker(self._client, server)
            self._workers[server] = worker
        return await worker.call(
            name,
            arguments,
            progress_callback=progress_callback,
        )

    async def close_all(self) -> None:
        """关闭所有 worker（会话在各自的任务里退出）。"""
        workers = list(self._workers.values())
        self._workers.clear()
        for worker in workers:
            await worker.close()


class _MCPThread:
    """专用 MCP 线程：一个事件循环 + 一个 `_SessionHub`。

    **为什么不能跑在主服务的循环上**：MCP SDK 的 stdio 会话内部是 anyio 的
    TaskGroup，它的 cancel scope 必须由建立它的任务退出。服务关停 /
    `asyncio.run()` 收尾会**并发取消所有任务**，包括这个 task group 的内部
    读写任务，会话的 `async with` 退出就会卡住（实测）。

    放到独立线程的循环里之后：主循环怎么关停都碰不到这些内部任务；应用关停
    时 lifespan 再显式调 `close_mcp_sessions()`，把 worker 任务取消掉、等会话
    自己退出，最后停掉这个线程。线程是 daemon，就算没走关停钩子，进程也能退出
    （stdio 子进程随父进程断开管道而退出）。
    """

    _instance: _MCPThread | None = None
    _instance_lock = threading.Lock()

    @classmethod
    def get(cls, client: MultiServerMCPClient) -> _MCPThread:
        """取（必要时启动）进程级的 MCP 线程。"""
        with cls._instance_lock:
            if (
                cls._instance is None
                or cls._instance._closed
                or cls._instance._client is not client
            ):
                cls._instance = cls(client)
            return cls._instance

    @classmethod
    def current(cls) -> _MCPThread | None:
        """已有的 MCP 线程（不启动新的）。"""
        with cls._instance_lock:
            return cls._instance

    def usable(self, client: MultiServerMCPClient) -> bool:
        """这条线程还能不能用来提交调用。"""
        return not self._closed and self._client is client

    def __init__(self, client: MultiServerMCPClient) -> None:
        self._client = client
        self._hub = _SessionHub(client)
        self._loop = asyncio.new_event_loop()
        self._ready = threading.Event()
        self._closed = False
        self._thread = threading.Thread(
            target=self._run,
            name="mcp-session-loop",
            daemon=True,
        )
        self._thread.start()
        if not self._ready.wait(timeout=5):
            raise RuntimeError("MCP 专用线程启动超时")

    def _run(self) -> None:
        """线程入口：跑自己的事件循环，直到 close() 把它停掉。"""
        asyncio.set_event_loop(self._loop)
        self._ready.set()
        try:
            self._loop.run_forever()
        finally:
            self._loop.close()

    def submit(
        self,
        server: str,
        name: str,
        arguments: dict[str, Any],
        progress_callback: Any = None,
    ) -> Any:
        """把一次调用调度到 MCP 线程，返回 concurrent.futures.Future。"""
        coro = self._hub.call_tool(
            server,
            name,
            arguments,
            progress_callback=progress_callback,
        )
        return asyncio.run_coroutine_threadsafe(coro, self._loop)

    def run(self, coro: Coroutine[Any, Any, Any], *, timeout: float) -> Any:
        """在 MCP 线程上跑一个协程并等结果（**只能从其他线程调用**）。

        建图时加载工具用它：调用方是 `langgraph dev` 的主循环线程，协程在
        MCP 线程的循环上跑，所以这里阻塞等待不会死锁。**别在 MCP 线程自己
        里调用**——`.result()` 会把它的循环堵死。
        """
        future = asyncio.run_coroutine_threadsafe(coro, self._loop)
        try:
            return future.result(timeout)
        except TimeoutError as exc:
            # concurrent.futures.TimeoutError 在 3.11+ 就是内置 TimeoutError。
            # future 已经结束的话，是协程自己抛的 TimeoutError（比如服务器超时），
            # 原样往上抛；只有 future 还没结束才是真的等超时。
            if future.done():
                raise
            future.cancel()
            raise TimeoutError(f"MCP 线程执行超时（{timeout:g} 秒）") from exc

    async def close(self) -> None:
        """关掉所有会话，然后停掉线程。"""
        if self._closed:
            return
        self._closed = True
        try:
            future = asyncio.run_coroutine_threadsafe(self._hub.close_all(), self._loop)
            await asyncio.wrap_future(future)
        finally:
            # 即使 close_all 失败也要把线程停掉，别在关停流程里留下活线程
            if not self._loop.is_closed():
                self._loop.call_soon_threadsafe(self._loop.stop)
            await asyncio.to_thread(self._thread.join, 5)


async def close_mcp_sessions() -> None:
    """关闭当前进程的所有 MCP 长会话。

    给应用关停钩子用（`admin/app.py` 的 lifespan）。不调用也不会留下僵尸
    进程（MCP 线程是 daemon），但显式关闭会让子进程立即退出、日志更干净。
    """
    thread = _MCPThread.current()
    if thread is None:
        return
    try:
        await thread.close()
    finally:
        with _MCPThread._instance_lock:  # noqa: SLF001 — 同类内部状态
            if _MCPThread._instance is thread:
                _MCPThread._instance = None


async def _retry_transport(
    request: MCPToolCallRequest,
    handler: Callable[[MCPToolCallRequest], Awaitable[MCPToolCallResult]],
) -> MCPToolCallResult:
    """工具调用期的传输层兜底：瞬时失败重试一次，最终失败转成错误结果。

    重试时 `_SessionHub` 已经丢掉了失败的那条会话，所以第二次调用会重新建连。
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

    - 超时不重试：时间预算已经烧掉了，再等一次只会更慢。
    - 4xx 不重试：鉴权失败 / 路径写错，重试多少次都一样；5xx 和 429 才值得。
    - 连接被掐断（`ConnectError` / `BrokenResourceError`）是典型值得重试的
      瞬时故障。
    """
    root = _root(exc)
    if isinstance(root, (TimeoutError, httpx.TimeoutException)):
        return False
    if isinstance(root, httpx.HTTPStatusError):
        status = root.response.status_code
        return status == 429 or status >= 500
    return True


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
