# AGENTS.md

基于 LangChain Deep Agents + LangGraph 的**网页版 code agent**，前端是独立的 Vite + React SPA。
这是个**学习项目**：以「能跑、能看懂、能改」为标准，不追求生产级完备。代码粗糙甚至出错是预期内的，别顺手"补全"成另一套工程规范。

## 仓库形态：两个互不牵连的子项目

根目录的 `pyproject.toml` 只管后端；`web/` 是完全独立的 pnpm 项目，不参与 uv 依赖管理。改后端不要碰 `web/`，反之亦然。

## Setup commands

**后端（Python ≥ 3.12，uv + hatchling）**

- 装依赖：`uv sync`
- 跑起来：`uv run scode` —— **在哪个目录运行，那个目录就是 agent 的工作空间**（langgraph 子进程 cwd = 当前目录）；scode 在 `$TMPDIR/scode-config-*` 生成一份路径绝对化的派生 langgraph.json，监听 `127.0.0.1:2024`，并轮询 `GET /ok` + `GET /assistants/{id}/graph` 做就绪验证，两项都通过才算启动成功。改后端代码需重启（scode 固定传 `--no-reload`）
- 校验配置：`uv run langgraph validate --config stupid_code/langgraph.json`
- 控制台脚本 `scode` = `stupid_code:start`（`pyproject.toml`）

**前端（pnpm 12，见 `web/package.json` 的 `packageManager`）**

- 装依赖：`cd web && pnpm install`
- 开发：`pnpm dev`（5173，Vite 把 `/api/*` 代理到 `VITE_LANGGRAPH_URL`，默认 `http://localhost:2024`）
- 构建（含类型检查）：`pnpm build` —— `tsc -b && vite build`
- Lint：`pnpm lint`（oxlint）
- 后端没起来时：`VITE_USE_MOCK=true pnpm dev`，mock 默认**关闭**，不设即 false

Python 侧**没有** ruff / black / mypy 配置，**整个仓库没有测试、没有 CI**。不要发明这些命令。

**Docker（可选，012 期）**

- 全栈：`docker compose up --build` → 前端 <http://127.0.0.1:5173>，后端 `127.0.0.1:2024`
- 只起后端：`docker compose up -d backend`
- 工作空间由 `SCODE_WORKSPACE` 决定（默认仓库自身），挂到容器里的 `/workspace`
- 坑位见下面第 15 条

## Project layout

- `stupid_code/` — 后端包。顶层只放入口与起停，实现按职责分包：`__init__.py` 是 `start()` 入口、`launcher.py` 是 `scode` 的启动/就绪/关停逻辑、`langgraph.json` 是框架读的配置；`graph/`（`agent.py` 导出 `graph`，`memory.py` 装配长期记忆中间件，`model_switch.py` 是运行期切换对话模型的中间件，`compaction.py` 是 `/compaction` 手动压缩历史，`mcp.py` 加载 MCP 工具，`permissions.py` 是 shell 人工确认的档位与危险判定，`workspace.py` 解析 `configurable.workspace` 并校验工作空间，`backend.py` 装真实磁盘+shell 的 backend（根目录是运行期属性），`persistence.py` 把 checkpoint/store 落到 `data/langgraph.db`）、`config/`（`model.py` 读 `conf/config.toml`、`subagent.py` 读 `conf/subagents.toml`、`mcp.py` 读 `conf/mcp.json`、`prompts.py` 是主 agent 的系统提示词）、`admin/` 是挂在 `/admin` 下的管理接口 + `workspaces.py`（`POST /workspaces/pick` 弹系统目录选择框）
- `stupid_code/README.md` — 后端启动说明；`stupid_code/API.md` — 当前实际可用的端点清单
- `web/src/api/` — 后端通信层，`mock/` 用**与真实后端完全相同的签名**实现假数据；`web/src/store/` Zustand 状态；`components/`、`pages/`、`lib/`
- `docs/overall-design.md` — 目标架构与前后端契约；`docs/frontend-design.md` — 前端交互设计；`docs/learning-path.md` — 框架背景与学习路线
- `docs/backend/PROGRESS.md` — 后端进度快照（001–014 期合并成一份，见「测试与验证」）
- `Dockerfile` — 后端镜像（python:3.12-slim + uv；代码在 `/app`、venv 在 `/opt/venv`、agent 工作空间在 `/workspace`）；`web/Dockerfile` + `web/nginx.conf` — 前端镜像（Vite 构建 → nginx 托管 + `/api` 反代）；`docker-compose.yml` — 串起两个服务
- `examples/mcp_stdio_server.py` — 一个能直接跑的 stdio MCP 服务器（用 `mcp` 包自带的 FastMCP，零新依赖），拿来验证 `conf/mcp.json` 的 stdio 传输
- `skills-lock.json` — langchain-skills 安装记录与 hash，**已入库**，用来追踪参考资料版本

