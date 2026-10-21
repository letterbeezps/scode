# stupid_code 后端

基于 [Deep Agents](https://github.com/langchain-ai/deepagents) / LangGraph 的 Agent Server，由 `langgraph dev` inmem 运行时托管。

## 启动

在项目根 `uv sync` 后，**切到要让 agent 操作的目录**再启动（那个目录就是工作空间）：

```bash
uv run scode
```

`scode`（入口见 [launcher.py](launcher.py)）把 langgraph 服务器当成「用完即弃」的本地计算进程：

1. **工作空间 = 当前目录**：langgraph 子进程的 cwd 就是你运行 scode 的目录，
   未来 agent 的 shell / 文件工具以它为根（当前 deepagents 默认 StateBackend，
   文件还在 graph state 的虚拟文件系统里，与 cwd 无关）；
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

前端联调另开终端：`cd ../web && pnpm dev`（http://localhost:5173）。

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
│   └── persistence.py     # SQLite 工厂：checkpoint/store → ../data/langgraph.db
├── config/           # 读项目根 conf/ 的那层（代码在这里，数据在 ../../conf/）
│   ├── model.py           # conf/config.toml → 模型实例 + CRUD helpers
│   ├── subagent.py        # conf/subagents.toml → SubAgent 规格
│   └── prompts.py         # 主 agent 的系统提示词
├── admin/            # 挂在 /admin 下的管理接口
│   ├── app.py             # Starlette 子应用与路由表
│   └── models.py          # /admin/models 五个端点的处理函数
└── data/             # SQLite 数据库目录（gitignore）
```

| 文件 | 作用 |
|---|---|
| **起停** | |
| [__init__.py](__init__.py) | `start()` —— `scode` 命令入口；设 `sys.dont_write_bytecode` 保证源码目录零运行残留 |
| [launcher.py](launcher.py) | cwd 即工作空间、生成临时派生配置、就绪探测、生命周期管理（`.langgraph_api` 保留不清理） |
| **图与持久化**（`graph/`） | |
| [graph/agent.py](graph/agent.py) | `code_agent` 图：`create_deep_agent()`，导出 `graph` |
| [graph/persistence.py](graph/persistence.py) | SQLite 持久化工厂：`AsyncSqliteSaver`（checkpoint）+ `AsyncSqliteStore`（store），都指向 `../data/langgraph.db` |
| **配置解析**（`config/`） | |
| [config/model.py](config/model.py) | 加载与校验 `../../conf/config.toml`，构建模型实例；CRUD helpers |
| [config/subagent.py](config/subagent.py) | 加载与校验 `../../conf/subagents.toml`，转成 deepagents 的 `SubAgent` 规格 |
| [config/prompts.py](config/prompts.py) | 主 agent 的系统提示词。框架 0.7.28 已不提供内置基础提示词，这段就是模型唯一看到的系统提示词 |
| **管理接口**（`admin/`） | |
| [admin/app.py](admin/app.py) | 挂在 langgraph dev 的 Starlette 子应用与路由表（`langgraph.json` 的 `http.app` 指向它） |
| [admin/models.py](admin/models.py) | `/admin/models` 路由处理函数 |
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
> `../docs/backend/004_subagents_config.md`。

## 注意

- 不要给 `create_deep_agent()` 传 `checkpointer`：持久化由平台在 `langgraph.json` 层配置（`checkpointer`/`store` 指向 `graph/persistence.py`），在 agent 里显式传入会启动失败。对话历史写入 `data/langgraph.db`，重启后仍可恢复；删除该文件即重置全部历史。
- 模型供应商配置在项目根 `conf/config.toml`（从 `conf/config.example.toml` 复制），选择顺序 `default` → `recent`，协议只支持 anthropic / openai；改配置需重启服务。
- 子 agent 配置在项目根 `conf/subagents.toml`，同样改完要重启服务（子 agent 在 `graph/agent.py` 导入时构建一次）。`model` 必须是 `config.toml` 里配过的供应商 + 其 `models` 白名单里的模型名。
- `langgraph.json` 的 `http.app` 字段指向 `admin/app.py:app`。本期实现的 `/admin/models` 接口改完配置后仍需重启 `scode` 才能让运行中的 graph 加载新模型实例。
- 详细的阶段目标与验证步骤见 `../docs/backend/001_basic_agent_server.md`、`../docs/backend/002_config_toml_models.md`、`../docs/backend/003_model_admin_api.md`、`../docs/backend/004_subagents_config.md`。
