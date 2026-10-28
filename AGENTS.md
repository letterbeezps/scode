# AGENTS.md

基于 LangChain Deep Agents + LangGraph 的**网页版 code agent**，前端是独立的 Vite + React SPA。
这是个**学习项目**：以「能跑、能看懂、能改」为标准，不追求生产级完备。代码粗糙甚至出错是预期内的，别顺手"补全"成另一套工程规范。

> **这个文件是「硬约束清单」，不是说明书。** 每条只给结论和一句话原因；机制细节、框架源码细节、实测数据都在
> [`docs/backend/PROGRESS.md`](docs/backend/PROGRESS.md)（下称 **PROGRESS**），那里有「硬约束 → 小节」速查表。动代码前先看
> 对应小节，别凭印象改。

---

## 仓库形态

根目录 `pyproject.toml` 只管后端；`web/` 是完全独立的 pnpm 项目，不参与 uv 依赖管理。**改后端不要碰 `web/`，反之亦然。**

## Setup commands

**后端**（Python ≥ 3.12，uv + hatchling）

```bash
uv sync          # 装依赖
uv run scode     # 跑起来（运行它的那个目录 = agent 的工作空间）
uv run langgraph validate --config stupid_code/langgraph.json
```

改后端代码**必须重启**（scode 传 `--no-reload`）。监听 `127.0.0.1:2024`。

**前端**（pnpm 12）

```bash
cd web && pnpm install
pnpm dev     # 5173，/api/* 代理到 VITE_LANGGRAPH_URL（默认 http://localhost:2024）
pnpm build   # tsc -b && vite build（含类型检查）
pnpm lint    # oxlint
VITE_USE_MOCK=true pnpm dev   # 无后端时用 mock（默认关闭）
```

Python 侧**没有** ruff / black / mypy，**整个仓库没有测试、没有 CI**。不要发明这些命令。

**Docker（可选）**：`docker compose up --build`（全栈）／`docker compose up -d backend`（只起后端）；工作空间由 `SCODE_WORKSPACE`
决定，挂到容器里的 `/workspace`。

## Project layout

完整目录树见 PROGRESS §2.1。关键几处：

| 路径 | 内容 |
|---|---|
| `stupid_code/graph/` | `agent.py` 建图 · `backend.py` 磁盘+shell · `subagent_policy.py` 子 agent 策略 · `workspace.py` 工作空间 · `memory.py`+`paths.py` 长期记忆/路径常量 · `skills.py` skill · `model_switch.py` 切模型 · `compaction.py` 压缩 · `mcp.py` MCP · `permissions.py` 人工确认 · `persistence.py` SQLite |
| `stupid_code/config/` | 读 `conf/` 下三个配置：`model.py` / `subagent.py` / `mcp.py`；`prompts.py` 是系统提示词 |
| `stupid_code/admin/` | `/admin` 下的接口：`models.py` / `memory.py` / `skills.py`（共用 `common.py` 的工作空间解析）；`workspaces.py` 是 `POST /workspaces/pick` |
| `web/src/` | `api/` 通信层（`mock/` 用**与真实后端完全相同的签名**）· `store/` Zustand · `components/` `pages/` `lib/` |
| `docs/` | `backend/PROGRESS.md` 活文档 · `overall-design.md` 目标契约 · `frontend-design.md` 前端 · `learning-path.md` 框架背景 |

---

## 硬约束

动手前至少扫一遍这 20 条。每条末尾的 **→** 指向 PROGRESS 的对应小节（个别指向 README），细则在那里。

1. **clone 后先装参考资料**：`.agents/` 和 `.claude/` 是 gitignore 的，跑
   `npx skills add langchain-ai/langchain-skills --skill '*' --yes`，否则编码 Agent 看不到它们。
   **写 deepagents / LangGraph 代码前先查这些 skill 和线上文档，别凭记忆写**——框架还在 0.x，迭代很快。*→ README「1. 装 skills」*