## 动手前必须知道的几件事

1. **`.agents/` 和 `.claude/` 是 gitignore 的**。clone 后必须先装参考资料，否则编码 Agent 看不到它们：
   `npx skills add langchain-ai/langchain-skills --skill '*' --yes`
   然后 `ls .agents/skills | head` 确认。**写 deepagents / LangGraph 代码前先查这些 skill 和线上文档，别凭记忆写**——框架还在 0.x，迭代很快。
2. **不要给 `create_deep_agent()` 传 `checkpointer`**。`langgraph dev` 会直接抛 ValueError（ValueError: persistence 由平台自动处理）。持久化在 `langgraph.json` 配置：`checkpointer`/`store` 指向 `graph/persistence.py` 的 SQLite 工厂，checkpoint 落 `stupid_code/data/langgraph.db`，重启后对话历史可恢复。
3. **`langgraph.json` 里写死了三个文件路径**：`./graph/agent.py:graph`、`./graph/persistence.py:checkpointer`、`./admin/app.py:app`。挪这三个文件必须同步改 `langgraph.json`，否则启动时报找不到模块。另有几个模块用 `__file__` 定位目录，**层数跟包结构绑死**：`config/model.py` 与 `config/subagent.py` 定位项目根（`parents[2] / "conf"`）、`graph/persistence.py` 定位包根的 `data/`（`parents[1] / "data"`）、`launcher.py` 定位本包目录（langgraph.json 所在处，不能挪）。再往下挪目录要同步改这些层数。`scode` 启动时会把 langgraph.json 里的相对路径绝对化后写进 `$TMPDIR/scode-config-*`，所以**作者视角的路径仍相对 `stupid_code/` 写**。
4. **`.langgraph_api/` 要留着，别删**：inmem 运行时把它硬编码为相对 cwd 的路径，无法配置改位。里面的 `.langgraph_ops.pckl` 是 **thread 索引**（会话列表与 metadata 的来源）——checkpoint 确实已由 `graph/persistence.py` 的 SQLite 工厂接管（同名的 `.langgraph_checkpoint.*.pckl` 是空的），但删掉 ops 索引后平台重启就认不出已有 thread：`/threads/search` 返回空、`/threads/{id}/state` 404，历史数据还躺在 `stupid_code/data/langgraph.db` 里却取不出来。所以 scode **不再清理**它；持久状态分两处，缺一不可。派生 langgraph.json（相对路径绝对化）只放 `$TMPDIR/scode-config-*`，退出即删。后端源码目录不进运行 cwd，不会被写 `.langgraph_api` / `__pycache__`。
5. **`GET /assistants` 返回 405**。列 assistant 要用 `POST /assistants/search`，再拿 `assistant_id`（UUID）去 `GET /assistants/{id}/graph`。
6. **前端已经按契约写完了，后端要"实现前端已假定的契约"，不是"对齐已有实现"**。改后端接口前先看 `stupid_code/API.md` 和 `web/src/api/`。工作空间这条链路 014 期已经闭环（前端 `POST /workspaces/pick` 弹系统目录框 → 后端回绝对路径 → 随 `configurable.workspace` 生效），别再按旧文档以为它是「只透传」。
7. **SSE 一律用 fetch + 手动解析，不用 `EventSource`**（已定事项，别改回去）。
8. **工作空间 + 权限是任务级参数**，按 `threadId` 存而非全局：同任务内前后两条消息可能针对不同目录。另有 `draft` 副本供新任务用，`createThread()` 时 `adoptDraft()` 固化并重置，否则两个任务的运行边界会串。**对话模型不是任务级参数**——它是全局偏好（存 localStorage），每次运行随 `configurable.model` 发给后端。
9. **deepagents 0.7.28 不再提供内置系统提示词**。`BASE_AGENT_PROMPT` 在 0.7.0 废弃（0.9.0 移除），`HarnessProfile.base_system_prompt` 默认 `None`，内置的几个 claude profile 也没设。**`create_deep_agent(system_prompt=...)` 传进去的就是模型唯一看到的系统提示词**——别以为框架会垫底，行为准则要自己写全（见 `stupid_code/config/prompts.py`）。验证方法：用假模型把 `request.system_message` 打出来。
10. **长期记忆用 `middleware=` 挂 `MemoryMiddleware`，别用 `create_deep_agent(memory=...)`**。两者是同一个中间件，但 `memory=` 只能用框架默认的 backend——默认是 StateBackend（虚拟文件系统），**读不到磁盘上的 `.scode-memory.md`**。自己挂才能给 `FilesystemBackend`（见 `stupid_code/graph/memory.py`）。另外**同一工作空间内记忆只在会话开始时读一次**，改完文件要开新会话才生效；**换工作空间会重新读**（见第 17 条）。**记忆文件不会自动创建**：不存在时记忆块里会告诉模型先用 `write_file` 建（`graph/memory.py` 的 `_MEMORY_TEMPLATE`），别再改回启动时预创建——那会往用户选的项目里凭空塞文件。**记忆块用本项目自己的中文模板**（框架公开的 `system_prompt=` 扩展点），别改回框架那份英文 `MEMORY_SYSTEM_PROMPT`：它教模型用 `edit_file` 保存，而本项目的记忆文件可能根本不存在（`edit_file` 打在不存在的文件上直接报错，模型要白白浪费一轮失败的工具调用）。**记忆内容有长度上限**（`MEMORY_MAX_CHARS = 8000`，超了保留头尾中间省略）——框架不截断，记忆文件是 agent 自己写的会一直涨，不设上限能把上下文窗口顶爆。记忆文件名是 `.scode-memory.md` 而不是框架默认的 `AGENTS.md`：后者是"写给编码 agent 看的项目约定"（本项目根目录那份就是），和 agent 自己攒的长期记忆语义不同，混用会把开发者的项目说明当记忆注入。
11. **端口锁死 2024，被占用就直接启动失败**。`langgraph dev` 在 2024 被占时会自动换端口（日志里 `Port 2024 is already in use, using port NNNNN instead`），而 launcher 的就绪检查只轮询 2024——早期版本因此会在 2024 被旧服务占着时**误报"已就绪"**（前端连的是旧代码，看起来像"改了没生效"）。现在 launcher 启动前先探端口：2024 被占就**启动失败**并告诉你怎么查占用进程，**绝不自动换端口**（前端默认就连 2024，换了没法用）。另外启动途中 Ctrl+C 也会整组清理子进程，早期版本会漏、留下占端口的孤儿。
12. **backend 是真实磁盘 + 本机 shell**（007 期）。`graph/backend.py` 构造 `WorkspaceCompositeBackend(default=LocalShellBackend)`（`CompositeBackend` 的子类，路由守卫见第 17 条 ⑧）：agent 的 `write_file` / `edit_file` 改的是工作空间里的真文件，`execute` 能跑任意命令。**框架有条硬限制**：backend 支持命令执行时，`FilesystemMiddleware` 不接受 `permissions`（直接抛 `NotImplementedError`）——shell 能绕过任何文件权限，权限和 shell 不能共存。所以 `graph/backend.py` 的 `apply_subagent_policies()` 会给**声明了 `permissions` 的子 agent** 换成无 shell 的 `FilesystemBackend`，`conf/subagents.toml` 里 `reviewer` 的只读就是靠这个保证的；同一个函数还会让这类子 agent **不继承 MCP 工具**（MCP 不走文件权限层，继承过来等于另开一条写路径）。改子 agent 配置时别把 `permissions` 直接塞回规格里。
13. **切换对话模型靠中间件，不靠重建图**（010 期）。`graph/model_switch.py` 的 `ChatModelSwitchMiddleware` 覆盖 `wrap_model_call` / `awrap_model_call`，把 `request.model` 换成用户在界面上选的那个——框架最终是拿 `request.model.bind_tools(...)` 发请求的，所以换了就是真换。三个容易踩的点：① **`ModelRequest.runtime` 是 `Runtime`，没有 `.config` 属性**（只有 `ToolCallRequest.runtime` 才有），取 `configurable` 要用 `langgraph.config.get_config()`；② 中间件在 `middleware=` 列表里**越靠前越外层**，切换中间件要排在 prompt-caching / memory 之前，那些中间件才看得到换过的模型；**但 deepagents 是按 `.name` 把自定义中间件合并进基础栈的**（撞名原地替换、不撞就追加到 core 之后），所以压缩中间件留在 core 段、**位于切换中间件外层**，它内部读 `request.model` 看到的仍是启动时的模型（摘要本身不受影响，摘要自己按 `configurable` 解析）；③ 切换**只作用于主 agent**——子 agent 一律用各自原有的模型（`conf/subagents.toml` 里写死的，或建图时继承来的）。框架上做得到让子 agent 也跟着切（子 agent 的中间件也拿得到父图的 `configurable`），但**别那么做**：子 agent 用哪个模型是配置出来的（本项目 `reviewer`/`summarizer` 刻意用便宜的 `MiniMax-M3.1-Flash`），用户在下拉框选模型的意图是「这段对话用这个模型」，让委派出去的活跟着烧新模型会打乱配置好的成本结构。要改子 agent 的模型，去 `conf/subagents.toml` 写死。切换**不重启后端**：那条路径每次调用都重读 `conf/config.toml`，所以新增模型、改 base_url / api_key 立刻生效；但 harness profile 和摘要阈值是建图时定的，不跟着换。
14. **压缩历史用 `graph/compaction.py` 的 `CompactionMiddleware`**（011 期）。它继承 deepagents 的 `SummarizationMiddleware` 并做三件事：① `.name` 报成**框架自带那一份的公开别名**——别名**从框架那里问出来，不写死字面量**（框架升级改了公开别名，写死的字符串就对不上，会静默变成两份摘要中间件）——这样才能**顶掉** `create_deep_agent()` 自带的那份（deepagents 按 `.name` 合并：撞名原地替换，不撞就多一份；两份摘要中间件同时跑会重复压缩）；② 覆盖 `_should_summarize()`，用户发 `/compaction` 就强制压缩一次（**只看最后一条用户消息**，命令消息会留在对话里，否则下一轮又压一次）；③ 用 `summarizer=` 这个公开扩展点接管摘要调用，让摘要也用**当前选中的模型**——框架默认把摘要模型在构造时就固定了（`self._summary_chat_model = self.model`），切了模型之后压缩还在烧旧供应商。别用 `RunnableLambda` 包同步函数来实现摘要：`ainvoke` 会把它丢进线程池，`get_config()` 依赖 contextvar，跨线程拿不到 `configurable`，会静默退回默认模型——要自己实现 `invoke`/`ainvoke`。被摘走的旧消息会落到工作空间的 `conversation_history/`（已 gitignore），agent 能 `read_file` 读回来。
15. **容器里跑有三个坑（012 期）**。① **`/app`（后端代码）和 `/workspace`（agent 工作空间）必须分开**：框架按 `__file__` 定位 `conf/`、`data/`、`langgraph.json`（见第 3 条），这些位置是约定死的，所以后端代码来自镜像、位置固定在 `/app`；只有 `conf/` 和 `stupid_code/data/` 来自宿主（前者有密钥，后者要跨重启保留历史）。**别把两者合并到一个挂载点** —— 早先一版把源码也放 `/workspace`，`SCODE_WORKSPACE` 一指向外部目录，挂载就把源码整个盖住，容器直接 `ModuleNotFoundError: No module named 'stupid_code'`（editable 安装的 `.pth` 硬编码了项目根）。这类"默认能跑、换个参数就崩"的坑默认路径测不出来，**必须显式测一次外部 workspace**。② **必须 editable 安装**：`config/model.py`、`config/subagent.py`、`launcher.py`、`graph/persistence.py` 四个模块靠源码树位置定位文件，装成非 editable 这些路径全落到 site-packages 里，直接找不到文件。③ **`launcher.py` 的监听地址读 `SCODE_BIND_HOST`**（默认仍是 `127.0.0.1`，原生跑法行为不变），容器里设 `0.0.0.0` 才对外可达——但**宿主侧 `ports` 映射只绑 `127.0.0.1`**，容器内绑全网卡 ≠ 宿主可访问，AGENTS.md 的安全姿态不受影响。改 `web/nginx.conf` 时注意：**`set` 必须写在 `rewrite` 前面**（rewrite 模块按配置顺序执行，`rewrite ... break` 会终止后续指令，`set` 写在后面则 `$api_upstream` 未初始化 → 500），SSE 那段必须 `proxy_buffering off` + `proxy_read_timeout 3600s`（默认 60s 会把长对话掐断）。`conf/config.toml` 在 `.dockerignore` 里，**别把它打进镜像**（明文 api_key 会固化进镜像层）。
16. **MCP 工具是建图时静态注册的（013 期）**。① **别用运行期注入**：`create_deep_agent(tools=[...])` 才是正路——工具注册在框架的 ToolNode 里，模型调用时框架自己执行。框架确实也支持运行期注入（中间件在 `wrap_model_call` 里改 `request.tools`、再在 `wrap_tool_call` 里 `request.override(tool=...)` 执行，见 `langchain/agents/factory.py` 的 `DYNAMIC_TOOL_ERROR_TEMPLATE` → "Option 2: Handle dynamic tools in middleware"），但要多一个中间件 + 两套钩子，**代价是改 conf/mcp.json 要重启后端**——本项目选了简单的那条（跟 conf/subagents.toml 一样）。② **协议一行都别手写**：连服务器、取工具、把 MCP 工具转成 LangChain 工具全交给 `langchain-mcp-adapters`（底层是官方 SDK `mcp`，stdio 管道和 streamable-http 握手都在它那里）；本项目只补 SDK 不做的事——改名（`mcp__{服务器}__{工具}`），以及用 adapter 公开的 `tool_interceptors` 兜传输层失败（瞬时失败重试一次，最终失败转成 `isError=True` 的结果，让模型看到 `status="error"` 的 ToolMessage，而不是整轮 run 崩掉）。**FastMCP 是 `mcp` 包自带的**（`mcp.server.fastmcp`），写示例服务器不用另外装 `fastmcp`（那是另一个包）。③ **工具名必须是 `mcp__{服务器}__{工具}`**（Claude Code 约定）：项目自带的 `.agents/skills/ecosystem-primer/SKILL.md` 里就写着 `mcp__docs-langchain__*`，agent 读的是那份说明 —— 名字对不上它会以为 MCP 没接上，转而自己拿 `execute` 去 curl MCP 端点（实测过，能 work 但绕一大圈）。**别用 adapter 的 `tool_name_prefix`**：它拼的是 `{服务器}_{工具}`（单下划线），对不上。④ **MCP 工具只有异步实现**：adapter 造的 `StructuredTool` 只填了 `coroutine`（`func` 是 None），所以 `tool.invoke()` 这类**同步**路径会抛 `NotImplementedError`（本地脚本 `graph.invoke()` 会撞上）。本项目没有同步调用场景，**不补 `func`**；Agent Server 全程异步，没问题。**原地改 `name` 就行，别重建 StructuredTool**：重建会把 adapter 已配好的 `handle_tool_error`（MCP 自己报的错要保留图片等内容块）丢掉；改 `name` 是安全的（`BaseTool.__setattr__` 会清掉缓存的 `tool_call_schema`）。⑤ **子 agent 默认继承 MCP 工具，但只读子 agent 除外**：deepagents `graph.py` 里 `raw_subagent_tools = spec.get("tools") if "tools" in spec else tools`，子 agent 没写 `tools` 就继承主 agent 的（实测 general-purpose 子 agent 调通了 `mcp__demo__echo`）。**声明了 `permissions` 的子 agent 绝不能让它们继承**：`reviewer` 的只读是靠无 shell 的 `FilesystemBackend` 保证的，MCP 工具完全不经过那层——`apply_subagent_policies()` 会把这类子 agent 的 `tools` 置空（主 agent 传给 `create_deep_agent` 的 `tools` 只有 MCP 工具，所以空列表就是「不接 MCP」）。另外**子 agent 自己写了 `interrupt_on` 会整体替换父级的**（deepagents 里是 `spec.get("interrupt_on", interrupt_on)`）：`fixer` 声明 `write_file` 之后，`execute` 的人工确认就静默没了——`apply_subagent_policies()` 显式做了合并（同名键子 agent优先）。⑥ **建图时加载 MCP 服务器是同步阻塞的**：`graph/agent.py` 导入时就在连服务器，所以**必须限时**——`graph/mcp.py` 用 `asyncio.wait_for` 真的掐断（每服务器**总共** 12 秒，重试和退避都算在这 12 秒里；超时不再重试），且**各服务器并行加载**（总耗时 ≈ 单个服务器的预算，不是各预算之和）；http 的 `timeout` 默认 8 秒（`config/mcp.py` 的 `_DEFAULT_HTTP_TIMEOUT`）是**每次会话的 httpx connect/write/pool 预算**，不是启动限时——启动限时只由 `_LOAD_TIMEOUT` 负责。**别学早先那版只在重试之间看时间戳的假限时**——挂死的服务器照样能把启动拖过 launcher 的 60 秒就绪超时。⑦ **图导入时不能直接 `asyncio.run`**：`langgraph dev` 是在**它自己的事件循环里**导入图模块的（后端日志里能看到 `thread_name=uvloop_1`），`asyncio.run` 会抛 "cannot be called from a running event loop" —— `graph/mcp.py` 的 `_run_sync()` 检测到有循环就**换线程跑**（那个线程自带空 loop，合法）。⑧ **一个服务器挂掉只少几个工具**：逐个服务器取（`client.get_tools()` 内部是 gather，一个失败整批都炸）、失败重试 2 次（只在**非超时**失败上重试：公网端点会抖，实测 10 次连接失败 1 次，报 `ConnectError(EndOfStream())`，跟 SDK 无关）、彻底连不上就跳过它，其余服务器照常。**调用期**的同类抖动由 `tool_interceptors` 再重试一次。**报错要看根因**：anyio 的 TaskGroup 会把真实异常包进 `ExceptionGroup`，直接打印只有 "unhandled errors in a TaskGroup"，`graph/mcp.py` 的 `_describe()` 负责剥到最里层。⑨ **配置校验要逐个服务器做**：一把梭抛 `ConfigError` 会让**整个 MCP 都没了**（连能用的服务器也一起废掉，界面上完全看不出来）——真实配置里带 `description` 字段（Claude Desktop / VS Code 那种格式常见）就能触发。`config/mcp.py` 现在逐个服务器校验，写错的只跳它自己（日志里报一句为什么），并且 `description` 也认了（认了但忽略，agent 用不上）。⑩ **`conf/mcp.json` 不入库**：仓库只提供 `conf/mcp.example.json`（两个只读公网服务器），用户按需复制。原因有两个——它是机器相关的；更重要的是**配 MCP 等于引入一段启动时执行的第三方代码**（stdio 的 `command` 在建图时直接拉起），服务器给的工具有副作用，工具描述也会进模型上下文。只配信任的服务器。

