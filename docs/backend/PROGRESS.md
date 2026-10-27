# 后端进度快照（001–020 合并版）

> **这份文档是什么**：项目后端从第 001 期到第 020 期的**进度快照**。
> 它把原先散在 `001_*.md` ~ `009_*.md` 九份阶段文档里的内容合并成一份，
> 回答三个问题：**现在做到了哪一步 / 为什么这么做 / 接下来还欠什么**。
>
> - 快照时间：2026-10-27，代码基线 `335a890` + 019 / 020 期改动
> - 后端：`stupid_code/`（Python 5879 行）　前端：`web/src/`（TS/TSX 7775 行）
> - 依赖版本：`deepagents 0.7.28` / `langchain 1.4.6` / `langgraph 1.2.16` /
>   `langgraph-cli 0.4.36` / `langchain-anthropic 1.7.6` / `langchain-openai 1.7.2` /
>   `langchain-mcp-adapters 0.3.2`
> - **以代码为准**。本文记录的是当前实现的实际形态，不是设计意图。
>   目标架构见 [`docs/overall-design.md`](../overall-design.md)，
>   前后端 HTTP 契约见 [`stupid_code/API.md`](../../stupid_code/API.md)。
>
> 写新一期文档时照 §10 的结构来，别再按期新开文件——直接续写本文的对应章节。

---

## 0. 速查表：AGENTS.md 的硬约束 → 本文对应小节

[`AGENTS.md`](../../AGENTS.md) 是**硬约束清单**（每条一句结论 + 一句原因）。本文是它的**展开**：
机制细节、框架源码细节、实测数据都在下面这些小节里。改代码前先查对应小节，别凭印象改。

| AGENTS.md | 主题 | 本文小节 |
|---|---|---|
| 1 | 参考资料要先装 | [`README.md`](../../README.md) 的「1. 装 skills」 |
| 2 | 别传 `checkpointer` | §2.2 |
| 3 | 三条硬编码路径 + `__file__` 层数 | §2.2 |
| 4 | `.langgraph_api/` 要留着 | §4.2 |
| 5 | `GET /assistants` 返回 405 | §8.1 |
| 6 | 前端契约先行 | §4.1 |
| 7 | SSE 不用 EventSource | §4.2 |
| 8 | 任务级参数 | §4.4 |
| 9 | 没有内置系统提示词 | §4.3 |
| 10 | 长期记忆的挂法与边界 | 006 · §8.11 |
| 11 | 端口锁死 2024 | 008 · §9 |
| 12 | 真实 backend 与子 agent 权限 | 007 · 012 |
| 13 | 运行期切模型 | 010 · §8.5 |
| 14 | 手动压缩历史 | 011 · §8.6 |
| 15 | 容器里的三个坑 | 012 |
| 16 | MCP | 013 · §8.8 |
| 17 | 工作空间是运行期参数 | 014 · §8.9 |
| 18 | 中间产物收在 `.scode/` | §8.10 |
| 19 | 记忆两个作用域 + 写记忆走人工确认 | §8.11 |
| 20 | skill 两个作用域 | §8.12 |
| Security | 安全姿态总表 | §5 |
| Security | 每条姿态的理由 | §5.1 |
| Security | 已知缺口（都是「已知的边界」） | §6 |
| Security | 常见问题与排查 | §9 |

---

## 1. 当前状态总览

### 1.1 一句话

**后端 Agent Server 已跑通，前端已连真后端完成整轮对话，agent 能改真实文件、跑本机 shell、派子 agent、存长期记忆，执行命令前有人工确认关卡。**

### 1.2 逐期落地情况

| 期 | 主题 | 状态 | 代码落在哪 |
|---|---|---|---|
| 001 | 基础 Agent Server 启动框架 | ✅ 已落地 | `stupid_code/launcher.py` + `langgraph.json` |
| 002 | `conf/config.toml` 多供应商模型配置 | ✅ 已落地 | `stupid_code/config/model.py` |
| 003 | 模型配置管理接口 | ✅ 已落地 | `stupid_code/admin/app.py` + `admin/models.py` |
| 004 | 子 agent 配置（`conf/subagents.toml`） | ✅ 已落地 | `stupid_code/config/subagent.py` |
| 005 | 后端包结构整理 | ✅ 已落地 | `stupid_code/{graph,config,admin}/` |
| 006 | agent 长期记忆（项目级 `.scode-memory.md` + 用户级 `~/.scode/memory.md`） | ✅ 已落地 | `stupid_code/graph/memory.py` |
| 007 | 真实 backend（磁盘 + shell） | ✅ 已落地 | `stupid_code/graph/backend.py` |
| 008 | launcher 端口锁定与关停 | ✅ 已落地 | `stupid_code/launcher.py` |
| 009 | shell 人工确认（HITL） | ✅ 已落地 | `stupid_code/graph/permissions.py` + 前端 `ApprovalCard.tsx` |
| 010 | 运行期切换对话模型 | ✅ 已落地 | `stupid_code/graph/model_switch.py` + 前端侧边栏模型下拉框 |
| 011 | 手动压缩对话历史（`/compaction`） | ✅ 已落地 | `stupid_code/graph/compaction.py` + 前端斜杠命令菜单 |
| 012 | Docker 运行（后端 + 前端） | ✅ 已落地 | `Dockerfile` + `web/Dockerfile` + `docker-compose.yml` |
| 013 | MCP 支持（`conf/mcp.json`，http + stdio） | ✅ 已落地 | `stupid_code/config/mcp.py` + `stupid_code/graph/mcp.py` |
| 014 | 工作空间按任务生效（`configurable.workspace`）+ 系统目录选择框 | ✅ 已落地 | `stupid_code/graph/workspace.py` + `stupid_code/admin/workspaces.py` |
| 015 | 记忆块模板 + 长度上限；HITL 档位钉进图状态 + `delete` 进关卡 | ✅ 已落地 | `stupid_code/graph/memory.py` + `stupid_code/graph/permissions.py` |
| 016 | agent 自己的中间产物收拢到 `.scode/` | ✅ 已落地 | `stupid_code/graph/backend.py` |
| 017 | 长期记忆分两个作用域（用户级 + 项目级）+ 前端记忆面板 + 写记忆走人工确认 | ✅ 已落地 | `stupid_code/graph/paths.py` + `stupid_code/admin/memory.py` + `graph/permissions.py` + 前端 `components/memory/` |
| 018 | skill（全局 `~/.scode/.agents/skills/` + 项目级 `<工作空间>/.agents/skills/`）+ 前端斜杠菜单勾选 | ✅ 已落地 | `stupid_code/graph/skills.py` + `stupid_code/admin/skills.py` + 前端 `lib/skills.ts` |
| 019 | 全仓精简（重复逻辑归一）+ 文档收敛到单一事实源 | ✅ 已落地 | `stupid_code/graph/workspace.py` + `stupid_code/config/model.py` + `stupid_code/admin/models.py` + 本文档 §3 末节 |
| 020 | 删掉 `/tmp/` 路由（及其守卫类 `WorkspaceCompositeBackend`） | ✅ 已落地 | `stupid_code/graph/backend.py` + 本文档 §3 末节 |
| 021 | 拦同一个 tool 用同一组参数反复失败 | ✅ 已落地 | `stupid_code/graph/repeated_calls.py` + 本文档 §3 末节 |

### 1.3 前端完成度

按 [`docs/frontend-design.md`](../frontend-design.md) 实现，**功能上已完成**。
逐条能力对照（✅/❌ 清单）见同文档 §12「实现现状」——那里是前端能力清单的**单一事实源**，
本文不复刻。

与后端耦合最深的几条（**改后端时先看这几条**）：

- **工作空间选择器**（点按钮弹系统原生目录选择框；下拉里还有「最近用过的项目」
  和手动输入路径——014 期）→ `POST /workspaces/pick`
- **权限档位选择器**（`manual` / `normal` / `auto`）+ **人工确认卡片**
  （显示命令 + 为什么被拦，批准 / 拒绝 / 改后执行）→ `configurable.permissions`
  + `interrupt_on`（009/015 期）
- **对话模型切换**（侧边栏下拉框，选中即生效，不用重启后端——010 期）
  → `configurable.model`
- **斜杠命令菜单**（输入 `/` 弹列表，`/compaction` 手动压缩对话历史——011 期）
- **skill 勾选**（同一个斜杠菜单里混排 skill，勾中的 `SKILL.md` 全文钉进上下文——018 期）
  → `configurable.skills`
- **记忆面板**（输入区「记忆」按钮，查看/编辑用户级 + 项目级两份记忆——017 期）
  → `GET`/`PUT /admin/memory`
- 模型管理界面（直连 `/admin/models`）、会话列表 / 建会话 / 删会话 / 标题
  （存平台的 `metadata.title`）、流式对话、工具调用可视化、Diff 渲染、Todo 同步
- mock 模式（`VITE_USE_MOCK=true`，签名与真实后端完全一致）

### 1.4 验证方式

**全仓库没有自动化测试、没有 CI。** 验证靠本文 §7 的手工步骤 + §8 的已验证事实清单。

---

## 2. 当前系统结构

### 2.1 目录树

```
stupid-code/
├── docs/
│   ├── overall-design.md      # 目标架构与前后端契约
│   ├── frontend-design.md     # 前端交互设计
│   ├── learning-path.md       # 框架背景与学习路线
│   └── backend/PROGRESS.md    # 本文档
├── conf/                       # 配置数据（代码在 stupid_code/config/，数据在这里）
│   ├── config.toml             # 模型供应商配置 —— 不入库（gitignore）
│   ├── config.example.toml     # 模板 —— 入库
│   └── subagents.toml          # 子 agent 声明 —— 入库（不含密钥）
├── stupid_code/               # 后端 Python 包
│   ├── __init__.py             # scode 命令入口（start()）
│   ├── launcher.py             # 起停 langgraph dev、就绪探测、优雅关停
│   ├── langgraph.json          # 框架读的配置
│   ├── graph/
│   │   ├── agent.py            # create_deep_agent()，导出 graph
│   │   ├── backend.py          # 真实磁盘 + shell 的 backend
│   │   ├── subagent_policy.py  # 子 agent 的权限/HITL/工具策略
│   │   ├── compaction.py       # /compaction 手动压缩 + 摘要用当前模型
│   │   ├── memory.py           # 长期记忆中间件（用户级 + 项目级两个来源）
│   │   ├── paths.py            # 记忆/skill 的路径常量（$SCODE_HOME）
│   │   ├── model_switch.py     # 运行期切换对话模型的中间件
│   │   ├── permissions.py      # 人工确认的档位与危险判定
│   │   ├── skills.py           # skill 发现（全局 + 项目级）+ 运行期源 + pin
│   │   └── persistence.py      # SQLite 工厂：checkpoint/store → ../data/langgraph.db
│   ├── config/
│   │   ├── model.py            # conf/config.toml → 模型实例 + CRUD
│   │   ├── subagent.py         # conf/subagents.toml → SubAgent 规格
│   │   └── prompts.py          # 主 agent 的系统提示词
│   ├── admin/
│   │   ├── app.py              # Starlette 子应用与路由表
│   │   ├── memory.py           # /admin/memory 两个端点（记忆读写）
│   │   ├── models.py           # /admin/models 五个端点
│   │   ├── skills.py           # GET /admin/skills（skill 清单）
│   │   └── workspaces.py       # POST /workspaces/pick（系统目录选择框）
│   └── data/                   # SQLite 数据库目录（gitignore）
├── web/                       # 前端（独立 pnpm 项目，不参与 uv 依赖管理）
├── pyproject.toml             # 依赖与 scode 入口
└── skills-lock.json           # langchain-skills 安装记录
```

### 2.2 `langgraph.json` 里的三条硬编码路径

```json
{
  "dependencies": ["."],
  "graphs":       {"code_agent": "./graph/agent.py:graph"},
  "http":         {"app": "./admin/app.py:app"},
  "checkpointer": {"path": "./graph/persistence.py:checkpointer"},
  "store":        {"path": "./graph/persistence.py:store"}
}
```

**挪这三个文件必须同步改这里**，否则启动报找不到模块。

另有几个模块用 `__file__` 定位目录，**层数跟包结构绑死**：

| 模块 | 定位目标 | 写法 |
|---|---|---|
| `config/model.py`、`config/subagent.py` | 项目根的 `conf/` | `Path(__file__).resolve().parents[2] / "conf"` |
| `graph/persistence.py` | 包根的 `data/` | `os.path.dirname(os.path.dirname(os.path.abspath(__file__)))` |
| `launcher.py` | 本包目录（langgraph.json 所在处） | `Path(__file__).resolve().parent` |

`scode` 启动时会把 langgraph.json 里的相对路径**绝对化**后写进 `$TMPDIR/scode-config-*`，
所以**作者视角的路径仍相对 `stupid_code/` 写**。

### 2.3 启动方式

```bash
# 后端 —— 在哪个目录运行，那个目录就是 agent 的工作空间
cd /path/to/workspace
uv run scode

# 前端
cd web && pnpm dev     # 5173，Vite 把 /api/* 代理到 VITE_LANGGRAPH_URL（默认 http://localhost:2024）
```

后端没起来时：`VITE_USE_MOCK=true pnpm dev`（mock 默认**关闭**，不设即 false）。

其他命令：

```bash
uv sync                                                    # 装依赖
uv run langgraph validate --config stupid_code/langgraph.json   # 校验配置
```

---

## 3. 已落地的能力（按期详解）

### 001 · 基础 Agent Server 启动框架

**做了什么**：把 `langgraph dev` 拉起来，用 `create_deep_agent()` 建图，前端连上真后端完成一轮对话。

**关键取舍**

- **不要给 `create_deep_agent()` 传 `checkpointer`**。`langgraph dev` 直接抛
  `ValueError`（persistence 由平台自动处理）。持久化在 `langgraph.json` 里配
  `checkpointer` / `store` 指向 `graph/persistence.py` 的 SQLite 工厂。
- **SSE 一律用 fetch + 手动解析，不用 `EventSource`**（已定事项，别改回去）。
- `scode` 固定传 `--no-reload`：reload 监视 cwd，而 cwd 是用户的真实项目目录，
  agent 写文件会自我触发重启。**改后端代码统一重启 scode**。

**踩过的坑**

- `langgraph dev` 的相对路径以**启动 cwd** 为基准。cwd 现在是用户工作空间（任意目录），
  所以 launcher 必须把 langgraph.json 派生一份**路径绝对化**的副本到
  `$TMPDIR/scode-config-*`，用 `--config` 指向它。
- **SIGINT 必须显式 `signal.signal` 接管**：非交互环境（IDE 任务、shell 后台作业）
  可能继承 SIGINT=IGN，仅靠 Python 默认的 KeyboardInterrupt 注入不触发清理。

### 002 · `conf/config.toml` 多供应商模型配置

**做了什么**：模型配置（含 api_key）统一放项目根 `conf/config.toml`，支持多供应商、
anthropic / openai 两种协议；不再使用 `.env`。

**配置语义**

| 字段 | 位置 | 必填 | 说明 |
|---|---|---|---|
| `default` | `[models]` | 与 `recent` 至少一个 | 启动时优先使用的模型，`"供应商名:模型名"` |
| `recent` | `[models]` | 同上 | `default` 缺省时的回退；**目前只读**，没有写回逻辑 |
| `protocol` | `[models.providers.<name>]` | 是 | 只接受 `anthropic` / `openai` |
| `display_name` | `[models.providers.<name>]` | 否 | 展示名 |
| `base_url` | `[models.providers.<name>]` | 否 | 不填则用协议官方端点 |
| `api_key` | `[models.providers.<name>]` | 是 | 明文，写在 `conf/config.toml`（已 gitignore） |
| `models` | `[models.providers.<name>]` | 是 | 该供应商可用模型名白名单，不在列表里的模型直接报错 |

**关键取舍**

- TOML 解析用标准库 `tomllib`（requires-python ≥ 3.12 已满足），不引新依赖。
- 模型构建走 `init_chat_model(model, model_provider=protocol)` 而非直接 import
  `ChatAnthropic` / `ChatOpenAI`：protocol 是配置字符串，需要"字符串→类"的官方分发器；
  且它**懒加载**集成包——只配 anthropic 协议的环境不会加载 langchain-openai。
- **校验从严**：模型不在 `models` 白名单里直接报错（防拼写错误），错误信息带修复提示。
- 模型在 `graph/agent.py` 导入时构建一次。**改 `config.toml` 必须重启 scode**。

**踩过的坑**

- 官方 OpenAI 集成包是 **`langchain-openai`**。PyPI 上的 `langchain-openapi` 是第三方包
  （作者 zbmain，非官方、无文档说明），**不是同一个东西**，装错会在构建 openai 协议
  模型时 `ImportError`。
- gitignore 只防未来提交，不洗历史——若 key 曾被提交过，删除文件后应到供应商后台**换新 key**。

### 003 · 模型配置管理接口

**做了什么**：给 agent server 加一组管理 `conf/config.toml` 的 HTTP 接口，
利用 langgraph_cli 原生的 `http.app` 挂载机制挂一个自写的 Starlette 子应用。

**接口（当前实现是「模型」粒度，不是「供应商」粒度）**

| 方法 | 路径 | 功能 |
|---|---|---|
| GET | `/admin/models` | 列出全部模型，扁平数组，key 默认脱敏 |
| GET | `/admin/models/{id}` | 单个模型详情，`id` 形如 `provider:model` |
| POST | `/admin/models` | 新增模型（provider 不存在则自动建供应商段） |
| PUT | `/admin/models/{id}` | 改模型属性 |
| DELETE | `/admin/models/{id}` | 删除模型（供应商变空则自动删整段） |

**关键取舍**

- **用 Starlette 不用 FastAPI**：CRUD 不依赖 Pydantic 验体，FastAPI 是冗余依赖。
- **路径前缀 `/admin`**：避开 langgraph 内置的 `/ok`、`/assistants`、`/threads`、
  `/runs`、`/store`、`/cron`、`/info`、`/metrics`。
- **TOML 写回**用 `tomli_w`（保留类型，不保留注释），写临时文件 + `os.replace` 原子替换。
- **key 脱敏**：默认返回 `***XXXX`（末 4 位），`?reveal=true` 才给明文。
- **不缓存**：每个请求实时读盘。**不热重载**：改完 toml 要重启 `scode`，
  所有写操作的响应都带 `restart_required: true`。

**踩过的坑**

- **langgraph dev 装了 blockbuster**，async 函数里直接调同步阻塞 IO
  （`os.mkdir` / `open` / `os.replace`）会被拦截报 500。
  `admin/models.py` 里所有同步 IO 都用 `asyncio.to_thread` 包到线程里跑。
- 接口层是**模型**粒度、toml 内部按**供应商**分组，两者不是一回事：
  `protocol` / `base_url` / `api_key` / `display_name` 实际属于整个供应商段，
  所以改一个模型会影响同供应商下所有模型——响应里的 `co_affected` 就是这个意思。
- `tomli_w` 写回会**丢掉注释**。手写的注释在一次 PUT 之后就消失。

### 004 · 子 agent 配置（`conf/subagents.toml`）

**做了什么**：子 agent 声明放配置文件，主 agent 通过 `task` 工具派活。

**当前 `conf/subagents.toml` 里的三个子 agent**

| 名字 | 演示的字段 |
|---|---|
| `reviewer` | `system_prompt` + `permissions`（只读：所有写操作 deny） |
| `fixer` | `interrupt_on`（`write_file` / `edit_file` 要人工确认） |
| `summarizer` | `response_format`（结构化输出 JSON schema） |

**关键取舍**

- **文件入库**（不像 `config.toml`）：里面只有子 agent 声明，没有密钥。
- **文件不存在 = 不配置任何子 agent**，返回空列表而不是报错——deepagents 自带的
  `general-purpose` 子 agent 照常可用。
- **内容写错就报错**：字段名打错（比如 `system_promt`）要立刻报出来，
  否则会以为配上了其实没生效。
- **`model` 必填**：deepagents 的 `SubAgent` 允许不写 model（继承父 agent 的），
  但这里要求每个子 agent 都显式指定，免得"看着配了其实用的是主模型"。
- **`model` 传实例，不传字符串**：deepagents 内部 `resolve_model(spec["model"])` 收到
  `"provider:model"` 字符串会去调 langchain 的 `init_chat_model()`，而它不认识本项目
  自定义的供应商名（`minimax`、`deepseek`），会直接抛错。所以在这里就换成实例。
- **`permissions` 传对象，不传 dict**：deepagents 要的是 `FilesystemPermission` 数据类，
  它的 `__post_init__` 会校验路径（必须以 `/` 开头、不能有 `..`、不能有 `~`），
  这里把 `ValueError` 包成 `ConfigError` 再抛。

**子 agent 的模型复用 `config.toml` 的连接信息**——`base_url` / `api_key` 不在
subagent 配置里重复写。

**不支持的字段**：`middleware`（要 Python 对象，TOML 表达不了）。

### 005 · 后端包结构整理

**做了什么**：`stupid_code/` 里平铺在一级目录的模块按**职责**收进子包，
顶层只留"进程入口"和"框架读的配置"。

**关键取舍**

- **按"职责"分包，不按"技术类型"分包**。`config/` 里三个文件都是"读配置产出东西"的，
  `graph/` 里都是"图怎么建、状态存哪"的——比 tools/prompts/utils 这种技术分类好找。
- **`config/`（包） vs `conf/`（目录）** 是两个东西：前者是代码，后者是数据。
- **`graph/` 而不是 `app/`**：`admin/app.py` 已经占了 app 这个名字。
- **`data/` 留在包根**（`stupid_code/data/`），它是"整个后端的持久产物"，
  不是"图的私有数据"。

### 006 · agent 长期记忆（`.scode-memory.md` + `~/.scode/memory.md`）

**做了什么**：每次新会话开始时，把**两份**长期记忆读进系统提示词——

| 作用域 | 文件 | 跟着谁走 |
|---|---|---|
| 项目级 | `<工作空间>/.scode-memory.md` | 项目 |
| 用户级 | `~/.scode/memory.md`（目录由 `$SCODE_HOME` 决定） | 用户，跨所有工作空间 |

文件不存在就当没记忆（**不会自动创建**，014 期改的）。

**关键取舍**

- **用 `middleware=` 挂 `MemoryMiddleware`，别用 `create_deep_agent(memory=...)`**。
  两者是同一个中间件，但 `memory=` 只能用框架默认的 backend——默认是 StateBackend
  （虚拟文件系统），**读不到磁盘上的文件**。自己挂才能给 `FilesystemBackend`。
- **同一工作空间内记忆只在会话开始时读一次**。`MemoryMiddleware.before_agent` 见到
  state 里已有 `memory_contents` 就不重复读——这是框架的设计（记忆块要参与 prompt
  缓存）。代价是**改完 `.scode-memory.md` 要开新会话才生效**。014 期起
  `WorkspaceMemoryMiddleware` 在 state 里记了"上次读的是哪个工作空间"，**换工作空间
  会把 `memory_contents` 摘掉逼框架重读**，否则会拿 A 项目的记忆指导 B 项目的活。
- **不会自动创建 `.scode-memory.md`**（014 期改的）：启动和开跑时都不往工作空间写文件，
  避免用户选中一个项目就凭空多出这个文件。框架遇到读不到的文件会 `continue` 跳过
  （当没记忆），所以记忆块里要告诉模型文件不存在时先用 `write_file` 创建。
- **记忆文件叫 `.scode-memory.md`，不用框架默认的 `AGENTS.md`**。后者是
  "写给编码 agent 看的项目约定"（本项目根目录那份就是），和"agent 自己攒的长期记忆"
  是两回事。工作空间正好是项目根时，沿用默认名会把开发者的项目说明当记忆注入。
- **工作空间 = 运行期选中 / 默认目录**：006 期时是 `Path.cwd()`（launcher 把子进程的
  cwd 设成用户工作空间）；014 期起按 `configurable.workspace` 动态解析，见 014。

**015 期改动：记忆块换成本项目自己的模板 + 加长度上限**

014 期之前用的是框架自带的 `MEMORY_SYSTEM_PROMPT`（英文通用模板），有两个问题：

- **它教模型用错工具**。框架那段写的是 "you can save new knowledge by calling the
  `edit_file` tool"，但本项目的记忆文件**可能根本不存在**（可选、不自动创建），
  `edit_file` 打在不存在的文件上会直接返回 error。模型每个新工作空间都要白白浪费
  一轮失败的工具调用，才读到我们另外追加的中文说明。
- **它跟本项目的真实语义对不上**，也没说"可选 / 每个工作空间一份 / 一次会话读一次"，
  而且整段英文跟项目的中文系统提示词不一致。

