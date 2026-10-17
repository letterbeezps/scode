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

### 1.1 `langgraph.json`（项目根目录）

```json
{
  "dependencies": ["."],
  "graphs": {
    "code_agent": "./stupid_code/agent.py:graph"
  },
  "env": "./.env"
}
```

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

### 1.3 `.env`（项目根目录）

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
langgraph dev --no-browser
```

终端 2（等后端就绪）：

```bash
for i in $(seq 1 30); do
  curl -sf http://127.0.0.1:2024/ok > /dev/null && echo "✅ ready" && break
  echo "waiting... ($i/30)" && sleep 1
done
```

看到 `✅ ready` 再继续。30 秒没好就看终端 1 的报错。

终端 3（前端）：

```bash
cd /Users/1token/Desktop/project/stupid-code/web
pnpm install
pnpm dev
```

打开 http://localhost:5173

---

## 3. 验证

### 步骤 1：后端起来了

```bash
curl http://127.0.0.1:2024/ok
```

期望返回 `200`。

### 步骤 2：图注册成功

```bash
curl http://127.0.0.1:2024/assistants
```

期望返回里有 `code_agent`。没有就是 `agent.py` 导入失败，看终端 1 报错。

### 步骤 3：前端能对话

浏览器发一句"你好"，能收到回复即通过。

### 步骤 4：停止按钮可用

生成较长回复时点停止，Network 里 `POST .../runs/{run_id}/cancel` 返回 200。

### 步骤 5：刷新恢复历史

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
- `--no-browser` 参数存在
- `langgraph validate` 输出 `1 graph found`
- `langgraph dev` 拒绝自带 checkpointer 的图
- `/ok` 响应是紧凑 JSON（`{"ok":true,...}`）
- 依赖已在 `pyproject.toml` 声明，`uv sync` 即可