2. **别给 `create_deep_agent()` 传 `checkpointer`**——`langgraph dev` 会直接抛 ValueError（persistence 由平台自动处理）。
   持久化在 `langgraph.json` 里配（`graph/persistence.py` 的 SQLite 工厂），checkpoint 落 `stupid_code/data/langgraph.db`。
   *→ §4.1*

3. **三个文件路径写死在 `langgraph.json` 里**：`./graph/agent.py:graph`、`./graph/persistence.py:checkpointer`、
   `./admin/app.py:app`——挪了要同步改，否则启动找不到模块。另有几个模块用 `__file__` 定位目录，**层数跟包结构绑死**
   （具体哪几个、各是第几层见 §2.2）。**作者视角的路径仍相对 `stupid_code/` 写**。*→ §2.2*

4. **`.langgraph_api/` 要留着，别删**：里面的 `.langgraph_ops.pckl` 是 **thread 索引**（会话列表的来源）。checkpoint 归
   SQLite 管，但删掉 ops 索引后平台重启就认不出已有 thread，历史数据躺在 `langgraph.db` 里取不出来——**持久状态分两处，
   缺一不可**。*→ §4.2*

5. **`GET /assistants` 返回 405**——列 assistant 用 `POST /assistants/search`，再拿 `assistant_id` 去
   `GET /assistants/{id}/graph`。*→ §8.1*

6. **前端已按契约写完了，后端要"实现前端已假定的契约"，不是"对齐已有实现"**。改后端接口前先看
   `stupid_code/API.md` 和 `web/src/api/`。工作空间那条链路 014 期已闭环，别再按旧文档以为它只是「只透传」。*→ §4.1*

7. **SSE 一律用 fetch + 手动解析，不用 `EventSource`**（已定事项，别改回去）——后者不支持自定义 header。*→ §4.2*

8. **`workspace` / `permissions` / `skills` 是任务级参数**，按 `threadId` 存而非全局：同任务内前后两条消息可能针对不同目录、
   不同 skill。另有 `draft` 副本，`createThread()` 时 `adoptDraft()` 固化并重置，否则两个任务的运行边界会串。**`model` 不是
   任务级**——它是全局偏好（localStorage），但每次 run 仍随请求走。四个参数都放在 run 的 **`context`** 里（后端
   `graph/run_context.py` 的 `RunContext` 是 `context_schema`），**不再塞进 `configurable`**；同一请求不能同时带
   `context` 和 `config.configurable`，`thread_id` 仍由平台放在 `configurable` / URL 里。**恢复挂起的运行时，这些都要原样带回去。**
   *→ §4.4*

9. **deepagents 0.7.x 不再提供内置系统提示词**。`create_deep_agent(system_prompt=...)` 传进去的**就是模型唯一看到的
   系统提示词**——别以为框架会垫底，行为准则要自己写全（`stupid_code/config/prompts.py`）。*→ §4.3*

10. **长期记忆用 `middleware=` 挂 `MemoryMiddleware`，别用 `create_deep_agent(memory=...)`**（后者只能用框架默认的
    StateBackend 虚拟文件系统，读不到磁盘上的文件）。另有四条：**文件不自动创建**；**用本项目的中文模板**；**8000 字上限**；
    **文件名 `.scode-memory.md`**。*→ 006 / §8.11*

11. **端口锁死 2024，被占用就启动失败**——`langgraph dev` 自己会换端口，就绪检查只轮询 2024，会打到旧服务上**误报"已就绪"**
    （前端连旧代码，像"改了没生效"）。**绝不自动换端口**，前端默认就连 2024。*→ 008 / §9*