现在 `build_memory_middleware()` 通过框架公开的 `system_prompt=` 扩展点换成
`memory.py` 里的 `_MEMORY_TEMPLATE`（中文），把上面三件事写进去，并明确
**第一次用 `write_file`、之后才 `edit_file`**。同时覆盖 `_format_agent_memory()`：
框架那份在记忆为空时填英文的 `(No memory loaded)`，现在改成模板自己的说法
（"为空表示还没有记忆"）；顺带让「剥 HTML 注释 / 跳过空段」的行为跟框架一致——
不然会出现"框架说没记忆、我们说有记忆"的自相矛盾（实测：记忆文件里只有一行
`<!-- 注释 -->` 就会踩到）。

**记忆文件加了长度上限**（`MEMORY_MAX_CHARS = 8000`）：框架把记忆文件**整个**读进
系统提示词，不截断。记忆文件是 agent 自己写的（`edit_file` 追加），会一直涨——
实测一个 20 万字符的记忆文件能把系统提示词撑到 20 万字符，直接顶爆上下文窗口，
这一轮 run 就废了。超限时**保留头尾、中间省略**（头是 `write_file` 整体重写时整理过的
核心，尾是 `edit_file` 追加的最新记录），并插一行说明。截断只影响注入提示词的内容，
磁盘上的文件不动。

**记忆文件是谁创建的：只有 agent 调 `write_file`**

中间件**只读不写**——`before_agent` 走 `download_files`，读不到就是「没记忆」，
不建文件（这是 014 期刻意的：别往用户选的项目里凭空塞文件）。实测：

| agent 的动作 | 结果 |
|---|---|
| `edit_file` 写记忆（文件还不存在） | `Error: File '/.scode-memory.md' not found` —— **不创建** |
| `write_file` 写记忆（文件还不存在） | `Updated file /.scode-memory.md` —— **创建** |

所以「模型会不会用错工具」直接决定记忆能不能存下来。框架默认那份英文模板教的是
`edit_file`，在本项目会白白失败一轮；换成项目自己的模板后第一个动作就是
`write_file`（模板里写明「`edit_file` 要求文件已经存在，对不存在的文件会直接报错」）。

**015 期修：绝对路径写记忆会落进嵌套目录**

工作空间根是**软链展开后**的真实路径（`resolved`），但模型手里的绝对路径可能是
用户手打的那条（`given`，没展开软链）——macOS 上 `/tmp` → `/private/tmp` 就是这种。
只拿 `resolved` 去剥前缀，`relative_to` 直接失配 → 前缀剥不掉 → 框架把绝对路径
当虚拟路径 → 文件落到 `<工作空间>/tmp/x/.scode-memory.md` 这种嵌套目录里，
**还不报错**（014 期只修了一半：软链形态一致时是好的）。

现在 `graph/workspace.py` 的 `WorkspaceRoot` 同时记两种形态，解析时一起算好缓存
（热路径只读缓存，不碰文件系统）；`graph/backend.py` 的 `_workspace_relative()`
对两种形态各试一次。实测（工作空间 `/tmp/scode-sym-xxx`）：

| 模型传的路径 | 落点 |
|---|---|
| `/tmp/scode-sym-xxx/.scode-memory.md`（软链形态） | `<工作空间>/.scode-memory.md` ✔ |
| `/private/tmp/scode-sym-xxx/.scode-memory.md`（真实形态） | `<工作空间>/.scode-memory.md` ✔ |
| `/.scode-memory.md`（虚拟路径） | `<工作空间>/.scode-memory.md` ✔ |

**017 期改动：长期记忆分两个作用域 + 前端记忆面板**

017 期之前只有项目级记忆。现在两份都有：项目级 `<工作空间>/.scode-memory.md`
（跟着项目走）、用户级 `~/.scode/memory.md`（跟着用户走，跨所有工作空间共用）。

**框架本来就支持多来源**——`MemoryMiddleware(sources=[...])` 的 `sources` 是 list，
框架自己的示例就是 `["~/.deepagents/AGENTS.md", "./.deepagents/AGENTS.md"]`：
一条用户级、一条项目级。本项目实现的就是这两条，**不是自己另造一套机制**。

具体怎么接的：

- **中间件的 backend 是一层 `CompositeBackend`**（`graph/memory.py`）：
  - 默认 → `WorkspaceFilesBackend`，根目录跟着**运行期**工作空间走（`cwd` 是
    property），所以这一轮选了哪个项目目录，项目级记忆就从哪个目录读；
  - 路由 `/user-memory/` → `FilesystemBackend`，根固定在 `~/.scode/`。
  - `CompositeBackend.download_files()` 会按路径分批路由，两条来源各自落到自己的
    backend 上——这正是框架多来源机制的设计用途。
- **主 backend 上也有同一条 `/user-memory/` 路由**（`graph/backend.py`），所以 agent
  能用 `write_file("/user-memory/memory.md", ...)` 写用户级记忆，**跟写项目级记忆
  用同一个工具**，不用额外教一套。
- **顺序：用户级在前、项目级在后**。框架按 `sources` 顺序拼接，后面的在提示词里
  更靠后、冲突时优先被读到——项目级更具体，理应压过用户级。
- **记忆模板**（`_MEMORY_TEMPLATE`）改成讲两个作用域的分工：用户级记"跟具体项目
  无关的东西"（角色、偏好、沟通方式、工具链），项目级记"这个项目的约定"。
  还加了一句"分不清放哪就放项目级"——用户级写错了会跟着你到每一个项目。
- **两份都不自动创建**，agent 第一次写时自己用 `write_file` 建（`~/.scode/` 目录
  也是那时才出现，跟项目级记忆同一个态度：不往用户主目录里凭空塞东西）。
- **用户级记忆落在用户主目录**——容器里 `~` 是容器用户的家目录，容器一重建就
  空了。要跨容器存活得挂一个宿主目录进去、把 `SCODE_HOME` 指过去
  （见 `docker-compose.yml` 的 `SCODE_HOME` 卷）。

**为什么不用 LangGraph store**（store 早就在 `langgraph.json` 里配好了，实测也
能用——`stupid_code/data/langgraph.db` 的 `store` 表第一次写时才建）：

- 会变成"项目级是文件、用户级是数据库"两套介质两套排查方式；
- store 的 value 格式由 `StoreBackend` 自己产生（手写 `{"content": ...}` 读不出来），
  而且**人没法直接看**——记忆是给人看、给人手改的东西。

**新增两个端点 + 前端记忆面板**

`GET /admin/memory` / `PUT /admin/memory`（`stupid_code/admin/memory.py`）把磁盘上
那两份记忆直接暴露出来，前端 `components/memory/MemoryPanel.tsx` 拿来显示和编辑。

- **为什么要有**：记忆是磁盘上的 markdown，但网页版用户看不见它——想看一眼或改
  一个字都得开终端翻工作空间。
- **面板放在输入区那一行**（工作空间/权限选择器旁）。项目级记忆是**任务级**的，
  跟着当前 taskStore 的工作空间走；没选工作空间时后端退回它自己的默认工作空间
  （跟 agent 的行为一致）。
- 两个 textarea，各自一个保存按钮；**写空内容 = 清空文件**（文件留在原地，只是
  没内容了），不是删文件。
- **改完不立刻生效**：记忆是会话开始时读一次的（框架机制），要开新会话。这句话
  直接写在面板底部，免得用户以为没保存成功。
- **两边同时改会互相覆盖**（后写的赢）：agent 用 `write_file` 写、面板也直接写
  文件，两边都是普通写者。这句话也写在面板底部。

**017 期改动：写记忆走人工确认**

写记忆是**唯一一条「影响未来所有会话」的写路径**。对比一下别的写路径：

| 写路径 | 影响 | 有人管吗 |
|---|---|---|
| `write_file` 改代码 | 局部，可回滚，git 能看 | ❌ 不拦（是 code agent 的日常） |
| `execute` 跑命令 | 跑命令 | ✅ `normal` 拦危险模式，`manual` 全拦 |
| `delete` 删文件 | 递归删 | ✅ `manual` 档拦 |
| MCP 工具 | 副作用在服务器上 | ✅ `manual` 档拦非只读 |
| **写记忆** | **持久 + 可能跨项目 + 隐蔽 + 会自我强化** | **017 期起拦** |

记忆写错了的后果跟改错代码完全不是一个量级：代码写错了当场就能看出来，
记忆写错了会**一直影响后面每一个会话**（用户级那条还会跟着你到每一个项目），
而且**没人会知道它是什么时候、为什么写错的**——agent 写完记忆，界面上什么
都不会显示。错误记忆还有个自增强效应：agent 基于错记忆做出错决策，还可能把
「错上加错」的结论再写一条记忆。

所以 `write_file` / `edit_file` 也进了 `interrupt_on`（`graph/permissions.py`）：

- **判据只看路径**：`is_memory_path()` 认出「目标是记忆文件」的那次调用，其余
  一律不拦——**写代码完全不受影响**。
- **档位**：`normal` 和 `manual` 都拦，`auto` 不拦（`auto` 的语义是「不要打断
  我」）。记忆写入不像 `execute` 那样频繁，代价可以接受。
- **只给 `approve` / `reject`，不给 `edit`**：前端能改的只是 `file_path`
  （路径），改路径不等于改内容——用户改完路径，写进去的还是原来那段内容，
  纯误导。要改内容就拒绝，然后在对话里说清楚，让模型重写。
- **判据是纯字符串操作，不碰文件系统**：`when` 谓词跑在工具调用链上，而
  `langgraph dev` 装了 blockbuster——事件循环里的同步 FS 调用（`os.stat` /
  `os.readlink`）会把整轮 run 带崩。所以只用 `os.path.basename` /
  `os.path.expanduser` 这类纯字符串操作。

认的路径写法（实测）：

| 模型传的路径 | 作用域 | 拦不拦 |
|---|---|---|
| `/.scode-memory.md` | 项目级 | ✔ |
| `/user-memory/memory.md` | 用户级 | ✔ |
| `<工作空间>/.scode-memory.md`（绝对路径） | 项目级 | ✔ |
| `~/.scode/memory.md` | 用户级 | ✔ |
| `<工作空间>/src/main.py` | 不是记忆 | ✘ |
| `<工作空间>/memory.md`（项目里普通的 memory.md） | **不是记忆** | ✘ |

最后一条**故意不按文件名匹配**：`memory.md` 太通用，项目里随便一个
`memory.md` 都不该被当成用户级记忆——用户级只认精确等于 `$SCODE_HOME/memory.md`
的那个。

**补救流程（记忆写错了怎么办）**

1. **前端「记忆」按钮** → 改对应的那个 textarea → 保存。
   - 用户级错了改 `~/.scode/memory.md`（影响**所有**项目）
   - 项目级错了改 `<工作空间>/.scode-memory.md`（只影响这个项目）
   - **必须开新会话**才生效——当前会话读的是会话开始时的快照
2. **面板打不开就改磁盘**：`$EDITOR ~/.scode/memory.md`
3. **不知道哪条错了就整体清空**：`: > ~/.scode/memory.md`
   （实测：清空和删文件对注入效果**完全等价**，正文都是空；记忆块本身还在，
   里面是模板和「怎么用这份记忆」的规则）
4. **当前会话里的临时纠正**：直接告诉 agent「那条记忆是错的」——这进对话历史，
   本会话有效，但**文件里那条还在**，下个会话又冒出来，所以还得改文件

### 007 · 真实 backend（CompositeBackend + LocalShellBackend）

**做了什么**：agent 的文件操作落在工作空间的**真实磁盘**上，并拿到 `execute`（本机 shell）。

之前 backend 是 deepagents 默认的 `StateBackend`——虚拟文件系统，`write_file` /
`edit_file` 写的是内存副本，落不了盘。连带两个后果：长期记忆文件存不下来、
agent 不会跑命令改完代码没法验证。

**当前实现**

```python
CompositeBackend(
    default=LocalShellBackend(
        root_dir=workspace_dir(),   # = Path.cwd()
        virtual_mode=True,          # 文件操作锁在工作空间内（shell 不受限）
        inherit_env=True,           # shell 继承当前环境，否则 PATH 是空的
    ),
    routes={
        "/tmp/": StateBackend(),    # 临时区走虚拟 FS，不落盘（020 期已删）
        "/user-memory/": FilesystemBackend(root_dir="~/.scode/"),   # 017 期加
        "/user-skills/": FilesystemBackend(root_dir="~/.scode/.agents/skills/"),  # 018 期加
    },
    artifacts_root="/.scode",           # agent 自己的中间产物收在这一个目录里
)
```

> 📌 **现状以 020 期为准**：`/tmp/` 那条路由已经删掉，`WorkspaceCompositeBackend`
> 守卫类也一并没了。上面这段保留 007 期的形态，方便对照当时的取舍。
> 见下方「020 · 删掉 `/tmp/` 路由」。

**016 期改动：agent 自己的产物收拢到 `.scode/`**

deepagents 会往 backend 里写三样东西，落点由 `CompositeBackend.artifacts_root`
决定（默认 `/`，也就是工作空间根目录）：

| 内容 | 默认路径 | 本项目路径 |
|---|---|---|
| 被压缩掉的对话历史 | `/conversation_history/<session_id>.md` | `<工作空间>/.scode/conversation_history/<session_id>.md` |
| 超大的工具结果（eviction） | `/large_tool_results/<tool_call_id>` | `<工作空间>/.scode/large_tool_results/<tool_call_id>` |
| 二进制内容块（默认关着） | `/blobs/<sha256>` | `<工作空间>/.scode/blobs/<sha256>` |

**问题**：默认路径全在工作空间根目录，用户的项目里会冒出三个顶层目录；而
`large_tool_results/` 和 `blobs/` **此前压根没进 `.gitignore`**——实测一次
120KB 的工具结果 eviction 就在工作空间里留下一个未忽略的临时文件。

**改法**：把 `artifacts_root` 设成 `/.scode`，三个子目录跟着前缀走。理由：

- 一个隐藏目录、一条 gitignore 规则，命名跟项目已有的 `.scode-memory.md` 一致。
- **产物必须在工作空间里**：工具消息里就是这么告诉 agent 的「结果太大，存到这个
  路径，你可以 `read_file` 读回来」。路径出了 `virtual_mode` 的边界就读不回来，
  eviction 会退化成「存了但读不到」。
- **受限子 agent 也套一层没有路由的 CompositeBackend**（`graph/backend.py` 的
  `build_restricted_backend()`，原来是裸 `FilesystemBackend`）：框架读 `artifacts_root` 的条件是
  `isinstance(backend, CompositeBackend)`，裸 backend 拿不到这个属性，产物就会
  退回 `/` 根目录，跟主 agent 分叉。没有路由 = 行为跟裸 FilesystemBackend 完全
  一致，框架的权限判定路径（`_resolve_real_path`）也显式认 CompositeBackend。

**代价**：在途对话里旧的摘要记着 `conversation_history/...` 旧路径，读不到了。
判断为可接受——那是 scratch 文件，agent 读不到就当没有。

**关键取舍**

- **用 `CompositeBackend` 包一层，而不是直接用 `LocalShellBackend`**：把"哪部分路径
  走哪种存储"变成配置而不是散落在代码里。以后要加"某个目录走 langgraph store 跨会话
  持久化"之类的规则，加一条 route 就行。
- **`/tmp/` 路由到 `StateBackend`**：会话内的临时区，agent 的临时产物不该在用户磁盘上
  留垃圾。框架会自动为 CompositeBackend 生成一段"虚拟路径 ↔ shell 路径"的提示，
  `/tmp/` 会被标成"shell 访问不到，只能用文件工具"。
  **（020 期已删掉这条路由和它的守卫类——见下方「020 · 删掉 `/tmp/` 路由」）**
- **`inherit_env=True`**：`LocalShellBackend` 默认 `inherit_env=False`，shell 拿到的是
  **空环境**——PATH 是空的，`uv` / `python` / `node` 全都找不到。
- **声明了 `permissions` 的子 agent 要换一套 backend**。框架有条硬限制：backend
  支持命令执行时，`FilesystemMiddleware` 不接受 `permissions`，直接抛
  `NotImplementedError`。理由站得住——`execute` 能用 shell 绕过任何文件权限
  （`echo x > file`）。处理办法：给这类子 agent 单独一个**没有 shell** 的
  `FilesystemBackend`（真实磁盘，路径同样锁在工作空间内），权限就真的拦得住。
  实现见 `graph/subagent_policy.py` 的 `apply_subagent_policies()`。
- **长期记忆中间件不共用这个 CompositeBackend**：记忆只需要"工作空间里那一个文件"，
  自己持有一个以工作空间为根的 `FilesystemBackend` 更直白。两者解析出来的真实路径
  是同一个，所以 agent 写进去的内容下次开新会话照样会被读进来。

### 008 · launcher 的端口与关停行为

**做了什么**：修掉 launcher 的两个老毛病——端口被占时误报"已就绪"、
启动途中 Ctrl+C 留下孤儿。

**关键取舍**

- **端口锁死 2024，占用就失败**，而不是"自动换一个"。两个理由：
  1. `langgraph dev` 在端口被占时会自己换一个（日志里写
     `Port 2024 is already in use, using port NNNNN instead`），而 launcher 的就绪检查
     只轮询 2024——不锁定端口的话，就绪检查打到的是**占着 2024 的旧服务**，
     它当然"已就绪"，但跑的是旧代码，看起来就像"改了没生效"。
  2. 前端默认连 2024（`VITE_LANGGRAPH_URL`）。自动换端口的话前端得跟着改，一改就漏；
     而且旧服务还占着 2024，改了也是错的。
- **启动前先探端口**（`socket.bind` 试一下），而不是等就绪超时。占用时立刻报错，
  用户不用干等 60 秒。
- **整个生命周期只有一个 `finally`**。早期版本启动阶段是 `except Exception`，而
  `KeyboardInterrupt` 继承自 `BaseException` 抓不住，异常穿透出去后，负责清理的
  `finally` 根本没机会执行。现在把"启动 + 等待就绪 + 等待退出"整段包在一个
  `try/finally` 里，任何路径都会收掉子进程组。

### 009 · shell 的人工确认（HITL）

**做了什么**：agent 的 `execute` 工具在本机跑命令之前，按运行期传来的权限档位决定
拦不拦；拦下时图挂起，前端弹确认卡片，用户批准或拒绝后图才继续。

**三档行为**

| 档位 | 行为 |
|---|---|
| `auto` | 不确认，直接执行（用户明确选择了不被打断） |
| `manual` | **每一条**执行命令、每一次删文件都确认 |
| `normal` | 只有命中「危险模式」的命令才确认（**默认档**） |

档位随运行请求走 `config.configurable.permissions`，**不存全局**——和 `workspace`
一样是任务级参数。

**危险模式清单**（`graph/permissions.py` 的 `DANGEROUS_PATTERNS`，命中就认为这条命令
不可逆 / 影响系统 / 会拉远程代码执行）：

`rm` 带 r/f · `dd if=` · `mkfs`/`fdisk`/`diskutil` · fork 炸弹 · `shutdown`/`reboot`/`halt` ·
`sudo`/`su -` · `chmod 777` · `chown ... root` · `git push --force` · `git reset --hard` ·
`git clean -f` · `curl`/`wget` 管道到 sh · 重定向到系统目录 · `kill -9`/`killall` ·
`history -c`

**关键取舍**

- **只拦 shell 类的写操作**。框架有条硬限制：backend 支持命令执行时 `FilesystemMiddleware`
  不接受 `permissions`（抛 `NotImplementedError`），所以文件权限和 shell 不能共存。
  本期绕开这个矛盾：只拦 shell，文件工具靠真实磁盘 + 提示词，不做工具层强制。
- **危险判定用固定正则，不用 AI**。原设想 `normal` 档由 AI 判断这次操作是否危险：
  AI 审核要额外一次模型调用，判断标准也没法复现，出了问题说不清是谁该负责。
  改成固定规则——命中就是命中，不命中就不命中，行为可预期。**代价是宁可漏拦也不误拦**
  （`rm --recursive --force` 这类等价写法匹配不上）。**`normal` 是过滤器，不是安全边界**：
  它只看命令字符串，`find -delete`、`python -c "shutil.rmtree(...)"`、先 `write_file`
  写个脚本再 `execute` 它，都绕得开。要确定性就切 `manual`。
- **子 agent 默认继承顶层 `interrupt_on`**（deepagents 的合并规则：
  `spec.get("interrupt_on", interrupt_on)`）。所以没声明 `permissions` 的子 agent
  （如 `fixer`）执行命令也会走 HITL；声明了 `permissions` 的子 agent（`reviewer`）
  被换成无 shell 的 backend，压根没有 `execute` 工具，不受影响。

**015 期改动：三个真问题**

*一、`delete` 工具没人管*

`delete` 是文件工具、不走 `execute`，所以一直没被拦。但它的工具说明写得很清楚：
「Deleting a directory removes it and everything inside it, recursively」——**删目录是
递归的，跟 `rm -rf` 等价**。于是模型换个工具就把确认绕过去了：用户看到「rm -rf 会
问我」，但 agent 用 `delete` 删目录时一声不吭。

现在 `delete` 也进 `interrupt_on`，**只在 `manual` 档拦**（删文件是 code agent 的
日常，`normal` 档拦它太吵）。确认卡片上写明删的是什么、不可撤销。

*二、恢复时档位变了 → 被拒绝的命令照样执行*

框架的 `when` 谓词**在恢复时会再跑一次**，而且明确要求「同一次调用必须给出同样的
答案」。档位只从运行配置里读的话，恢复时前端回传的值一变，结论就变：

- 变成 `auto` → 谓词返回 False → 用户的「拒绝」被跳过，**被拒绝的命令照样执行**
  （框架文档原话：the reviewer's answer is skipped and the tool runs, even if they
  rejected it）
- 变成 `manual` → 多出/少掉待确认的调用 → decisions 数量对不上 → 框架抛
  `ValueError`，整轮跑挂

实测复现（2026-10-26）：`normal` 档挂起 → 用户拒绝 → 恢复时回传 `auto` → **文件
被删了**。

修法：`PermissionLevelMiddleware` 在**开跑前**把档位写进图状态（checkpoint 里的私有
字段），`when` 谓词优先读它。恢复时 `before_agent` 不会重跑（实测），state 里留的就是
发起那轮运行时的那一档。**不信任客户端回传的值**。子 agent 的谓词读的是子 agent
自己的 state，所以每个子 agent 也挂一份这个中间件。

*三、前端竞态：metadata 还没落盘就开跑*

工作空间和档位除了在内存里，还写进 thread metadata（刷新页面靠它回填）。原来那个
PATCH 是 fire-and-forget，run 紧接着就开跑——**run 已经挂起、metadata 还没写进去**
的话，刷新页面回填成默认档位，恢复时的判定就跟发起时对不上。现在改成先
`await` PATCH 再开跑（写失败不阻塞主流程）。

**015 期新增：`edit` 决策（改完命令再执行）**

框架的 HITL 支持 `edit`：用户可以改完命令再批准，不用「拒绝 → 模型重写 → 再问」地
绕一圈。现在 `execute` 的 `allowed_decisions` 是 `["approve", "edit", "reject"]`，
`delete` 是 `["approve", "reject"]`（改路径意义不大）。

前端相应地：审批卡片每条动作可以**单独**选批准 / 拒绝 / 改后执行，命令是可编辑的
文本框；拒绝时可以填理由（作为 `message` 传给模型，模型能知道为什么被拒）；卡片上
还显示工作目录（相对路径的命令在哪执行，用户得知道）。

**改完的命令不会再过一遍危险模式判定**——那是用户自己敲的，他比你清楚。框架会在
工具结果前面加一句「a human reviewer replaced this tool call」告诉模型命令被改过。

### 010 · 运行期切换对话模型

**做了什么**：侧边栏下拉框换一个模型，**下一条消息就用新供应商的 base_url / api_key /
protocol**，不用重启后端。

**为什么不能靠改 config.toml**：模型实例在 `graph/agent.py` 导入时建一次，改配置就得
重启服务——而重启会丢掉正在跑的东西，用户每换一个模型都要重启一次是不能接受的。

**为什么是中间件**：deepagents 把模型实例交给 `create_agent()` 之后就不管了，但框架在
**每次**模型调用前都会组装一个 `ModelRequest`，其中 `request.model` 就是那次要用的模型。
中间件的 `wrap_model_call` / `awrap_model_call` 拿到它，`request.override(model=...)`
换掉——而框架最终是拿 `request.model.bind_tools(...)` 去发请求的
（`langchain/agents/factory.py` 的 `_get_bound_model`），所以换了就是真换了。

**数据流**

```
侧边栏下拉框（localStorage）
  → 每次发消息时随 configurable 一起发：configurable.model = "供应商名:模型名"
  → 后端 graph/model_switch.py 读 configurable["model"]
  → 重新读 conf/config.toml，按该 id 建模型实例（base_url / api_key / protocol）
  → request.override(model=那个实例) → 框架用它发请求
```

**关键取舍**

- **每次调用都重新读 `config.toml`**：新增模型、改 base_url、改 api_key 都立刻生效，
  不用重启。这条路径和「启动时建默认模型」是两条独立的路。
- **模型实例按连接信息缓存**（`config/model.py` 的 `_MODEL_CACHE`，键含 api_key），
  避免每次调用新建 HTTP 客户端；改了 key 键就变了，缓存自然失效。
