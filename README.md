# stupid-code

一个基于 [LangChain Deep Agents](https://docs.langchain.com/oss/python/deepagents/overview) 的 **code agent** 学习项目。

写代码是 agent 最难啃的场景之一：长上下文、跨文件编辑、需要 shell、需要反复试错。这个项目想做的事情就是**亲手把一个 code agent 搭出来**，在踩坑的过程中搞懂 Deep Agents 这个框架到底提供了什么、什么时候该用、以及它的边界在哪里。

> **这是一个学习项目，不是一个产品。** 代码以"能跑、能看懂、能改"为标准，不追求生产级完备。遇到问题先读源码和官方文档，别指望这里有完整的工程规范。

---

## ⚠️ 动手开发前，请先装 langchain-skills

**这一步是必须的，请在动手写代码前先执行：**

```bash
npx skills add langchain-ai/langchain-skills --skill '*' --yes
```

本项目依赖 [langchain-ai/langchain-skills](https://github.com/langchain-ai/langchain-skills) 提供的 22 个 Agent Skills 作为**开发时的参考资料**——框架选型、`create_deep_agent` 的用法、中间件怎么选、LangGraph 的持久化与人工介入……这些内容都在这些 skill 里，不要凭记忆写。

`.agents/` 和 `.claude/` 目录被写进了 `.gitignore`，**不会提交到仓库**。所以每次 clone 之后都必须自己装一遍，否则你的编码 Agent 看不到这些参考文档。

装完之后可以确认一下：

```bash
ls .agents/skills | head
```

看到 `deep-agents-core`、`ecosystem-primer` 等目录就成了。

<details>
<summary>其他安装方式（按需）</summary>

| 场景 | 命令 |
| --- | --- |
| 全局安装（所有项目可用） | `npx skills add langchain-ai/langchain-skills --skill '*' --yes --global` |
| 只装给某个 Agent（如 Claude Code） | `npx skills add langchain-ai/langchain-skills --agent claude-code --skill '*' --yes` |
| 只装单个 skill | `npx skills add langchain-ai/langchain-skills --skill deep-agents-core --yes` |

`npx skills` 遵循 Agent Skills 规范，Claude Code、Cursor、Windsurf 等支持该规范的编码工具都能用。

安装状态记录在 `skills-lock.json` 里（含每个 skill 的内容 hash），可以提交到仓库用来追踪版本。

</details>

---

## 当前状态

**后端 Agent Server 已跑通，前端能连真后端完成一轮对话（001 期完成）。**

后端（`stupid_code/`）：

- 依赖已装齐并锁进 `uv.lock`：`deepagents`、`langchain`、`langchain-anthropic`、`langgraph-cli[inmem]`、`langgraph-sdk`、`langgraph-runtime-inmem`、`langgraph-checkpoint-sqlite`、`httpx`、`pydantic`
- `langgraph.json` 注册了 `code_agent` 图（`./agent.py:graph`），`agent.py` 里 `create_deep_agent()` 导出 `graph`
- `uv run scode` 以子进程拉起 `langgraph dev`（监听 `127.0.0.1:2024`），自动轮询 `GET /ok` 与 `GET /assistants/{id}/graph` 做就绪验证；`Ctrl+C` 或 SIGTERM 会连整个子进程组一起关掉，不留孤儿占端口
- scode 把 langgraph 进程当用完即弃的本地计算进程：**在哪个目录运行 scode，那个目录就是工作空间**（子进程 cwd）；langgraph 必然生成的 `.langgraph_api/` 易失缓存落在工作空间下，但 scode 启动前/退出时各删一次（有价值状态都在 SQLite，删它无损失）；派生 langgraph.json 放 `$TMPDIR/scode-config-*`（退出即删）；唯一持久的是 checkpoint/store，经 `persistence.py` 写入 `stupid_code/data/langgraph.db`（已 gitignore，删掉即重置历史），刷新页面能恢复对话

前端（`web/`）：

- 按 [`docs/frontend-design.md`](docs/frontend-design.md) 实现的任务列表、流式对话、工具调用可视化、Diff 渲染、待办同步
- 输入区下方有**工作空间**（文件夹浏览器）和**权限**（`manual` / `normal` / `auto` 三级确认策略）
- `VITE_USE_MOCK=false` 下直连真后端；mock 只是后端没跑时演示 UI 用的

还没做的（按阶段推进，文档在 `docs/backend/`）：

- **下一期是 [002 config.toml 多供应商模型配置](docs/backend/002_config_toml_models.md)** —— 把模型供应商从 `.env` 单供应商迁到 `config.toml`，支持 anthropic / openai 两种协议。文档已写，代码还没动
- `GET /directories` **未实现** —— 工作空间选择器在真后端下报 404 属预期，见 [`stupid_code/API.md`](stupid_code/API.md)
- 工作空间 / 权限目前只是前端随请求发过去的参数（`config.configurable`），**后端还没在工具入口读它、也没按档位拦截**
- 危险操作确认（HumanInTheLoop）、写文件落真实磁盘、路径逃逸拦截、运行护栏 —— 都还没做
- 全仓库**没有自动化测试、没有 CI**，验证靠 [`docs/backend/001_basic_agent_server.md`](docs/backend/001_basic_agent_server.md) 里的手工步骤

> 写代码前先看一眼 [`AGENTS.md`](AGENTS.md)：里面记了 checkpointer、路径解析、端点用法这些踩过的坑。

---

## 技术栈

### 后端

| 项目 | 说明 |
| --- | --- |
| 语言 | Python ≥ 3.12（`.python-version` 锁定） |
| 包管理 | [uv](https://docs.astral.sh/uv/)（`uv.lock` 已存在） |
| 构建 | hatchling |
| Agent 框架 | [`deepagents`](https://pypi.org/project/deepagents/)（MIT，当前最新 0.7.x，要求 Python ≥ 3.11） |
| 控制台脚本 | `scode` → `stupid_code:start` |

`pyproject.toml` 里显式声明的是 `deepagents`、`langchain`、`langchain-anthropic`、`langgraph-cli[inmem]`、`langgraph-sdk`、`langgraph-runtime-inmem`、`langgraph-checkpoint-sqlite`、`httpx`、`pydantic`；`deepagents` 自身还会再拉一批传递依赖进来。

### 前端

| 项目 | 说明 |
| --- | --- |
| 框架 | Vite 8 + React 19 + TypeScript 6 |
| 样式 | TailwindCSS 4（CSS 变量驱动主题，亮/暗） |
| 状态 | Zustand 5 |
| 路由 | React Router 7 |
| 包管理 | [pnpm](https://pnpm.io/)（`web/pnpm-lock.yaml` 锁定依赖，版本号也锁在 `package.json` 的 `packageManager`） |

前端是**完全独立的项目**，不参与 uv 的依赖管理，两边互不牵连。

### Deep Agents 提供了什么

它是建在 LangChain / LangGraph 之上的**开箱即用 agent harness**，规划、上下文管理、子 agent 这些能力是**配置出来的，不需要自己实现**：

- **任务规划** —— TodoList 中间件帮 agent 拆解复杂任务
- **上下文管理** —— 长对话自动摘要，工具输出落盘，不把 context 撑爆
- **文件系统** —— 可插拔后端（本地 / 沙箱 / 远程）上的读写、编辑、搜索
- **Shell 访问** —— 在你选的沙箱里执行命令
- **子 agent** —— 派发任务给上下文互相隔离的专职 agent
- **长期记忆** —— 跨会话的 pluggable state / store
- **人工介入** —— 敏感工具调用执行前可批准 / 编辑 / 拒绝
- **Skills** —— 按需加载的可复用行为
- **工具** —— 自己的函数，或任意 MCP server

### 三层关系，别搞混

```
Deep Agents   ← 最上层，带电池的 harness（规划 / 文件 / 子 agent / 记忆）
     ↓
LangChain     ← create_agent，模型 + 工具 + agent 循环的抽象层
     ↓
LangGraph     ← 底层运行时，图的编排、持久化、checkpoint
     
LangSmith     ← 横切，追踪与评测
```

层与层可以组合：任意 `CompiledStateGraph` 都能作为 Deep Agent 的子 agent 接进来。

---

## 快速开始

### 1. 装 skills

见文首的 ⚠️ 章节。

### 2. 同步依赖

```bash
uv sync
```

依赖已经在 `pyproject.toml` 里声明好并锁进 `uv.lock`，不用再 `uv add`。

> `deepagents` 是 model-agnostic 的，任何支持 tool calling 的模型都行——OpenAI、Anthropic、Google、Ollama / vLLM 自托管的开放权重模型都可以。换 provider 时改 `stupid_code/agent.py` 里的 `init_chat_model(...)` 即可。

### 3. 配置 API key

**建在 `stupid_code/.env`，不是仓库根目录。** `langgraph.json` 里的 `"env": "./.env"` 是相对 `stupid_code/` 解析的，放错地方启动时读不到 key。

```bash
# stupid_code/.env
ANTHROPIC_API_KEY=sk-ant-...
```

`.env` 已被 `.gitignore` 忽略，别把 key 提交上去。

> 001 期就这一份 `.env`、单供应商。002 期会迁到 `config.toml`（见 [`docs/backend/002_config_toml_models.md`](docs/backend/002_config_toml_models.md)），`.env` 届时只留密钥供 `${VAR}` 引用。

### 4. 跑起来

```bash
uv run scode
```

看到这两行才算启动成功（`/ok` 通了 + `code_agent` 图能加载）：

```
✅ Agent Server 已就绪：http://127.0.0.1:2024/ok
✅ 图 code_agent 已注册并可加载（6 个节点）
```

60 秒没就绪、或子进程提前退出，`scode` 会报错并以退出码 1 结束。`Ctrl+C` 停止。

改完 `langgraph.json` 想确认配置本身没问题：

```bash
uv run langgraph validate --config stupid_code/langgraph.json   # Configuration file ... is valid. (1 graph found)
```

排查见 [`stupid_code/README.md`](stupid_code/README.md) 和 [`docs/backend/001_basic_agent_server.md`](docs/backend/001_basic_agent_server.md)。

> ⚠️ **别给 `create_deep_agent()` 传 `checkpointer`。** `langgraph dev` 会直接抛 ValueError（持久化由平台接管，不需要你配）。

### 5. 跑通官方最小示例

别急着抄现成的代码，先照着官方 quickstart 手写一遍 research agent，把 `create_deep_agent` 的形状摸清楚：

- <https://docs.langchain.com/oss/python/deepagents/quickstart>

最小形态长这样：

```python
from deepagents import create_deep_agent

agent = create_deep_agent(
    model="anthropic:claude-sonnet-4-5-20250929",
    system_prompt="You are a research assistant.",
)
result = agent.invoke({"messages": "Research LangGraph and write a summary"})
```

配合 `deepagents-python-quickstart` skill 一起看。

### 6. 起网页前端

`web/` 是独立的前端项目，用 pnpm 管理，不参与上面 uv 那套。后端起来了，**默认就该走真后端**：

```bash
cd web
pnpm install
cp .env.example .env.local
```

`.env.example` 里 `VITE_USE_MOCK=true`，连真后端时把它改成 `false`，然后：

```bash
pnpm dev
```

打开 <http://localhost:5173>。开发态 Vite 把 `/api/*` 代理到 `VITE_LANGGRAPH_URL`（默认 `http://localhost:2024`，即 `langgraph dev` 的端口），避免跨域。

mock 只是后端没跑时演示 UI 用的，可以临时开：

```bash
VITE_USE_MOCK=true pnpm dev
```

`src/api/mock/` 用与真后端**完全相同的接口签名**实现假数据，覆盖流式 token、工具调用状态流转、todo 同步、Diff 渲染、停止生成等路径，侧边栏有黄色提示条提示当前是假数据。注意 mock **默认是关的** —— `VITE_USE_MOCK` 不设即为 false，前端会直接去连后端然后满屏报错。

界面细节、接口契约、`GET /directories` 的约定都在 [`web/README.md`](web/README.md)。

---

## 项目结构

```
stupid-code/
├── AGENTS.md                # 给编码 Agent 看的项目约定：命令、坑、边界
├── pyproject.toml           # 项目配置与依赖（scode 入口在这里）
├── uv.lock                  # 依赖锁定
├── .python-version          # 3.12
├── skills-lock.json         # langchain-skills 的安装记录与 hash
├── docs/                    # 设计文档
│   ├── overall-design.md    # 目标架构与前后端接口契约
│   ├── frontend-design.md   # 网页前端的界面与交互设计
│   └── backend/             # 按阶段推进的后端任务文档
│       └── 001_basic_agent_server.md
├── web/                     # 网页前端（Vite + React，与 Python 相互独立）
│   ├── README.md            # 前端说明、接口契约、工作空间与权限
│   ├── pnpm-lock.yaml
│   └── src/                 # api / store / components / pages
├── stupid_code/             # 后端 Python 包，按职责分四块
│   ├── README.md            # 后端启动说明
│   ├── API.md               # 当前实际在用的端点清单
│   ├── langgraph.json       # 图注册 + http.app + checkpointer/store 指向 persistence.py
│   ├── __init__.py          # start() —— scode 命令的入口
│   ├── launcher.py          # scode：cwd 即工作空间 + 派生配置 + 就绪探测 + 缓存清理 + 优雅关停
│   ├── agent.py             # create_deep_agent()，导出 graph
│   ├── persistence.py       # SQLite 工厂：checkpoint/store → data/langgraph.db
│   ├── model_config.py      # 读 conf/config.toml、校验、构建模型、模型 CRUD helpers
│   ├── admin/               # 挂在 /admin 下的管理接口（langgraph.json 的 http.app 指向 app.py）
│   │   ├── app.py           # Starlette 子应用与路由表
│   │   └── models.py        # /admin/models 五个端点的处理函数
│   └── data/                # langgraph.db（gitignore，唯一持久运行产物，固定在后端包目录）
└── .agents/skills/          # langchain-skills（gitignore，需自行安装）
    └── ... 22 个 skill
```

> **工作空间语义**：在哪个目录运行 `uv run scode`，langgraph 子进程的 cwd 就是那个目录（agent 未来的文件/shell 工具以此为根）。langgraph 必然在 cwd 生成的 `.langgraph_api/` 由 scode 在启动前和退出时各删一次；scode 自己把路径绝对化后的派生 langgraph.json 放进 `$TMPDIR/scode-config-*`（退出即删）。作者视角的配置路径仍相对 `stupid_code/` 写，别把 `langgraph.json` / `agent.py` / `persistence.py` / `admin/app.py` 挪出去——这四个路径被 `langgraph.json` 直接引用。

---

## 学习路线

22 个 skill 大致可以这么用，跟着 `ecosystem-primer` 的选型表往下走：

**第一步 · 搞清楚选型** — 动手前先读 `ecosystem-primer`，它决定了你该用 Deep Agents 还是 LangChain 还是 LangGraph，以及下一步该加载哪个 skill。

**第二步 · 搭出最小 agent** — `deepagents-python-quickstart` + `deep-agents-core`。跑通官方 quickstart，然后逐个摸中间件：TodoList、Filesystem、SubAgent、HumanInTheLoop、Skills、Memory。

**第三步 · 做深 code agent 的能力** — 这是本项目的正题：

| 想搞清楚的问题 | 看这个 skill |
| --- | --- |
| 长任务怎么不跑偏 | `deep-agents-core`、`deep-agents-orchestration` |
| 上下文爆了怎么办 | `deep-agents-core`（context management） |
| 跨会话记住东西 | `deep-agents-memory` |
| 危险操作怎么拦 | `langgraph-human-in-the-loop` |
| 中间件怎么写 | `langchain-middleware` |
| 断了能接着跑 | `langgraph-persistence`、`langgraph-fundamentals` |
| agent 好不好用 | `eval-engineering` |

**第四步 · 回头补底层** — 等你真的需要自定义控制流了，再下沉到 `langgraph-decision-models`、`langgraph-*` 系列。

其余还有 `langchain-fundamentals`、`langchain-rag`、`langchain-dependencies`（依赖版本管理）、`swarm`（多 agent 编排）、`managed-deep-agents`、`langgraph-cli` 等，按需查。

> 建议：**读文档和 skill 的优先级高于读本仓库的代码。** 这个仓库的代码大概率是粗糙的、甚至是错的，那正是学习项目该有的样子。

---

## ⚠️ 安全

`deepagents` 明确采用 **"trust the LLM"** 模型：agent 的能力上限就是你给它的工具权限，它**不会自我约束**。

一个 code agent 天然带着 shell 执行和文件写入权限，所以：

- 边界要**在工具层 / 沙箱层**强制执行，不要指望模型自觉
- 跑在真实仓库里之前，先在容器或一次性沙箱里试
- 危险命令的批准流程用 `HumanInTheLoopMiddleware` 搭；中断恢复需要的 checkpointer 由 `langgraph dev` 平台自动提供，**不要手动传给 `create_deep_agent()`**（会直接抛 ValueError）
- **只监听 `127.0.0.1`**。`scode` 已经写死了这个地址，别改成 `0.0.0.0` —— 一个天生带 shell 执行和文件写权限的 agent 暴露到局域网，等于把整台机器交出去
- `/directories` 这类会暴露文件系统结构的端点，用之前必须加路径白名单
- API key 永远走环境变量 / `.env`，别硬编码

---

## 参考资料

- Deep Agents 文档 — <https://docs.langchain.com/oss/python/deepagents>
- API Reference — <https://reference.langchain.com/python/deepagents/>
- 官方 examples — <https://github.com/langchain-ai/deepagents/tree/main/examples>
- LangChain 生态各层关系 — <https://docs.langchain.com/oss/python/concepts/products>
- langchain-skills 仓库 — <https://github.com/langchain-ai/langchain-skills>
- 社区论坛 — <https://forum.langchain.com/c/oss-product-help-lc-and-lg/deep-agents/18>

> Deep Agents 迭代很快（0.x 阶段）。**以线上文档为准，不要凭记忆或凭本 README 里的片段写代码。**