12. **backend 是真实磁盘 + 本机 shell**（`LocalShellBackend`）。框架硬限制：backend 支持命令执行时，`FilesystemMiddleware`
    **不接受 `permissions`**（shell 能绕过任何文件权限）。所以声明了 `permissions` 的子 agent 要换成无 shell 的 backend，且
    **不继承 MCP 工具**；改子 agent 配置时别把 `permissions` 塞回规格里。*→ 007 / 012*

13. **切换对话模型靠中间件，不靠重建图**。① `ModelRequest.runtime` **没有 `.config` 属性**，但**有 `.context`**——切模型直接读
    `request.runtime.context.model`；只有摘要路径（拿不到 Runtime）才用 `langgraph.config.get_config()` 读平台镜像的
    `configurable`；② `middleware=` 里**越靠前越外层**，切换中间件要排在 prompt-caching / memory 之前；
    ③ 切换**只作用于主 agent**，`isolated` / `general-purpose` 子 agent 用各自配置里的模型——**别让子 agent 跟着切**。
    `mode="fork"` 的子 agent 会继承父级**全部 middleware**，所以 `agent.py` 用 `apply_model_switch_policy()` 往它的规格里塞一个同名但
    `enabled=False` 的切换中间件，顶掉继承来的那个；新增 fork 入口时别漏掉这一步。*→ 010 / §8.5*

14. **压缩历史用 `graph/compaction.py` 的 `CompactionMiddleware`**。① `.name` 报成**框架自带那一份的公开别名**（从框架问出来，
    不写死字面量）；② 用 `summarizer=` 这个公开扩展点接管摘要调用，让摘要用**当前选中的模型**；③ **别用 `RunnableLambda` 包
    同步函数**。*→ 011 / §8.6*

15. **容器里跑有三个坑**：① **`/app`（后端代码）和 `/workspace`（agent 工作空间）必须分开**，合并会让容器直接
    `ModuleNotFoundError`；② **必须 editable 安装**；③ `web/nginx.conf` 里 **`set` 必须写在 `rewrite` 前面**，SSE 那段必须
    `proxy_buffering off` + `proxy_read_timeout 3600s`；`conf/config.toml` **别打进镜像**。*→ 012*

16. **MCP 工具是建图时静态注册的**——改 `conf/mcp.json` 要重启后端。① **协议一行都别手写**，全交给
    `langchain-mcp-adapters` / 官方 `mcp` SDK；② **工具名必须是 `mcp__{服务器}__{工具}`**，**别用 adapter 的
    `tool_name_prefix`**；③ **MCP 工具只有异步实现**；④ **只读子 agent 不能继承 MCP 工具**；⑤ **建图时连服务器是同步阻塞的**，
    必须限时。*→ 013 / §8.8*

17. **工作空间是运行期参数，根目录是 property**（同一张图服务不同项目目录）。① **FS 操作必须走线程**；② **不合法就失败，
    不静默退回默认目录**，且 **`WorkspaceError` 继承 `ValueError`**；③ 没选工作空间 = 用后端默认工作空间，**不是拒绝一切**；
    ④ 绝对路径要对着 `resolved` / `given` **两种形态**剥前缀。*→ 014 / §8.9*

18. **agent 自己的中间产物收在 `<工作空间>/.scode/`**。① **`artifacts_root` 只有 `CompositeBackend` 认**——受限子 agent 的
    backend 要包一层无路由的 CompositeBackend，**别改回裸 `FilesystemBackend`**；② **产物路径必须留在工作空间里**。*→ §8.10*

19. **长期记忆分两个作用域**（项目级 `<工作空间>/.scode-memory.md`、用户级 `~/.scode/memory.md`）。**写记忆要走人工确认**
    （`normal` 和 `manual` 档）——**写记忆是唯一一条"影响未来所有会话"的写路径**，代码写错当场能改，记忆写错会一直影响后面每个
    会话，且没人知道它什么时候写错的；判据只看路径、**纯字符串不碰 FS**（`graph/permissions.py` 的 `is_memory_path()`）。
    *→ §8.11*