- **取不到就退回默认模型**：选了一个不存在的模型时记 warning、继续用默认模型，
  而不是让整个对话挂掉。**模型调用阶段的失败不兜底**（401、限流、上下文超长
  直接抛给用户看）——那是真实错误，不该藏。
- **模型是全局偏好，不是任务级参数**：`workspace` / `permissions` 按 `threadId` 存，
  因为同任务内前后两条消息可能针对不同目录；模型没有这种语义，选了就是全局切。
  选中值存 localStorage，每次运行都随请求带过去，所以刷新页面、后端重启都还在。
- **只切主 agent，子 agent 不跟着切**。子 agent 用哪个模型是**配置**出来的——
  本项目 `reviewer` / `summarizer` 刻意用便宜的 `MiniMax-M3.1-Flash`，
  主 agent 用 `MiniMax-M3`，「主对话用强模型、委派出去用便宜模型」是这个结构
  的一部分。用户在下拉框选模型，意图是「**这段对话**用这个模型」。
  让子 agent 跟着切，等于把委派出去的活偷偷挪到新选（可能很贵）的模型上，
  把配置好的成本结构打乱。
  - `conf/subagents.toml` 里声明了 model 的子 agent：一律用它自己写的那个
  - deepagents 自动加的 `general-purpose`：用建图时继承来的那个（即启动时的默认模型）
  - `mode="fork"` 的子 agent：**默认会跟着切**——它继承父级全部 middleware，
    `agent.py` 用 `apply_model_switch_policy()` 给它的规格塞一个同名但 `enabled=False`
    的切换中间件顶掉继承来的那个，保证它用 `subagents.toml` 里配的模型。新增 fork
    入口时别漏掉这一步。
  - 要改某个子 agent 用哪个模型，去 `conf/subagents.toml` 写死——那才是「显式配置」该待的地方

  （框架层面做得到：子 agent 的中间件也能拿到父图的 `configurable`。这里选择不用。）
- **中间件的顺序有意义**：切换中间件放在 `middleware=` 列表最前 → 在最终栈里位于
  core 中间件之后、prompt-caching / memory / HITL 这些尾部之前，也就是**比它们更外层**。
  这样 `AnthropicPromptCachingMiddleware` 和 `MemoryMiddleware` 看到的是换过的模型，
  缓存断点才会按新模型决定加不加。

**已知边界**（不重启后端换模型的固有代价）

| 边界 | 说明 |
|---|---|
| harness profile 不跟着换 | deepagents 按**启动时**的模型决定系统提示词附加内容、工具描述改写、排除哪些工具 |
| 摘要阈值不跟着换 | 压缩历史的触发阈值按启动时模型的上下文窗口算；切到窗口更小的模型可能触发偏晚 |
| ~~摘要用的还是旧模型~~ | **011 期已修**：摘要改用当前选中的模型，见下面的 011 期 |
| 子 agent 不跟着换 | 子 agent 用哪个模型是**配置**出来的（`conf/subagents.toml`），切换只影响主对话；fork 继承的切换中间件已用 `enabled=False` 的同名实例顶掉 |
| 选了不存在的模型 | 静默退回默认模型（后端有 warning 日志，界面上看不出来） |

### 011 · 手动压缩对话历史（`/compaction`）

**做了什么**：输入框敲 `/` 弹出命令菜单，选「压缩对话历史」→ 后端把之前的对话
总结成一段摘要，释放上下文窗口；旧的对话落成文件，agent 需要时能 `read_file` 读回来。

**框架自带的两层**（deepagents `middleware/summarization.py`）

| 层 | 干什么 | 怎么触发 |
|---|---|---|
| `SummarizationMiddleware` | 自动：对话超阈值时压缩 | 框架自己判断 |
| `SummarizationToolMiddleware` | 手动：注册 `compact_conversation` 工具 | 模型调用那个工具 |

两层共用 `_summarization_event` 这个私有 state key，状态才对得上。

**关键发现一：摘要的模型是建图时定死的**

`langchain` 的 `SummarizationMiddleware.__init__` 里有：

```python
self._summary_chat_model = self.model     # 构造那一刻就固定了
```

摘要调用走 `self._summary_model.invoke(...)`，**不是** `request.model`。
所以「切到新供应商之后，压缩历史还在烧旧供应商」是框架的默认行为。

这跟「这段对话用这个模型」的意图对不上：用户特意切过去图省钱，压缩却按旧价结算。
框架留了公开扩展点——`summarizer` 参数（一个 Runnable，接管摘要调用）。
本项目用它，在**每次调用时**解析 `configurable.model`，摘要也用当前选中的模型。

**关键发现二：要让 `/compaction` 生效，得顶掉自带的那份**

deepagents 按中间件的 `.name` 合并：**名字撞上已有槽位就原地替换，不撞就多一份**。
自带那份的 `.name` 对「正好是它自己」返回公开别名、对子类返回类名
（子类必须显式覆盖）。所以 `CompactionMiddleware.name` 报同样的名字 → 原地替换。
两份摘要中间件同时跑会重复压缩、互相打架。

**别名不要写死字面量**：框架升级改了公开别名，写死的字符串就对不上了 → 静默变成
两份摘要中间件。本项目的做法是**从框架那里取**（`compaction.py` 的
`_framework_summary_name()`）：取框架写在 `name` property 旁边的 ClassVar
`SummarizationMiddleware.serialized_name`。

**别直接 `return SummarizationMiddleware.name`**：property 访问类属性拿到的是
**property 对象本身**，不是字符串。合并键变成一个永远对不上的对象 → 静默变成两份
摘要中间件（实测过：最终栈 2 份，一份框架的、一份我们的）。

**关键发现三：判断「要不要压缩」的地方就是 `_should_summarize()`**

子类覆盖它：这一轮用户发的是 `/compaction` 就返回 True，剩下的活全部交给框架
原有 machinery（切分 → 总结 → 落盘 → 生成 summary event）。

**只看最后一条用户消息**：`/compaction` 这条消息会留在对话里（模型要看到它才知道
发生了什么），如果判断成「出现过就行」，下一轮又会误判一次，历史被反复压缩。

**压缩了什么**：框架默认把被摘走的旧消息写到 backend 的
`conversation_history/<session_id>.md`，摘要里带着那个路径，agent 之后可以
`read_file` 读回来。所以压缩不是「丢历史」，是「把历史挪进文件」。
（这个目录已经加进 `.gitignore`——它是工作空间本地状态，跟 `.scode-memory.md` 同类。）

**前端**

- `web/src/lib/commands.ts`：命令表。加新命令不用改接口——命令就是一条普通消息，
  后端认出就执行
- `web/src/components/chat/InputBar.tsx`：开头敲 `/` 弹菜单，↑↓ 选、回车/Tab 确认、
  Esc 关闭。只在**开头**是 `/` 且还没打空格时才弹（`/usr/local/bin` 这种路径不误弹）
- `web/src/components/chat/UserMessage.tsx`：命令渲染成「命令气泡」，
  `/compaction` 显示成一句普通聊天看着像在说胡话
- 系统提示词里加了一段，告诉模型收到 `/compaction` 时简短确认就行，
  不要复述摘要、也不要接着上次的活往下做

**关键取舍**

- **摘要用当前选中的模型**：用 `summarizer` 这个公开扩展点接管，没去改框架私有属性
  （改 `self._summary_model` 是共享可变状态，并发跑会串）。
- **自己实现 Runnable 而不是用 `RunnableLambda`**：框架的摘要调用有同步
  `invoke` 和异步 `ainvoke` 两条路。`RunnableLambda` 包同步函数的话，异步路径会
  把它丢进线程池——而 `get_config()` 依赖 contextvar，跨线程不一定拿得到
  `configurable`，就会静默退回默认模型。自己实现 `invoke`/`ainvoke` 就没这个问题。
- **`/compaction` 是普通消息**：不在前端做特殊拦截，后端按消息内容认出命令。
  加新命令不用改接口。

### 012 · Docker 运行（后端 + 前端）

**目标**：不用在宿主机装 Python / Node，`docker compose up --build` 就能跑起
后端 Agent Server + 前端网页，且行为跟原生跑法一致（真后端、SSE 流式、
agent 能改真实文件、历史不丢）。

**成果**：

| 文件 | 作用 |
|---|---|
| `Dockerfile` | 后端镜像（python:3.12-slim + uv） |
| `web/Dockerfile` | 前端镜像（node 构建 → nginx 托管） |
| `web/nginx.conf` | 静态托管 + `/api` 反代 + SSE 参数 |
| `docker-compose.yml` | 串起两个服务 |
| `.dockerignore` / `web/.dockerignore` | 构建上下文排除（含 api_key） |
| `stupid_code/launcher.py` | 新增 `SCODE_BIND_HOST`（见下） |

**关键取舍一：后端仍用 `scode` 启动，不用 `langgraph dev` 直接跑**

`langgraph dev` 在容器里有个坑：`langgraph.json` 里 `dependencies: ["."]`
会被框架解读成"把 cwd 加进 sys.path"，而 cwd 是 agent 的工作空间——那会把
工作空间里一个叫 `stupid_code` 的目录当成后端包导入。

更根本的是：`scode` 负责派生配置（把 langgraph.json 里的相对路径绝对化）、
就绪校验（`/ok` + 图注册都通过才算启动成功）、端口锁定、优雅关停。
这些逻辑在 008 期已经踩过坑了，容器里重新实现一遍必然踩第二遍。
所以容器入口直接是 `/opt/venv/bin/scode`，复用同一套逻辑。

**关键取舍二：app 根和 agent 工作空间必须分开**

容器里有两个"目录"，性质不同：

| 目录 | 内容 | 位置能变吗 |
|---|---|---|
| `/app` | stupid-code 本体：源码 + `conf/` + `data/` | **不能** —— 框架按 `__file__` 定位这些目录 |
| `/workspace` | agent 干活的目录（用户指定） | 能，随时指向别的项目 |

框架那四处 `__file__` 定位（见上）决定了 `/app` 的位置是约定死的，
所以后端**代码来自镜像**，只有**配置和持久化**来自宿主：

```yaml
volumes:
  - "./conf:/app/conf"                    # 供应商配置（含明文 api_key）
  - "./stupid_code/data:/app/stupid_code/data"  # SQLite checkpoint / store
  - "${SCODE_WORKSPACE:-.}:/workspace"    # agent 的工作空间
```

**踩过一次的坑：合并成一个目录会直接崩**

早先一版把源码和 workspace 合在 `/workspace`（venv 移到 `/opt/venv` 规避遮挡）。
默认跑（workspace = 仓库）一切正常，但一旦 `SCODE_WORKSPACE` 指向别处，
挂载就把 `/workspace` 整个盖住 —— 镜像里的源码没了：

```
ModuleNotFoundError: No module named 'stupid_code'
```

根因是 editable 安装的 `.pth` 硬编码了项目根：

```
/opt/venv/lib/python3.12/site-packages/_editable_impl_stupid_code.pth
→ /workspace
```

**这类"默认能跑、换个参数就崩"的 bug 最难查** —— 默认路径测不出来，
必须显式测一次 `SCODE_WORKSPACE` 指向外部目录。

**关键取舍三：必须用 editable 安装**

`uv sync` 默认把根项目装成 editable，`stupid_code` 解析到 `/app/stupid_code`
而不是 site-packages。装成非 editable 的话那几处 `__file__` 定位全落到
site-packages 里，直接找不到文件 —— `config.toml` 读不到，graph 加载失败。

**坑一：nginx 的 `set` 必须写在 `rewrite` 前面**

反代要剥掉 `/api` 前缀（和 vite dev 代理的 rewrite 一致），而用变量形式的
`proxy_pass` 才能在后端容器重建换 IP 后重新解析域名：

```nginx
set $api_upstream http://backend:2024;
rewrite ^/api/(.*)$ /$1 break;
proxy_pass $api_upstream;
```

`set` 写在 `rewrite` 后面会 500。原因是 nginx 的 rewrite 模块**按配置顺序**
执行指令，而 `rewrite ... break` 会终止本模块后续指令的执行 ——
`set` 根本没轮到执行，`$api_upstream` 是未初始化状态：

```
[warn] using uninitialized "api_upstream" variable
[error] invalid URL prefix in ""
```

实测：`/api/ok` 返回 500，`/api/admin/models` 同样 500，但直接打后端
`http://127.0.0.1:2024/ok` 是 200 —— 很容易误判成"后端没起来"。

**坑二：SSE 必须关掉 nginx 的缓冲**

`POST /threads/{id}/runs/stream` 是长连接流式响应。nginx 默认会缓冲，
攒够一块才吐给前端，界面上"逐字输出"就没了（看起来像一次性刷出来）。
所以 `/api/` 那个 location 里要：

```nginx
proxy_buffering off;
proxy_cache off;
gzip off;
proxy_read_timeout 3600s;   # 默认 60s，agent 跑几分钟是常事
```

**坑三：`SCODE_BIND_HOST` —— 容器里必须绑 0.0.0.0**

`launcher.py` 原来把监听地址写死 `127.0.0.1`。容器里这么绑的话，
服务在容器外完全不可达（前端容器连不上，宿主 `ports` 映射也打不通）。

改成读环境变量 `SCODE_BIND_HOST`，默认仍是 `127.0.0.1`（**原生跑法行为不变**），
容器里设成 `0.0.0.0`。

但这不违反 AGENTS.md 的"绝不要绑 0.0.0.0"：那条约束针对的是**宿主暴露面**。
容器有独立的网络命名空间，容器内绑全网卡 ≠ 宿主上能访问 ——
宿主侧的端口映射仍然只绑 `127.0.0.1`：

```yaml
ports:
  - "127.0.0.1:2024:2024"
```

顺带把就绪探测和监听地址拆开了：探测永远打 `127.0.0.1`（`PROBE_HOST`），
绑 `0.0.0.0` 时也连得上，而拿 `0.0.0.0` 当连接目标在不同平台上行为不一致。

**坑四：api_key 不能进镜像层**

`conf/config.toml` 里有明文 api_key，`.dockerignore` 里必须排除它 ——
打进镜像等于把密钥固化进镜像层，`docker history` 就能翻出来。
运行时靠 volume 把宿主的 `conf/` 挂进去。

同理前端镜像的构建参数也**不能依赖宿主的 `.env.local`**（不在版本库里，
而且 mock 开着的话容器里跑的是假数据，看着像"后端没连上"）。
`web/Dockerfile` 里显式注入 `VITE_USE_MOCK=false` 等变量。

**这条的直接后果：启动前必须先有 `conf/config.toml`，否则容器起不来**

密钥不进镜像是有代价的——**新克隆的仓库没有这个文件**（已 gitignore），
直接 `docker compose up` 会失败：

```
ConfigError: 找不到 /app/conf/config.toml。请复制 conf/config.example.toml 为 conf/config.toml 并填入供应商信息。
GraphLoadError: Failed to load graph 'code_agent' from /app/stupid_code/graph/agent.py: ...
Application startup failed. Exiting.
```

现象值得记一下，因为**它不直观**：

- 后端容器进入 `Restarting` 循环（`restart: unless-stopped` 配的）；
- 前端因为 `depends_on: {condition: service_healthy}` 一直**等**着不起来；
- 界面上什么都看不到，连后端直连 `http://127.0.0.1:2024/ok` 也不通。

第一反应容易是「Docker 配错了」，其实只是配置文件没准备。
**排查先看 `docker compose logs backend`**。

想在容器外先验证配置对不对（不起服务，最快暴露配置错误）：

```bash
uv run python -c "from stupid_code.config.model import load_config; load_config(); print('config OK')"
```

**验证步骤（带 curl）**

```bash
# 0. 前提：仓库根下已有 conf/config.toml
docker compose up --build -d

# 1. 两个容器都 healthy（前端要等后端 /ok 通过才起）
docker compose ps

# 2. 后端就绪
curl -s http://127.0.0.1:2024/ok
# → {"ok":true,"services":{}}

# 3. 前端静态页
curl -s -o /dev/null -w "%{http_code}\n" http://127.0.0.1:5173/
# → 200

# 4. 反代生效（剥掉 /api 后打到后端）
curl -s http://127.0.0.1:5173/api/ok
# → {"ok":true,"services":{}}

# 5. 图注册成功
AID=$(curl -s -X POST http://127.0.0.1:5173/api/assistants/search \
  -H 'Content-Type: application/json' -d '{}' \
  | python3 -c "import json,sys; print([a for a in json.load(sys.stdin) if a['graph_id']=='code_agent'][0]['assistant_id'])")
curl -s http://127.0.0.1:5173/api/assistants/$AID/graph \
  | python3 -c "import json,sys; print([n['id'] for n in json.load(sys.stdin)['nodes']])"

# 6. SSE 真跑一轮（会消耗 token）
TID=$(curl -s -X POST http://127.0.0.1:5173/api/threads \
  -H 'Content-Type: application/json' -d '{}' \
  | python3 -c "import json,sys; print(json.load(sys.stdin)['thread_id'])")
curl -sN -X POST "http://127.0.0.1:5173/api/threads/$TID/runs/stream" \
  -H 'Content-Type: application/json' -H 'Accept: text/event-stream' \
  -d '{"assistant_id":"code_agent","input":{"messages":[{"role":"user","content":"只回复两个字：你好"}]},"stream_mode":["updates"],"on_disconnect":"continue","config":{"configurable":{"permissions":"auto","model":"minimax:MiniMax-M3"}}}'

# 7. 持久化：重启后历史还在
docker compose restart backend
curl -s -X POST http://127.0.0.1:5173/api/threads/search \
  -H 'Content-Type: application/json' -d '{"limit":10}'

# 8. 换个工作空间（务必测这条：默认路径测不出 workspace 相关的崩）
mkdir -p /tmp/other-ws && SCODE_WORKSPACE=/tmp/other-ws docker compose up -d --force-recreate backend
docker compose ps backend   # 期望 healthy，而不是 CrashLoopBackOff
```

**已验证的事实**（2026-10-25 实测，Docker 29.9.2 / Compose v5.6.1）

- 两个容器都起来且 `healthy`；`/ok` 200、`/` 200、`/api/ok` 200
- `code_agent` 图注册成功，8 个节点：`__start__` / `model` / `tools` /
  `MemoryMiddleware.before_agent` / `HumanInTheLoopMiddleware.after_model` 等
- SSE 端到端跑通，模型真实返回内容（`你好`）
- agent 的 `write_file` 在**宿主**仓库里落地（容器写 → volume → 宿主可见），
  `execute` 也能跑
- `docker compose stop` 退出码 0，宿主无残留 `langgraph_cli` 进程
- 重启容器后 thread 索引与 checkpoint 都在，历史消息（含工具调用）完整读回
- 容器内路径解析全部正确：`stupid_code` → `/app/stupid_code`、
  conf → `/app/conf`、db → `/app/stupid_code/data/langgraph.db`
- **`SCODE_WORKSPACE` 指向外部目录**（`/tmp/sc-ws-test`）时同样正常：
  容器 healthy、图加载成功、agent 的 `write_file` 落在**那个外部目录**里，
  与宿主仓库互不干扰

**本期不做**

- 不做多副本 / 集群（inmem 运行时本就是单进程开发态）
- 不做生产级镜像优化（没压 `uv` / `pnpm` 缓存层体积，没做 distroless）
- 不做前端 dev 模式的容器化（`pnpm dev` + 热重载仍建议在宿主跑，
  后端用 `docker compose up backend` 即可）
- 不改 `GET /directories` 未实现这一既有缺口（工作空间选择器在容器里同样报错）

### 013 · MCP 支持（`conf/mcp.json`）

**目标**：agent 能用上 MCP 服务器提供的工具。用户在项目根的 `conf/mcp.json`
里自己加服务器，**http 和 stdio 两种传输都支持**。

**成果**：

| 文件 | 作用 |
|---|---|
| `conf/mcp.example.json` | MCP 配置模板（`conf/mcp.json` 不入库，按需复制；格式跟 Claude Code / Cursor 一致） |
| `stupid_code/config/mcp.py` | 配置的加载与校验（pydantic 声明字段）、`${VAR}` 展开、连接参数构建 |
| `stupid_code/graph/mcp.py` | 工具加载：连服务器、取工具、改名、重名检测、`tool_interceptors` 兜错 + 调用期重试 |
| `stupid_code/graph/agent.py` | `tools=load_mcp_tools()` |
| `examples/mcp_stdio_server.py` | 一个能直接跑的 stdio MCP 服务器（零新依赖），用来验 stdio 传输 |
| `pyproject.toml` | 新增依赖 `langchain-mcp-adapters>=0.3.2`（连带官方 SDK `mcp`） |

**依赖说明**：MCP 协议**一行都没手写**。`langchain-mcp-adapters` 负责连服务器、
取工具清单、把 MCP 工具转成 LangChain 工具；底层是官方 Python SDK `mcp`
（stdio 管道、streamable-http 握手、会话初始化都在它那里）。

`fastmcp`（另一个 PyPI 包）**不用装**——FastMCP 是官方 `mcp` 包自带的
（`from mcp.server.fastmcp import FastMCP`），`examples/mcp_stdio_server.py`
就是这么写的。

**配置格式**

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

| 字段 | 适用传输 | 说明 |
|---|---|---|
| `type`（或 `transport`） | 全部 | `http` / `stdio` / `sse` / `websocket`；写 `streamable_http` 也认。**不写能推断**：有 `command` 当 stdio，有 `url` 当 http |
| `url` | http / sse / websocket | 必填，必须以 `http://` / `https://` 开头（websocket 要 `ws://` / `wss://`） |
| `command` + `args` | stdio | `command` 必填；`args` 可省（默认空数组） |
| `env` / `cwd` | stdio | 子进程的环境变量 / 工作目录 |
| `headers` | http / sse | 请求头，值里可写 `${VAR}` |
| `timeout` / `sse_read_timeout` / `terminate_on_close` | http / sse | 超时与收尾选项。不写 `timeout` 时默认 8 秒（不是 adapter 的 30 秒，见下） |
| `description` | 全部 | 给界面看的元信息（Claude Desktop / VS Code 那种配置里常见）。**认了但忽略**——agent 看不到它 |

**密钥不写死在文件里**：`env` 和 `headers` 的值里可以写 `${VAR}`，
加载时从**进程环境**展开；变量不存在时**原样保留** `${VAR}`
（宁可留个能看懂的占位符，也不要悄悄变成空字符串）。

**逐个服务器校验**：某一个写错了只跳它自己，其余照常（跳过的那个在日志里
报一句为什么）。早先是一把梭——**一个服务器配错，整个 MCP 都没了**，
连能用的那几个也一起废掉，界面上还看不出来。

**关键取舍一：静态注册，不是运行期注入**

工具在建图时取一次，交给 `create_deep_agent(tools=[...])`。这样它们就是
**普通工具**——注册在框架的 ToolNode 里，模型调用时框架自己执行，
不需要额外的中间件。

框架其实也支持运行期注入（中间件在 `wrap_model_call` 里往 `request.tools`
追加工具，再在 `wrap_tool_call` 里用 `request.override(tool=...)` 执行它们，
见 `langchain/agents/factory.py` 的 `DYNAMIC_TOOL_ERROR_TEMPLATE` →
"Option 2: Handle dynamic tools in middleware"）。**本项目试过，然后放弃了**：

| | 运行期注入 | 静态注册（现方案） |
|---|---|---|
| 代码量 | 多一个中间件（442 行）+ 两套钩子 | 一个 `load_mcp_tools()` |
| 改 `conf/mcp.json` | 不用重启 | **要重启**（跟 `conf/subagents.toml` 一样） |
| 服务器启动时挂着 | 别的服务器照常，它 60 秒后自动恢复 | 别的服务器照常，它要等重启 |
| 理解成本 | 要理解「注入 + 覆盖」两套机制 | 就是普通工具 |

这个项目是**学习项目**，标准是「能跑、能看懂、能改」（见 AGENTS.md）。
多一套钩子换「改配置不用重启」，不划算——`conf/subagents.toml` 本来也是
改完要重启的。所以选了简单的那条。

**关键取舍二：工具名用 `mcp__{服务器}__{工具}`**

这是 Claude Code 那套约定。**理由是项目自带的参考资料就是这么写的**——
`.agents/skills/ecosystem-primer/SKILL.md` 里有一句：

> If the LangChain Docs MCP server is connected
> (`mcp__docs-langchain__*` tools are available), query it directly

agent 读的就是这份说明。名字对不上，agent 会以为 MCP 没接上——**实测过**：
它转而自己拿 `execute` 去 curl MCP 端点（能 work，但绕了一大圈，
还多烧了一堆 token）。改成这个约定之后，agent 直接就调了。

顺带解决了两件事：跟内置工具（`read_file` / `execute` / `task`…）不重名；
双下划线分隔也不会跟工具名里本来就有的单下划线混淆。名字长度上限 64
（Anthropic 的限制），超了截断。

**关键取舍三：容错分三层**

