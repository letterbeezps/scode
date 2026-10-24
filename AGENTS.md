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

## Project layout

- `stupid_code/` — 后端包。顶层只放入口与起停，实现按职责分包：`__init__.py` 是 `start()` 入口、`launcher.py` 是 `scode` 的启动/就绪/关停逻辑、`langgraph.json` 是框架读的配置；`graph/`（`agent.py` 导出 `graph`，`memory.py` 装配长期记忆中间件，`model_switch.py` 是运行期切换对话模型的中间件，`compaction.py` 是 `/compaction` 手动压缩历史，`permissions.py` 是 shell 人工确认的档位与危险判定，`backend.py` 装真实磁盘+shell 的 backend，`persistence.py` 把 checkpoint/store 落到 `data/langgraph.db`）、`config/`（`model.py` 读 `conf/config.toml`、`subagent.py` 读 `conf/subagents.toml`、`prompts.py` 是主 agent 的系统提示词）、`admin/` 是挂在 `/admin` 下的管理接口
- `stupid_code/README.md` — 后端启动说明；`stupid_code/API.md` — 当前实际可用的端点清单
- `web/src/api/` — 后端通信层，`mock/` 用**与真实后端完全相同的签名**实现假数据；`web/src/store/` Zustand 状态；`components/`、`pages/`、`lib/`
- `docs/overall-design.md` — 目标架构与前后端契约；`docs/frontend-design.md` — 前端交互设计；`docs/learning-path.md` — 框架背景与学习路线
- `docs/backend/PROGRESS.md` — 后端进度快照（001–011 期合并成一份，见「测试与验证」）
- `skills-lock.json` — langchain-skills 安装记录与 hash，**已入库**，用来追踪参考资料版本

## 动手前必须知道的几件事

1. **`.agents/` 和 `.claude/` 是 gitignore 的**。clone 后必须先装参考资料，否则编码 Agent 看不到它们：
   `npx skills add langchain-ai/langchain-skills --skill '*' --yes`
   然后 `ls .agents/skills | head` 确认。**写 deepagents / LangGraph 代码前先查这些 skill 和线上文档，别凭记忆写**——框架还在 0.x，迭代很快。
