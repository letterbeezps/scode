# stupid_code 后端

基于 [Deep Agents](https://github.com/langchain-ai/deepagents) / LangGraph 的 Agent Server，由 `langgraph dev` inmem 运行时托管。

## 启动

在项目根 `uv sync` 后启动（在项目根运行则项目根就是工作空间）：

```bash
uv run scode
```

要让 agent 操作别的目录，**切到那个目录**，用 `--project` 指回本项目：

```bash
cd /path/to/workspace
uv run --project /path/to/stupid-code scode
```

`scode`（入口见 [launcher.py](launcher.py)）把 langgraph 服务器当成「用完即弃」的本地计算进程：

1. **工作空间默认 = 当前目录**：langgraph 子进程的 cwd 就是你运行 scode 的目录，
   agent 的 shell / 文件工具以它为根（backend 是真实磁盘 + 本机 shell，见
   [graph/backend.py](graph/backend.py)）。前端选的工作空间通过
   `configurable.workspace` 按消息生效，会覆盖这个默认值（见
   [graph/workspace.py](graph/workspace.py)）；
2. **`.langgraph_api/` 保留不动**：langgraph inmem 运行时必然在 cwd 下生成它
   （路径硬编码，无法配置改位）。里面的 `.langgraph_ops.pckl` 是 **thread 索引**——
   会话列表与 metadata 的来源。删掉它，平台重启后认不出已有 thread：
   `/threads/search` 返回空、`/threads/{id}/state` 报 404，历史数据还躺在
   SQLite 里却取不出来。所以 scode 不再清理它；
3. **持久状态分两处，缺一不可**：thread 索引在工作空间的 `.langgraph_api/` 里；
   checkpoint / store 经自定义 saver 写入本包目录下的
   `data/langgraph.db`（SQLite），路径按代码文件定位，与你在哪个目录运行无关；
4. 派生配置（把 langgraph.json 里的 `./graph/agent.py` 等相对路径绝对化）写到
   `$TMPDIR/scode-config-*`，退出即删。

启动后自动完成就绪验证：

1. `GET http://127.0.0.1:2024/ok` — HTTP 服务可用；
2. `GET /assistants/{id}/graph` — `code_agent` 图能正常加载。

两项都通过后输出就绪提示；60 秒未就绪或子进程崩溃则以退出码 1 失败。
`Ctrl+C` / SIGTERM / SIGINT 都会关闭整个子进程组并清理临时配置目录，不残留进程占用端口。
scode 固定传 `--no-reload`（reload 会监视工作空间，agent 写文件会自我触发重启），改后端代码后请重启 scode。

前端联调另开终端：`cd <项目根>/web && pnpm dev`（http://localhost:5173）。

### 监听地址

`launcher.py` 的监听地址读环境变量 `SCODE_BIND_HOST`，默认 `127.0.0.1`（原生跑法）。
容器里要设成 `0.0.0.0` 才对外可达——见根目录 `Dockerfile` 与 `docker-compose.yml`。
就绪探测永远打 `127.0.0.1`（绑全网卡时同样连得上）。

## 文件

按职责分四块：起停、图与持久化、配置解析、管理接口。

顶层只放「进程入口」和「配置」两类东西，实现细节按职责进子包：

```
stupid_code/
├── __init__.py       # scode 命令入口
├── launcher.py       # 起停 langgraph dev
├── langgraph.json    # 图注册（框架读的配置）
├── graph/            # 图与它的持久化
│   ├── agent.py           # create_deep_agent()，导出 graph
│   ├── backend.py         # 真实 backend：CompositeBackend(default=LocalShellBackend)
│   ├── workspace.py       # 解析 configurable.workspace + 每轮校验/缓存
│   ├── memory.py          # 长期记忆：项目级 .scode-memory.md + 用户级 ~/.scode/memory.md
│   ├── memory_home.py     # 用户级记忆的家目录（$SCODE_HOME）与 /user-memory/ 路由常量
│   ├── skills.py          # skill 发现：全局（静态）+ 项目级（运行期）+ 用户勾选的 pin
│   ├── compaction.py      # /compaction 手动压缩 + 摘要用当前选中的模型
│   ├── model_switch.py    # 运行期切换对话模型（configurable.model）
│   ├── mcp.py             # MCP 工具加载：建图时取一次，交给 create_deep_agent(tools=...)
│   └── persistence.py     # SQLite 工厂：checkpoint/store → ../data/langgraph.db
├── config/           # 读项目根 conf/ 的那层（代码在这里，数据在 ../../conf/）
│   ├── model.py           # conf/config.toml → 模型实例 + CRUD helpers
│   ├── subagent.py        # conf/subagents.toml → SubAgent 规格
│   ├── mcp.py             # conf/mcp.json → MCP 连接参数
│   └── prompts.py         # 主 agent 的系统提示词
├── admin/            # 挂在 /admin 下的管理接口 + /workspaces/pick
│   ├── app.py             # Starlette 子应用与路由表
│   ├── models.py          # /admin/models 五个端点的处理函数
│   ├── memory.py          # /admin/memory：读和写两份长期记忆
│   ├── skills.py          # GET /admin/skills：列全局 + 项目级两份 skill
│   └── workspaces.py      # POST /workspaces/pick（弹系统目录选择框）
└── data/             # SQLite 数据库目录（gitignore）
```

| 文件 | 作用 |
|---|---|
| **起停** | |
| [__init__.py](__init__.py) | `start()` —— `scode` 命令入口；设 `sys.dont_write_bytecode` 保证源码目录零运行残留 |
| [launcher.py](launcher.py) | 工作空间（`SCODE_WORKSPACE` 或当前目录，工作空间在仓库根时警告）、生成临时派生配置、就绪探测、生命周期管理（`.langgraph_api` 保留不清理） |
| **图与持久化**（`graph/`） | |
| [graph/agent.py](graph/agent.py) | `code_agent` 图：`create_deep_agent()`，导出 `graph` |
| [graph/backend.py](graph/backend.py) | 真实 backend：`WorkspaceCompositeBackend(default=LocalShellBackend)`（真实磁盘 + 本机 shell，`/tmp/` 走虚拟 FS；工作空间自己的绝对路径不会被 `/tmp/` 路由吞掉；`artifacts_root="/.scode"` 把 agent 自己的产物收进一个隐藏目录）；`apply_subagent_policies()` 给声明了 `permissions` 的子 agent 换无 shell 的 backend、不继承 MCP 工具，并合并父级 `interrupt_on` |
| [graph/workspace.py](graph/workspace.py) | 工作空间：解析 `configurable.workspace`；每轮开跑前校验（线程里）并刷新缓存；`WorkspaceMiddleware` 把绝对路径写进系统提示词 |
| [graph/memory.py](graph/memory.py) | 长期记忆：读**项目级**（工作空间根的 `.scode-memory.md`）和**用户级**（`~/.scode/memory.md`）两份，**不自动创建**（没记忆就当空的），装成 `MemoryMiddleware` 挂进 `middleware=` |
| [graph/memory_home.py](graph/memory_home.py) | 记忆落点的单一事实来源：用户级记忆的家目录（`$SCODE_HOME`）、两个作用域的文件名与虚拟路径、`/user-memory/` 路由前缀 |
| [graph/skills.py](graph/skills.py) | skill：两个来源（**全局** `~/.scode/.agents/skills/` 是静态常量、**项目级** `<工作空间>/.agents/skills/` 走运行期虚拟路径）；用户勾选的 skill 由 `configurable.skills` 送来，正文钉进上下文；换工作空间或换勾选都重读 |
| [graph/compaction.py](graph/compaction.py) | `/compaction` 手动压缩历史 + 摘要用当前选中的模型；`.name` 报成框架自带那份的公开别名，顶掉而不是叠加 |
| [graph/model_switch.py](graph/model_switch.py) | 运行期切换对话模型：中间件在每次模型调用前把 `request.model` 换成用户选中的那个 |
| [graph/mcp.py](graph/mcp.py) | MCP 工具加载：按 `conf/mcp.json` 连服务器取工具（并行 + 总预算限时）、加 `mcp__{服务器}__{工具}` 前缀、检测重名；**每个服务器一条长会话**（专用 MCP 线程 + worker 队列，同服务器调用串行，失败自动重连）；用 adapter 的 `tool_interceptors` 兜传输层失败并在调用期重试一次。协议本身交给 `langchain-mcp-adapters` / 官方 `mcp` SDK |
| [graph/permissions.py](graph/permissions.py) | 危险操作人工确认：权限档位解析（manual/normal/auto）+ 危险命令识别 + `interrupt_on` 的 `when` 谓词；档位记进图状态，恢复时的判定不受客户端回传值影响。**写记忆文件也在拦截范围内**（判据只看路径，纯字符串不碰 FS） |
| [graph/persistence.py](graph/persistence.py) | SQLite 持久化工厂：`AsyncSqliteSaver`（checkpoint）+ `AsyncSqliteStore`（store），都指向 `../data/langgraph.db` |
| **配置解析**（`config/`） | |
| [config/model.py](config/model.py) | 加载与校验 `../../conf/config.toml`，构建模型实例；CRUD helpers |
| [config/subagent.py](config/subagent.py) | 加载与校验 `../../conf/subagents.toml`，转成 deepagents 的 `SubAgent` 规格 |
| [config/mcp.py](config/mcp.py) | 加载与校验 `../../conf/mcp.json`（pydantic 声明字段，未知字段当场报错），展开 `${VAR}`，转成 MCP 客户端的连接参数（http / stdio / sse / websocket；只收 JSON 能表达的字段） |
| [config/prompts.py](config/prompts.py) | 主 agent 的系统提示词。框架 0.7.28 已不提供内置基础提示词，这段就是模型唯一看到的系统提示词 |
| **管理接口**（`admin/`） | |
| [admin/app.py](admin/app.py) | 挂在 langgraph dev 的 Starlette 子应用与路由表（`langgraph.json` 的 `http.app` 指向它） |
| [admin/models.py](admin/models.py) | `/admin/models` 路由处理函数 |
| [admin/memory.py](admin/memory.py) | `/admin/memory`：`GET` 读两份长期记忆、`PUT` 写一份（给前端的记忆面板用） |
| [admin/skills.py](admin/skills.py) | `GET /admin/skills`：列可用的 skill（全局 + 项目级），给前端的斜杠菜单用 |
| [admin/workspaces.py](admin/workspaces.py) | `POST /workspaces/pick`：弹系统原生目录选择框（osascript / zenity / FolderBrowserDialog），阻塞到用户选完（上限 600 秒） |
| **配置与产物** | |
| [langgraph.json](langgraph.json) | LangGraph 配置：图注册、依赖、`http.app` 挂载、checkpointer/store 指向 SQLite；路径均相对本目录（scode 启动时改写为绝对路径） |
| `data/` | SQLite 数据库目录（gitignore，唯一持久运行产物，可删除后重置历史）；**不在工作空间里**，固定在本包目录下 |

> `graph/agent.py`、`graph/persistence.py`、`admin/app.py` 这三个路径被 `langgraph.json` 直接引用，
> 挪动它们必须同步改 `langgraph.json`，否则启动时找不到模块。
> `config/` 下的模块用 `__file__` 往上定位项目根（`parents[2] / "conf"`），
> `graph/persistence.py` 定位包根的 `data/`（`parents[1] / "data"`）——**再往下挪目录要同步改层数**。
> `launcher.py` 定位本包目录（langgraph.json 所在处），不能挪。

> 模型供应商配置（含 api_key）改在项目根 `conf/config.toml`（从 `conf/config.example.toml` 复制，不入库）。本项目不再使用 `.env`。 |
>
> 子 agent 声明在项目根 `conf/subagents.toml`（入库，无密钥）：每个 `[[subagents]]` 至少要有
> `name` / `description` / `model` 三项，`model` 写 `供应商名:模型名`，复用 `config.toml` 里
> 该供应商的连接信息。文件不存在 = 不配置子 agent。字段说明见
> `../docs/backend/PROGRESS.md` 的「004 · 子 agent 配置」一节。
>
> 长期记忆有**两个作用域**：项目级在工作空间根的 `.scode-memory.md`（跟着项目走），
> 用户级在 `~/.scode/memory.md`（跟着用户走，跨所有工作空间共用，目录由
> `$SCODE_HOME` 决定）。**都不会自动创建**（避免往用户选的项目、或者用户主目录里
> 凭空塞文件），每次新会话开始时由 `MemoryMiddleware` 读进系统提示词；
> **同一工作空间内只读一次，换工作空间会重新读**。agent 自己用 `write_file` 写
> （用户级走 `/user-memory/memory.md` 这条虚拟路径）——**写记忆要人工确认**
> （`normal` 和 `manual` 档，判据只看路径，写普通文件不受影响）。前端有个记忆
> 面板能看和改它们（`GET/PUT /admin/memory`）。细节见
> `../docs/backend/PROGRESS.md` 的「006 · agent 长期记忆」一节。
>
> agent 的文件操作落在工作空间的**真实磁盘**上，`execute` 直接在本机跑 shell：
> backend 是 `CompositeBackend(default=LocalShellBackend)`，见
> `../docs/backend/PROGRESS.md` 的「007 · 真实 backend」一节。
>
> agent 自己的**中间产物**（被压缩掉的对话历史、超大的工具结果、二进制块）落在
> 工作空间的 `.scode/` 下（`.scode/conversation_history/`、`.scode/large_tool_results/`、
> `.scode/blobs/`），落点由 backend 的 `artifacts_root` 决定。这些目录已 gitignore，
> 用户项目里不会冒出未忽略的临时文件；agent 需要时可以用 `read_file` 读回来，
> 所以**不能挪出工作空间**。详见 `../docs/backend/PROGRESS.md` 的「8.10 agent 自己的中间产物」。
>
> skill 也分**两个作用域**：全局在 `~/.scode/.agents/skills/`（跟着用户走，跨所有
> 工作空间共用），项目级在 `<工作空间>/.agents/skills/`（跟着项目走）。**全局是静态
> 的**（不依赖工作空间，可以写死成常量），**项目级不是**（工作空间是运行期参数，
> 每轮现算——它用虚拟路径 `/.agents/skills/` 实现，由主 backend 的运行期根目录
> 解析）。用户在输入框敲 `/` 勾选的 skill，正文会被**钉进对话上下文**
> （`configurable.skills` 传过来）；没勾的也在系统提示词的列表里，agent 觉得相关
> 会自己 `read_file` 加载。全局 skill 走主 backend 的 `/user-skills/` 路由，
> agent 能用 `read_file("/user-skills/<名字>/SKILL.md", ...)` 读全文。
> 前端用 `GET /admin/skills` 拿清单。详见
> `../docs/backend/PROGRESS.md` 的「8.12 skill（018 期）」一节。
>
> `execute` 有**人工确认**（009 期）：按运行期传来的权限档位决定拦不拦，拦下时图挂起，
> 前端弹确认卡片，批准/拒绝后用 `command.resume` 让图继续。见
> `../docs/backend/PROGRESS.md` 的「009 · shell 的人工确认（HITL）」一节。
>
> MCP 服务器配在项目根 `conf/mcp.json`（013 期，格式跟 Claude Code 一致，**不入库**——
> 仓库只提供 `conf/mcp.example.json`，按需复制）：
> `http` 和 `stdio` 都支持，工具在建图时静态注册（名字是 `mcp__{服务器}__{工具}`）。
> **改完要重启后端**（跟 `conf/subagents.toml` 一样）；某个服务器连不上只少它那几个工具。
> stdio 服务器会在启动时执行命令，只配信任的服务器。
> 仓库根的 `examples/mcp_stdio_server.py` 是一个能直接跑的 stdio 服务器（零新依赖），
> 拿来验 stdio 传输。字段说明见 `../docs/backend/PROGRESS.md` 的「013 · MCP 支持」一节。

## 注意

- 不要给 `create_deep_agent()` 传 `checkpointer`：持久化由平台在 `langgraph.json` 层配置（`checkpointer`/`store` 指向 `graph/persistence.py`），在 agent 里显式传入会启动失败。对话历史写入 `data/langgraph.db`，重启后仍可恢复；删除该文件即重置全部历史。
- 模型供应商配置在项目根 `conf/config.toml`（从 `conf/config.example.toml` 复制），选择顺序 `default` → `recent`，协议只支持 anthropic / openai；改配置需重启服务。
- 子 agent 配置在项目根 `conf/subagents.toml`，同样改完要重启服务（子 agent 在 `graph/agent.py` 导入时构建一次）。`model` 必须是 `config.toml` 里配过的供应商 + 其 `models` 白名单里的模型名。
- MCP 配置在项目根 `conf/mcp.json`（不入库，从 `conf/mcp.example.json` 复制），**改完要重启服务**（工具在建图时静态注册，跟 `conf/subagents.toml` 一样）。连接参数里的任何字符串都可以写 `${VAR}`，从进程环境展开，别写死密钥。每个服务器一条长会话（有状态服务器不会被重置）；MCP 工具只有异步实现（本地脚本 `graph.invoke()` 调它会抛 `NotImplementedError`）；声明了 `permissions` 的只读子 agent 不继承 MCP 工具；`manual` 档下非只读的 MCP 工具也要人工确认。
- 长期记忆用 `middleware=` 挂 `MemoryMiddleware`，**不要用 `create_deep_agent(memory=...)`**：后者只能用框架默认的 StateBackend，读不到磁盘上的 `.scode-memory.md`。
- **同一工作空间内记忆只在会话开始时读一次**：改了 `.scode-memory.md` 要开新会话（新建 thread）才生效；**换工作空间会重新读**（`WorkspaceMemoryMiddleware` 记着上次的工作空间）。
- **backend 是真实磁盘 + 本机 shell**（`graph/backend.py`）。agent 能读工作空间里的任何文件
  （包括 `conf/config.toml` 里的 api_key），`execute` 能跑任意命令——所以**执行命令前有人工确认**
  （`graph/permissions.py`，009 期）：按 `configurable.permissions` 的档位决定拦不拦
  （`auto` 全放行 / `manual` 每条都问 / `normal` 只问命中危险模式的），拦下时图挂起等前端决定。
  拦的是 `execute` 和 `delete`（`delete` 删目录是递归的、跟 `rm -rf` 等价，只在
  `manual` 档拦）；**write_file / edit_file 不拦**——那是 code agent 的日常。
- **恢复挂起的运行建议原样带回档位**：`command.resume` 的请求体带上同一个
  `configurable.permissions`（015 期起后端判定读的是**图状态里记的档位**，客户端回传
  错了也不改结论；但原样带回能保证恢复这一轮跟发起那一轮看到的是同一套配置）。
  `decisions` 的个数必须和挂起时的 `action_requests` 一样多，
  否则框架直接抛 `Number of human decisions (N) does not match number of hanging tool calls (M)`。
- **声明了 `permissions` 的子 agent 会被换成无 shell 的 backend**：框架不允许
  「能跑命令」和「文件权限」共存（shell 能绕过任何权限），不换的话建图时直接抛
  `NotImplementedError`。`conf/subagents.toml` 里 `reviewer` 的只读就是靠这个保证的。
- **没声明 `permissions` 的子 agent 会继承顶层 `interrupt_on`**（deepagents 的合并规则），
  所以它们执行命令同样会挂起等人确认。
- `langgraph.json` 的 `http.app` 字段指向 `admin/app.py:app`。本期实现的 `/admin/models` 接口改完配置后仍需重启 `scode` 才能让运行中的 graph 加载新模型实例。
- **端口锁死 2024，被占用就直接启动失败**（008 期）：早期版本端口被占时会误报"已就绪"
  ——`langgraph dev` 自己换了端口，而就绪检查只轮询 2024，打到的是旧服务，前端连的是
  旧代码。现在启动前先探端口，占用就报错并告诉你怎么查占用进程，**绝不自动换端口**
  （前端默认就连 2024）。
- 详细的阶段目标与验证步骤见 `../docs/backend/PROGRESS.md`（001–009 期合并成一份进度快照）。