1. **加载时**：逐个服务器取工具（不用 `client.get_tools()`——它内部是 gather，
   一个失败整批都炸），**并行**加载（互不依赖，串行的话 N 个服务器要花 N 倍时间），
   失败重试 2 次（**只在非超时失败上重试**：超时重试没有意义），彻底连不上就
   跳过它，其余服务器照常。
2. **调用时**：用 adapter 公开的 `tool_interceptors` 扩展点接住传输层失败
   （服务器挂了 / 网络抖）：瞬时失败重试一次，最终失败构造一个
   `CallToolResult(isError=True)`——adapter 会把它变成 `status="error"` 的
   ToolMessage，**模型看得见「这个工具没调通」**，可以换个工具重试，整轮对话不崩。
   （框架的 ToolNode 默认 `_default_handle_tool_errors` 只放过
   `ToolInvocationError`，其余一律重抛，一次网络抖动整个 run 就变 internal error。）
3. **限时**：建图时加载是**同步阻塞**的（`graph/agent.py` 导入时就在连服务器），
   所以每服务器**总共** 12 秒（`_LOAD_TIMEOUT`，重试和退避都算在里面）——
   用 `asyncio.wait_for` **真的掐断**。因为服务器是并行加载的，
   总耗时 ≈ 单个服务器的预算，不是各预算之和；死服务器拖不过 launcher 的
   60 秒就绪超时。

**关键取舍四：只补 SDK 不做的两件事**

`langchain-mcp-adapters` 已经做掉了绝大部分工作，剩下两件得自己来：

| 要补的 | 为什么 SDK 没做 |
|---|---|
| 改名 `mcp__{服务器}__{工具}` | adapter 的 `tool_name_prefix` 拼的是 `{服务器}_{工具}`（单下划线），跟项目 skill 里的 `mcp__docs-langchain__*` 对不上 |
| 兜传输层失败 + 调用期重试 | adapter 文档写明：传输层失败「always raise regardless of this setting」，只有 MCP 自己的执行错误（`isError=True`）才变 ToolMessage；`tool_interceptors` 是它留的公开扩展点 |

补法是**只原地改 `name`**：adapter 的工具对象上已经配好了 `args_schema`、
`response_format`、`handle_tool_error`（MCP 自己报的错要保留图片等内容块），
重建一个 `StructuredTool` 等于把这些都丢掉。改 `name` 是安全的：
`BaseTool.__setattr__` 在 `name` 被重新赋值时会清掉缓存的 `tool_call_schema`，
下次用会按新名字重建。改名前还会做重名检测——字符替换和截断可能把两个名字
撞成一个，撞了跳过后来者并 warning。

**MCP 工具只有异步实现**：adapter 造的 `StructuredTool` 只填了 `coroutine`
（`func` 是 None），所以 `tool.invoke()` 这类同步路径会抛 `NotImplementedError`
（本地脚本 `graph.invoke()` 会撞上）。本项目没有同步调用场景，不补 `func`；
Agent Server 全程异步，没问题。

**配置校验交给 pydantic**（项目本来就有这个依赖）。每种传输一个模型，
字段集照着 adapter 的连接参数字典写（`langchain_mcp_adapters/sessions.py`
里的 `StdioConnection` / `StreamableHttpConnection` / …），`extra="forbid"`
让写错的字段当场报出来。错误消息翻成中文：

```
mcp.json 的服务器 'x' 配置不合法：typo：不认识的字段
mcp.json 的服务器 'x' 配置不合法：url 必须以 http:// 或 https:// 开头，当前是 'ftp://x.com'
```

**踩过的坑**

- **一个服务器配错，曾经把整个 MCP 都带走**。配置校验是一把梭抛的
  `ConfigError`，上层直接返回空工具列表——结果连能用的那几个 http 服务器
  也一起没了，界面上完全看不出来（界面上本来就不显示 MCP 工具）。
  触发它的是一个很平常的字段：真实配置里带 `description`（Claude Desktop /
  VS Code 那种格式常见），而我们只认 adapter 那套字段。
  **现在改成逐个服务器校验**：写错的只跳它自己，其余照常，日志里报一句为什么。
  `description` 也认了（给界面看的元信息，agent 用不上）。
- **建图时不能直接 `asyncio.run`**。`langgraph dev` 是在**它自己的事件循环里**
  导入图模块的（后端日志里能看到 `thread_name=uvloop_1`），
  `asyncio.run` 会抛 "cannot be called from a running event loop"。
  现在 MCP 的异步工作全部提交到专用 MCP 线程：建图时
  `_MCPThread.run()` 从主线程 `future.result(timeout)` 等结果；工具调用走
  `run_coroutine_threadsafe`。**别在 MCP 线程自己里调 `run()`**，会堵死它自己的循环。
- **MCP 工具只有异步实现**。adapter 造的 `StructuredTool` 只填了 `coroutine`
  （`func` 是 None），同步执行路径（`tool.invoke()`）会抛 `NotImplementedError`
  ——本地脚本用 `graph.invoke()` 就会撞上。本项目没有同步调用场景，不补 `func`。
- **早先那版的「限时」是假的**。当时只在「两次重试之间」看一眼时间戳，
  一个挂死的服务器（连上了但不回话）照样能把启动拖过 launcher 的 60 秒
  就绪超时。现在改成 `asyncio.wait_for` 真的掐断，**12 秒是含重试的总预算**，
  并且**各服务器并行加载**，总耗时 ≈ 单个服务器的预算。
  后来还发现「只在两次重试之间看时间」那版的另一种浪费：**超时也被重试**，
  1 秒预算实测跑出 3.31 秒——现在超时直接放弃。
- **anyio 的 TaskGroup 会把真实异常包进 `ExceptionGroup`**。直接打印只看得到
  「unhandled errors in a TaskGroup (1 sub-exception)」——看不出是网络问题、
  超时还是 401。`_describe()` 负责一层层剥到最里层，日志里才看得到
  `ConnectError: All connection attempts failed`。
- **pydantic 的宽松模式会悄悄改类型**：`timeout: true` 会被当成 1.0
  （= 1 秒超时！），`timeout: "8"` 会被当成 8.0。两种都不是用户想写的意思，
  所以在转换之前（`mode="before"`）就拦下来。
- **别用 `asyncio.Lock` 给加载加锁**。`asyncio.Lock` 会把实例绑死在第一个用到它的
  事件循环上，langgraph dev 的运行循环不一定只有一个，绑死了在别的事件循环里
  直接抛 `RuntimeError`。
- **公网 MCP 端点会抖**。`docs.langchain.com/mcp` 实测 10 次连接失败 1 次，
  报 `httpx.ConnectError(EndOfStream())`——**用纯 httpx 打同一个地址也一样**，
  所以跟 SDK 无关，是 CDN 在 TLS 握手阶段直接掐连接。加载重试就是为它准备的
  （重试 2 次，退避 0.5 秒 / 1 秒）。

**验证步骤**

```bash
# 1. 先看配置对不对（不起服务，最快暴露语法/字段错误）
cd /path/to/stupid-code
uv run python -c "
from stupid_code.config.mcp import load_connections
import json
print(json.dumps(load_connections(), indent=2, ensure_ascii=False))
"
```

期望输出形如：

```json
{
  "docs-langchain": {"transport": "http", "url": "https://docs.langchain.com/mcp",
                      "timeout": 8.0}
}
```

配置写错时这一步直接抛 `ConfigError`（字段名、拼错的 `type` 都会被指出来）。

```bash
# 2. 起后端后看工具挂上没有（后端日志）
#    预期：MCP 工具已加载：5 个（来自 2 个服务器）
#    某个服务器连不上时：MCP 服务器 'xxx' 连不上，跳过它的工具：...

# 3. 跑一轮对话，确认 agent 真的调了 MCP 工具
TID=$(curl -s -X POST http://127.0.0.1:2024/threads \
  -H 'Content-Type: application/json' -d '{}' \
  | python3 -c "import sys,json;print(json.load(sys.stdin)['thread_id'])")

curl -s -N -X POST "http://127.0.0.1:2024/threads/$TID/runs/stream" \
  -H 'Content-Type: application/json' -H 'Accept: text/event-stream' \
  -d '{"assistant_id":"code_agent",
       "input":{"messages":[{"role":"user","content":"用 MCP 的文档搜索工具查一下 create_deep_agent 是什么，一句话总结。"}]},
       "stream_mode":["updates"],"on_disconnect":"continue",
       "config":{"configurable":{"workspace":"/abs/path","permissions":"auto"}}}'
```

在 SSE 的 `updates` 事件里应能看到 `mcp__docs-langchain__search_docs_by_lang_chain`
这类工具调用，以及它的返回内容。

**stdio 传输怎么验**（http 通了不代表 stdio 通了，两条路径不一样）：

```bash
# 1. 在 conf/mcp.json 里加一个 stdio 服务器（examples/ 里那个是现成的）
cat > /tmp/demo-mcp.json <<'JSON'
{
  "mcpServers": {
    "demo": {
      "type": "stdio",
      "command": "<项目>/.venv/bin/python",
      "args": ["<项目>/examples/mcp_stdio_server.py"]
    }
  }
}
JSON
# 把它并进 conf/mcp.json，然后**重启后端**（MCP 工具是建图时静态注册的）

# 2. 后端日志里应该看到三个服务器都加载上了
#    MCP 工具已加载：5 个（来自 3 个服务器）

# 3. 跑一轮对话，让它调 stdio 那个工具
#    预期在 SSE 里看到 "name":"mcp__demo__echo"，返回内容是 "echo: <你传的字>"
```

**本期不做**

- 不做 MCP 的界面化管理（只能手改 `conf/mcp.json`）
- 不做 MCP 资源（resources）、提示（prompts）、采样（sampling）的接入
- ~~不给 MCP 工具加人工确认~~（review 后补上了，见下方「补充」）
- ~~不做有状态会话~~（review 后补上了，见下方「补充」）
- **不做「改配置不用重启」**（试过运行期注入，为了少一套钩子放弃了，见「关键取舍一」）
- 不做 MCP 工具的按需加载 / 懒加载（建图时一次性取完）

**补充（2026-10-26，review 后）**

review 时对着 adapter 0.3.2 的源码重新核了一遍，改了三处：

**① 每个服务器一条长会话（原来的每次调用新建会话是错的）**

`MultiServerMCPClient.get_tools()` 造出来的工具，**每次调用都会新建会话**（adapter
文档原话："A new session will be created for each tool call"）：stdio 每次
fork 一个子进程，http 每次重新握手。对文档搜索这种无状态服务器只是慢一点；
对有状态服务器（`server-memory` 的知识图谱、浏览器、REPL）等于每次调用重置。

现在 `graph/mcp.py`：

- 建图时只开一个**临时会话**列工具清单（拿 schema / 描述），列完就关
- 工具对象绑到 `_SessionProxy`（鸭子类型的 `ClientSession`，adapter 只调用它的
  `call_tool()`），schema / 结果转换 / 错误处理全都还是 adapter 的
- 第一次真正调用时才建持久会话，之后一直复用
- 每个服务器一个 `_ServerWorker` 任务 + 队列，**同一服务器的调用串行**；
  transport 层失败会话退出，下一次调用（或 retry）自动重连
- 会话跑在**专用 MCP 线程**（daemon，`_MCPThread`）的循环里：MCP SDK 的 stdio
  会话内部是 anyio TaskGroup，cancel scope 必须由建立它的任务退出。最早把会话
  放在主循环上，`asyncio.run()` 收尾会并发取消内部任务，进程**直接卡死**（实测）；
  独立线程之后主循环怎么关都碰不到它
- 应用关停由 `admin/app.py` 的 lifespan 调 `close_mcp_sessions()`：取消 worker
  任务、等 `async with` 退出、停线程。实测停服务后 `server-memory` 子进程
  和 langgraph 进程都没有残留
- **建图时的工具清单加载也走这条线程**：`load_mcp_tools()` 把 `_load_servers()`
  提交到 MCP 线程，主线程用 `future.result(_LOAD_TIMEOUT + 5)` 等结果；
  原来为「在已运行的事件循环里跑 `asyncio.run`」写的 `_run_sync` 临时线程/loop
  已经删掉，MCP 的异步工作现在只有一条线程、一个入口

**② MCP 工具也走 HITL（manual 档）**

`build_interrupt_on(mcp_tools=...)` 把**非只读**的 MCP 工具登记进 `interrupt_on`：

- `manual` 档下每次 MCP 调用都挂起等确认；`normal` / `auto` 不拦
  （`normal` 是「已知危险模式」过滤器，MCP 行为由服务器定义，没有可复现的模式）
- `readOnlyHint is True` 的工具跳过（docs 的两个搜索、memory 的 `read_graph` /
  `search_nodes` / `open_nodes` 都带这个标注）；**这是服务器自报的，不是安全边界**，
  没声明就按有副作用处理
- 确认卡片显示服务器名 + 完整参数（`_describe_mcp`），只给 approve / reject，
  **不给 edit**——参数结构由服务器 schema 管，改错一个字段可能比拒绝更糟
- `graph/mcp.py` 加载时把 `mcp_server` 写进工具 `metadata`，权限层靠它生成卡片
- 只读子 agent 本来就不继承 MCP 工具，不受影响；其他子 agent 继承同一份
  `interrupt_on`（`apply_subagent_policies` 已经做了合并，见 `graph/subagent_policy.py`）

**③ 配置字段与重试分类**

- `config/mcp.py` 补了 stdio 的 `encoding` / `encoding_error_handler`（adapter
  支持、JSON 能表达）。`auth` / `httpx_client_factory` / `session_kwargs` 是
  Python 对象，JSON 表达不了，**故意不认**——需要 OAuth 得改代码
- `_retryable()` 现在不重试超时，也**不重试 4xx**（鉴权失败 / 路径写错重试没意义），
  只重试 5xx / 429 / 连接类错误
- `_load_one` 预算在第一次尝试前就耗尽时抛明确的 `TimeoutError`，不再依赖 `assert`

**验证步骤**

```bash
# 1. 有状态工具：连续调两次 mcp__demo__count，返回值必须递增
#    把 examples/mcp_stdio_server.py 配进 conf/mcp.json（见上面 stdio 那节），
#    重启后端，然后让 agent 连续调两次 count（或直接写脚本调 tool.ainvoke）
#    预期：1 → 2
#    （旧实现每次调用新建子进程，两次都会是 1）

# 2. 真实服务：14 个工具 / 3 个服务器（docs、reference、memory）
#    让 agent 调 mcp__memory__create_entities 建一个实体，再调 read_graph
#    预期：read_graph 能看到刚建的实体；ps 里 server-memory 的 PID 前后不变

# 3. manual 档：让 agent 调非只读的 MCP 工具
#    预期：SSE 的 __interrupt__ 里 action_requests[0].name 是
#    mcp__memory__create_entities，description 带服务器名和参数，
#    allowed_decisions 只有 approve / reject；command.resume 批准后工具执行

# 4. 停服务后检查残留
ps -axo pid,command | grep -E "server-memory|langgraph dev"
#    预期：没有输出
```

**已验证的事实**（2026-10-26 真实服务 + 本地 stdio 测试）

- 有状态 stdio 服务器：bump 1 → 2，read 2；会话跨调用保留 ✔
- 真实服务加载 14 个工具 / 3 个服务器（含 `npx` 的 memory）✔
- `mcp__memory__create_entities` 写入后，`mcp__memory__read_graph` 能看到；
  前后 `server-memory` 的 PID 不变（一条长会话）✔
- `manual` 档下 `mcp__memory__create_entities` 触发 HITL，卡片描述带服务器名和
  参数；approve 后 tool 消息正常返回 ✔
- `security`：`readOnlyHint=True` 的 docs 搜索 / memory 读取工具不进 `interrupt_on`；
  reference 的两个工具没有标注，按有副作用登记 ✔
- 停服务后没有 `server-memory` / `langgraph dev` 残留 ✔
- 专用 MCP 线程下，`asyncio.run(script)` 不再卡在 `_cancel_all_tasks` ✔

---

### 014 · 工作空间按任务生效 + 系统目录选择框

**目标**

让「选了哪个工作空间，agent 就在哪个目录里干活」这件事真正成立。

改之前前端已经把工作空间发过来了（`configurable.workspace`），但后端**只透传、
不读**——backend 的根目录在建图时就定死了（`SCODE_WORKSPACE` 或启动时的 cwd），
所以同一个会话里选哪工作空间都一样，agent 永远在启动时的那个目录里改代码。

本期做两件事：

1. **后端按运行解析工作空间**：文件工具（`read_file` / `write_file` / `edit_file` /
   `delete` / `ls` / `glob` / `grep`）和 `execute`（shell 的工作目录）都落在
   `configurable.workspace` 指的目录里。
2. **前端用系统原生目录选择框选目录**：点工作空间按钮 → 弹系统文件浏览窗口 →
   选一个文件夹。跟「cd 到项目目录里再跑 claude」是同一个心智模型。

**成功标准**

- 选了工作空间 A，跑一轮让 agent 建文件 → 文件落在 A 里，不在默认目录
- `execute` 跑 `pwd` → 输出是 A
- 没选工作空间 → 用后端默认工作空间（原生跑法不受影响）
- 选了个不存在的目录 → 这一轮**直接失败**并说清原因，不静默换个目录
- 如果 agent 写了长期记忆，`.scode-memory.md` 落在选中的工作空间里；没写就不会创建
- 点按钮能弹出系统的目录选择框

**本期不做**

- 不做「多工作空间同时开」（一个会话一个工作空间，切换只影响下一条消息）
- 不做目录列表接口（`GET /directories` 那种「后端返回目录列表」的设计被否掉了，
  理由见「关键取舍一」）
- 不做工作空间历史的服务端存储（历史来自对话历史的 metadata，前端自己读）
- 不做工作空间沙箱（agent 本来就有 shell，能碰整个文件系统，见 §5）

**关键取舍**

**一、选目录靠系统弹窗，不靠后端列目录**

浏览器的目录选择 API（File System Access API 的 `showDirectoryPicker()`、
`<input webkitdirectory>`）**故意不暴露绝对路径**——只给目录名 / 相对路径，
这是浏览器的安全设计，绕不过去。而工作空间要的恰恰是绝对路径。

于是有两条路：

- 后端列目录（`GET /directories?path=...`）：前端点着走，后端返回绝对路径。
  **代价是后端把文件系统目录树开放成一个 HTTP 接口**，得配白名单、403 语义、
  一堆安全说明。
- **后端弹系统原生窗口**（本期选的）：`POST /workspaces/pick` → 后端起
  `osascript -e 'choose folder'` / `zenity --file-selection --directory` /
  PowerShell 的 `FolderBrowserDialog` → 用户在系统窗口里选 → 拿到绝对路径。

后端跑在用户自己机器上，弹窗就弹在用户眼前，绝对路径也是真的。后端不需要
「知道有哪些目录」，用户也不需要手打路径。

同一时刻只允许一个弹窗：弹窗占着默认 executor 线程最多 600 秒，和文件工具 /
记忆读写共用一个池，并发请求会弹多个窗口并耗尽线程池。重复请求返回 409。

**二、根目录做成运行期属性，不是建图时常量**

框架把 backend 的根目录存在 `self.cwd` 里，所有路径解析都从它出发
（`FilesystemBackend._resolve_path`、glob/grep 的搜索根、
`LocalShellBackend.execute` 的 cwd）。所以只要改这一个属性，全对。

做法是把它做成 property（`graph/backend.py` 的 `_WorkspaceRoot`）：取值时读当前
运行的 `configurable.workspace`。为什么不是「运行期换 backend 实例」：

- backend 实例在建图时就注册进框架的工具里了，运行期换不了
- 同一时刻可能有多个对话在跑（不同 thread、不同工作空间）。property 背后是
  contextvar，天然按运行隔离；改共享实例的属性则会串目录

**三、工作空间不合法就失败，不静默退回默认目录**

前端选了 `/a/b`，这个目录后来被删了——这时候 agent 的写操作落哪儿？

- 退回默认工作空间：等于把代码写到用户**没选过**的目录里，比报错危险得多
- 报 WorkspaceError：这一轮直接失败，错误信息「工作空间不存在：/a/b」

本期选后者。中间件在**每轮开跑前**（`WorkspaceMiddleware.before_agent`）都重新
校验一次（`_resolved_cache` 只是给热路径读的，不能拿它当"校验过就不用再校验"），
不用等 agent 写文件时才炸。运行中途目录被删不会每次工具调用都重新 stat。

**四、没选工作空间 = 用后端默认工作空间**

不是「拒绝一切文件操作」。原生跑法（`cd /path/to/project && uv run scode`）
里用户根本没有前端可选，后端自己的工作空间就是那个项目目录，拒绝等于什么都
干不了。前端按钮上的提示也是这么写的（「未选择工作空间，Agent 将使用后端
默认目录」）。

**五、文件工具同时认「虚拟路径」和「绝对路径」**

框架的 `virtual_mode` 语义：`/foo` → `<工作空间>/foo`，**绝对路径也按虚拟路径
处理**。但系统提示词里写了工作空间的绝对路径之后，模型有时会直接拿那个绝对
路径去调 `write_file`——框架会把它当虚拟路径，于是文件落到
`<工作空间>/Users/me/proj/src/x.py` 这种地方，**还不报错**（实测踩到：模型
调 `write_file("/private/var/.../hello.txt")`，文件跑到了工作空间里的
`private/var/.../` 嵌套目录）。

所以 `_WorkspaceRoot._resolve_path()` 先把「以工作空间绝对路径开头」的写法剥掉
前缀，两种写法指向同一个文件。剥不掉的（工作空间之外的绝对路径）交回框架按
虚拟路径处理——它出不去工作空间，只是落到工作空间内的同名子目录里。

**六、文件系统操作必须走线程（blockbuster）**

`langgraph dev` 装了 **blockbuster**：事件循环里直接调同步 FS（`os.readlink` /
`os.stat`）会抛 `BlockingError`，整个 run 挂掉。踩过一次，报错点还比较隐蔽：

```
Blocking call to os.readlink
During task with name 'WorkspaceMiddleware.before_agent'
```

所以：

- 解析路径（`resolve()` 展开软链、`exists()` / `is_dir()` 校验）→ 中间件的
  `abefore_agent` 里 `await asyncio.to_thread(...)`
- **热路径**（backend 取根目录）不能读文件系统 → 解析结果缓存在
  `graph/workspace.py` 的 `_resolved_cache` 里；**每轮开跑前重新校验一次并
  刷新缓存**，运行中的模型调用 / 工具调用只读缓存。HITL 恢复不经过
  `before_agent`，`awrap_model_call` 在缓存未命中时会补一次线程解析

框架自己的 backend 也没这个问题：`BackendProtocol` 的异步方法全是
`asyncio.to_thread(self.<同步方法>, ...)`，FS 调用都发生在工作线程里。

**七、任务参数跟 thread 走（前端）**

`taskStore` 只在内存里，刷新页面就丢。前端发消息时把 `workspace` / `permissions`
一并写进 thread 的 `metadata`（`PATCH /threads/{id}` 是合并语义），
`loadThreads` / `selectThread` 时回填；审批卡片挂着时两个选择器禁用——恢复请求
会原样带回这两个值，否则会出现「批准的是 A 目录的命令，却在 B 目录执行」。

**八、`/tmp` 路由不能吃掉工作空间自己的绝对路径**

`CompositeBackend` 的 `/tmp/` → `StateBackend` 路由先于 default backend
「剥掉工作空间前缀」生效。工作空间本身在 `/tmp/...` 时（Linux 的 `mktemp -d`
默认就在那儿），模型传宿主绝对路径 `/tmp/ws/x` 会被写进虚拟 FS——不落盘、还报
成功。`graph/backend.py` 的 `WorkspaceCompositeBackend` 在路由前判断 key 是否
以当前工作空间开头，是就交给 default backend；虚拟 `/tmp/...`（不在工作空间下）
仍然走 `StateBackend`，临时产物的语义不变。

> 📌 **020 期结论**：整条 `/tmp/` 路由连同 `WorkspaceCompositeBackend` 守卫类一起删了。
> 守卫类存在的唯一理由就是防这条路由——路由没了，守卫类自然也没了。现状见
> 下方「020 · 删掉 `/tmp/` 路由」。

**九、记忆文件不自动创建**

之前启动/开跑时都会补一份 `/.scode-memory.md`，用户选中一个项目就会凭空多出
一个文件（还会进 git status）。现在改成**可选文件**：不存在就当没记忆，
记忆块（`memory.py` 的 `_MEMORY_TEMPLATE`）里说明文件是可选的、告诉模型
不存在时先用 `write_file` 创建、之后再 `edit_file`。第一次写记忆是 agent 的主动
行为，不是框架的副作用。

**验证步骤（带 curl）**