2. **不要给 `create_deep_agent()` 传 `checkpointer`**。`langgraph dev` 会直接抛 ValueError（ValueError: persistence 由平台自动处理）。持久化在 `langgraph.json` 配置：`checkpointer`/`store` 指向 `graph/persistence.py` 的 SQLite 工厂，checkpoint 落 `stupid_code/data/langgraph.db`，重启后对话历史可恢复。
3. **`langgraph.json` 里写死了三个文件路径**：`./graph/agent.py:graph`、`./graph/persistence.py:checkpointer`、`./admin/app.py:app`。挪这三个文件必须同步改 `langgraph.json`，否则启动时报找不到模块。另有几个模块用 `__file__` 定位目录，**层数跟包结构绑死**：`config/model.py` 与 `config/subagent.py` 定位项目根（`parents[2] / "conf"`）、`graph/persistence.py` 定位包根的 `data/`（`parents[1] / "data"`）、`launcher.py` 定位本包目录（langgraph.json 所在处，不能挪）。再往下挪目录要同步改这些层数。`scode` 启动时会把 langgraph.json 里的相对路径绝对化后写进 `$TMPDIR/scode-config-*`，所以**作者视角的路径仍相对 `stupid_code/` 写**。
4. **`.langgraph_api/` 要留着，别删**：inmem 运行时把它硬编码为相对 cwd 的路径，无法配置改位。里面的 `.langgraph_ops.pckl` 是 **thread 索引**（会话列表与 metadata 的来源）——checkpoint 确实已由 `graph/persistence.py` 的 SQLite 工厂接管（同名的 `.langgraph_checkpoint.*.pckl` 是空的），但删掉 ops 索引后平台重启就认不出已有 thread：`/threads/search` 返回空、`/threads/{id}/state` 404，历史数据还躺在 `stupid_code/data/langgraph.db` 里却取不出来。所以 scode **不再清理**它；持久状态分两处，缺一不可。派生 langgraph.json（相对路径绝对化）只放 `$TMPDIR/scode-config-*`，退出即删。后端源码目录不进运行 cwd，不会被写 `.langgraph_api` / `__pycache__`。
5. **`GET /assistants` 返回 405**。列 assistant 要用 `POST /assistants/search`，再拿 `assistant_id`（UUID）去 `GET /assistants/{id}/graph`。
6. **前端已经按契约写完了，后端要"实现前端已假定的契约"，不是"对齐已有实现"**。改后端接口前先看 `stupid_code/API.md` 和 `web/src/api/`。`GET /directories` 前端已在调用但后端**未实现**——工作空间选择器在真后端下报错是预期的，不是 bug。
7. **SSE 一律用 fetch + 手动解析，不用 `EventSource`**（已定事项，别改回去）。
8. **工作空间 + 权限是任务级参数**，按 `threadId` 存而非全局：同任务内前后两条消息可能针对不同目录。另有 `draft` 副本供新任务用，`createThread()` 时 `adoptDraft()` 固化并重置，否则两个任务的运行边界会串。**对话模型不是任务级参数**——它是全局偏好（存 localStorage），每次运行随 `configurable.model` 发给后端。
9. **deepagents 0.7.28 不再提供内置系统提示词**。`BASE_AGENT_PROMPT` 在 0.7.0 废弃（0.9.0 移除），`HarnessProfile.base_system_prompt` 默认 `None`，内置的几个 claude profile 也没设。**`create_deep_agent(system_prompt=...)` 传进去的就是模型唯一看到的系统提示词**——别以为框架会垫底，行为准则要自己写全（见 `stupid_code/config/prompts.py`）。验证方法：用假模型把 `request.system_message` 打出来。
10. **长期记忆用 `middleware=` 挂 `MemoryMiddleware`，别用 `create_deep_agent(memory=...)`**。两者是同一个中间件，但 `memory=` 只能用框架默认的 backend——默认是 StateBackend（虚拟文件系统），**读不到磁盘上的 `.scode-memory.md`**。自己挂才能给 `FilesystemBackend`（见 `stupid_code/graph/memory.py`）。另外记忆**只在会话开始时读一次**，改完文件要开新会话才生效。记忆文件名是 `.scode-memory.md` 而不是框架默认的 `AGENTS.md`：后者是"写给编码 agent 看的项目约定"（本项目根目录那份就是），和 agent 自己攒的长期记忆语义不同，混用会把开发者的项目说明当记忆注入。
11. **端口锁死 2024，被占用就直接启动失败**。`langgraph dev` 在 2024 被占时会自动换端口（日志里 `Port 2024 is already in use, using port NNNNN instead`），而 launcher 的就绪检查只轮询 2024——早期版本因此会在 2024 被旧服务占着时**误报"已就绪"**（前端连的是旧代码，看起来像"改了没生效"）。现在 launcher 启动前先探端口：2024 被占就**启动失败**并告诉你怎么查占用进程，**绝不自动换端口**（前端默认就连 2024，换了没法用）。另外启动途中 Ctrl+C 也会整组清理子进程，早期版本会漏、留下占端口的孤儿。
12. **backend 是真实磁盘 + 本机 shell**（007 期）。`graph/backend.py` 构造 `CompositeBackend(default=LocalShellBackend)`：agent 的 `write_file` / `edit_file` 改的是工作空间里的真文件，`execute` 能跑任意命令。**框架有条硬限制**：backend 支持命令执行时，`FilesystemMiddleware` 不接受 `permissions`（直接抛 `NotImplementedError`）——shell 能绕过任何文件权限，权限和 shell 不能共存。所以 `graph/backend.py` 的 `apply_permission_backend()` 会给**声明了 `permissions` 的子 agent** 换成无 shell 的 `FilesystemBackend`，`conf/subagents.toml` 里 `reviewer` 的只读就是靠这个保证的。改子 agent 配置时别把 `permissions` 直接塞回规格里。
13. **切换对话模型靠中间件，不靠重建图**（010 期）。`graph/model_switch.py` 的 `ChatModelSwitchMiddleware` 覆盖 `wrap_model_call` / `awrap_model_call`，把 `request.model` 换成用户在界面上选的那个——框架最终是拿 `request.model.bind_tools(...)` 发请求的，所以换了就是真换。三个容易踩的点：① **`ModelRequest.runtime` 是 `Runtime`，没有 `.config` 属性**（只有 `ToolCallRequest.runtime` 才有），取 `configurable` 要用 `langgraph.config.get_config()`；② 中间件在 `middleware=` 列表里**越靠前越外层**，切换中间件要排在 prompt-caching / memory 之前，那些中间件才看得到换过的模型；**但 deepagents 是按 `.name` 把自定义中间件合并进基础栈的**（撞名原地替换、不撞就追加到 core 之后），所以压缩中间件留在 core 段、**位于切换中间件外层**，它内部读 `request.model` 看到的仍是启动时的模型（摘要本身不受影响，摘要自己按 `configurable` 解析）；③ 切换**只作用于主 agent**——子 agent 一律用各自原有的模型（`conf/subagents.toml` 里写死的，或建图时继承来的）。框架上做得到让子 agent 也跟着切（子 agent 的中间件也拿得到父图的 `configurable`），但**别那么做**：子 agent 用哪个模型是配置出来的（本项目 `reviewer`/`summarizer` 刻意用便宜的 `MiniMax-M3.1-Flash`），用户在下拉框选模型的意图是「这段对话用这个模型」，让委派出去的活跟着烧新模型会打乱配置好的成本结构。要改子 agent 的模型，去 `conf/subagents.toml` 写死。切换**不重启后端**：那条路径每次调用都重读 `conf/config.toml`，所以新增模型、改 base_url / api_key 立刻生效；但 harness profile 和摘要阈值是建图时定的，不跟着换。
14. **压缩历史用 `graph/compaction.py` 的 `CompactionMiddleware`**（011 期）。它继承 deepagents 的 `SummarizationMiddleware` 并做三件事：① `.name` 报成**框架自带那一份的公开别名**——别名**从框架那里问出来，不写死字面量**（框架升级改了公开别名，写死的字符串就对不上，会静默变成两份摘要中间件）——这样才能**顶掉** `create_deep_agent()` 自带的那份（deepagents 按 `.name` 合并：撞名原地替换，不撞就多一份；两份摘要中间件同时跑会重复压缩）；② 覆盖 `_should_summarize()`，用户发 `/compaction` 就强制压缩一次（**只看最后一条用户消息**，命令消息会留在对话里，否则下一轮又压一次）；③ 用 `summarizer=` 这个公开扩展点接管摘要调用，让摘要也用**当前选中的模型**——框架默认把摘要模型在构造时就固定了（`self._summary_chat_model = self.model`），切了模型之后压缩还在烧旧供应商。别用 `RunnableLambda` 包同步函数来实现摘要：`ainvoke` 会把它丢进线程池，`get_config()` 依赖 contextvar，跨线程拿不到 `configurable`，会静默退回默认模型——要自己实现 `invoke`/`ainvoke`。被摘走的旧消息会落到工作空间的 `conversation_history/`（已 gitignore），agent 能 `read_file` 读回来。

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
- **shell 已有人工确认**（009 期）：`graph/permissions.py` 按运行期 `configurable.permissions` 的档位决定拦不拦（`auto` 全放行 / `manual` 每条都问 / `normal` 只问命中危险模式的），拦下时图挂起，前端弹确认卡片，批准/拒绝后用 `command.resume` 让图继续。**只拦 `execute`**，文件类工具（`write_file`/`edit_file`/`delete`）不拦——那是 code agent 的日常。agent 仍能读工作空间里的任何文件（包括 `conf/config.toml` 里的 api_key），这**没有**被 HITL 覆盖
- **恢复挂起的运行有两个硬约束**：① 请求体要带同一个 `configurable.permissions`（后端判定在恢复时会再跑一次，档位变了结论就变）；② `command.resume.decisions` 的个数必须和挂起时的 `action_requests` 一样多，否则框架直接抛 `Number of human decisions (N) does not match number of hanging tool calls (M)`，整个运行报错
- **框架的 reject 理由字段叫 `message`，不叫 `feedback`**（`RejectDecision` 的定义）。写错名字理由被静默丢掉，模型只看到"用户拒绝了这次工具调用"
- `/directories` 会暴露文件系统结构——需要路径白名单，且只允许本地监听
