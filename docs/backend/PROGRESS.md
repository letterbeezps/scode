# 后端进度快照（001–012 合并版）

> **这份文档是什么**：项目后端从第 001 期到第 012 期的**进度快照**。
> 它把原先散在 `001_*.md` ~ `009_*.md` 九份阶段文档里的内容合并成一份，
> 回答三个问题：**现在做到了哪一步 / 为什么这么做 / 接下来还欠什么**。
>
> - 快照时间：2026-10-25，代码基线 `c184207`
> - 后端：`stupid_code/`（Python 1798 行）　前端：`web/`（TS/TSX 5920 行）
> - 依赖版本：`deepagents 0.7.28` / `langchain 1.4.6` / `langgraph 1.2.16` /
>   `langgraph-cli 0.4.36` / `langchain-anthropic 1.7.6` / `langchain-openai 1.7.2`
> - **以代码为准**。本文记录的是当前实现的实际形态，不是设计意图。
>   目标架构见 [`docs/overall-design.md`](../overall-design.md)，
>   前后端 HTTP 契约见 [`stupid_code/API.md`](../../stupid_code/API.md)。
>
> 写新一期文档时照 §10 的结构来，别再按期新开文件——直接续写本文的对应章节。

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
| 006 | agent 长期记忆（`.scode-memory.md`） | ✅ 已落地 | `stupid_code/graph/memory.py` |
| 007 | 真实 backend（磁盘 + shell） | ✅ 已落地 | `stupid_code/graph/backend.py` |
| 008 | launcher 端口锁定与关停 | ✅ 已落地 | `stupid_code/launcher.py` |
| 009 | shell 人工确认（HITL） | ✅ 已落地 | `stupid_code/graph/permissions.py` + 前端 `ApprovalCard.tsx` |
| 010 | 运行期切换对话模型 | ✅ 已落地 | `stupid_code/graph/model_switch.py` + 前端侧边栏模型下拉框 |
| 011 | 手动压缩对话历史（`/compaction`） | ✅ 已落地 | `stupid_code/graph/compaction.py` + 前端斜杠命令菜单 |
| 012 | Docker 运行（后端 + 前端） | ✅ 已落地 | `Dockerfile` + `web/Dockerfile` + `docker-compose.yml` |

### 1.3 前端完成度

按 [`docs/frontend-design.md`](../frontend-design.md) 实现，**功能上已完成**：

- 会话列表 / 建会话 / 删会话 / 标题（存平台的 `metadata.title`）
- 流式对话、工具调用可视化、Diff 渲染、Todo 同步
- 工作空间选择器（文件夹浏览器）　⚠️ 后端 `/directories` 未实现，真后端下报错属预期
- 权限档位选择器（`manual` / `normal` / `auto`）
- 人工确认卡片（显示命令 + 为什么被拦，批准 / 拒绝）
- 模型管理界面（直连 `/admin/models`）
- **对话模型切换**（侧边栏下拉框，选中即生效，不用重启后端——010 期）
- **斜杠命令菜单**（输入 `/` 弹列表，`/compaction` 手动压缩对话历史——011 期）
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
│   │   ├── compaction.py       # /compaction 手动压缩 + 摘要用当前模型
│   │   ├── memory.py           # 长期记忆中间件
│   │   ├── model_switch.py     # 运行期切换对话模型的中间件
│   │   ├── permissions.py      # 人工确认的档位与危险判定
│   │   └── persistence.py      # SQLite 工厂：checkpoint/store → ../data/langgraph.db
│   ├── config/
│   │   ├── model.py            # conf/config.toml → 模型实例 + CRUD
│   │   ├── subagent.py         # conf/subagents.toml → SubAgent 规格
│   │   └── prompts.py          # 主 agent 的系统提示词
│   ├── admin/
│   │   ├── app.py              # Starlette 子应用与路由表
│   │   └── models.py           # /admin/models 五个端点
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

### 006 · agent 长期记忆（`.scode-memory.md`）

**做了什么**：每次新会话开始时，把工作空间根的 `.scode-memory.md` 读进系统提示词；
文件不存在就自动创建一份带模板的。

**关键取舍**

- **用 `middleware=` 挂 `MemoryMiddleware`，别用 `create_deep_agent(memory=...)`**。
  两者是同一个中间件，但 `memory=` 只能用框架默认的 backend——默认是 StateBackend
  （虚拟文件系统），**读不到磁盘上的文件**。自己挂才能给 `FilesystemBackend`。
- **记忆只在会话开始时读一次**。`MemoryMiddleware.before_agent` 见到 state 里已有
  `memory_contents` 就不重复读——这是框架的设计（记忆块要参与 prompt 缓存）。
  代价是**改完 `.scode-memory.md` 要开新会话才生效**。