```bash
# 1. 起服务
cd /path/to/repo && uv run scode
#    预期：Agent Server 已就绪；图 code_agent 已注册并可加载（9 个节点）

# 2. 弹系统目录选择框（会阻塞到你在窗口里选完）
curl -s -X POST http://127.0.0.1:2024/workspaces/pick -H 'Content-Type: application/json' -d '{}'
#    选中了：{"path":"/Users/you/projects/demo"}
#    取消了：{"path":null,"cancelled":true}
#    弹不出来（无图形界面）：503 {"error":"..."}

# 3. 起一轮对话，把工作空间指到临时目录，看 agent 的写操作落在哪
WS=$(mktemp -d)
TID=$(curl -s -X POST http://127.0.0.1:2024/threads \
  -H 'Content-Type: application/json' -d '{}' \
  | python3 -c "import sys,json;print(json.load(sys.stdin)['thread_id'])")

curl -sN -X POST "http://127.0.0.1:2024/threads/$TID/runs/stream" \
  -H 'Content-Type: application/json' -H 'Accept: text/event-stream' \
  -d "{\"assistant_id\":\"code_agent\",
       \"input\":{\"messages\":[{\"role\":\"user\",\"content\":\"在工作空间里创建 hello.txt，内容写 hello world。\"}]},
       \"stream_mode\":[\"updates\"],\"on_disconnect\":\"continue\",
       \"config\":{\"configurable\":{\"workspace\":\"$WS\",\"permissions\":\"auto\"}}}"

#    预期：SSE 里有 write_file 调用；然后
ls -la "$WS"
#    预期：hello.txt 在这个目录里；.scode-memory.md **不会**凭空出现
#    （只有 agent 真的写了记忆才会创建）

# 4. 工作空间不存在 → 这一轮直接失败
#    （把上面的 workspace 换成 /definitely/not/here）
#    预期：SSE 里是 error 事件，message 是「工作空间不存在：/definitely/not/here」
#    （WorkspaceError 必须继承 ValueError，平台才透传 str(exc)，见下方补充）
```

**常见问题**

- **点按钮没反应 / 一直转**：系统在弹窗等你选，但弹窗被浏览器窗口挡住了
  （macOS 上它是独立窗口，不在浏览器里）。看看别的窗口 / 任务栏。
- **503「弹不出目录选择框」**：后端跑在无图形界面的环境里（Docker 容器、纯
  SSH 的服务器）。用下拉里的「手动输入绝对路径」。
- **GET /workspaces/pick 返回 404**：方法不对，这是 POST 端点。（顺带一个坑：
  用 GET 打过去会拿到 404 而不是 405——langgraph 的兜底 Mount 会把「路径匹配
  但方法不匹配」吃掉。）
- **改了工作空间，agent 还是写在老目录**：工作空间是**按消息**生效的，跑完
  那一轮之后改选择器不影响已经跑完的运行；下一条消息才用新的。
- **`.scode-memory.md` 跑到别的项目去了**：记忆文件跟着工作空间走，每个项目各有一份
  （这是有意的：不同项目的约定不该混在一起）。它**不会自动创建**——只有在某个项目里
  真的让 agent 保存过记忆，那个目录下才会出现。

**已验证的事实**（2026-10-25 对真实服务实测）

- `configurable.workspace` → `write_file("/hello.txt")` → 文件真的落在该目录，
  `execute` 的 `pwd` 也是该目录 ✔
- 如果让 agent 写了记忆，`.scode-memory.md` 会落在该目录；普通跑一轮**不会**凭空创建 ✔
  （014 期起改的，见「补充」）
- 没传 workspace → 落在后端默认工作空间（`Path.cwd()`）✔
- 传了个不存在的目录 → `execute` 返回
  `Error executing command (WorkspaceError): 工作空间不存在：...`，
  **没有**静默换到默认目录 ✔（框架的 `LocalShellBackend.execute` 有个宽泛的
  `except Exception`，把异常转成了命令错误输出）
- 中间件在开跑前就拦住坏工作空间（不等到 agent 写文件）✔
- 系统提示词里带上了工作空间的绝对路径 ✔
- `POST /workspaces/pick` 三条分支都对：选中了 / 取消了 / 弹不出来 ✔
- macOS 上 `osascript` 确实弹出了系统目录选择框并阻塞到被中断 ✔
- `blockbuster` 会在事件循环里拦同步 FS 调用，报 `BlockingError:
  Blocking call to os.readlink`（`Path.resolve()` 里的软链解析）——
  **所有路径解析都必须走线程** ✔

**补充（2026-10-26，review 修复后）**

- 每轮开跑前重新校验：解析成功 → 删除目录 → 下一轮 `before_agent` 抛
  `WorkspaceError`（缓存被刷新），不再沿用旧缓存路径 ✔
- 同一 thread 换工作空间：`WorkspaceMemoryMiddleware` 会重读新目录的
  `.scode-memory.md`；同一工作空间内仍只读一次 ✔
- HITL 恢复不经过 `before_agent`：`awrap_model_call` 在缓存未命中时补一次
  线程解析，避免 `Path.resolve()` 在事件循环里撞 blockbuster ✔
- 工作空间在 `/tmp` 下时，宿主绝对路径不再被 `/tmp/` 路由吞掉：`WorkspaceCompositeBackend`
  把「以工作空间开头」的 key 交给 default backend，文件真的落盘；不在工作空间下的
  虚拟 `/tmp/...` 仍然走 `StateBackend` ✔
  **（020 期：那条路由和守卫类都删了——现在压根没有 `/tmp/` 路由可吃）**
- 普通跑一轮不会创建 `.scode-memory.md`；模型自己调 `write_file` 写记忆时才创建 ✔
- 2026-10-26 对真实服务（MiniMax 真模型）实测：`/tmp/scode-real-a` → 记忆读入
  A；同一 thread 切到 `/tmp/scode-real-b` → `memory_contents` 换成 B；
  空目录 C 跑完不出现 `.scode-memory.md`；删掉 A 后新开一轮 → SSE `error`
  事件带「工作空间不存在：/private/tmp/scode-real-a」✔
- **平台只透传内置异常的 message**：`langgraph_api/serde.py` 的 `_orjson_default`
  只对 `ValueError` / `TypeError` / `RuntimeError` 等内置类型返回 `str(exc)`，
  其余一律 `"An internal error occurred"`。`WorkspaceError` 最早继承裸
  `Exception`，真实服务上只看到一句内部错误；改成继承 `ValueError` 后才带出
  具体路径（`graph/backend.py` 里那个 `except ValueError` 也因此收窄，避免
  把 WorkspaceError 当成「路径不在工作空间下」吞掉）✔
- 记忆块用本项目自己的中文模板（015 期）：里面写明「文件可选、不会自动创建、
  第一次用 `write_file`、之后用 `edit_file`、每个工作空间一份、一次会话读一次」。
  不再出现框架的英文 `(No memory loaded)` ✔
- 记忆文件超 `MEMORY_MAX_CHARS`（8000 字）时保留头尾、中间省略并插一行说明；
  磁盘上的文件不动 ✔（015 期实测：20 万字符的记忆文件 → 系统提示词 9212 字符）

---

### 019 · 全仓精简 + 文档收敛

**做了什么**：对整个后端做了一遍「有没有为了复杂而复杂」的审查，把确定冗余的地方收掉，
并把散在多处的文档收敛到单一事实源。

**先说结论**：这个后端**没有**「为了复杂而复杂」的模块。AST 全仓扫过——240 个顶层符号
**零死代码**、唯一一处未使用的 import、所有模块级常量都在用。看着复杂的那些地方
（同步/异步双钩子、`.name` 覆写、MCP 长会话、权限档位钉进 state）逐条查过框架源码，
**都有硬依据**。真正的问题不在代码，在**文档**：同一批实测结论存了两份、目录树抄了三遍、
其中一份已经漂移。

**代码侧改了这些**（都是行为等价的重构）

| 改了什么 | 在哪 |
|---|---|
| 抽出 `configurable_of(config)`：读运行期参数（工作空间 / 档位 / 模型 / skill）的统一入口。原来 `config.get("configurable") if isinstance(config, dict) else None` 这句在 5 个文件里各写了一遍，而 `permissions.py` 那份还多检查了一层 `isinstance(configurable, dict)` | `graph/workspace.py` |
| `current_workspace()` 改成 `current_workspace_root().resolved`——两者在所有分支上等价（实测过），原来把「取 config → 提 configurable → 查缓存」抄了一遍 | `graph/workspace.py` |
| 删掉 `resolve_workspace()`：只有 `workspace_of()` 一个调用者，两层各包一行 | `graph/workspace.py` |
| 抽出 `_model_entry()`：模型列表和详情原本各手写同一份 8 字段字典 | `config/model.py` |
| `_parse_model_id()` 上移复用，`build_model_by_spec()` 不再自己写一遍 `provider:model` 的解析；`build_model()` 内联进 `load_model()`（只有它一个调用者） | `config/model.py` |
| 三个 `_do()` 闭包收成一个 `_mutate()`；原来三个返回的 tuple **顺序还不一致**（`(status, id, err)` / `(status, err, co)` / `(status, err, rest)`），是「记错顺序」的隐患 | `admin/models.py` |
| 删掉 `permissions.py` 里唯一一处未使用的 import；删掉 `memory.py` 里两个纯别名 | — |

**关键取舍**

- **`config/model.py` 的「模型不存在」从返回值改成异常**：新增 `NotFoundError(ConfigError)`。
  `get_model` / `update_model` / `delete_model` 不再返回 `(bool, ...)`，直接抛
  `NotFoundError`；成功时只返回结果本身。调用方按异常类型分 404 和 400。
  - **为什么**：`(ok, data)` 那个 tuple 让每个调用点都要写一遍「先看 bool 再看数据」，
    而且三个调用点的 tuple 顺序还不一样。异常把「没有这个东西」和「写错了」分成两类，
    状态码直接跟着异常类型走。
  - **HTTP 行为完全没变**：404 的响应体还是 `{"error": "模型 'minimax:foo' 不存在"}`，
    400 还是 400——`stupid_code/API.md` 里写的就是这两个，没动。
  - **「404 不写盘」也保住了**：`_mutate()` 只在 fn 没抛异常时才 `save_config`——
    模型不存在时不该把 `conf/config.toml` 重新序列化一遍（那会丢掉用户写的注释）。
- **同一规则的报错措辞统一**：`_parse_model_id()` 报「模型 ID 'x' 不合法」，原来
  `build_model_by_spec()` 报「模型标识 'x' 不合法」——同一套规则两种措辞，现在统一成前者。
- **评估后回退了一处**：本来想把「记忆 / skill 换工作空间就重读」抽成共享 helper，
  做完发现那是**为抽象而抽象**——它替换掉的是几行自洽代码，却多出一个 16 行的 helper
  和跨模块跳转。已回退，两处逻辑保持各自内联。

**文档侧**：把「同一件事写两遍」的地方收敛成单一事实源，每处都留了指针

| 内容 | 收敛到 | 原来散在 |
|---|---|---|
| 实测结论 | 本文档 §8 | `stupid_code/API.md` 的「已验证的事实」（整节已删，-79 行） |
| 目录树 | 本文档 §2.1 | `docs/overall-design.md` §9（**已漂移**：缺 `workspace.py` / `skills.py` / `admin/skills.py`，还列着「待建」目录）、`stupid_code/README.md`（-29 行，已删） |
| 当前安全姿态 | 本文档 §5 | 根 `README.md` §安全（改成只留结论）、`docs/overall-design.md` §6（改成只写设计意图） |
| 前端能力清单 | `docs/frontend-design.md` §12 | 本文档 §1.3（改成只留与后端耦合的条目） |

顺手修掉了 `docs/frontend-design.md` §12 的两行漂移：「权限三级下拉（拦截点待后端实现）」
和「与真实后端联调 ❌ 后端 P0 未开始」——后端早就到 018 期了。

**验证**

- 等价性逐条对照（`current_workspace` / `configurable_of` / 记忆与 skill 的「摘 key 逼
  框架重读」逻辑 / `list_models` / `get_model`）：全部一致
- `/admin/models` 五个端点端到端：状态码（200 / 201 / 400 / 404）和「什么时候写
  `conf/config.toml`」全部与改动前一致
- `uv run langgraph validate --config stupid_code/langgraph.json` → `1 graph found`

### 020 · 删掉 `/tmp/` 路由

**做了什么**：删掉主 backend 上那条 `/tmp/` → `StateBackend` 的路由，以及为它专门写的
守卫类 `WorkspaceCompositeBackend`。

**目标**：`/tmp/` 路由是 019 期审查出的唯一一处「为了复杂而复杂」——它有 69 行代码
专门伺候，而且那条代码防的问题，删掉路由之后压根不存在了。

**为什么删**

- **它是唯一可能跟宿主绝对路径撞上的路由**。其余两条（`/user-memory/` /
  `/user-skills/`）是**虚拟名**，磁盘上根本不存在，真实路径里不会出现这两个前缀。
  而 `/tmp` 是真实目录：macOS 上它是 `/private/tmp` 的软链，Linux 上 `mktemp -d`
  默认就落在那儿——**工作空间本身完全可能在 `/tmp/...` 下**。
- **为了防这个撞车，才有了 69 行的守卫类**。`WorkspaceCompositeBackend` 覆写了
  `_get_backend_and_key` / `ls` / `als` / `grep` / `agrep` / `glob` / `aglob` 七处，
  在路由之前先判断「这个 key 是不是以当前工作空间绝对路径开头」，是就绕开路由交给
  default backend。**删掉路由，这个判断就没有存在意义了**——没有任何路由会再吃掉
  工作空间自己的路径。
- **它的功能跟项目已有的产物策略重复**。`/tmp/` 路由当初是为了给 agent 一个
  「会话内临时区」（不落盘），但项目自己的中间产物早就收在 `<工作空间>/.scode/`
  （016 期），agent 要写临时文件直接写工作空间里就行。
- **提示词反而更清楚了**。框架会给 CompositeBackend 自动生成一段「虚拟路径 ↔ shell
  路径」的映射提示（`deepagents/middleware/filesystem.py` 的 `_route_host_path_prompt()`）。
  `/tmp/` 那条路由因为指向 `StateBackend`（不是 `FilesystemBackend`），在提示词里
  只占一行 `- \`/tmp/\``——**没有对应的 shell 路径**，意思就是「这个路径 shell 访问不到」。
  删掉之后提示词少两行，剩下两条路由都带真实宿主路径映射，更清楚。

**代码侧改了这些**

| 改了什么 | 在哪 |
|---|---|
| 删掉 `WorkspaceCompositeBackend` 整个类（71 行，含 7 个覆写方法） | `graph/backend.py` |
| `build_backend()` 的 routes 只剩 `/user-memory/` 和 `/user-skills/`，返回裸 `CompositeBackend` | `graph/backend.py` |
| `build_restricted_backend()` 同样返回裸 `CompositeBackend`——**保留 `artifacts_root`**：框架读它的条件是 `isinstance(backend, CompositeBackend)`，裸 `FilesystemBackend` 拿不到，产物会退回 `/` 根目录 | `graph/backend.py` |
| `_workspace_relative()`（22 行独立函数）内联进 `_WorkspaceRoot._resolve_path()`（9 行循环）——它只剩一个调用者 | `graph/backend.py` |
| 删掉 `StateBackend` / `GlobResult` / `GrepResult` / `LsResult` 四个 import | `graph/backend.py` |

**关键取舍**

- **保留 `_WorkspaceRoot._resolve_path()` 的宿主绝对路径剥离**。这一段跟路由无关：
  系统提示词会把工作空间的**真实绝对路径**给模型，模型可能直接拿它调文件工具，
  框架会当成虚拟路径处理，文件落进 `<工作空间>/private/var/.../` 这种嵌套目录里
  **还不报错**。这条机制必须留。
- **顺带把两种路径形态的判断留住了**。`_resolve_path()` 依次试 `resolved`（软链已
  展开）和 `given`（用户给的那条）两个根——macOS 上用户手打 `/tmp/proj` 而真实路径是
  `/private/tmp/proj` 时，只拿 `resolved` 去比会失配。这跟路由无关，是另一码事。
- **行为变化只有一个，而且是预期内的**：agent 写 `/tmp/xxx` 时，以前进虚拟 FS
  （不落盘），现在跟其它路径一样落在 `<工作空间>/tmp/xxx`。这条路径以前 agent 也
  基本不用——框架提示词里明确说 `/tmp/` 是「shell 访问不到，只能用文件工具」，
  而 agent 要写临时文件时更自然会写工作空间里的相对路径。

**验证**

A/B 对比脚本（`/tmp/scode_backend_ab.py`）：把 `HEAD` 版 `backend.py` 和工作区新版
装进同一个进程，跑同一批场景比结果。**必须一致的场景全部一致**，**预期差异的场景
确认有差异**：

| 场景 | 结果 |
|---|---|
| 写宿主绝对路径（resolved 形态） | old == new ✔ |
| 写虚拟路径 `/v.txt` | old == new ✔ |
| 写工作空间之外的绝对路径 | old == new ✔ |
| 写 `/user-memory/` 路由 | old == new ✔ |
| 写 `/user-skills/` 路由 | old == new ✔ |
| `ls` / `grep` / `glob` 传工作空间绝对路径 | old == new ✔ |
| 软链形态（given ≠ resolved）下 `_resolve_path` 的五种输入 | old == new ✔ |
| **工作空间在 `/tmp/` 下时写宿主绝对路径（两种形态）** | **old == new ✔**（这条最关键——守卫类存在的理由） |
| 受限 backend 的 routes / default 类型 / artifacts_root / 有无 execute | old == new ✔ |
| `ls("/")` 的路由目录列表 | old 有 `/tmp/`、new 没有（预期差异）✔ |
| 写 `/tmp/probe.txt` 的落点 | old 进虚拟 FS、new 落 `<工作空间>/tmp/probe.txt`（预期差异）✔ |
| 系统提示词的路由段落 | old 少一行 `- \`/tmp/\``（预期差异）✔ |

另外：

- `uv run langgraph validate --config stupid_code/langgraph.json` → `1 graph found`
- `uv run python -c "import stupid_code.graph.agent"` → 图建起来（`CompiledStateGraph`）

**已验证的事实**

- 删掉 `/tmp/` 路由后，**工作空间在 `/tmp/` 下时宿主绝对路径依然正确落盘**（两种路径
  形态都试了）——因为压根没有路由会再吃它，守卫类不必存在 ✔
- 软链形态（`given ≠ resolved`）下 `_resolve_path` 的行为跟改动前逐项一致 ✔
- 系统提示词里剩下的两条路由都带真实宿主路径映射（`- \`/user-memory/\` -> \`~/.scode/\``），
  没有「shell 访问不到」的条目 ✔

### 021 · 拦同一个 tool 用同一组参数反复失败

**做了什么**：加一个中间件（`graph/repeated_calls.py`），同一个 tool 用同一组参数连续失败
到阈值就不再执行，返回一条错误消息告诉模型「换个思路」。

**要解决什么**：模型调 `edit_file` 对不上字符串，调了 8 次，每次参数一模一样，每次都失败。
它不是在推进，是在原地转圈——每一轮都烧掉一次真实的工具执行和一次模型往返。

**原本没有任何机制管这件事**（逐条查过）：

| 层次 | 有什么 | 对「重复调用」的效果 |
|---|---|---|
| LangGraph | `recursion_limit`（默认 10007） | 只管**总步数**，管不了重复 |
| deepagents | 压缩中间件 | 管上下文长度，不管重复 |
| deepagents 内建提示词 | 「If something fails repeatedly, stop and analyze *why*」 | **本项目用不上**——内建提示词 0.7.0 就废弃了，`config/prompts.py` 自己写全了系统提示词，这句没被继承到 |

**判定：签名 + 连续性**

签名 = tool 名 + 参数的稳定序列化（`json.dumps(args, sort_keys=True)`）。`sort_keys=True`
必须有——否则 `{"a":1,"b":2}` 和 `{"b":2,"a":1}` 是两次不同的调用，模型改一下参数顺序就绕过去了。

**只数「紧邻的」同签名失败**：失败之后换个参数再试是正常的（模型换了思路），不该连坐。
中间夹了别的调用、或遇到一次成功，计数就清零。

**失败怎么判定**：`ToolMessage.status == "error"`。框架统一用这个标记表示失败——

- 工具抛异常 → deepagents 在**工具边界**把它转成 `status="error"` 的 ToolMessage
  （`deepagents/middleware/filesystem.py`，注释写明 "never let them escape"），异常不穿透
- **参数校验错误**也是这个状态（工具压根没跑，但消息已经是 error）

两种形态统一处理。但有两条例外：

- **HITL 拒绝**也产生 `status="error"`（`human_in_the_loop.py` 的 `_answer_message`）——
  那是**用户的决策**不是模型重试，按 content 前缀排除
- **本中间件自己发的拦截消息**也是 error——不排除的话它会把自己算成失败，计数滚雪球
  （实测：拦一次之后每次都拦，提示里的次数一直涨）。排除后次数稳定

**`execute` 的命令失败（exit code ≠ 0）返回 `status="success"`**，所以 `pytest` 跑不过
不会被拦——那不是工具失败，是命令的退出码。被拦的是「工具本身用不了」：路径不存在、
`edit_file` 对不上字符串、权限拒绝。

**计数从消息历史来，不是 state**

扫 `request.state["messages"]`，不维护自己的计数器。两条理由：

1. **工具结果在执行之后才写回 state**（实测：`wrap_tool_call` 里看到的 messages 只到当前
   这条 AI 消息，上一次迭代的工具结果已经在里面了）——「上一次失败」看得见，够判连续失败
2. **不需要额外 state 字段**。自己维护计数器就得处理「什么时候清零」，而「连续性」的
   语义（中间夹了别的调用就清零）从消息历史扫更准

时序上唯一的例外：**同一批并行发出的 tool call 互相看不到对方的结果**——这是对的，
并行不是重试。

**消息历史会被压缩**：对话长了被 `SummarizationMiddleware` 压缩，老消息被摘要替换，
「连续失败」的证据就没了——判定会漏。可接受：压缩说明上下文已经很长了，模型自己都记不清
前面失败了什么，这时候拦住它意义不大。宁可漏判不可误判。

**关键取舍**

- **拦下后返回消息，而不是抛异常**：抛异常会中断整轮运行——但模型可能只需要换个参数就能过。
  返回一条错误消息让它自己调整更温和
- **阈值 3（允许试 2 次）**：参数写错一两次很正常，第 3 次还没成功基本可以断定它在原地转圈
- **跟 HITL 的相对顺序有讲究，但恰好是对的**：deepagents 把 `HumanInTheLoopMiddleware` 放在
  core 栈，自定义 middleware 在它之后；按 langchain 的「先定义 = 最外层」，**HITL 在外层**
  ——HITL 拒绝发生在本中间件**之前**，所以本中间件能看到那条拒绝消息（然后排除它）
- **子 agent 不继承**：子 agent 是独立 `create_agent()` 建的图，父级的 `middleware=` 不会传
  下去（跟 `PermissionLevelMiddleware` 一样，得显式挂）。主 agent 的重复调用是主要问题，
  子 agent 先不管
- **提示词也补了一条**：deepagents 内建提示词里那句「失败别重试」本项目没继承到，
  `config/prompts.py` 补了一条对应的中文。它是软引导，中间件才是硬约束

**验证**

`/tmp/scode_repeated_test.py`：单元层测 `call_signature` / `consecutive_failures` 的判定，
端到端用 **deepagents 真实的 `FilesystemMiddleware` 工具**跑（不是 langchain 的 `@tool`——
后者失败时抛异常不返回 error ToolMessage，形态不一样，拿它测会得出错误结论）。

| 场景 | 结果 |
|---|---|
| 连续 2 次同签名失败 | 判定为 2 ✔ |
| 中间换了别的 tool | 不连续（0）✔ |
| 成功过 | 清零（0）✔ |
| HITL 拒绝 | 不计入（0）✔ |
| 参数顺序不同但内容相同 | 算连续（2）✔ |
| 找不到对应参数 | 0（宁可漏判不可误判）✔ |
| `threshold=1` | 构造时抛 ValueError ✔ |
| **端到端：4 次同样失败调用** | **工具只真跑了 2 次，第 3、4 次被拦** ✔ |
| 端到端：换参数 | 无拦截 ✔ |
| 端到端：阈值 2 | 第 2 次就拦 ✔ |
| 端到端：成功的重复调用 | 无拦截 ✔ |
| 拦截消息里的次数 | 稳定在 3，不滚雪球 ✔ |

另外用**项目真实的 backend** 复验了一遍：前 2 次真失败（`Error: File '/a.py' not found`），
第 3、4 次返回拦截消息，工具不再执行。

- `uv run langgraph validate --config stupid_code/langgraph.json` → `1 graph found`
- `uv run python -c "import stupid_code.graph.agent"` → 图建起来（`CompiledStateGraph`）
- 全仓零未使用 import

**踩过的坑（留给下一个人）**

- **框架只注入它认识的关键字**：`before_agent` / `wrap_tool_call` 的参数是按签名注入的，
  `config` 只有在注解是 `RunnableConfig` / `RunnableConfig | None` 时才注入——注解写 `Any`
  会被静默跳过，然后报「missing 1 required positional argument」
