# 001 基础 Agent Server 启动框架

## 目标

把后端 Agent Server 跑起来，让前端连上真后端完成一轮对话。

### 成功标准

- `langgraph dev` 启动无报错
- 前端 `VITE_USE_MOCK=false` 时，能发消息、收到回复
- 停止按钮可用
- 刷新页面后历史消息能恢复

### 本期不做

文件读写工具、命令执行、危险操作确认、运行护栏、`/directories` 端点、鉴权——留到 002 及以后。

### 关键取舍

- Agent 能力用 `create_deep_agent()` 默认配置，不裁剪
- **不要传 `checkpointer`**：`langgraph dev` 会拒绝自带 checkpointer 的图（ValueError：persistence 由平台自动处理）。对话持久化平台已管，刷新恢复历史不靠自己配
- 文件系统用默认 `StateBackend`，改动不落磁盘——本期只验证链路通，不追求 Agent 真正改文件

---

## 1. 建 4 个文件

> 后端相关文件（`langgraph.json`、`agent.py`、`.env`）都放在 `stupid_code/` 目录内。

### 1.1 `stupid_code/langgraph.json`

```json
{
  "dependencies": ["."],
  "graphs": {
    "code_agent": "./agent.py:graph"
  },
  "env": "./.env"
}
```

路径都相对该文件所在目录解析（`scode` 启动时把 cwd 设为 `stupid_code/`，并通过 `langgraph dev --config langgraph.json` 指定配置）。

### 1.2 `stupid_code/agent.py`

```python
from deepagents import create_deep_agent
from langchain.chat_models import init_chat_model

model = init_chat_model("anthropic:claude-sonnet-4-6")

graph = create_deep_agent(
    model=model,
    system_prompt="你是一个编程助手。",
)
```

> 模型名换成你账号能用的。**不要加 `checkpointer`**，会导致 `langgraph dev` 启动失败。

### 1.3 `stupid_code/.env`

```
ANTHROPIC_API_KEY=你的key
```

### 1.4 `web/.env.local`

```
VITE_LANGGRAPH_URL=http://localhost:2024
VITE_ASSISTANT_ID=code_agent
VITE_USE_MOCK=false
```

---

## 2. 启动

终端 1（后端，长驻）：

```bash
cd /Users/1token/Desktop/project/stupid-code
uv sync
uv run scode
```

`scode` 会以子进程方式执行 `langgraph dev --config langgraph.json --no-browser`（cwd 为 `stupid_code/`），并自动轮询验证：先 `GET /ok` 确认 HTTP 服务可用，再 `GET /assistants/{id}/graph` 确认 `code_agent` 图能正常加载。看到下面的提示才表示启动成功：

```
✅ Agent Server 已就绪：http://127.0.0.1:2024/ok
✅ 图 code_agent 已注册并可加载（6 个节点）
```

60 秒内没就绪、或子进程提前退出，`scode` 会报错并以退出码 1 结束。按 `Ctrl+C` 停止（会一并关掉整个子进程组，不残留进程占用端口）。

终端 2（前端）：

```bash
cd /Users/1token/Desktop/project/stupid-code/web
pnpm install
pnpm dev
```

打开 http://localhost:5173

---

## 3. 验证

### 步骤 1：后端起来了且图可加载

终端 1 同时出现 `✅ Agent Server 已就绪` 和 `✅ 图 code_agent 已注册并可加载` 即通过。

前者等价于 `curl http://127.0.0.1:2024/ok` 返回 200；后者等价于：

```bash
# 先查出 code_agent 的 assistant_id（UUID），再拉它的图结构
AID=$(curl -s -X POST http://127.0.0.1:2024/assistants/search -H 'Content-Type: application/json' -d '{}' \
  | python3 -c "import sys,json; print(next(a['assistant_id'] for a in json.load(sys.stdin) if a['graph_id']=='code_agent'))")
curl -s "http://127.0.0.1:2024/assistants/$AID/graph"
```

期望返回非空 `nodes`（本期约 6 个：`__start__`、`model`、`tools`、deep agents 中间件节点、`__end__`）。没有 `code_agent` 或 graph 报错，就是 `agent.py` 导入失败，看终端 1 日志。

### 步骤 2：前端能对话

浏览器发一句"你好"，能收到回复即通过。

### 步骤 3：停止按钮可用

生成较长回复时点停止，Network 里 `POST .../runs/{run_id}/cancel` 返回 200。

### 步骤 4：刷新恢复历史

刷新页面，历史消息还在。

---

## 4. 常见问题

| 现象 | 怎么办 |
|---|---|
| 缺 API key | 检查 `.env` |
| ValueError 提到 checkpointer | 删掉 `agent.py` 里的 checkpointer |
| 模型不存在 | 换成你账号能用的模型名 |
| 前端还是假数据 | 确认 `VITE_USE_MOCK=false`，重启 `pnpm dev` |
| 连不上后端 | 确认 `VITE_LANGGRAPH_URL` 端口与 `langgraph dev` 一致 |
| 工作空间选择器报错 | 正常，本期没实现 `/directories` |

---

## 5. 已验证的事实

- `langgraph dev` 默认监听 127.0.0.1
- `--no-browser`、`--config` 参数存在；配置与内部相对路径都以启动 cwd 为基准
- `langgraph validate --config stupid_code/langgraph.json` 输出 `1 graph found`
- `langgraph dev` 拒绝自带 checkpointer 的图
- `/ok` 响应是紧凑 JSON（`{"ok":true,...}`）
- `GET /assistants` 返回 405，列出 assistant 要用 `POST /assistants/search`
- `GET /assistants/{assistant_id}/graph` 返回图结构（`nodes`/`edges`），assistant_id 是 UUID，需先 search 获取
- inmem 持久化缓存写在 cwd 下的 `.langgraph_api/`（已 gitignore）
- 依赖已在 `pyproject.toml` 声明，`uv sync` 即可
