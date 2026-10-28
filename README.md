<h1 align="left">
  <img src="assets/scode-logo.png" alt="scode logo" width="64" align="middle">
  stupid-code
</h1>

一个基于 [LangChain Deep Agents](https://docs.langchain.com/oss/python/deepagents/overview) 的 **code agent** 学习项目。

写代码是 agent 最难啃的场景——长上下文、跨文件编辑、要 shell、要反复试错。这个项目想亲手把一个 code agent 搭出来，顺带搞懂 Deep Agents 提供了什么、边界在哪。

> 学习项目，不是产品。标准是「能跑、能看懂、能改」，不追求生产级完备。

---

## 这是什么

- **后端**（`stupid_code/`）—— 基于 Deep Agents + LangGraph 的 Agent Server，真实磁盘 + 本机 shell，`uv run scode` 起在 `127.0.0.1:2024`
- **前端**（`web/`）—— 独立的 Vite + React SPA，5173，通过 HTTP 调后端

agent 能读写工作空间里的文件、跑 shell、多轮对话、流式输出、子 agent 委派、跨会话长期记忆、危险命令人工确认、运行期切模型、手动压缩历史、加载 skill。

**当前状态**：后端能力均已落地，前端已连真后端完成整轮对话。

### 技术栈

| 层 | 选型 |
| --- | --- |
| Agent 框架 | [deepagents](https://pypi.org/project/deepagents/) 0.7.x（建在 LangChain / LangGraph 之上） |
| 后端 | Python ≥ 3.12 + [uv](https://docs.astral.sh/uv/)，`langgraph dev` 起服务，监听 `127.0.0.1:2024` |
| 前端 | Vite 8 + React 19 + TypeScript 6 + TailwindCSS 4 + Zustand 5（独立 pnpm 项目） |
| 模型 | model-agnostic，支持 anthropic / openai 两种协议，配置在 `conf/config.toml` |
| 持久化 | SQLite（`stupid_code/data/langgraph.db`）+ 平台侧 thread 索引 |

Deep Agents / LangChain / LangGraph 三层的关系、这套框架白送哪些能力 → [`docs/learning-path.md`](docs/learning-path.md)

---

## 快速开始

### 1. 装 skills

`.agents/` 和 `.claude/` 在 `.gitignore` 里，clone 之后要自己装一遍——这 22 个 skill 是**开发这个项目时**给编码 Agent 用的参考资料。

```bash
npx skills add langchain-ai/langchain-skills --skill '*' --yes
ls .agents/skills | head
```

其他安装方式（全局 / 只装给某个 Agent / 只装单个）→ [`docs/learning-path.md`](docs/learning-path.md)

> 和 **agent 运行时加载的 skill** 是两回事：那个由使用者放在 `~/.scode/.agents/skills/`（全局）和 `<工作空间>/.agents/skills/`（项目级），见「注意事项」。

### 2. 装依赖、配模型

```bash
uv sync
cp conf/config.example.toml conf/config.toml   # 填上 api_key
```

`conf/config.toml` 已被 gitignore，`conf/config.example.toml` 是模板。`deepagents` 是 model-agnostic 的，换 provider 只改这个文件：

```toml
[models]
default = "minimax:MiniMax-M3"          # "供应商名:模型名"

[models.providers.minimax]
protocol = "anthropic"                  # 只支持 anthropic / openai
base_url = "https://api.minimax.cn/anthropic"
api_key = "sk-..."
models = ["MiniMax-M3", "MiniMax-M3.1-Flash"]
```

供应商和模型也可以在网页端「设置 → 模型管理」里改。改 `conf/config.toml` **不需要重启**后端（切换对话模型那条路径每次调用都重读），只有改「后端启动时带的默认模型」才要重启。

### 3. 跑后端

```bash
# 推荐：工作空间和仓库分开
cd ~/projects/my-work
uv run --project /path/to/stupid-code scode
```

也可以直接在仓库根 `uv run scode`（工作空间就是仓库），但 agent 有工作空间的写权限——见「注意事项」。

看到这一行才算启动成功：

```
✅ Agent Server 已就绪：http://127.0.0.1:2024/ok
```

60 秒没就绪或子进程提前退出，`scode` 会报错并以退出码 1 结束。`Ctrl+C` 停止。

改完 `langgraph.json` 想确认配置本身没问题：

```bash
uv run langgraph validate --config stupid_code/langgraph.json
```

### 4. 起前端

`web/` 是独立的 pnpm 项目，不参与上面 uv 那套：

```bash
cd web
pnpm install
cp .env.example .env.local    # VITE_USE_MOCK 改成 false
pnpm dev
```

打开 <http://localhost:5173>。开发态 Vite 把 `/api/*` 代理到 `VITE_LANGGRAPH_URL`（默认 `http://localhost:2024`）。

后端没跑、只想看 UI，可以 `VITE_USE_MOCK=true pnpm dev`——mock 用与真后端**完全相同的接口签名**实现假数据。

### 5. 可选：子 agent / MCP / Docker

- **子 agent** —— 建 `conf/subagents.toml`（可提交），每条至少 `name` / `description` / `model`。[字段表 → backend.md §3.4](docs/backend/backend.md)
- **MCP** —— 建 `conf/mcp.json`（从 `conf/mcp.example.json` 复制，**不入库**），`http` 和 `stdio` 都支持。**改完要重启后端**。[字段表 → backend.md §3.13](docs/backend/backend.md)
- **Docker** —— `docker compose up --build`（全栈）或 `docker compose up -d backend`（只起后端）。**启动前必须先有 `conf/config.toml`**，它不进镜像、靠 volume 挂进去，忘了容器起不来。[细节 → backend.md §3.12](docs/backend/backend.md)

### 6. 摸清 `create_deep_agent` 的形状

别急着抄现成的代码，先照官方 quickstart 手写一遍 research agent：

```python
from deepagents import create_deep_agent

agent = create_deep_agent(
    model="anthropic:claude-sonnet-4-5-20250929",
    system_prompt="You are a research assistant.",
)
result = agent.invoke({"messages": "Research LangGraph and write a summary"})
```

配合 `deepagents-python-quickstart` skill 一起看，官方文档 <https://docs.langchain.com/oss/python/deepagents/quickstart>。

---

## 注意事项

跑起来就会撞上的几件事：

- **别把仓库根当工作空间** —— agent 能写工作空间里的任何文件，包括 `conf/mcp.json` 和后端源码，这些会在下次启动时执行，等于绕开 `execute` 的人工确认。工作空间默认是运行 `scode` 的目录，也可以用 `SCODE_WORKSPACE` 指定；前端选的按消息生效，会覆盖默认值。
- **端口锁死 2024** —— 被占用时 `scode` 直接启动失败并说明是谁占着，**不会自动换端口**（自动换会让就绪检查打到旧服务上，误报"已就绪"，前端连的是旧代码）。
- **持久状态分两处，缺一不可** —— thread 索引在工作空间的 `.langgraph_api/`，checkpoint / store 在 `stupid_code/data/langgraph.db`（已 gitignore，删掉即重置历史）。
- **人工确认拦 `execute` 和 `delete`** —— 普通文件类工具（`write_file` / `edit_file`）不拦，那是 code agent 的日常；**写记忆文件除外**（`normal` / `manual` 档都拦），`delete` 删目录是递归的、跟 `rm -rf` 等价，所以也拦，但只在 `manual` 档拦（`normal` 档太吵）。
- **记忆分两级** —— 项目级在工作空间根的 `.scode-memory.md`，用户级在 `~/.scode/memory.md`。**改完要开新会话才生效**。写记忆要人工确认（`normal` / `manual` 档）——记忆写错了会一直影响后面每个会话。
- **skill 分两个作用域** —— 全局 `~/.scode/.agents/skills/`，项目级 `<工作空间>/.agents/skills/`。输入框敲 `/` 混着命令和 skill，**选 skill 是勾选**（不发消息），勾中的全文钉进对话上下文。
- **agent 的中间产物收在工作空间的 `.scode/` 里** —— 被压缩掉的对话历史、超大的工具结果、二进制块都在这下面，已 gitignore，agent 需要时能 `read_file` 读回来。
- **API key 走 `conf/config.toml`**，已 gitignore，别硬编码进代码。
- **别给 `create_deep_agent()` 传 `checkpointer`** —— `langgraph dev` 会直接抛 ValueError（持久化由平台接管）。

更多硬约束见 [`AGENTS.md`](AGENTS.md)（20 条，每条一句结论 + 一句原因）。

---

## 安全

`deepagents` 是 **"trust the LLM"** 模型：agent 的能力上限就是你给它的工具权限，它**不会自我约束**。一个 code agent 天然带着 shell 执行和文件写入权限，所以边界要在**工具层 / 沙箱层**强制执行。跑在真实仓库里之前，先在容器或一次性沙箱里试。

- **只监听 `127.0.0.1`** —— 别改成 `0.0.0.0`
- **工作空间之外只有两条路径** —— `/user-memory/`（`~/.scode/`，可写）和 `/user-skills/`（`~/.scode/.agents/skills/`，设计上只读、实际没有写保护）

完整的安全姿态和已知缺口 → [`docs/backend/backend.md`](docs/backend/backend.md) §5

---

## 文档

| 文档 | 内容 |
| --- | --- |
| [`docs/backend/backend.md`](docs/backend/backend.md) | 后端现状：每个能力的机制 / 取舍 / 踩过的坑 / 实测结论 |
| [`docs/learning-path.md`](docs/learning-path.md) | Deep Agents 给了什么、三层关系、按 skill 的学习路线 |
| [`docs/overall-design.md`](docs/overall-design.md) | 目标架构、前后端接口契约、安全设计 |
| [`docs/frontend-design.md`](docs/frontend-design.md) | 前端界面与交互设计 |
| [`stupid_code/README.md`](stupid_code/README.md) · [`API.md`](stupid_code/API.md) | 后端启动说明 · 当前可用端点清单 |
| [`web/README.md`](web/README.md) | 前端说明与接口契约 |
| [`AGENTS.md`](AGENTS.md) | 给编码 Agent 的硬约束清单 |

官方资料：[Deep Agents 文档](https://docs.langchain.com/oss/python/deepagents) · [API Reference](https://reference.langchain.com/python/deepagents/) · [examples](https://github.com/langchain-ai/deepagents/tree/main/examples) · [社区论坛](https://forum.langchain.com/c/oss-product-help-lc-and-lg/deepagents/18)

> Deep Agents 迭代很快（0.x 阶段）。**以线上文档为准，不要凭记忆或凭本 README 里的片段写代码。**

---

## 许可证

[MIT](LICENSE) © 2026 letterbee