- **同步异步两个钩子都要实现**：只实现 `wrap_tool_call` 在异步路径下会抛
  `NotImplementedError`（框架明确要求两个都实现）
- **`wrap_tool_call` 不生成图节点**：`get_graph().nodes` 里看不到它——它在 `tools` 节点内部
  生效。想确认它挂上了，要么看源码，要么跑一次真实调用看是否触发

## 4. 关键机制速查

### 4.1 图的构建（`graph/agent.py`）

```python
backend = build_backend()
default_model = load_model()
compaction = build_compaction_middleware(default_model, backend)

graph = create_deep_agent(
    model=default_model,
    system_prompt=SYSTEM_PROMPT,
    subagents=[
        apply_subagent_policies(spec, default_interrupt_on=interrupt_on)
        for spec in load_subagents()
    ],
    backend=backend,
    # 切换中间件放最前 → 在最终栈里比 prompt-caching / memory 更外层
    middleware=[
        ChatModelSwitchMiddleware(default_model),
        # 名字叫 SummarizationMiddleware → 顶掉 create_deep_agent 自带的那份
        compaction,
        # compact_conversation 工具：模型自己也能压缩
        build_compaction_tool_middleware(compaction),
        build_memory_middleware(),
    ],
    interrupt_on=build_interrupt_on(),
)
```

### 4.2 持久化分两处，缺一不可

| 东西 | 落在哪 | 删掉的后果 |
|---|---|---|
| checkpoint（线程状态快照） | `stupid_code/data/langgraph.db`（经 `graph/persistence.py`） | 历史消息没了 |
| thread 索引（会话列表、metadata、status） | 工作空间的 `.langgraph_api/.langgraph_ops.pckl` | `POST /threads/search` 返回空、`GET /threads/{id}/state` 404——**数据还在 SQLite 里，但平台认不出这些 thread 了** |

`.langgraph_api/` 由 inmem 运行时硬编码生成在 cwd 下，**无法配置改位**。
**别删它**——scode 已经不再清理它。

### 4.3 提示词是模型唯一看到的系统提示词

deepagents 0.7.28 **不再提供内置的基础提示词**：`BASE_AGENT_PROMPT` 在 0.7.0 废弃
（0.9.0 移除），`HarnessProfile.base_system_prompt` 默认 `None`，内置的几个 claude profile
也没设。所以 `create_deep_agent(system_prompt=...)` 传进去的**就是全部**。

提示词里**不写子 agent 名单**——名单由 deepagents 自动写进 `task` 工具的 description，
再抄一份就是两份真相。想提高委派率，去改 `conf/subagents.toml` 里的 `description`。

### 4.4 运行参数（`config.configurable`）

| key | 前端常量 | 语义 | 后端读取情况 |
|---|---|---|---|
| `workspace` | `WORKSPACE_KEY` | 工作空间绝对路径 | ✅ 已实现（014 期，`graph/workspace.py`）：文件工具和 `execute` 的 cwd 都跟着它走 |
| `permissions` | `PERMISSIONS_KEY` | 确认档位 manual/normal/auto | ✅ 已实现（`graph/permissions.py`） |
| `model` | `MODEL_KEY`（`web/src/lib/model.ts`） | 对话模型 id `供应商名:模型名` | ✅ 已实现（`graph/model_switch.py`） |
| `skills` | `SKILLS_KEY`（`web/src/lib/skills.ts`） | 本次对话勾选的 skill 名字列表 | ✅ 已实现（018 期，`graph/skills.py`）：勾选的 `SKILL.md` 全文钉进对话历史 |

`workspace` / `permissions` / `skills` **按 `threadId` 存而非全局**——同任务内前后两条消息可能针对
不同目录、不同 skill。另有 `draft` 副本供新任务用，`createThread()` 时 `adoptDraft()` 固化并重置。

`skills` 之所以也是任务级：项目级 skill 在**工作空间里**（`<工作空间>/.agents/skills/`），
而工作空间是运行期参数——skill 选择不能建图时定死，只能每次运行带过去。

`model` 是**全局偏好**（localStorage），每次运行都随请求带过去，所以刷新页面、
后端重启都还在。**恢复挂起的运行时也要原样带回去**：恢复时后端同样按
`configurable.model` 换模型，带空了就退回默认模型，跟批准前用的不是同一个模型。
`skills` 同理——恢复那一轮不该跟批准前不是同一组 skill。

### 4.5 端点速查

平台内置（`langgraph dev` 直接提供）：`/ok`、`/assistants/search`、
`/assistants/{id}/graph`、`/threads`、`/threads/search`、`/threads/{id}`（GET/PATCH/DELETE）、
`/threads/{id}/state`、`/threads/{id}/runs/stream`、`/threads/{id}/runs/{runId}/cancel`。

自定义：`/admin/models` 五个端点 + `POST /workspaces/pick`（弹系统目录选择框，014 期）
+ `/admin/memory` 两个端点（GET 读两份记忆 / PUT 写一份，017 期）
+ `GET /admin/skills`（列 skill 清单，018 期）。

完整清单与请求/响应示例见 [`stupid_code/API.md`](../../stupid_code/API.md)。

---

## 5. 安全姿态

| 边界 | 现状 |
|---|---|
| 监听地址 | **只监听 `127.0.0.1`**。绝不要绑 `0.0.0.0` |
| API key | 只走 `conf/config.toml`（gitignore），不进 `.env`、不入库 |
| shell 执行 | 有人工确认关卡（009），`normal` 档只拦命中危险模式的命令 |
| 删文件 | 有人工确认关卡（015），但只有 `manual` 档拦；`normal` 档不拦 |
| 文件写入 | **不拦**（`write_file`/`edit_file`）——那是 code agent 的日常。**例外：写记忆文件要拦**（017 期），`normal` 和 `manual` 档都拦 |
| 文件路径 | 文件工具锁在工作空间内（`virtual_mode=True`），**shell 不受此限** |
| 工作空间之外的写路径 | **有一条**（017 期）：`/user-memory/` 路由指向 `~/.scode/`，agent 能用 `write_file` 在那个目录里建/改文件。范围限于这一个目录——**跟"文件工具锁在工作空间内"不矛盾**，工作空间内的路径依然出不去 |
| 工作空间之外的读路径 | **有一条**（018 期）：`/user-skills/` 路由指向 `~/.scode/.agents/skills/`，agent 能用 `read_file` 读全局 skill 的全文。同样只覆盖这一个目录 |
| 读取范围 | agent 能读工作空间里的任何文件，**包括 `conf/config.toml` 里的 api_key**——这块没被 HITL 覆盖 |
| 子 agent 权限 | 只有声明了 `permissions` 的子 agent 才是硬约束；没声明的拿的是主 agent 那套带 shell 的 backend |
| 危险判定 | 正则匹配，不是语义分析。**宁可漏拦也不误拦** |

### 5.1 每条姿态的理由

`AGENTS.md` 的 Security 一节只留结论；理由在这里，改姿态前先看这些。

| 姿态 | 为什么这么定 |
|---|---|
| API key 只走 `conf/config.toml` | 明文 key 一旦进了 `.env`、镜像层或仓库就等于公开——`conf/config.toml` 至少是 gitignore 的 |
| 后端只监听 `127.0.0.1` | 这 agent 天生带 shell 执行和文件写权限，绑 `0.0.0.0` 等于把整台机器交出去 |
| 边界在工具层强制，不靠模型自觉 | deepagents 是 "trust the LLM" 模型：agent **不会自我约束**，边界必须在工具层/沙箱层强制执行 |
| 危险操作走人工确认，**边界条件必须落盘持久化、不能重算** | 重算 = 恢复时算出来的档位可能和挂起时不一致，被用户拒绝的命令会照样执行。档位要钉进图状态（checkpoint） |
| HITL 判据记在图状态里，**不读客户端回传的值** | 框架的 `when` 谓词在恢复时会再跑一次；只从运行配置读档位的话，恢复那轮会绕过上次的拒绝 |
| 工作空间不要包含后端仓库 | agent 能改 `conf/mcp.json`（里面可以写 stdio `command`）和后端源码，下次启动时执行，等于绕开 `execute` 的人工确认 |
| MCP 是新的执行/注入面 | stdio 服务器会在建图时和首次调用时拉起命令，服务器给的工具有副作用、工具描述会进模型上下文 |
| 两条工作空间之外的路径 | `/user-memory/`（`~/.scode/`，**可写**）和 `/user-skills/`（`~/.scode/.agents/skills/`，**只读**）各覆盖一个目录。agent 仍能读工作空间里任何文件（包括 `conf/config.toml` 里的 api_key），**这块没被 HITL 覆盖** |
| 目录选择靠系统原生弹窗 | 后端不提供「列目录」接口——那等于把文件系统目录树开放成 HTTP 接口。该端点会阻塞到用户选完，后端仍只监听 `127.0.0.1` |

**恢复挂起的运行还有两个硬约束**：请求体要带同一个 `configurable.permissions`；`command.resume.decisions` 的个数必须和挂起时的
`action_requests` 一样多。**框架的 reject 理由字段叫 `message`，不叫 `feedback`**。

---

## 6. 已知缺口

| 缺口 | 影响 | 备注 |
|---|---|---|
| shell 不受路径限制 | `execute` 能访问工作空间外的任何路径 | 设计如此，但和"文件工具锁在工作空间内"不一致 |
| 工作空间不是沙箱 | agent 有 shell 就能碰整个文件系统，选工作空间只是"默认在哪干活" | deepagents 是 trust the LLM 模型，这是既定前提 |
| 无图形界面时弹不出目录框 | 后端在 Docker / 纯 SSH 环境下只能手打路径 | 前端下拉里有手动输入兜底 |
| 危险判定是正则 | `rm --recursive --force` 这类等价写法匹配不上 | `normal` 档的固有局限；`normal` 是过滤器不是安全边界，要确定性用 `manual` |
| `delete` 在 `normal` 档不拦 | 删文件/删目录（递归）不弹确认 | 015 期起 `manual` 档会拦；`normal` 档拦它太吵 |
| 改完的命令不再过危险判定 | 用户在卡片上把 `rm -rf x` 改成 `rm -rf /`，直接执行 | 015 期新增 `edit` 决策的取舍：那是用户自己敲的 |
| 子 agent 也会触发确认 | `fixer` 这类没声明 `permissions` 的子 agent 执行命令同样挂起 | 要不要默认放行是个待定的产品决策 |
| 同一工作空间内记忆只在会话开始时读一次 | 改完 `.scode-memory.md` 要开新会话才生效；换工作空间会重读 | 框架设计（记忆块参与 prompt 缓存） |
| 记忆面板改完也不立刻生效 | 面板里改完记忆，当前会话里的 agent 读到的还是旧内容 | 同一个框架机制；面板底部写了这句话 |
| 用户级记忆是全局的，不按项目隔离 | 写错的用户级记忆会跟着你到**每一个**项目 | 有意为之：用户级就是跨项目的；模板里提示"分不清放哪就放项目级" |
| agent 能读写 `~/.scode/` 整个目录 | `/user-memory/` 那条路由覆盖整个目录，不只是 `memory.md` | 只覆盖这一个目录；这是"用户级记忆"这个功能要求的权限面 |
| 记忆面板和 agent 同时改会互相覆盖 | 后写的赢，可能吃掉对方刚写的内容 | 两边都是普通文件写者；面板底部写了这句话 |
| 取消勾选不会把已钉进上下文的 skill 拿掉 | 那个 `SKILL.md` 全文还留在对话历史里，每轮都会重发 | 框架的 pin 语义是追加（`Overwrite([])` 清 `pinned_skills` + 追加消息），改不了 |
| 目录不存在时框架会打一条 warning 日志 | 后端日志里有 `Cannot load skills from '/.agents/skills/': path_not_found` | **提示词里已过滤掉**（不留噪音），但**日志里仍会出现**——框架自己打的，控制不了 |
| skill 的 `SKILL.md` 正文没有长度上限 | 一个巨大的 `SKILL.md` 会整篇进上下文 | 框架只限制文件大小（10MB），不限注入长度；记忆那块有 8000 字上限，skill 这边没有 |
| langgraph store 配了但没用上 | `langgraph.json` 里的 `store` 至今零调用，`data/langgraph.db` 的 `store` 表是空的 | 有意为之：记忆走文件（人能看、人能手改）；留着的 store 以后给别的用途 |
| general-purpose 子 agent 的档位来自 `configurable` | 它是框架自动加的，我们没机会给它挂 `PermissionLevelMiddleware`（它的中间件继承靠 `.name` 匹配，我们那个名字不在它的默认栈里）。所以它 state 里没有档位记录，谓词退回读客户端回传的值 | 真实使用中没问题：前端恢复时原样带回发起那轮的档位（审批挂起期间选择器禁用）。客户端**不**原样带回就会翻转 |
| 记忆文件只增不减 | `edit_file` 追加，老的、错的条目一直躺在文件里（8000 字上限只管**注入**，不管磁盘上的文件） | 靠前端记忆面板手动清理 |
| 切模型不换 harness profile | 系统提示词附加内容、工具描述改写、排除的工具都按启动时的模型定死 | 建图时决定的，跑起来改不了 |
| 切模型不换摘要阈值 | 压缩历史的触发阈值按启动时模型的上下文窗口算 | 切到窗口更小的模型可能触发偏晚 |
| 切模型不换「超预算」兜底的预算 | 压缩中间件在最终栈里位于切换中间件**外层**，它内部读 `request.model.profile` 时看到的还是启动时的模型 | 本项目模型无 profile，这条兜底恒不触发；真超限时靠 `ContextOverflowError` 的兜底路径兜住 |
| 选了不存在的模型会静默退回 | 界面上看不出切换没生效，只有后端日志有 warning | 有意为之：不让整个对话挂掉 |
| MCP 工具在 `normal` / `auto` 档不经过人工确认 | `manual` 档已经拦非只读工具；`normal` / `auto` 下 MCP 工具直接执行 | `normal` 是「已知危险模式」过滤器，MCP 行为由服务器定义；要确定性就切 `manual` |
| `readOnlyHint` 是服务器自报的 | 服务器可以谎报只读，从而跳过 `manual` 档的确认 | 只用它决定「要不要打扰用户」，不当安全边界；不信任服务器就别配它 |
| 工作空间是仓库根时能改启动配置 | agent 能写 `conf/mcp.json` 和后端源码，下次启动时执行——绕开 `execute` 的人工确认 | 已加启动警告；推荐用 `SCODE_WORKSPACE` 指向单独目录 |
| 改 `conf/mcp.json` 要重启后端 | 加服务器 / 改地址之后得重启才生效 | 013 期有意为之（静态注册换简单，见「013 · 关键取舍一」） |
| 服务器启动时挂着，得等重启 | 该服务器的工具整个会话都没有 | 加载时重试过；仍失败就等下次重启 |
| MCP 长会话是进程级共享的 | 不同对话看到同一个服务器状态（浏览器页面、REPL 变量） | 单用户项目够用；要按 thread 隔离得把 thread_id 送进 MCP 线程 |
| MCP 连接失败只少几个工具 | 连不上的服务器的工具不会出现在模型面前（界面看不出来） | 有意为之：不让一个外部服务拖垮整轮对话 |
| MCP 配置写错的服务器只跳它自己 | 那几个工具整个会话都没有，界面上也看不出来 | 日志里会报一句为什么；其余服务器照常 |
| 流式回复是整段到达 | 不是 token 级增量 | 平台两种模式都支持，`messages-tuple` 事件名是 `messages` |
| 没有自动化测试、没有 CI | 验证全靠手工 | 本项目是有意如此（学习项目） |

---

## 7. 手工验证流程

### 步骤 0：配置冒烟（不起服务，最快暴露配置错误）

```bash
cd /path/to/stupid-code
uv run python -c "
from stupid_code.config.model import load_model
m = load_model()
print(type(m).__module__, type(m).__name__)
"
```

期望输出包含 `ChatAnthropic`（或 `ChatOpenAI`）。配置有错时这一步直接抛 `ConfigError`。

### 步骤 1：配置校验

```bash
uv run langgraph validate --config stupid_code/langgraph.json
```

### 步骤 2：启动

```bash
cd $(mktemp -d)     # 工作空间 = 这个临时目录
uv run --project /path/to/stupid-code python -c "import stupid_code; stupid_code.start()"
```

看到两条就绪提示（`/ok` + 图可加载）即通过。**在哪个目录运行，那个目录就是工作空间。**

### 步骤 3：端点抽查

```bash
curl -s http://127.0.0.1:2024/ok
curl -s -X POST http://127.0.0.1:2024/assistants/search -H 'Content-Type: application/json' -d '{}'
curl -s http://127.0.0.1:2024/admin/models | python3 -m json.tool
```

### 步骤 4：HITL 挂起 + 恢复

```bash
TID=$(curl -s -X POST http://127.0.0.1:2024/threads \
  -H 'Content-Type: application/json' -d '{}' \
  | python3 -c "import sys,json;print(json.load(sys.stdin)['thread_id'])")

curl -N -X POST "http://127.0.0.1:2024/threads/$TID/runs/stream" \
  -H 'Content-Type: application/json' \
  -d '{"assistant_id":"code_agent",
       "input":{"messages":[{"role":"user","content":"请执行命令：echo hello"}]},
       "stream_mode":["updates"],
       "config":{"configurable":{"permissions":"manual"}}}'
```

期望 SSE 里出现：

```json
{"__interrupt__": [{"value": {"action_requests": [{"name": "execute",
  "args": {"command": "echo hello"}, "description": "..."}],
  "review_configs": [{"action_name": "execute",
                       "allowed_decisions": ["approve", "reject"]}]}}]}
```

恢复：

```bash
curl -N -X POST "http://127.0.0.1:2024/threads/$TID/runs/stream" \
  -H 'Content-Type: application/json' \
  -d '{"assistant_id":"code_agent",
       "command":{"resume":{"decisions":[{"type":"approve"}]}},
       "stream_mode":["updates"],
       "config":{"configurable":{"permissions":"manual"}}}'
```

⚠️ 两个硬约束：

- `decisions` 的个数**必须**和挂起时的 `action_requests` 一样多，否则框架抛
  `Number of human decisions (N) does not match number of hanging tool calls (M)`。
- `configurable.permissions` **必须原样带回同一个档位**。

### 步骤 5：切换对话模型

先记下 `config.toml` 里 `default` 指向的那个模型名，然后：

```bash
TID=$(curl -s -X POST http://127.0.0.1:2024/threads \
  -H 'Content-Type: application/json' -d '{}' \
  | python3 -c 'import sys,json;print(json.load(sys.stdin)["thread_id"])')

# 不带 configurable.model → 用启动时的默认模型
curl -N -X POST "http://127.0.0.1:2024/threads/$TID/runs/stream" \
  -H 'Content-Type: application/json' \
  -d '{"assistant_id":"code_agent",
       "input":{"messages":[{"role":"user","content":"只回复两个字：收到"}]},
       "stream_mode":["updates"],
       "config":{"configurable":{"permissions":"auto"}}}'

# 带 configurable.model → 换成选中的那个（id 格式 "供应商名:模型名"）
curl -N -X POST "http://127.0.0.1:2024/threads/$TID/runs/stream" \
  -H 'Content-Type: application/json' \
  -d '{"assistant_id":"code_agent",
       "input":{"messages":[{"role":"user","content":"只回复两个字：收到"}]},
       "stream_mode":["updates"],
       "config":{"configurable":{"permissions":"auto","model":"minimax:MiniMax-M3.1-Flash"}}}'
```

看两次分别用了哪个模型——**不用猜**，消息里的 `response_metadata.model_name` 就是
实际调用的模型：

```bash
curl -s "http://127.0.0.1:2024/threads/$TID/state" | python3 -c '
import sys, json
st = json.load(sys.stdin)
for m in st.get("values", {}).get("messages", []):
    if m.get("type") == "ai":
        md = m.get("response_metadata") or {}
        print(md.get("model_name"), "|", repr(str(m.get("content"))[:30]))
'
```

期望：第一行是 `default` 那个模型，第二行是 `MiniMax-M3.1-Flash`。

顺手验一下**选错会退回默认**（后端记 warning，不报错）：

```bash
# 把 model 改成 "不存在的供应商:不存在" → 请求正常完成，但用的是默认模型
```

### 步骤 6：前端

```bash
cd web && pnpm dev
```

打开 http://localhost:5173，发一句"你好"，能收到回复即通过。

侧边栏左下角换模型 → 再发一句 → 回复正常即通过（**不用重启后端**）。
在设置页把模型删掉 → 侧边栏下拉框刷新后应回落到后端默认模型。

输入框敲 `/` → 弹出命令菜单 → 选「压缩对话历史」→ 模型简短确认即通过。
查状态确认压缩真的发生了：

```bash
curl -s "http://127.0.0.1:2024/threads/$TID/state" | python3 -c '
import sys, json
vals = json.load(sys.stdin).get("values", {})
ev = vals.get("_summarization_event") or {}
print("cutoff_index =", ev.get("cutoff_index"), "| 有摘要:", bool(ev.get("summary_message")))
'
```

`cutoff_index` 不是 None 就说明压过。工作空间里还会多出
`conversation_history/<session_id>.md`（被摘走的旧对话，已 gitignore）。

### 步骤 7：MCP 工具（013 期）

```bash
# 0. 没有配置的话先复制示例（conf/mcp.json 不入库）
cd /path/to/stupid-code
cp conf/mcp.example.json conf/mcp.json

# 1. 先看配置对不对（不起服务，最快暴露语法/字段错误）
uv run python -c "
from stupid_code.config.mcp import load_connections
import json
print(json.dumps(load_connections(), indent=2, ensure_ascii=False))
"
```

期望输出形如：

```json
{
  "docs-langchain": {"transport": "http", "url": "https://docs.langchain.com/mcp",
                      "timeout": 8.0}
}
```

配置写错时这一步直接抛 `ConfigError`（字段名、拼错的 `type` 都会被指出来）：

```
mcp.json 的服务器 'x' 配置不合法：typo：不认识的字段
mcp.json 的服务器 'x' 的 type 'stio' 不支持，只支持 http / sse / stdio / ...
```

```bash
# 2. 起服务后看工具挂上没有（后端日志）
#    预期：MCP 工具已加载：5 个（来自 2 个服务器）
#    某个服务器连不上时：MCP 服务器 'xxx' 连不上，跳过它的工具：ConnectError: ...

# 3. 跑一轮对话，确认 agent 真的调了 MCP 工具
TID=$(curl -s -X POST http://127.0.0.1:2024/threads \
  -H 'Content-Type: application/json' -d '{}' \
  | python3 -c "import sys,json;print(json.load(sys.stdin)['thread_id'])")

curl -s -N -X POST "http://127.0.0.1:2024/threads/$TID/runs/stream" \
  -H 'Content-Type: application/json' -H 'Accept: text/event-stream' \
  -d '{"assistant_id":"code_agent",
       "input":{"messages":[{"role":"user","content":"用 MCP 的文档搜索工具查一下 create_deep_agent 是什么，一句话总结。"}]},
       "stream_mode":["updates"],"on_disconnect":"continue",
       "config":{"configurable":{"workspace":"/abs/path","permissions":"auto"}}}'
```

在 SSE 的 `updates` 事件里应能看到 `mcp__docs-langchain__search_docs_by_lang_chain`
这样的工具调用和它的返回内容。

```bash
# 4. stdio 传输单独验一遍（http 通了不代表 stdio 通了）
#    在 conf/mcp.json 里加：
#      "demo": {"type": "stdio", "command": "<项目>/.venv/bin/python",
#               "args": ["<项目>/examples/mcp_stdio_server.py"]}
#    重启后端 → 日志应显示 3 个服务器都加载上了
#    再跑一轮对话让它调 echo：
#      "用 MCP 的 demo 服务器（stdio 那个）调用 echo 工具，传入文字 hello-stdio"
#    预期 SSE 里有 "name":"mcp__demo__echo"，返回内容是 "echo: hello-stdio"
```

**改配置要重启**：改完 `conf/mcp.json` 重启 `scode`，新服务器的工具才出现
（工具是建图时静态注册的，见「013 · 关键取舍一」）。

### 步骤 8：关停

`Ctrl+C` 后检查没有残留进程：

```bash
lsof -nP -iTCP:2024 -sTCP:LISTEN   # 应该没有输出
pgrep -f "langgraph_cli dev"        # 应该没有输出
```

---

## 8. 已验证的事实

> 下面是**曾经对着真服务实测过**的结论。每条都注明了验证时间——
> 框架在 0.x 迭代快，隔段时间要重新核。

### 8.1 平台与框架（2026-10-17 ~ 10-22 实测）

- `langgraph dev` 默认监听 127.0.0.1
- `langgraph dev` **拒绝自带 checkpointer 的图**
- `GET /assistants` 返回 **405**，列 assistant 要用 `POST /assistants/search`
- `assistant_id` 是 UUID，需先 search 获取；传 graph_id（`code_agent`）也能跑，
  平台会自己解析