- **没有 `.scode-memory.md` 就创建**，而不是静默跳过。框架遇到读不到的文件会 `continue`
  跳过（不报错），那样用户根本不知道记忆为什么是空的。
- **记忆文件叫 `.scode-memory.md`，不用框架默认的 `AGENTS.md`**。后者是
  "写给编码 agent 看的项目约定"（本项目根目录那份就是），和"agent 自己攒的长期记忆"
  是两回事。工作空间正好是项目根时，沿用默认名会把开发者的项目说明当记忆注入。
- **工作空间 = `Path.cwd()`**：launcher 把 langgraph 子进程的 cwd 设成用户工作空间，
  graph 也在那个进程里导入。

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
    routes={"/tmp/": StateBackend()},   # 临时区走虚拟 FS，不落盘
)
```

**关键取舍**

- **用 `CompositeBackend` 包一层，而不是直接用 `LocalShellBackend`**：把"哪部分路径
  走哪种存储"变成配置而不是散落在代码里。以后要加"某个目录走 langgraph store 跨会话
  持久化"之类的规则，加一条 route 就行。
- **`/tmp/` 路由到 `StateBackend`**：会话内的临时区，agent 的临时产物不该在用户磁盘上
  留垃圾。框架会自动为 CompositeBackend 生成一段"虚拟路径 ↔ shell 路径"的提示，
  `/tmp/` 会被标成"shell 访问不到，只能用文件工具"。
- **`inherit_env=True`**：`LocalShellBackend` 默认 `inherit_env=False`，shell 拿到的是
  **空环境**——PATH 是空的，`uv` / `python` / `node` 全都找不到。
- **声明了 `permissions` 的子 agent 要换一套 backend**。框架有条硬限制：backend
  支持命令执行时，`FilesystemMiddleware` 不接受 `permissions`，直接抛
  `NotImplementedError`。理由站得住——`execute` 能用 shell 绕过任何文件权限
  （`echo x > file`）。处理办法：给这类子 agent 单独一个**没有 shell** 的
  `FilesystemBackend`（真实磁盘，路径同样锁在工作空间内），权限就真的拦得住。
  实现见 `graph/backend.py` 的 `apply_permission_backend()`。
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
| `manual` | **每一条**执行命令都确认 |
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

- **只拦 `execute`**。框架有条硬限制：backend 支持命令执行时 `FilesystemMiddleware`
  不接受 `permissions`（抛 `NotImplementedError`），所以文件权限和 shell 不能共存。
  本期绕开这个矛盾：只拦 shell，文件工具靠真实磁盘 + 提示词，不做工具层强制。
- **危险判定用固定正则，不用 AI**。原设想 `normal` 档由 AI 判断这次操作是否危险：
  AI 审核要额外一次模型调用，判断标准也没法复现，出了问题说不清是谁该负责。
  改成固定规则——命中就是命中，不命中就不命中，行为可预期。**代价是宁可漏拦也不误拦**
  （`rm --recursive --force` 这类等价写法匹配不上）。
- **档位必须原样带回去**：后端的拦截判定在**恢复时会再跑一次**，档位变了结论就变
  （批准后变成"还要拦"，就永远批不掉了）。
- **子 agent 默认继承顶层 `interrupt_on`**（deepagents 的合并规则：
  `spec.get("interrupt_on", interrupt_on)`）。所以没声明 `permissions` 的子 agent
  （如 `fixer`）执行命令也会走 HITL；声明了 `permissions` 的子 agent（`reviewer`）
  被换成无 shell 的 backend，压根没有 `execute` 工具，不受影响。

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
| 子 agent 不跟着换 | 子 agent 用哪个模型是**配置**出来的（`conf/subagents.toml`），切换只影响主对话 |
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

---

## 4. 关键机制速查

### 4.1 图的构建（`graph/agent.py`）

```python
backend = build_backend()
default_model = load_model()
compaction = build_compaction_middleware(default_model, backend)