20. **skill 分两个作用域**（全局 `~/.scode/.agents/skills/`、项目级 `<工作空间>/.agents/skills/`——目录名是 `.agents` 不是
    `.skills`）。① **全局静态、项目级不是**（工作空间是运行期参数，项目级源**不能**是常量）；② **别传
    `create_deep_agent(skills=...)`**；③ **`.name` 报成框架那份的公开别名**；④ **pin 只在"选择变了"时做**；⑤ **取消勾选不移除已钉
    内容**。*→ §8.12*

---

## Code style

- 注释和 docstring 用中文；标识符、命令、库名保持英文原样
- 后端：类型注解齐全，偏现代写法（`X | None`），HTTP 用 `httpx`；涉及子进程时注意信号与进程组处理（`launcher.py` 已处理 SIGTERM/SIGINT → 优雅关闭）
- 前端：**`strict` 模式没有开**，但有 `verbatimModuleSyntax` / `noUnusedLocals` 等——类型检查只在 `pnpm build` 时跑
- 主题走 Tailwind CSS 变量（亮/暗），类名合并用 `lib/cn.ts`

## 测试与验证

没有自动化测试。验证靠 PROGRESS §7 的手工步骤，照它的结构续写新一期：**目标 / 成功标准 / 本期不做 / 关键取舍 /
验证步骤（带 curl）/ 常见问题 / 已验证的事实**。最后一节很重要——把踩过的坑固化下来，别让下一个人重新踩。

## 文档会滞后于代码

以代码为准；改到相关代码时顺手把对应段落更新掉。`docs/backend/PROGRESS.md` 是后端的**活文档**（每期一节，最新一期在最后，
顶部有硬约束速查表）；`docs/overall-design.md` 写的是**设计**，与代码有出入时以 PROGRESS 为准；`docs/frontend-design.md` 是
前端交互；`docs/learning-path.md` 是框架背景，框架升级后要回头核一遍。`README.md` 只写「这是什么 / 怎么跑 / 注意事项」，
**细节一律指向 `docs/`**。

## PR & commit conventions

- 默认分支 `master`，暂无远端
- Commit 用 conventional commits，英文：`feat:` / `fix:` / `docs:` / `docs(backend):`（带 scope 用括号）
- 保持提交范围单一，一个 commit 一件事

## Security

- **API key 只走 `conf/config.toml`**（gitignore），**不进 `.env`、不入库**
- 后端**只监听 `127.0.0.1`**。**绝不绑 `0.0.0.0`**
- deepagents 是 "trust the LLM" 模型：agent **不会自我约束**，边界必须在工具层/沙箱层强制执行
- 危险操作走人工确认（`HumanInTheLoopMiddleware` + checkpointer），**边界条件必须落盘持久化，不能重算**
- **HITL 的判定判据记在图状态里，不读客户端回传的值**。**恢复挂起的运行有两个硬约束**：请求体带同一个
  `context.permissions`；`command.resume.decisions` 个数必须和挂起时的 `action_requests` 一样多。**框架的 reject 理由字段叫
  `message`，不叫 `feedback`**
- **工作空间不要包含后端仓库**。推荐 `SCODE_WORKSPACE=/path/to/project` 指向单独目录
- **MCP 是一个新的执行/注入面**。**只配信任的服务器**；`conf/mcp.json` 不入库，仓库只提供 `conf/mcp.example.json`
- **文件工具有两条工作空间之外的路径**：`/user-memory/`（`~/.scode/`，**可写**）和 `/user-skills/`（`~/.scode/.agents/skills/`，
  **只读**）。agent 仍能读工作空间里任何文件（包括 `conf/config.toml` 里的 api_key），**这块没被 HITL 覆盖**
- **目录选择靠系统原生弹窗**（`POST /workspaces/pick`），后端不提供「列目录」接口。该端点会阻塞到用户选完，后端仍只监听
  `127.0.0.1`