- `POST /threads` 的 body **必填**，空 body → 422 `Invalid JSON in request body`
- `GET /threads` → **405**（`allow: POST`）；列表走 `POST /threads/search`
- Thread **没有 title 字段**，标题要自己存 `metadata.title`，用 `PATCH /threads/{id}` 写
- 平台错误体字段是 `{"detail": "..."}`，我们 `/admin/*` 用的是 `{"error": "..."}`——前端两种都认
- run 结束（尤其出错）时服务端直接关连接，浏览器记成 `net::ERR_ABORTED`——
  **这是正常收尾，不是前端 bug**
- 平台 `error` 事件是 `{"error": "AnthropicAuthenticationError", "message": "..."}`，
  只显示 message 等于什么都没说，两个字段要合起来给用户看
- `langgraph.json` 的 `http.app` 由 `langgraph_api.api.load_custom_app()` 解析，
  变量必须是 `Starlette` 或 `FastAPI` 实例
- starlette 通过 langgraph_api 间接安装，无需在 pyproject 显式声明

### 8.2 持久化与目录（2026-10-19 实测）

- **重启后 thread 会整体"消失"，除非保留 `.langgraph_api/`**：checkpoint 快照确实持久化在
  `stupid_code/data/langgraph.db`（`checkpoints` / `writes` 两张表），但 **thread 索引**
  存在工作空间的 `.langgraph_api/.langgraph_ops.pckl` 里。删掉该目录再重启，
  `POST /threads/search` 返回空数组、`GET /threads/{id}/state` 报 404
  `Thread or assistant not found.`——数据还躺在 SQLite 里，平台却认不出这些 thread 了。
  保留该目录后，两者都恢复正常（`same-named .langgraph_checkpoint.*.pckl` 是空的，
  说明 checkpoint 确实只走 SQLite）
- 附带结论：**thread 索引按工作空间分**（跟着 cwd 走），**checkpoint 按代码文件定位**
  （全局一份）。两者不在同一个工作空间时索引会与 checkpoint 失配

### 8.3 后端能力（各期实测）

- `langgraph validate --config stupid_code/langgraph.json` 输出 `1 graph found`
- 主 agent 的文件工具集是 `ls / read_file / write_file / edit_file / delete / glob /
  grep / execute`
- `execute` 真能跑本机命令：cwd = 工作空间，`$HOME` 等环境变量继承得到
- agent 的 `write_file` 写进 `/.scode-memory.md` 后，磁盘上那个文件的内容真的变了
- 记忆文件**不会自动创建**（014 期起）：空工作空间里不会再凭空出现
  `.scode-memory.md`；agent 第一次用 `write_file` 写记忆时才建（记忆块里说明了这一点）
- 用假模型抓 `request.system_message`：记忆内容确实在系统提示词的长期记忆块里
  （015 期起换成项目自己的中文模板，不再是框架的 `<agent_memory>` 英文块）
- 记忆读的是**选中工作空间**根目录那份：同一 thread 换工作空间会重读，
  换 thread 各自独立读 ✔（015 期对 `WorkspaceMemoryMiddleware` 单独复测）
- 真实服务里模型能原样念出记忆文件里的内容
- 服务端的图节点列表出现 `MemoryMiddleware.before_agent`；
  不传 `memory=` 参数时框架不会自己挂这个中间件——本项目是自己挂的
- `create_agent` 会把中间件的 `state_schema`（`MemoryState`）合并进图的状态 schema，
  所以 `memory_contents` 这个 channel 存在，私有状态不进入输出 state
- `reviewer` 的工具集里**没有 execute**；调它的 `write_file` 返回
  `Error: permission denied for write on /should-not-exist.txt`，文件没有被创建
- 框架确实在「backend 支持 execute + 有 permissions」时抛 `NotImplementedError`
  （`deepagents/middleware/filesystem.py`）
- `supports_execution()` 对 CompositeBackend 查的是 `backend.default`
  （`isinstance(backend.default, SandboxBackendProtocol)`）
- `LocalShellBackend` 默认 `inherit_env=False`，shell 拿到的是空环境
- `task` 工具的描述里正确列出 `general-purpose`（deepagents 自带）+ 配置的三个子 agent
- `summarizer` 真实跑通：返回的 JSON 严格符合 `response_format` 定的 schema
- `fixer` 的 `interrupt_on` 生效：写文件调用被挂起，线程状态里 `next = ["tools"]`
  且 `interrupts` 里带着 `allowed_decisions`，文件没有执行
- approve 恢复可用：之后子 agent 继续执行并返回结果

### 8.4 HITL（2026-10-22 对真实服务实测）

- 平台把 interrupt 以 **`updates` 事件**下发，键是 `__interrupt__`，值是
  `[{value: {action_requests, review_configs}}]`。`action_requests` 里**没有工具调用 id**，
  只有名字和参数
- `configurable.permissions` 能到达后端的 `when` 谓词：三档行为在真实服务上可区分
- `command.resume` 能让图从挂起点继续：批准后命令真的执行，拒绝后命令不执行，
  模型收到 `User rejected the tool call for 'execute' with reason: ...`
- **reject 的理由字段叫 `message`，不叫 `feedback`**（框架 `RejectDecision` 的定义）。
  叫错的话理由被静默丢掉，模型只看到"用户拒绝了这次工具调用"。早期版本踩过这个坑
- **一次 interrupt 可能含多个 `action_request`**（模型一轮里发了多条命令）。
  框架在 `HumanInTheLoopMiddleware.after_model` 里校验
  `len(decisions) == len(action_requests)`，对不上直接抛
  `Number of human decisions (N) does not match number of hanging tool calls (M)`，
  整个运行报错。早期版本只发一个 decision，遇到这个场景直接崩
- **`2>/dev/null` 不能算「写入系统目录」**。原来的正则 `>\s*/(etc|usr|...|dev)`
  会匹配 `2>/dev/null`，而这种写法满地都是——等于几乎每条命令都被拦，拦截就失去意义。
  现在用负向前瞻排除 `/dev/null`、`/dev/stdout`、`/dev/stderr`、`/dev/fd/*`
- 平台的后端工具在 `execute` 之外还有 `ls` / `read_file` / `write_file` / `edit_file` /
  `delete` / `glob` / `grep`；015 期起也拦 `delete`（只在 `manual` 档）

**015 期对 interrupt_on 的复测（2026-10-26，用假模型 + 真实图）**

- **`delete` 之前完全没人管**：实测 `delete("/victim.txt")` 直接执行（`Deleted
  /victim.txt`），而等价的 `execute("rm -rf ...")` 会挂起。**015 期起 `delete` 进
  `interrupt_on`**：`manual` 档挂起 ✔、`normal` 档不挂起 ✔、`auto` 档不挂起 ✔
- **恢复时档位翻转 → 被拒绝的命令照样执行**（实测复现）：`normal` 档挂起 → 用户
  拒绝 → 恢复时回传 `auto` → **文件被删了**。框架文档也明说了：the reviewer's
  answer is skipped and the tool runs, even if they rejected it。
  **015 期起不会了**：档位记在图状态里，恢复时读的是发起那轮运行时的那一档，
  实测同样场景下文件还在 ✔
- **`before_agent` 在恢复时不会重跑**（实测：整个恢复过程只打印了一次
  `before_agent`）——这是「把档位记进 state」这个修法成立的前提
- **`edit` 决策可用**：改完的命令真的执行了，模型收到
  `Note: a human reviewer replaced this tool call before it ran.` ✔
- **`reject` 的 `message` 会传给模型**：
  `User rejected the tool call for 'execute' with reason: 那个文件我还要用` ✔
- **`review_configs` 跟 `action_requests` 一一对应、顺序一致**（前端靠它渲染每条
  动作允许哪些决定）：`execute` → `["approve","edit","reject"]`、
  `delete` → `["approve","reject"]` ✔
- **decisions 数量对不上照旧抛**：
  `Number of human decisions (0) does not match number of hanging tool calls (1).`
  —— 前端在 store 里拦了一道，不让它发出去 ✔

### 8.5 模型切换（2026-10-23 对真实服务实测）

- **`request.override(model=...)` 真的换模型**。框架最终是拿
  `request.model.bind_tools(...)` 去发请求的（`langchain/agents/factory.py` 的
  `_get_bound_model`），不是拿建图时那个实例。换完就是真换
- **`get_config()` 在 `wrap_model_call` / `awrap_model_call` 里能拿到 `configurable`**。
  `ModelRequest.runtime` 是 `Runtime`，**没有 `.config` 属性**（`ToolCallRequest.runtime`
  才有），所以别去找 `request.runtime.config`——用 `langgraph.config.get_config()`
- **子 agent 的中间件也能拿到父图的 `configurable`**（子图继承父图的 config）。
  框架上做得到「子 agent 也跟着换」——**但本项目有意不用**：子 agent 的模型是
  `conf/subagents.toml` 配置出来的，切换只该影响主对话（见 010 期的取舍）
- **`configurable.model` 能穿过 `langgraph dev` 的 run 请求体**到达图的中间件，
  实测 `response_metadata.model_name` 从 `MiniMax-M3` 变成 `MiniMax-M3.1-Flash`，
  **后端没重启**
- **HITL 挂起后恢复，模型也保持**：恢复请求带上同一个 `configurable.model`，
  挂起前后两条 AI 消息的 `model_name` 一致
- **`AnthropicPromptCachingMiddleware` / `UnsupportedContentMiddleware` /
  `MemoryMiddleware(add_cache_control=True)` 都是看 `request.model` 决定行为**，
  所以它们会跟着切换后的模型走——前提是切换中间件比它们更外层
  （deepagents 把新的用户中间件放在 core 之后、尾部之前，天然满足）
- **`create_deep_agent` 的 `middleware=` 列表里，新中间件按名字落位**：
  名字撞上已有槽位就**原地替换**，不撞就插在 core 之后、尾部之前。
  想让自定义中间件在尾部那些（prompt-caching / memory / HITL）更外层，
  把它放列表靠前的位置即可
- **显式声明 `general-purpose` 子 agent 能顶掉自动添加的那份**
  （`any(spec["name"] == "general-purpose" for spec in inline_subagents)` 为真时
  不再自动加），其余字段（tools / interrupt_on / permissions）不写就继承主 agent。
  **本项目没有用它**——见上面那条，子 agent 的模型该由配置决定
- **模型实例按连接信息缓存是安全的**：键里带 api_key 和 base_url，
  改了 key 缓存自然失效，不会拿着旧 key 去请求
- **协议跟着供应商一起换**，不是只换模型名：切到 `protocol = "openai"` 的供应商时，
  请求真的按 OpenAI 的报文格式发出去（实测 anthropic → openai → anthropic 三次切换，
  每次都打到对应协议的服务上）

### 8.6 压缩对话历史（2026-10-24 对真实服务实测）

- **摘要的模型在构造时就定死了**：`langchain` 的 `SummarizationMiddleware.__init__`
  里 `self._summary_chat_model = self.model`，摘要调用走 `self._summary_model.invoke(...)`，
  **不是** `request.model`。**框架默认**切了模型之后自动压缩仍然用建图时那个实例
  （本项目已用 `summarizer=` 接管，摘要改用当前选中的模型——见 011 期）
- **deepagents 的摘要中间件不覆写 `before_model`**：自动压缩整个做在
  `wrap_model_call` 里。它内部用一个 langchain 的 `SummarizationMiddleware`
  当 `_lc_helper`，大部分方法转发过去
- **中间件按 `.name` 合并**：名字撞上已有槽位就原地替换，不撞就追加一份。
  自带的摘要中间件 `.name` 是 `SummarizationMiddleware`（子类默认报自己的类名，
  要替换必须显式覆盖 `name` 属性）
- **`SummarizationMiddleware.name` 是 property 对象，不是字符串**：
  `SummarizationMiddleware.name` 拿到的是 `<property object>`，直接返回它会让
  合并键永远对不上 → 静默变成两份摘要中间件。框架同时把这个公开别名写在
  ClassVar `serialized_name` 上，取那个才是字符串
- **框架的 `name` property 对「正好是它自己」返回公开别名、对子类返回类名**
  （`type(self) is _DeepAgentsSummarizationMiddleware` 是精确类型比较），
  所以 `super().name` 拿到的是子类名，不是别名
- **`summarizer` 是公开扩展点**：传一个 Runnable 就接管摘要调用（收到的是待总结的
  消息，摘要提示词要自己拼）。用来换摘要模型比改私有属性安全
- **`RunnableLambda` 包同步函数会丢 contextvar**：异步路径 `ainvoke` 会把同步函数
  丢进线程池执行，而 `get_config()` 依赖 contextvar——跨线程拿不到 `configurable`，
  会静默退回默认模型。要在异步路径里读运行配置，得自己实现 `invoke`/`ainvoke`
- **deepagents 的压缩不改 `state["messages"]`**：摘走的旧消息原样留在状态里，
  压缩通过私有的 `_summarization_event` 在模型调用时生效（LangChain 原生那个
  是用 `RemoveMessage(id=REMOVE_ALL_MESSAGES)` 直接改状态）
- **被摘走的旧消息会落到 backend 的文件里**：`conversation_history/<session_id>.md`，
  摘要里带着那个路径，agent 可以 `read_file` 读回来。压缩不是丢历史
- **`_summarization_event` 能在 `/threads/{id}/state` 里看到**：`cutoff_index` 和
  `summary_message` 都在——这是判断「压缩到底有没有发生」最直接的证据
- **本项目模型的摘要默认值**：MiniMax-M3（走 ChatAnthropic）**没有 profile**，
  所以 `compute_summarization_defaults` 给的是固定值：
  `trigger=("tokens", 170000)`、`keep=("messages", 6)`
- **主 agent 的最终中间件顺序**（实测打印）：
  `Filesystem → SubAgent → _ParentNotifier → Summarization(我们的) → PatchToolCalls
  → ChatModelSwitch → SummarizationTool → Memory → AnthropicPromptCaching
  → HumanInTheLoop → UnsupportedContent`
  框架把自定义中间件**按名字合并进基础栈**：撞名原地替换、不撞就追加到 core 之后。
  所以压缩中间件（替换自带那份）留在 core 段，**位于切换中间件外层**——
  它内部读 `request.model` 看到的仍是启动时的模型。摘要本身不受影响
  （`_RuntimeSummaryRunnable` 自己按 `configurable` 解析模型），
  受影响的只有「按 profile 算的超预算兜底」这条判断。
- **`/compaction` 只在「最后一条用户消息」是命令时才触发**：命令消息会留在对话里
  （模型要看到它），判断成「出现过就行」会导致下一轮又压一次

### 8.7 委派行为（2026-10-21 实测）
用 MiniMax-M3 + 本项目 subagent 配置做的对照实验：

| 组 | 提示词 | 用户请求 | 结果 |
|---|---|---|---|
| A | 旧（一句话） | "结构化摘要…" | 不委派，自己做 |
| B | 新（只有策略） | "审查 stupid_code/…" | 不委派，自己做 |
| C | 新 + 名单 | 同上 | 不委派，自己做 |
| D | 新 + 名单 | "**用 task 工具委派**，审查 conf/subagents.toml" | 委派 → `reviewer` ✅ |
| E | 新（只有策略） | 同上 | 委派 → `reviewer` ✅ |

两个结论：

1. **提示词里点不点名，模型选子 agent 的结果没有差别**（E 和 D 都选对 `reviewer`，
   B 和 C 都自己干了）。工具描述里那份名单够用，提示词里不用再抄一遍。
2. **真正决定委派与否的是用户请求**。明说"用 task 工具委派"就委派，不说就自己干
   ——A/B/C 三组提示词都没能改变这一点。

### 8.8 MCP（2026-10-25 对真实服务实测）

- **框架支持运行期注入动态工具**，但本项目**没用**：`langchain/agents/factory.py`
  的 `DYNAMIC_TOOL_ERROR_TEMPLATE` 写着 "Option 2: Handle dynamic tools in
  middleware"——中间件在 `wrap_model_call` 里改 `request.tools`、在 `wrap_tool_call`
  里 `request.override(tool=...)` 执行。`langgraph/prebuilt/tool_node.py` 的注释也
  说得很清楚："Validation is deferred to _execute_tool_sync to allow interceptors
  to short-circuit requests for unregistered tools"。**代价**：多一个中间件 +
  两套钩子 + 名字覆盖语义，换来「改配置不用重启」。这个项目是学习项目，
  标准是「能看懂」，所以选了静态注册（`create_deep_agent(tools=[...])`）
- **静态注册之后，工具就是普通工具**：注册在框架的 ToolNode 里，模型调用时
  框架自己执行。`request.tools` 里有没有它、bind_tools 绑没绑上，都是框架的事
- **`ToolNode` 默认把工具异常往上抛**：默认的 `_handle_tool_errors` 是
  `_default_handle_tool_errors`，它只放过 `ToolInvocationError`，其余一律重抛。
  一次网络抖动就会让整个 run 变成 internal error（实测过：
  `anyio.BrokenResourceError`）。要兜住得自己把异常转成 `ToolException`
  （langchain_core 会把它变成 `status="error"` 的 ToolMessage）
- **`MultiServerMCPClient.get_tools()` 不能整体用**：它内部是
  `asyncio.gather(*tasks)`（**没有** `return_exceptions=True`），
  一个服务器失败整批都炸。要「一个挂掉不影响其他」就得逐个服务器调
  `get_tools(server_name=...)` 自己兜
- **adapter 的 `handle_tool_errors=True` 只管 MCP 的执行错误**
  （`CallToolResult.isError=True`），**传输层失败照样抛**——
  文档里写明了："Transport/session failures ... always raise regardless of
  this setting"。adapter 0.3.2 为此留了公开的 `tool_interceptors` 扩展点
  （handler 可以重复调用），兜传输层失败和调用期重试就该在这里做
- **MCP 工具只有异步实现**：`convert_mcp_tool_to_langchain_tool` 造的
  `StructuredTool` 只填了 `coroutine`，`func` 是 None。框架的同步执行路径
  （`tool.invoke()` / `graph.invoke()`）会抛 `NotImplementedError`。
  本项目没有同步调用场景，**不补 `func`**；Agent Server 全程异步，没问题
- **`response_format="content_and_artifact"` 要求工具返回二元组**：
  langchain_core 的 `run()` 和 `arun()` 都会检查 `isinstance(response, tuple)`，
  不是二元组直接抛 ValueError。adapter 的 coroutine 本来就返回二元组
- **工具名约定会影响 agent 的行为**（实测）：项目自带的
  `.agents/skills/ecosystem-primer/SKILL.md` 里写着 MCP 工具叫
  `mcp__docs-langchain__*`。名字对不上时，agent 以为 MCP 没接上，
  转而自己拿 `execute` 去 curl MCP 端点（能 work，但绕一大圈、多烧 token）。
  改成这个约定之后，agent 直接就调了
- **公网 MCP 端点会抖，而且跟 SDK 无关**（实测）：`docs.langchain.com/mcp`
  10 次连接失败 1 次，报 `httpx.ConnectError(EndOfStream())`——**用纯 httpx
  打同一个地址也一样失败**，所以是 CDN 在 TLS 握手阶段直接掐连接。
  所以「一个服务器挂掉只少几个工具」+「加载重试」这两条容错不是锦上添花，
  是必需的
- **失败兜住之后，agent 会重试并如实告诉用户**（实测）：MCP 服务器全挂时，
  工具调用返回 `status="error"` 的 ToolMessage，agent 重试了 6 次，最后回答
  「MCP 的 reference-langchain 工具现在完全不可用：每次调用都返回
  `ExceptionGroup: unhandled errors in a TaskGroup`」。**整轮对话没有崩**
- **图是在 langgraph dev 自己的事件循环里导入的**（实测）：后端日志里加载
  MCP 工具那行是 `thread_name=uvloop_1`。所以建图时同步加载 MCP 服务器
  **不能直接 `asyncio.run`**（会抛 "cannot be called from a running event loop"），
  得检测到有循环就换线程跑
- **stdio 传输每次工具调用都重新拉起子进程**：adapter 默认无状态，
  每次调用新建一个 MCP 会话。慢，但不用管进程生死
- **`asyncio.Lock` 不能随便用来给异步加载加锁**：它会把实例绑死在第一个用到它的
  事件循环上（`asyncio.mixins._LoopBoundMixin`），langgraph dev 的运行循环不一定
  只有一个，绑死了在别的事件循环里直接抛 `RuntimeError`。
  加载本身幂等的话，不加锁最坏只是多连一次服务器
- **FastMCP 是官方 `mcp` 包自带的**（`mcp.server.fastmcp`），不用另外装
  `fastmcp`（那是另一个 PyPI 包）。`examples/mcp_stdio_server.py` 就是这么写的，
  零新依赖。`mcp` 包是 `langchain-mcp-adapters` 的依赖，跟着装上了
- **adapter 自带的 `tool_name_prefix` 拼的是 `{服务器}_{工具}`**（单下划线），
  跟项目 skill 里写的 `mcp__docs-langchain__*` 对不上，所以前缀还是得自己加。
  改 `tool.name` 是安全的：`BaseTool.__setattr__` 在 `name` 被重新赋值时会
  清掉缓存的 `tool_call_schema`（langchain_core/tools/base.py 的
  `_TOOL_CALL_SCHEMA_FIELDS`）
- **可以原地改 adapter 的工具，不用重建 `StructuredTool`**：重建会把 adapter
  已经配好的 `handle_tool_error` 丢掉——那个 handler 负责让 MCP 自己报的错
  （`isError=True`）保留图片等内容块，不该被拍平成一句话。本项目只改 `name`
- **子 agent 默认继承 MCP 工具，但只读子 agent 不能继承**（实测 + 收紧）：
  deepagents `graph.py` 里 `raw_subagent_tools = spec.get("tools") if "tools" in spec else tools`，
  `conf/subagents.toml` 里的子 agent 没写 `tools` 就继承主 agent 的。
  实测 general-purpose 子 agent 调通了 `mcp__demo__echo`，返回 `echo: sub-agent-test`。
  **但声明了 `permissions` 的 `reviewer` 必须例外**：它的只读靠无 shell 的
  `FilesystemBackend` 保证，MCP 工具不经过那层——`apply_subagent_policies()`（`graph/subagent_policy.py`）
  会把这类子 agent 的 `tools` 置空。另外子 agent 自己写 `interrupt_on` 会**整体
  替换**父级的（`fixer` 因此丢了 `execute` 的确认），这个函数也做了合并
- **调用期失败由 `tool_interceptors` 兜底**（实测）：拦截器重试一次后返回
  `CallToolResult(isError=True)`，adapter 转成 `status="error"` 的 ToolMessage。
  实测把加载成功的 stdio 脚本删掉再调工具，`ainvoke` 返回的是
  `ToolMessage(status="error")`，内容里有工具名、服务器名和根因（`McpError: Connection closed`），
  整轮 run 不会崩。**超时不重试**（`httpx.TimeoutException` / `TimeoutError`
  直接失败）：时间预算已经烧掉了，再等一次只会更慢
- **stdio 传输端到端跑通**（实测）：`conf/mcp.json` 里配一个 stdio 服务器
  （`command` + `args` 指到 `examples/mcp_stdio_server.py`），重启后端后
  agent 调 `mcp__demo__echo` 返回 `echo: hello-stdio`。http 和 stdio 是两条
  不同的路径（一个走 streamable-http，一个拉起子进程走 stdin/stdout），
  http 通了不代表 stdio 通了
- **早先那版的「限时」是假的**（实测后改的）：当时只在两次重试之间看时间戳，
  一个挂死的服务器（`command` 指到一个 `time.sleep(999)` 的脚本）照样能把
  加载拖住。现在用 `asyncio.wait_for` 真的掐断——挂死服务器实测被 12 秒
  **总预算**掐掉、只少它自己的工具，其余照常。**超时不再重试**：
  早先超时也进重试循环，1 秒预算实测跑出 3.31 秒（3 次尝试）
- **anyio 的 TaskGroup 会把真实异常包进 `ExceptionGroup`**：直接打印只看得到
  「unhandled errors in a TaskGroup (1 sub-exception)」，看不出是网络问题、
  超时还是 401。要一层层剥到最里层，日志里才看得到
  `ConnectError: All connection attempts failed`
- **pydantic 的宽松模式会悄悄改类型**：`timeout: true` → 1.0（= 1 秒超时！）、
  `timeout: "8"` → 8.0。两种都不是用户想写的意思，得在 `mode="before"` 拦下来
- **服务器并行加载，总耗时 ≈ 单个服务器的预算**（不是各预算之和），
  所以「配了十个服务器九个全挂」也不会把启动拖过 launcher 的 60 秒就绪超时。
  注意 12 秒是**含重试的总预算**，不是每次尝试的预算
- **配置校验要逐个服务器做**（实测踩到）：一把梭抛错会让**整个 MCP 都没了**——
  连能用的那几个服务器也一起废掉，界面上完全看不出来。真实配置里带
  `description` 字段（Claude Desktop / VS Code 那种格式常见）就能触发。
  现在改成逐个服务器校验，写错的只跳它自己；`description` 也认了（认了但忽略）