17. **工作空间是运行期参数，根目录是 property（014 期）**。① **后端按 `configurable["workspace"]` 解析工作空间**：框架把 backend 的根目录存在 `self.cwd` 里（所有路径解析都从它出发），本项目把它做成 property（`graph/backend.py` 的 `_WorkspaceRoot`），每次取值读当前运行的 configurable——**同一张图要服务不同项目目录的对话**。别改回建图时定死：那样前端选了工作空间也不起作用（这就是 014 期之前的状态）。用 property 而不是「运行期换 backend 实例」有两个原因：实例在建图时就注册进框架的工具里了；而且同一时刻可能有多个对话在跑，property 背后是 contextvar，天然按运行隔离，改共享实例的属性会串目录。② **文件系统操作必须走线程**：`langgraph dev` 装了 blockbuster，事件循环里直接调同步 FS（`os.readlink` / `os.stat`）会抛 `BlockingError`，整个 run 挂掉（报错行是 `During task with name 'xxx.before_agent'`）。所以路径解析（`Path.resolve()` 展开软链）、`exists()` 校验都要 `asyncio.to_thread`（记忆文件不再由中间件创建，见第 10 条）；**热路径（backend 取根目录）不能读文件系统**，解析结果缓存在 `graph/workspace.py` 的 `_resolved_cache` 里。**每轮运行开跑前都重新校验并刷新缓存**（只缓存首次结果的话，目录被删后校验会永远命中）；HITL 恢复不经过 `before_agent`，模型调用前缓存未命中时会补一次线程解析。③ **工作空间不合法就失败，不静默退回默认目录**：前端选的目录被删了 → **下一轮开跑前**的 `before_agent` 会重新校验并抛 `WorkspaceError`（框架的 `LocalShellBackend.execute` 有个宽泛的 `except Exception`，会把它变成命令错误输出，但中间件会更早拦住）。**`WorkspaceError` 必须继承 `ValueError`**：平台只透传内置异常的 message，裸 `Exception` 会被打码成 "An internal error occurred"（真实服务实测，见 `API.md`）。退回默认目录等于把 agent 的写操作落到用户没选过的目录里；运行中途被删不会每次工具调用都重新 stat（热路径只读缓存）。④ **没选工作空间 = 用后端默认工作空间**（`SCODE_WORKSPACE` 或启动时的 cwd），不是拒绝一切操作——原生跑法（`cd project && uv run scode`）里用户没有前端可选。⑤ **文件工具同时认虚拟路径和绝对路径**：框架的 `virtual_mode` 把**绝对路径也当虚拟路径**处理（`/Users/me/proj/x.py` → `<工作空间>/Users/me/proj/x.py`），而系统提示词里写了工作空间的绝对路径之后，模型偶尔会直接拿它调 `write_file`——文件就落到工作空间里的奇怪嵌套目录里，**还不报错**（实测踩到）。`graph/backend.py` 的 `_workspace_relative()` 剥掉工作空间前缀，两种写法指向同一个文件；剥不掉的工作空间外绝对路径交回框架（出不去工作空间）。**剥前缀要对着工作空间的两种路径形态各试一次**（015 期修）：根目录是**软链展开后**的真实路径（`resolved`），而模型手里的绝对路径可能是用户手打的那条（`given`，没展开软链）——macOS 上 `/tmp` → `/private/tmp` 就是这种。只拿 `resolved` 去比，`relative_to` 直接失配 → 前缀剥不掉 → 文件落进嵌套目录，还不报错（实测：工作空间 `/tmp/x` + 模型传 `/tmp/x/.scode-memory.md` → 落到 `/tmp/x/tmp/x/.scode-memory.md`）。两种形态都存在 `graph/workspace.py` 的 `WorkspaceRoot` 里，解析时一起算好缓存起来（热路径只读缓存，不碰文件系统）。⑥ **选目录靠系统原生弹窗，不靠后端列目录**：`POST /workspaces/pick` 让后端起 `osascript -e 'choose folder'` / `zenity --file-selection --directory` / PowerShell 的 `FolderBrowserDialog`（`stupid_code/admin/workspaces.py`）。浏览器的目录选择 API（`showDirectoryPicker()` / `<input webkitdirectory>`）**故意不暴露绝对路径**，绕不过去；而「后端返回目录列表」那种设计等于把文件系统目录树开放成 HTTP 接口，得配白名单和一堆安全说明。**这个端点会阻塞到用户在弹窗里选完**（上限 600 秒），别在 async 函数里直接做阻塞 IO（blockbuster 会拦）。**同一时刻只允许一个弹窗**（重复请求 409）：它占的是默认 executor 线程，和文件工具 / 记忆读写共用一个池，并发请求会把池子占满。⑦ **「之前聊过的项目」列表不走后端**：工作空间记在 thread 的 `metadata.workspace` 里，前端从线程列表直接读。**前端还会在发消息时把 `workspace` / `permissions` 写进 thread metadata**，刷新页面后用 `hydrateTaskSettings()` 回填 `taskStore`（它只在内存里）；审批挂起期间两个选择器禁用——恢复请求会原样带回这两个值，否则会出现「批准的是 A 目录的命令，却在 B 目录执行」。⑧ **`/tmp/` 路由不能吃掉工作空间自己的绝对路径**：`CompositeBackend` 的 `/tmp/ → StateBackend` 路由先于 default backend「剥前缀」生效，工作空间在 `/tmp/...`（Linux 的 `mktemp -d` 默认就在那儿）时，模型传的宿主绝对路径会被写进虚拟 FS。`graph/backend.py` 的 `WorkspaceCompositeBackend` 在路由前判断 key 是否以当前工作空间开头，是就交给 default；虚拟 `/tmp/...`（不在工作空间下）仍然走 StateBackend。
## Code style