graph = create_deep_agent(
    model=default_model,
    system_prompt=SYSTEM_PROMPT,
    subagents=[apply_permission_backend(spec) for spec in load_subagents()],
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
| `workspace` | `WORKSPACE_KEY` | 工作空间绝对路径 | ⚠️ **后端还没在工具入口读它**，目前只是透传 |
| `permissions` | `PERMISSIONS_KEY` | 确认档位 manual/normal/auto | ✅ 已实现（`graph/permissions.py`） |
| `model` | `MODEL_KEY`（`web/src/lib/model.ts`） | 对话模型 id `供应商名:模型名` | ✅ 已实现（`graph/model_switch.py`） |

`workspace` / `permissions` **按 `threadId` 存而非全局**——同任务内前后两条消息可能针对
不同目录。另有 `draft` 副本供新任务用，`createThread()` 时 `adoptDraft()` 固化并重置。

`model` 是**全局偏好**（localStorage），每次运行都随请求带过去，所以刷新页面、
后端重启都还在。**恢复挂起的运行时也要原样带回去**：恢复时后端同样按
`configurable.model` 换模型，带空了就退回默认模型，跟批准前用的不是同一个模型。

### 4.5 端点速查

平台内置（`langgraph dev` 直接提供）：`/ok`、`/assistants/search`、
`/assistants/{id}/graph`、`/threads`、`/threads/search`、`/threads/{id}`（GET/PATCH/DELETE）、
`/threads/{id}/state`、`/threads/{id}/runs/stream`、`/threads/{id}/runs/{runId}/cancel`。

自定义：`/admin/models` 五个端点。

**未实现**：`GET /directories`——工作空间选择器在真后端下报 404 属预期。

完整清单与请求/响应示例见 [`stupid_code/API.md`](../../stupid_code/API.md)。

---

## 5. 安全姿态

| 边界 | 现状 |
|---|---|
| 监听地址 | **只监听 `127.0.0.1`**。绝不要绑 `0.0.0.0` |
| API key | 只走 `conf/config.toml`（gitignore），不进 `.env`、不入库 |
| shell 执行 | 有人工确认关卡（009），`normal` 档只拦命中危险模式的命令 |
| 文件写入 | **不拦**（`write_file`/`edit_file`/`delete`）——那是 code agent 的日常 |
| 文件路径 | 文件工具锁在工作空间内（`virtual_mode=True`），**shell 不受此限** |
| 读取范围 | agent 能读工作空间里的任何文件，**包括 `conf/config.toml` 里的 api_key**——这块没被 HITL 覆盖 |
| 子 agent 权限 | 只有声明了 `permissions` 的子 agent 才是硬约束；没声明的拿的是主 agent 那套带 shell 的 backend |
| 危险判定 | 正则匹配，不是语义分析。**宁可漏拦也不误拦** |

---

## 6. 已知缺口

| 缺口 | 影响 | 备注 |
|---|---|---|
| `GET /directories` 未实现 | 工作空间选择器在真后端下报错 | 前端已按契约写好，等后端实现 |
| 后端没在工具入口读 `workspace` | 工作空间参数目前只是透传 | 前端已按 `threadId` 存储 |
| shell 不受路径限制 | `execute` 能访问工作空间外的任何路径 | 设计如此，但和"文件工具锁在工作空间内"不一致 |
| 危险判定是正则 | `rm --recursive --force` 这类等价写法匹配不上 | `normal` 档的固有局限 |
| 拒绝是整组的 | 一次挂起含多条命令时，卡片把整组展示，没有逐条挑选 | 框架的 `edit` 决策前端也没做 |
| 子 agent 也会触发确认 | `fixer` 这类没声明 `permissions` 的子 agent 执行命令同样挂起 | 要不要默认放行是个待定的产品决策 |
| 记忆只在会话开始时读一次 | 改完 `.scode-memory.md` 要开新会话才生效 | 框架设计 |
| 切模型不换 harness profile | 系统提示词附加内容、工具描述改写、排除的工具都按启动时的模型定死 | 建图时决定的，跑起来改不了 |
| 切模型不换摘要阈值 | 压缩历史的触发阈值按启动时模型的上下文窗口算 | 切到窗口更小的模型可能触发偏晚 |
| 切模型不换「超预算」兜底的预算 | 压缩中间件在最终栈里位于切换中间件**外层**，它内部读 `request.model.profile` 时看到的还是启动时的模型 | 本项目模型无 profile，这条兜底恒不触发；真超限时靠 `ContextOverflowError` 的兜底路径兜住 |
| 选了不存在的模型会静默退回 | 界面上看不出切换没生效，只有后端日志有 warning | 有意为之：不让整个对话挂掉 |
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

### 步骤 7：关停

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
- 空工作空间里 `ensure_memory_file()` 会创建带模板的 `.scode-memory.md`（709 字节）
- 用假模型抓 `request.system_message`：记忆内容确实在系统提示词的 `<agent_memory>` 块里
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
  `delete` / `glob` / `grep`；本期只拦 `execute`

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

**工作空间选择器报错**
正常，`/directories` 后端未实现。

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
`graph/backend.py` 的 `apply_permission_backend()`——正常路径下 `permissions`
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
