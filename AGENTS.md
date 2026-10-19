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

- `stupid_code/` — 后端包，按职责分四块。`agent.py` 导出 `graph`（`create_deep_agent()`）；`launcher.py` 是 `scode` 的启动/就绪/关停逻辑；`persistence.py` 把 checkpoint/store 落到 `data/langgraph.db`（SQLite，不入库）；`model_config.py` 读 `conf/config.toml` 并构建模型；`admin/` 是挂在 `/admin` 下的管理接口
- `stupid_code/README.md` — 后端启动说明；`stupid_code/API.md` — 当前实际可用的端点清单
- `web/src/api/` — 后端通信层，`mock/` 用**与真实后端完全相同的签名**实现假数据；`web/src/store/` Zustand 状态；`components/`、`pages/`、`lib/`
- `docs/overall-design.md` — 目标架构与前后端契约；`docs/frontend-design.md` — 前端交互设计
- `docs/backend/001_*.md` — 按阶段推进的后端任务文档（见「测试与验证」）
- `skills-lock.json` — langchain-skills 安装记录与 hash，**已入库**，用来追踪参考资料版本

## 动手前必须知道的几件事

1. **`.agents/` 和 `.claude/` 是 gitignore 的**。clone 后必须先装参考资料，否则编码 Agent 看不到它们：
   `npx skills add langchain-ai/langchain-skills --skill '*' --yes`
   然后 `ls .agents/skills | head` 确认。**写 deepagents / LangGraph 代码前先查这些 skill 和线上文档，别凭记忆写**——框架还在 0.x，迭代很快。
2. **不要给 `create_deep_agent()` 传 `checkpointer`**。`langgraph dev` 会直接抛 ValueError（ValueError: persistence 由平台自动处理）。持久化在 `langgraph.json` 配置：`checkpointer`/`store` 指向 `persistence.py` 的 SQLite 工厂，checkpoint 落 `stupid_code/data/langgraph.db`，重启后对话历史可恢复。
3. **`langgraph.json` 里写死了三个文件路径**：`./agent.py:graph`、`./persistence.py:checkpointer`、`./admin/app.py:app`。挪这三个文件必须同步改 `langgraph.json`，否则启动时报找不到模块。另有两个文件用 `__file__` 定位目录，因此只能待在 `stupid_code/` 根这一层：`model_config.py`（`../conf`）、`launcher.py`（本包目录）。`scode` 启动时会把这些相对路径绝对化后写进 `$TMPDIR/scode-config-*`，所以**作者视角的路径仍相对 `stupid_code/` 写**。
4. **`.langgraph_api/` 要留着，别删**：inmem 运行时把它硬编码为相对 cwd 的路径，无法配置改位。里面的 `.langgraph_ops.pckl` 是 **thread 索引**（会话列表与 metadata 的来源）——checkpoint 确实已由 `persistence.py` 的 SQLite 工厂接管（同名的 `.langgraph_checkpoint.*.pckl` 是空的），但删掉 ops 索引后平台重启就认不出已有 thread：`/threads/search` 返回空、`/threads/{id}/state` 404，历史数据还躺在 `stupid_code/data/langgraph.db` 里却取不出来。所以 scode **不再清理**它；持久状态分两处，缺一不可。派生 langgraph.json（相对路径绝对化）只放 `$TMPDIR/scode-config-*`，退出即删。后端源码目录不进运行 cwd，不会被写 `.langgraph_api` / `__pycache__`。
5. **`GET /assistants` 返回 405**。列 assistant 要用 `POST /assistants/search`，再拿 `assistant_id`（UUID）去 `GET /assistants/{id}/graph`。
6. **前端已经按契约写完了，后端要"实现前端已假定的契约"，不是"对齐已有实现"**。改后端接口前先看 `stupid_code/API.md` 和 `web/src/api/`。`GET /directories` 前端已在调用但后端**未实现**——工作空间选择器在真后端下报错是预期的，不是 bug。
7. **SSE 一律用 fetch + 手动解析，不用 `EventSource`**（已定事项，别改回去）。
8. **工作空间 + 权限是任务级参数**，按 `threadId` 存而非全局：同任务内前后两条消息可能针对不同目录。另有 `draft` 副本供新任务用，`createThread()` 时 `adoptDraft()` 固化并重置，否则两个任务的运行边界会串。

## Code style

- 注释和 docstring 用中文；标识符、命令、库名保持英文原样
- 后端：类型注解齐全，偏现代写法（`X | None`），HTTP 用 `httpx`；涉及子进程时注意信号与进程组处理（`launcher.py` 已处理 SIGTERM/SIGINT→优雅关闭）
- 前端：**`strict` 模式没有开**（`tsconfig.app.json` 里没有 `strict` 键），但有 `verbatimModuleSyntax`、`noUnusedLocals`、`noUnusedParameters`、`erasableSyntaxOnly` —— 类型检查只在 `pnpm build` 时跑
- 主题走 Tailwind CSS 变量（亮/暗），类名合并用 `lib/cn.ts`

## 测试与验证

没有自动化测试。验证靠文档里的手工步骤，照 `docs/backend/001_basic_agent_server.md` 的结构写新的阶段文档：**目标 / 成功标准 / 本期不做 / 关键取舍 / 验证步骤（带 curl）/ 常见问题 / 已验证的事实**。最后一节很重要——把踩过的坑固化下来，别让下一个人重新踩。

## 文档会滞后于代码

`README.md` 的「当前状态」、`docs/overall-design.md` §1.3 和 §9 的目录结构是按早期状态写的，**落后于代码**：后端依赖已装、`langgraph.json` 在 `stupid_code/` 里（不在根目录）、后端 Agent 已可跑。以代码为准；改到相关代码时顺手把对应段落更新掉。

## PR & commit conventions

- 默认分支 `master`，暂无远端
- Commit 用 conventional commits，英文：`feat:` / `fix:` / `docs:` / `docs(backend):`（带 scope 用括号）
- 保持提交范围单一，一个 commit 一件事

## Security

- **API key 只走环境变量**。`.env`、`.env.*` 已被 gitignore（`!.env.example` 例外），别把 key 硬编码或提交
- 后端**只监听 `127.0.0.1`**。绝不要绑 `0.0.0.0`——这个 agent 天生带 shell 执行和文件写权限，暴露到 `0.0.0.0` 是设计文档里列为「影响极高」的风险
- deepagents 是 "trust the LLM" 模型：agent **不会自我约束**，边界必须在工具层/沙箱层强制执行，别指望模型自觉
- 危险操作走人工确认（`HumanInTheLoopMiddleware` + checkpointer），边界条件必须落盘持久化，不能重算
- `/directories` 会暴露文件系统结构——需要路径白名单，且只允许本地监听