- 注释和 docstring 用中文；标识符、命令、库名保持英文原样
- 后端：类型注解齐全，偏现代写法（`X | None`），HTTP 用 `httpx`；涉及子进程时注意信号与进程组处理（`launcher.py` 已处理 SIGTERM/SIGINT→优雅关闭）
- 前端：**`strict` 模式没有开**（`tsconfig.app.json` 里没有 `strict` 键），但有 `verbatimModuleSyntax`、`noUnusedLocals`、`noUnusedParameters`、`erasableSyntaxOnly` —— 类型检查只在 `pnpm build` 时跑
- 主题走 Tailwind CSS 变量（亮/暗），类名合并用 `lib/cn.ts`

## 测试与验证

没有自动化测试。验证靠文档里的手工步骤，照 `docs/backend/PROGRESS.md` 的结构续写新一期的内容：**目标 / 成功标准 / 本期不做 / 关键取舍 / 验证步骤（带 curl）/ 常见问题 / 已验证的事实**。最后一节很重要——把踩过的坑固化下来，别让下一个人重新踩。

## 文档会滞后于代码

`README.md` 只写「这是什么 / 怎么跑 / 注意事项」，**细节一律指向 `docs/` 下的文档**，别把实现细节又堆回 README：

- `docs/backend/PROGRESS.md` —— 后端的**活文档**，每期一节，最新一期在最后
- `docs/overall-design.md` —— 目标架构与前后端契约，写的是**设计**，与代码有出入时以 `PROGRESS.md` 为准
- `docs/learning-path.md` —— 框架背景与学习路线，框架升级后要回头核一遍