- **npx 起的 MCP 服务器也能用**（实测）：`npx -y @modelcontextprotocol/server-memory`
  这种首次要现下载包的，第一次加载会慢一点（在 12 秒预算内没超），之后走缓存很快。
  实测 agent 调通了 `mcp__memory__create_entities` / `mcp__memory__create_relations`。
  **冷缓存 + 慢网络仍可能超过 12 秒预算**——那台服务器就等下次重启，这是有意的取舍
- **`conf/mcp.json` 不入库**（013 期收尾）：仓库只提供 `conf/mcp.example.json`
  （两个只读公网服务器）。它是机器相关的；更重要的是**配 MCP 等于引入一段启动时
  执行的第三方代码**（stdio 的 `command` 在建图时直接拉起），服务器给的工具有
  副作用、工具描述会进模型上下文。`.gitignore` 和 `.dockerignore` 都已排除它

---

### 8.9 工作空间（2026-10-25 对真实服务实测）

- **`configurable.workspace` 真的决定文件落点**：`write_file("/hello.txt")`
  落在该目录；`execute` 的 `pwd` 也是该目录 ✔
- **`.scode-memory.md` 跟着工作空间走，但不会自动创建**：agent 真的保存记忆时
  才在对应目录里出现 ✔（每个项目一份记忆——不同项目的约定不该混在一起）
- **不传 workspace → 落在 `Path.cwd()`**（后端默认工作空间）✔
- **传了不存在的目录**：不会静默换到默认目录。`execute` 返回
  `Error executing command (WorkspaceError): 工作空间不存在：/definitely/not/here`
  ——注意这个措辞来自框架：`LocalShellBackend.execute` 有个宽泛的
  `except Exception`，把异常转成了命令错误输出（退出码 1）而不是抛出去 ✔
- **中间件在开跑前就拦住坏工作空间**：不用等 agent 真的写文件才炸 ✔
- **系统提示词里带上了工作空间绝对路径**（`WorkspaceMiddleware` 追加一段）✔
- **`POST /workspaces/pick` 三条分支都对**：选中了 / 取消了 / 弹不出来（503）✔
- **macOS 上 `osascript` 真的弹出了系统目录选择框**（阻塞到被信号杀掉，
  后端日志里能看到 `POST /workspaces/pick 503 60032ms`）✔
- **blockbuster 会拦事件循环里的同步 FS 调用**：报
  `BlockingError: Blocking call to os.readlink`（`Path.resolve()` 展开软链时），
  报错行是 `During task with name 'WorkspaceMiddleware.before_agent'`。
  **凡是路径解析、stat、建文件，都得 `asyncio.to_thread`** ✔
- **GET 打 POST-only 的自定义路由会拿到 404 而不是 405**：langgraph 的兜底
  Mount（`Mount("")`）会把"路径匹配但方法不匹配"吃掉。排查自定义端点时别被
  404 误导，先确认方法对不对 ✔
- **`POSIX path of` 转出来的目录路径带结尾斜杠**（"/private/tmp/"），
  后端统一去掉了（根目录除外）✔
- **模型把绝对路径传给文件工具时，文件会落到 `<工作空间>/<绝对路径>` 的嵌套
  目录里**（框架 `virtual_mode` 的语义，绝对路径也按虚拟路径处理），而且
  **不报错**。实测模型调 `write_file("/private/var/.../hello.txt")`，文件跑到了
  工作空间里的 `private/var/.../`。现在 `_resolve_path()` 会先剥掉工作空间
  前缀，两种写法指向同一个文件 ✔

### 8.10 agent 自己的中间产物（016 期）

**产物落点**

- **`CompositeBackend.artifacts_root` 是唯一的开关**，同时决定三类产物的路径前缀：
  `FilesystemMiddleware` 和 `SummarizationMiddleware` 都从它读
  （`isinstance(backend, CompositeBackend)` 才认，否则退回 `/`）。
- 本项目设成 `/.scode`，实测三类前缀分别是 `/.scode/large_tool_results`、
  `/.scode/conversation_history`、`/.scode/blobs` ✔
- eviction 的落盘发生在**工具执行之后**：结果超过
  `tool_token_limit_before_evict`（默认 20000 tokens）就写进
  `large_tool_results/<tool_call_id>`，工具消息换成
  「Tool result too large, the result of this tool call c1 was saved in the
  filesystem at this path: /.scode/large_tool_results/c1」 ✔
- 实测 120000 字节的工具结果 → `<工作空间>/.scode/large_tool_results/c1`
  （120000 字节）落盘，`<工作空间>/large_tool_results/` 不存在，工作空间根目录
  只多出 `.scode` 一个条目 ✔
- **agent 能把落盘的结果读回来**：下一轮 `read_file("/.scode/large_tool_results/c1")`
  读到了内容（会被 read_file 自己的输出上限截断，但路径是通的）✔
- 对话历史：`SummarizationMiddleware._get_history_path()` 给出
  `/.scode/conversation_history/<session_id>.md`，按这个路径写就落在
  `<工作空间>/.scode/conversation_history/` ✔
- **`blobs/` 默认不生成**：二进制内容块要开 `offload_binary_content` 才有 ✔

**受限子 agent**

- 换成 `CompositeBackend`（没有路由）之后，**只读权限照样拦得住**：实测
  `write_file("/evil.txt")` 返回 `Error: permission denied for write on /evil.txt`，
  文件没被写出来 ✔
- 框架的权限判定路径（`deepagents/middleware/filesystem.py` 的
  `_resolve_real_path()`）显式认 `CompositeBackend`——先路由再解析软链——
  所以套一层 composite 不影响 `interrupt_on` 谓词的软链解析 ✔

**一个容易踩的点**

- `artifacts_root` **必须留在工作空间里**：工具消息让 agent `read_file` 那个路径，
  出了 `virtual_mode` 的边界就读不回来，eviction 会退化成「存了但读不到」。
- 产物路径是**虚拟路径**（以 `/` 开头，相对工作空间根），不是宿主绝对路径。
  宿主绝对路径会走 `graph/backend.py` 的 `_workspace_relative()` 剥前缀。

### 8.11 用户级记忆与记忆面板（017 期）

**两个作用域**

- **两份记忆都进了系统提示词**，顺序是**用户级在前、项目级在后** ✔
- **agent 能用同一个 `write_file` 工具写两份**：
  `write_file("/user-memory/memory.md", ...)` 写到 `~/.scode/memory.md`，
  `write_file("/.scode-memory.md", ...)` 写到 `<工作空间>/.scode-memory.md` ✔
- **写用户级记忆不会在工作空间里多出 `user-memory/` 目录** ✔（路由生效了，
  文件真的落在 `~/.scode/` 下）
- **换工作空间，项目级记忆跟着换**（用户级不变）✔
- **`ls("/")` 会多出一个挂载点**：框架的「Shell paths vs. virtual paths」段里
  会出现 `- /user-memory/ -> /Users/1token/.scode/`——**把真实宿主路径暴露给
  模型**了。这是框架自己的路由说明格式（route 有宿主目录就会列出来），不是 bug，
  但要知道模型看得见这个路径 ✔
- **两份都不自动创建**：`~/.scode/` 目录也是 agent 第一次写的时候才出现 ✔

**记忆块的位置**

- 记忆块在系统提示词的**最后一块** ✔
- prompt-caching 的断点 `cache_control={'type': 'ephemeral', 'ttl': '5m'}` 落在
  **最后一块**（也就是记忆块）✔ —— 记忆内容变了也不会把整个前缀缓存打穿
- ⚠️ **这个断点只对 `ChatAnthropic` 生效**。`conf/config.toml` 现在是
  `protocol = "anthropic"`，所以有效；**切成 openai 协议会静默失效**（框架的
  `add_cache_control` 只在 anthropic 协议下挂得上）

**接口**

- `GET /admin/memory?workspace=<绝对路径>` → 两份记忆的内容、路径、是否存在 ✔
  - `workspace` 可以不给 → 用后端默认工作空间
  - 返回的 `workspace` 是**软链展开后**的（macOS 上 `/tmp/x` → `/private/tmp/x`），
    跟 agent 看到的工作空间是同一个
  - 文件不存在不是错误：`exists: false` + 空内容
- `PUT /admin/memory` body `{scope, content, workspace}` → 写一份 ✔
  - `scope` 只能是 `user` / `project`，别的值 400
  - `content` 必须是字符串，别的类型 400
  - **写空字符串 = 清空文件**（文件留在原地）
  - 父目录不存在会建（`~/.scode/` 平时是空的）
- **工作空间不合法 → 400**，消息是 `工作空间不存在：/definitely/not/here` ✔
- **所有文件系统操作都走了 `asyncio.to_thread`**（blockbuster 会拦事件循环里的
  同步 FS）✔

**前端（真实浏览器实测）**

- 输入区「记忆」按钮 → 面板正常渲染：用户级 / 项目级两段、各自的路径、
  两个 textarea、各自的保存按钮、底部的「会话开始时读一次」提示 ✔
- 填入项目级内容点保存 → 磁盘上 `<workspace>/.scode-memory.md` 内容正确 ✔，
  `~/.scode/memory.md` 也正确 ✔，「已保存」提示出现 ✔
- **真实图（真模型 + 真 backend）里记忆块同时含两份内容** ✔

**写记忆走人工确认（017 期追加）**

- **`normal` 档写记忆 → 挂起**，待确认的是 `write_file` ✔，
  `allowed_decisions` 是 `approve` / `reject` ✔，卡片说明带了作用域、影响范围
  和内容预览 ✔
- **`normal` 档写普通文件 → 不挂起**，文件真的写了 ✔（写代码不受影响）
- **`auto` 档写记忆 → 不挂起**，文件写了 ✔
- **`manual` 档写记忆 → 挂起** ✔
- **恢复时把档位故意翻成 `auto` → 被拒绝的写入仍然没有执行** ✔
  （谓词读的是 state 里记的那一档，不是客户端回传的值）
- **`edit_file` 写记忆 → 挂起**，内容没变 ✔
- **绝对路径写记忆 → 挂起** ✔
- **用户级记忆（`/user-memory/memory.md`）→ 挂起**，卡片说明标了「用户级」 ✔
- **批准后真的落盘**，内容对得上 ✔
- **子 agent 继承**：声明式子 agent（`reviewer` / `summarizer`）继承了父级的
  记忆规则（带 `when` 谓词，只拦记忆文件）✔；`fixer` 自己声明了
  `write_file` 的确认规则（无 `when`）→ **每条写文件都拦**，比父级更严格 ✔；
  `reviewer` 是只读的（backend 层 deny），写不了记忆 ✔
- **framework 自带的 general-purpose 子 agent 也继承顶层 `interrupt_on`**
  （deepagents `graph.py` 里 `_merge_fs_interrupt_on(fs, interrupt_on)`）✔
  ——但它**没有**我们的 `PermissionLevelMiddleware`（继承靠 `.name` 匹配，
  我们那个名字不在它的默认栈里），所以它的档位来自 `configurable`，见已知缺口

### 8.12 skill（018 期）

**两个作用域的发现**

- 全局（`$SCODE_HOME/.agents/skills/`）与项目级（`<工作空间>/.agents/skills/`）
  都被发现，描述都进了系统提示词的 skill 列表 ✔
- **同名时项目级覆盖全局**（框架按源顺序读，后面的覆盖前面的）✔
- **全局 skill 跨工作空间可见**，项目级 skill 跟着工作空间换 ✔
- 换工作空间会**重读** skill 列表（新 skill 出现、旧 skill 消失、全局 skill 保留）✔
- 工作空间里没有 `.agents/` 时，**提示词里不出现 `path_not_found` 警告** ✔
  （框架自己打的日志 warning 仍在，见已知缺口）

**skill 块的位置**

- 系统提示词里**只有一块** skill 列表（我们的中间件顶掉了框架自带那份，没有两块）✔
- **顶掉靠 `.name` 报成框架自带那一份的公开别名**（`SkillsMiddleware.__name__`）——
  **从框架那里问出来，不写死字面量**：框架升级改了公开别名，写死的字符串就对不上 →
  静默变成两份 skill 中间件同时跑 ✔
- **skill 块排在记忆块之前**——记忆块仍在最后一块，prompt-caching 的断点落在
  记忆块上，前面的块（含 skill 块）全在缓存前缀里 ✔
  （这靠「不给 `create_deep_agent(skills=...)`」实现，见 `graph/agent.py` 的注释）

**pin（勾选的 skill 钉进上下文）**

- 勾选的项目级 skill，正文作为一条 `HumanMessage` 进对话历史 ✔
- 勾选的全局 skill 同样能钉 ✔（路径是虚拟的 `/user-skills/<name>/SKILL.md`）
- **没勾选的不会进** ✔
- **第二轮不重复 pin**：同一个 thread 里正文只出现 1 次 ✔
  **pin 只在"选择变了"时做**——pin 的消息会进对话历史、之后每轮都跟着重发，
  每轮都 pin 会把上下文撑爆
- **取消勾选不会把已钉进去的内容拿掉**（框架语义是追加，见已知缺口）

**agent 自主读取（渐进式披露）**

- `read_file("/user-skills/<name>/SKILL.md")` → 读到全局 skill 全文 ✔
- `read_file("/.agents/skills/<name>/SKILL.md")` → 读到项目级 skill 全文 ✔
- 读不存在的 → 报错（`Error: File '.../SKILL.md' not found`），不静默 ✔

**接口**

- `GET /admin/skills?workspace=<绝对路径>` → `{workspace, skills:[{name, description, scope, source, path}]}` ✔
  - `workspace` 可以不给 → 用后端默认工作空间
  - `scope` 是 `user`（全局）/ `project`（项目级）
  - `path` 是**虚拟路径**（`/user-skills/...` 或 `/.agents/skills/...`），不是宿主绝对路径
  - 工作空间不合法 → 400
  - ⚠️ **backend 的构造必须走 `asyncio.to_thread`**：`FilesystemBackend.__init__` 里有
    `Path(root_dir).resolve()`，在事件循环里直接调会被 blockbuster 拦下来
    （`BlockingError: Blocking call to os.readlink`），整个请求 500

**前端（真实浏览器实测）**

- 输入框敲 `/` → 菜单里**混排**命令和 skill ✔
- skill 行标了作用域（**全局** / **项目**）✔
- 勾选后输入框上方出现 chip（带 × 删除），**输入框清空、菜单关闭** ✔
- 已勾选的 skill 在菜单里标「已选」✔
- **支持多选**：连着勾两个，chip 并排显示 ✔
- **键盘可用**：↑↓ 移动高亮、回车选中、Esc 关闭 ✔
- 勾选 skill **不发送消息**（skill 不是命令）✔
- **勾选的 skill 真的随请求发给了后端**：thread 的 `metadata.skills` 是
  `["hello-global", "hello-project"]` ✔
- **对话历史里两个 skill 的全文都在**，模型明确回复「已按两个 skill 的指示执行」✔

---

## 9. 常见问题

**改了后端代码没生效**
`scode` 固定传 `--no-reload`，改代码要重启 scode。

**前端连的是旧服务 / "改了没生效"**
端口被占时 launcher 现在会**直接启动失败**并告诉你怎么查占用进程。查：

```bash
lsof -nP -iTCP:2024 -sTCP:LISTEN
pkill -f "langgraph_cli dev"
```

**启动报"找不到模块"**
`langgraph.json` 里的路径和实际文件位置对不上。挪文件必须同步改它。

**启动报 `ConfigError: 找不到 conf/config.toml`**
`config/` 下模块的 `parents[2]` 层数错了。`config/model.py` 往上两级才是项目根。

**对话历史没了**
`graph/persistence.py` 的 `data` 路径算错，SQLite 落到了别处。检查 `p.DB_PATH`。

**会话列表空了**
跟对话历史是两回事：thread 索引在工作空间的 `.langgraph_api/` 里。**别删那个目录。**

**工作空间选择器点不动 / 报 503**
后端在无图形界面的环境里（Docker、纯 SSH）弹不出系统目录选择框。用下拉里的
「手动输入绝对路径」。若连按钮都没反应，看别的窗口——macOS 上那个目录选择框是
**独立窗口**，不在浏览器里，容易被挡住。

**agent 的写操作落在别的目录**
工作空间是**按消息**生效的：改选择器不影响已经跑完的那一轮，下一条消息才用
新的。另外确认前端确实把 `configurable.workspace` 发过去了（工作空间为空 =
用后端默认工作空间）。后端日志里可以看这一轮解析到的工作空间。

刷新页面后前端会从 thread 的 `metadata.workspace` 回填；审批卡片挂着时两个
选择器禁用（避免恢复时带着改过的目录/档位）。如果回填后还是空的，检查发消息
时那次 `PATCH /threads/{id}` 是否失败（失败会被静默吞掉，不影响对话）。

**文件跑到了工作空间里的奇怪嵌套目录里**
比如 `<工作空间>/private/var/folders/.../x.txt`。这是模型把**绝对路径**传给了
文件工具，而框架的 `virtual_mode` 把绝对路径当虚拟路径处理（014 期已修：
`_resolve_path()` 会剥掉工作空间前缀）。

**这一轮直接报「工作空间不存在：xxx」**
前端选的目录被删了，或者不是目录。**不会**静默退回默认目录（那等于把代码写
到用户没选过的目录里）。重新选一个就行。

**改了记忆文件，agent 还是读旧的**
记忆是**会话开始时读一次**的（框架机制：记忆块要参与 prompt 缓存）。改了
`.scode-memory.md` 或 `~/.scode/memory.md` 之后，当前会话里的 agent 读到的还是
旧内容——**开一个新会话**才会重读。前端记忆面板里改完也一样（面板底部写了
这句话）。换工作空间会重读（`WorkspaceMemoryMiddleware` 把 `memory_contents`
摘掉逼框架重读），但同一个工作空间内不会。

**agent 写了错误的记忆**
按严重程度分三种处理：

| 情况 | 怎么办 |
|---|---|
| 当前会话里刚写错 | 直接告诉 agent「那条记忆是错的」——对话历史里说，本会话有效。但**文件里那条还在**，下个会话又冒出来，还得改文件 |
| 知道是哪一条 | 前端「记忆」按钮 → 删掉那一行 → 保存（**要开新会话**） |
| 不知道哪条错了 | `: > ~/.scode/memory.md`（或项目级那个）整体清空。实测清空和删文件对注入效果完全等价 |

017 期起 **agent 写记忆本身就要人工确认**（`normal` 和 `manual` 档），所以上面
这些是兜底，不是常态。

**斜杠菜单里没有 skill / 勾了没生效**

按这个顺序查：

1. `GET /admin/skills?workspace=<工作空间>` 返回空 → 那个目录下没有 `SKILL.md`。
   **全局的看 `~/.scode/.agents/skills/`（或 `$SCODE_HOME`），项目级的看
   `<工作空间>/.agents/skills/`**——目录名是 `.agents`，不是 `.skills`。
2. 接口有但菜单里没有 → 前端的工作空间和接口用的不是同一个。菜单跟着**当前任务**
   的工作空间走，换了工作空间要重新取。
3. 勾了但 agent 没用 → 勾选的是「**钉进上下文**」，不是「只允许用这些」。
   没勾的 skill 也在系统提示词的列表里，agent 自己决定要不要 `read_file`。
4. agent 明明该读却没读 → 让它用 `read_file` 读**列表里给的路径**，并且带
   `limit=1000`（默认 100 行太小，多数 `SKILL.md` 都超）。

**agent 看不到 MCP 工具 / 工具没挂上**
按这个顺序查：

1. 后端日志里有没有「MCP 工具已加载：N 个」。没有这一行 = `conf/mcp.json`
   没被读到（文件不存在、或 JSON 语法错误）。
2. 有「MCP 配置不合法」= 配置写错了。错误信息会指出是哪个服务器的哪个字段
   （比如 `type 'stio' 不支持`——手误）。
3. 有「MCP 服务器 'xxx' 连不上」= 那个服务器挂了，其余服务器的工具有效。
   **它不会自动恢复**，要等下次重启（静态注册的代价）。
4. 工具挂上了但 agent 不调 = 看模型有没有别的更顺手的选择；
   直接点名工具名（`mcp__docs-langchain__search_docs_by_lang_chain`）更稳。

**改了 `conf/mcp.json` 没反应**
改完要**重启 `scode`**（工具是建图时静态注册的）。确认改的是**项目根的
`conf/mcp.json`**（不是工作空间里的同名文件），而且 JSON 语法没错。
仓库里没有这个文件时，先从 `conf/mcp.example.json` 复制。

**MCP 工具调用报 "调用失败"**
那不是崩溃，是 `tool_interceptors` 把传输层的失败兜成了 `status="error"` 的
ToolMessage（框架默认会把工具异常直接抛上去，一次网络抖动就让整个 run
变成 internal error）。错误文本里有工具名、服务器名和根因。
模型看到的是「这个工具没调通」，可以换个工具重试——实测过：agent 会重试几次，
最后如实告诉用户「这个 MCP 服务器现在完全不可用」。

**本地脚本 `graph.invoke()` 调 MCP 工具报 `NotImplementedError`**
预期行为：adapter 只提供异步实现，本项目不补同步壳。用 `await graph.ainvoke(...)`
或让 Agent Server 执行。

**启动时打印「工作空间就是后端仓库本身」**
agent 能写 `conf/mcp.json` 和后端源码，这些会在下次启动时执行。按提示用
`SCODE_WORKSPACE=/path/to/project` 指向单独的项目目录。

**前端不弹确认卡片，但命令执行了**
先看档位：是不是传了 `auto`。`auto` 档就是全部放行。

**前端弹了卡片，但点了没反应**
看控制台有没有 422/500。常见原因是 `decisions` 的个数和 `action_requests` 对不上。

**批准后命令还是被拦**
恢复请求里没原样带回档位，或者档位在两次请求之间变了。

**模型自己在对话里问了，没调工具**
这不是拦截，是提示词在起作用。要验证拦截本身，用一条模型不会犹豫的命令
（`manual` 档下 `echo hello` 就够）。

**危险命令没被拦（`normal` 档）**
正常：危险判定是**正则匹配**，命令写法一变就可能匹配不上。宁可漏拦也不误拦。

**shell 里 `python` / `uv` 找不到**
`inherit_env` 没开。

**`execute` 工具调了没反应 / 报 "Execution not available"**
`supports_execution()` 对 CompositeBackend 检查的是 **default** backend，不是 routes。

**建图时报 `NotImplementedError: FilesystemMiddleware does not yet support
permissions with backends that provide command execution`**
有子 agent 声明了 `permissions`，而它的 backend 带 shell。看
`graph/subagent_policy.py` 的 `apply_subagent_policies()`——正常路径下 `permissions`
会被摘出来换成无 shell 的中间件。出现这个报错说明有子 agent 绕过了那层处理。

**`task` 工具里只有 `general-purpose`**
要么 `conf/subagents.toml` 不存在（那就该是这样），要么服务没重启。

**主 agent 老是派给 `general-purpose` 不派给你的子 agent**
`description` 写得不够具体。主 agent 是靠 `description` 判断该派给谁的。

**子 agent 写文件没落磁盘**
如果该子 agent 声明了 `permissions`，它用的是 `FilesystemBackend(root_dir=工作空间)`，
文件操作**仍然落真实磁盘**；只是没有 `execute` 工具。没声明 permissions 的子 agent
拿的是主 agent 那套带 shell 的 backend。

---

## 10. 下一期文档怎么写

**不再按期新开文件**，直接续写本文：

| 新内容 | 写到哪 |
|---|---|
| 新能力的目标 / 取舍 / 实现 | §3 加一节，或往对应期里补 |
| 实测出来的事实 | §8 对应小节 |
| 新发现的坑 | §9 常见问题 |
| 还没做的 | §6 已知缺口 |

结构照旧（AGENTS.md 要求的那套）：

**目标 / 成功标准 / 本期不做 / 关键取舍 / 验证步骤（带 curl）/ 常见问题 / 已验证的事实**

最后一节最重要——**把踩过的坑固化下来**，别让下一个人重新踩。

---

## 11. 相关文档

| 文档 | 内容 |
|---|---|
| [`docs/overall-design.md`](../overall-design.md) | 目标架构、前后端契约、安全设计 |
| [`docs/frontend-design.md`](../frontend-design.md) | 前端交互设计 |
| [`docs/learning-path.md`](../learning-path.md) | 框架背景与学习路线 |
| [`stupid_code/API.md`](../../stupid_code/API.md) | 当前实际可用的 HTTP 端点清单（含实测记录） |
| [`stupid_code/README.md`](../../stupid_code/README.md) | 后端启动说明 |
| [`AGENTS.md`](../../AGENTS.md) | 写代码前必看的坑位清单 |
| [`README.md`](../../README.md) | 面向人的项目说明：这是什么 / 怎么跑 / 注意事项 |
