# stupid_code 后端

基于 [Deep Agents](https://github.com/langchain-ai/deepagents) / LangGraph 的 Agent Server，由 `langgraph dev` inmem 运行时托管。

## 启动

在项目根目录执行：

```bash
uv sync        # 首次或依赖变更后
uv run scode
```

`scode`（入口见 [main.py](main.py)）会以子进程方式运行
`langgraph dev --config langgraph.json --no-browser`（cwd 为本目录），并自动完成就绪验证：

1. `GET http://127.0.0.1:2024/ok` — HTTP 服务可用；
2. `GET /assistants/{id}/graph` — `code_agent` 图能正常加载。

两项都通过后输出就绪提示；60 秒未就绪或子进程崩溃则以退出码 1 失败。
`Ctrl+C`（或收到 SIGTERM）会关闭整个子进程组，不残留进程占用端口。

前端联调另开终端：`cd ../web && pnpm dev`（http://localhost:5173）。

## 文件

| 文件 | 作用 |
|---|---|
| [langgraph.json](langgraph.json) | LangGraph 配置：图注册、依赖、env 文件，路径均相对本目录 |
| [agent.py](agent.py) | `code_agent` 图：`create_deep_agent()`，导出 `graph` |
| [main.py](main.py) | `scode` 命令入口：启动子进程、就绪探测、生命周期管理 |
| `.env` | API key 等环境变量（不入库，见根 `.gitignore`） |
| `.langgraph_api/` | `langgraph dev` 的 pickle 持久化缓存（不入库，可随时删除） |

## 注意

- 不要给 `create_deep_agent()` 传 `checkpointer`：`langgraph dev` 平台自带持久化，显式传入会启动失败。对话历史由平台写入 `.langgraph_api/`，重启后仍可恢复。
- 详细的阶段目标与验证步骤见 `../docs/backend/001_basic_agent_server.md`。