以代码为准；改到相关代码时顺手把对应段落更新掉。

## PR & commit conventions

- 默认分支 `master`，暂无远端
- Commit 用 conventional commits，英文：`feat:` / `fix:` / `docs:` / `docs(backend):`（带 scope 用括号）
- 保持提交范围单一，一个 commit 一件事

## Security

- **API key 只走环境变量**。`.env`、`.env.*` 已被 gitignore（`!.env.example` 例外），别把 key 硬编码或提交
- 后端**只监听 `127.0.0.1`**。绝不要绑 `0.0.0.0`——这个 agent 天生带 shell 执行和文件写权限，暴露到 `0.0.0.0` 是设计文档里列为「影响极高」的风险
- deepagents 是 "trust the LLM" 模型：agent **不会自我约束**，边界必须在工具层/沙箱层强制执行，别指望模型自觉
- 危险操作走人工确认（`HumanInTheLoopMiddleware` + checkpointer），边界条件必须落盘持久化，不能重算
- **shell 已有人工确认**（009 期）：`graph/permissions.py` 按运行期 `configurable.permissions` 的档位决定拦不拦（`auto` 全放行 / `manual` 每条都问 / `normal` 只问命中危险模式的），拦下时图挂起，前端弹确认卡片，批准/拒绝/改后执行后用 `command.resume` 让图继续。**拦 `execute` 和 `delete`**（015 期起）：`delete` 删目录是递归的、跟 `rm -rf` 等价，模型换个工具就能绕过确认——但它只在 `manual` 档拦，`normal` 档不拦（删文件是 code agent 的日常）。`write_file`/`edit_file` 不拦。agent 仍能读工作空间里的任何文件（包括 `conf/config.toml` 里的 api_key），这**没有**被 HITL 覆盖
- **HITL 的判定判据记在图状态里，不读客户端回传的值**（015 期）：框架的 `when` 谓词**在恢复时会再跑一次**，且要求给出同样的答案。档位只从运行配置里读的话，恢复时回传的值一变，被用户拒绝的命令会照样执行（框架文档：the reviewer's answer is skipped and the tool runs, even if they rejected it）。所以 `PermissionLevelMiddleware` 在开跑前把档位写进 state，谓词优先读它。**恢复时 `before_agent` 不会重跑**（实测），state 里留的就是发起那轮运行时的那一档。子 agent 的谓词读的是子 agent 自己的 state，所以每个子 agent 也挂一份这个中间件
- **工作空间不要包含后端仓库**（013 期补充）：agent 有工作空间的**写**权限。工作空间就是仓库根时，它能改 `conf/mcp.json`（里面可以写 stdio `command`）和后端源码，而这些会在下次启动时执行——等于绕开 `execute` 的人工确认。原生跑法用 `SCODE_WORKSPACE=/path/to/project` 指向单独目录（`cd /path/to/project && uv run --project /path/to/stupid-code scode`）；scode 检测到工作空间就是仓库时会打印警告
- **MCP 是一个新的执行/注入面**：`conf/mcp.json` 里的 stdio 服务器在**建图时直接拉起命令**，服务器给的工具有副作用、工具描述会进模型上下文。只配信任的服务器；这个文件已 gitignore，仓库只提供 `conf/mcp.example.json`
- **恢复挂起的运行有两个硬约束**：① 请求体要带同一个 `configurable.permissions`（后端判定在恢复时会再跑一次，档位变了结论就变）；② `command.resume.decisions` 的个数必须和挂起时的 `action_requests` 一样多，否则框架直接抛 `Number of human decisions (N) does not match number of hanging tool calls (M)`，整个运行报错
- **框架的 reject 理由字段叫 `message`，不叫 `feedback`**（`RejectDecision` 的定义）。写错名字理由被静默丢掉，模型只看到"用户拒绝了这次工具调用"
- **目录选择靠系统原生弹窗**（`POST /workspaces/pick`），后端不提供「列目录」接口——那等于把文件系统目录树开放成 HTTP 接口。该端点会阻塞到用户选完，后端仍只监听 `127.0.0.1`
