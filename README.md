# stupid-code

一个基于 [LangChain Deep Agents](https://docs.langchain.com/oss/python/deepagents/overview) 的 **code agent** 学习项目。

写代码是 agent 最难啃的场景——长上下文、跨文件编辑、要 shell、要反复试错。这个项目想亲手把一个 code agent 搭出来，顺带搞懂 Deep Agents 提供了什么、边界在哪。

> 学习项目，不是产品。标准是「能跑、能看懂、能改」，不追求生产级完备；遇到问题先读源码和官方文档。踩过的坑记在 [`AGENTS.md`](AGENTS.md)。

---

## 这是什么

- **后端**（`stupid_code/`）—— 基于 Deep Agents + LangGraph 的 Agent Server，真实磁盘 + 本机 shell，`uv run scode` 起在 `127.0.0.1:2024`
- **前端**（`web/`）—— 独立的 Vite + React SPA，5173，通过 HTTP 调后端

agent 具备：读写工作空间里的文件、跑 shell 命令、多轮对话、流式输出与工具调用可视化、子 agent 委派、跨会话长期记忆、危险命令人工确认、运行期切换对话模型、手动压缩对话历史。

**当前状态**：后端 001–011 期均已落地，前端已连真后端完成整轮对话。每期做了什么、为什么这么做、还欠什么，见 [`docs/backend/PROGRESS.md`](docs/backend/PROGRESS.md)。

### 技术栈

| 层 | 选型 |
| --- | --- |
| Agent 框架 | [deepagents](https://pypi.org/project/deepagents/) 0.7.x，建在 LangChain / LangGraph 之上 |
| 后端 | Python ≥ 3.12 + [uv](https://docs.astral.sh/uv/)，`langgraph dev` 起服务，监听 `127.0.0.1:2024` |
| 前端 | Vite 8 + React 19 + TypeScript 6 + TailwindCSS 4 + Zustand 5，**独立 pnpm 项目**，不参与 uv 依赖管理 |
| 模型 | model-agnostic，支持 anthropic / openai 两种协议，配置在 `conf/config.toml` |
| 持久化 | SQLite（`stupid_code/data/langgraph.db`）+ 平台侧的 thread 索引 |

> Deep Agents / LangChain / LangGraph 三层的关系、以及这套框架白送哪些能力，见 [`docs/learning-path.md`](docs/learning-path.md)。

---

## 快速开始

### 1. 装 skills

`.agents/` 和 `.claude/` 写进了 `.gitignore`，clone 之后必须自己装一遍——这 22 个 skill 是**开发时的参考资料**（框架选型、中间件、持久化……），你的编码 Agent 看不到就会凭记忆写：

```bash
npx skills add langchain-ai/langchain-skills --skill '*' --yes
ls .agents/skills | head    # 看到 deep-agents-core、ecosystem-primer 等目录就成了
```

<details>
<summary>其他安装方式（按需）</summary>

| 场景 | 命令 |
| --- | --- |
| 全局安装（所有项目可用） | `npx skills add langchain-ai/langchain-skills --skill '*' --yes --global` |
| 只装给某个 Agent（如 Claude Code） | `npx skills add langchain-ai/langchain-skills --agent claude-code --skill '*' --yes` |
| 只装单个 skill | `npx skills add langchain-ai/langchain-skills --skill deep-agents-core --yes` |

`npx skills` 遵循 Agent Skills 规范，Claude Code、Cursor、Windsurf 等支持该规范的编码工具都能用。安装状态记录在 `skills-lock.json` 里。

</details>

### 2. 同步依赖

```bash
uv sync
```

依赖已经在 `pyproject.toml` 里声明好并锁进 `uv.lock`，不用再 `uv add`。

> `deepagents` 是 model-agnostic 的，任何支持 tool calling 的模型都行——OpenAI、Anthropic、Google、Ollama / vLLM 自托管的开放权重模型都可以。换 provider 不用动代码，在 `conf/config.toml` 里加一段 `[models.providers.*]` 就行。

### 3. 配置模型与 API key

**建在根目录 `conf/config.toml`**（002 期起不再用 `.env`）。复制模板后填真实值：

```bash
cp conf/config.example.toml conf/config.toml
```

```toml
[models]
default = "minimax:MiniMax-M3"     # "供应商名:模型名"

[models.providers.minimax]
protocol = "anthropic"              # 只支持 anthropic / openai
base_url = "https://api.minimax.cn/anthropic"
api_key = "sk-..."
models = ["MiniMax-M3", "MiniMax-M3.1-Flash"]
```

`conf/config.toml` 已被 `.gitignore` 忽略，别把 key 提交上去；`conf/config.example.toml` 是模板，可以提交。

供应商 / 模型也可以直接在网页端的「设置 → 模型管理」里改（走 `/admin/models`），改完按提示重启后端生效。

> 010 期起有个例外：**在侧边栏切换对话模型那条路径每次调用都重读 `conf/config.toml`**，
> 所以新增模型、改 base_url / api_key 在下一次运行就生效，不用重启。
> 要改的只是「后端启动时带的默认模型」时才需要重启。

### 3.1 配子 agent（可选）

**建在根目录 `conf/subagents.toml`**（004 期，无密钥，可以直接提交）。每个 `[[subagents]]` 至少要有 `name` / `description` / `model` 三项：

```toml
[[subagents]]
name = "reviewer"                          # task(subagent_type="reviewer") 用它
description = "代码审查员：读改动、找缺陷，只输出问题清单"   # 主 agent 靠它决定何时委派
model = "minimax:MiniMax-M3.1-Flash"       # "供应商名:模型名"，复用 config.toml 的连接信息
system_prompt = "你是一个严格的代码审查员。"
```

`model` 的供应商和模型名必须在 `config.toml` 里配过（`models` 白名单）。
文件不存在 = 不配置子 agent，deepagents 自带的 `general-purpose` 照常可用。
完整字段表见 [`docs/backend/PROGRESS.md`](docs/backend/PROGRESS.md) 的「004 · 子 agent 配置」一节。

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

排查见 [`stupid_code/README.md`](stupid_code/README.md) 和 [`docs/backend/PROGRESS.md`](docs/backend/PROGRESS.md)。

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

### 7. 或者：整个项目跑在 Docker 里

不想在宿主机装 Python / Node 的话，两个服务都用容器跑。

**启动前必须先有 `conf/config.toml`**（步骤 3 做的事）：

```bash
cp conf/config.example.toml conf/config.toml   # 没这个文件就先复制
# 然后编辑 conf/config.toml，填上 api_key
```

这个文件**不会**打进镜像——它有明文 api_key，`.dockerignore` 把它排除了，
运行时靠 volume 挂进容器。所以**忘了准备它，容器起不来**：

```
ConfigError: 找不到 /app/conf/config.toml。请复制 conf/config.example.toml 为 conf/config.toml 并填入供应商信息。
GraphLoadError: Failed to load graph 'code_agent' from /app/stupid_code/graph/agent.py: ...
Application startup failed. Exiting.
```

后端容器会一直重启（`docker compose ps` 显示 `Restarting`），前端则因为
`depends_on: service_healthy` 一直等着不起。**先看后端日志**：

```bash
docker compose logs backend
```

另外 `.agents/skills` 也要装好（步骤 1），否则 agent 读不到参考资料。

准备好之后：

```bash
docker compose up --build
```

打开 <http://127.0.0.1:5173>。

要点：

- **工作空间默认是仓库本身** —— `SCODE_WORKSPACE` 指向的目录挂到容器里的 `/workspace`，agent 的文件 / shell 工具以此为根。想让它改别的项目：`SCODE_WORKSPACE=~/projects/other docker compose up`。
- **历史不会丢** —— thread 索引（`.langgraph_api/`）落在工作空间里，checkpoint（`stupid_code/data/langgraph.db`）挂在宿主上，容器重建后接着用。
- **api_key 不进镜像** —— `conf/config.toml` 被 `.dockerignore` 排除，靠 volume 挂进去。
- **端口只绑 127.0.0.1** —— 容器内后端进程绑 `0.0.0.0`（不然容器之间连不上），但宿主侧的端口映射只绑本机，对外依然只有本机能访问。

细节（含踩过的坑）见 [`docs/backend/PROGRESS.md`](docs/backend/PROGRESS.md) 的「012 · Docker 运行」一节。

---

## 注意事项

跑起来就会撞上的几件事：

- **在哪个目录运行 `uv run scode`，那个目录就是 agent 的工作空间** —— langgraph 子进程的 cwd 就是它，agent 的文件 / shell 工具以此为根。
- **端口锁死 2024** —— 被占用时 `scode` 直接启动失败并说明是谁占着，**不会自动换端口**（自动换会让就绪检查打到旧服务上，误报"已就绪"，前端连的是旧代码）。
- **持久状态分两处，缺一不可** —— thread 索引在工作空间的 `.langgraph_api/`，checkpoint / store 在 `stupid_code/data/langgraph.db`（已 gitignore，删掉即重置历史）。
- **人工确认只拦 `execute`** —— 文件类工具（`write_file` / `edit_file` / `delete`）不拦，那是 code agent 的日常。agent 仍能读工作空间里的任何文件。
- **恢复挂起的运行** —— 请求体要带同一个 `configurable.permissions`；`command.resume.decisions` 的个数必须和挂起时的 `action_requests` 一样多，否则框架直接抛错。
- **换模型不用重启后端** —— 但 harness profile 和摘要阈值是建图时定死的，不跟着换；子 agent 一律用各自配置里的模型。
- **记忆只在会话开始时读一次** —— 改完 `.scode-memory.md` 要开新会话才生效。
- **框架 0.7.x 不再提供内置系统提示词** —— `create_deep_agent(system_prompt=...)` 传进去的就是模型唯一看到的系统提示词，行为准则写在 `stupid_code/config/prompts.py`。
- **API key 走 `conf/config.toml`**，已 gitignore，别硬编码进代码。
- **工作空间选择器在真后端下报 404 属预期** —— `GET /directories` 后端还没实现，前端已按契约写好。

完整的踩坑清单（含代码位置、原因、验证方式）见 [`AGENTS.md`](AGENTS.md)；已知缺口见 [`docs/backend/PROGRESS.md`](docs/backend/PROGRESS.md) 的「已知缺口」一节。

---

## 文档地图

| 文档 | 内容 |
| --- | --- |
| [`docs/overall-design.md`](docs/overall-design.md) | 目标架构、前后端接口契约、安全设计 |
| [`docs/backend/PROGRESS.md`](docs/backend/PROGRESS.md) | 后端进度快照：每期的目标 / 取舍 / 验证步骤 / 已验证的事实 |
| [`docs/learning-path.md`](docs/learning-path.md) | Deep Agents 给了什么、三层关系、按 skill 的学习路线 |
| [`docs/frontend-design.md`](docs/frontend-design.md) | 前端界面与交互设计 |
| [`stupid_code/README.md`](stupid_code/README.md) | 后端启动说明 |
| [`stupid_code/API.md`](stupid_code/API.md) | 当前实际可用的端点清单 |
| [`web/README.md`](web/README.md) | 前端说明与接口契约 |
| [`AGENTS.md`](AGENTS.md) | 给编码 Agent 的项目约定：命令、路径、踩过的坑 |

---

## 安全

`deepagents` 明确采用 **"trust the LLM"** 模型：agent 的能力上限就是你给它的工具权限，它**不会自我约束**。

一个 code agent 天然带着 shell 执行和文件写入权限，所以：

- 边界要**在工具层 / 沙箱层**强制执行，不要指望模型自觉
- 跑在真实仓库里之前，先在容器或一次性沙箱里试
- 危险命令的批准流程用 `HumanInTheLoopMiddleware` 搭；中断恢复需要的 checkpointer 由 `langgraph dev` 平台自动提供，**不要手动传给 `create_deep_agent()`**（会直接抛 ValueError）
- **只监听 `127.0.0.1`**。`scode` 已经写死了这个地址，别改成 `0.0.0.0` —— 一个天生带 shell 执行和文件写权限的 agent 暴露到局域网，等于把整台机器交出去
- `/directories` 这类会暴露文件系统结构的端点，用之前必须加路径白名单
- API key 永远走 `conf/config.toml` 或环境变量，别硬编码进代码

---

## 参考资料

- Deep Agents 文档 — <https://docs.langchain.com/oss/python/deepagents>
- API Reference — <https://reference.langchain.com/python/deepagents/>
- 官方 examples — <https://github.com/langchain-ai/deepagents/tree/main/examples>
- LangChain 生态各层关系 — <https://docs.langchain.com/oss/python/concepts/products>
- langchain-skills 仓库 — <https://github.com/langchain-ai/langchain-skills>
- 社区论坛 — <https://forum.langchain.com/c/oss-product-help-lc-and-lg/deepagents/18>

> Deep Agents 迭代很快（0.x 阶段）。**以线上文档为准，不要凭记忆或凭本 README 里的片段写代码。**
