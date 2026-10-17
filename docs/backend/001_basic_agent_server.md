# 001 基础 Agent Server 启动框架

## 设计目标

### 要解决的问题

前端 4335 行代码写完了，但**一次都没连过真后端**——全部跑在 373 行 mock 假数据上。这导致三个后果：

1. 前端对后端协议的理解是猜的（事件字段名、流式粒度、`run_id` 位置都没验证过）
2. 后端还是空壳，`langgraph.json` 不存在，`stupid_code/` 只有一行 print
3. 两边对接只能靠文档里的约定，没有任何一侧验证过约定是对的

**这一期就是消除这个状态**：让后端能启动，让前端连真后端跑通一轮对话。

### 为什么先做这个，而不是先做 Agent 能力

Agent 能力（读写文件、执行命令）看起来更核心，但**没有可运行的链路时，做出来也无法验证**：

- 后端行为对不对，只能靠真跑一遍看
- 前端能不能正确消费后端事件，同样只能真跑

先打通链路，后面每加一个能力都能立刻验证；反过来，先写一堆 Agent 能力，最后联调时发现协议理解有误，全部返工。

### 成功标准

这一期做完，必须能达到：

- `langgraph dev` 启动无报错
- 前端 `VITE_USE_MOCK=false` 时，能创建会话、发消息、看到回复流式渲染
- 停止按钮可用（后端能收到 cancel）
- 刷新页面后历史消息能恢复

**这四条全过，这期就算完成。** 达不到就是没做完。

### 这一期不做

| 不做 | 为什么 |
|---|---|
| 文件读写工具 | 需要先定 backend 方案，见 002 |
| 命令执行工具 | 涉及安全边界与确认机制，见 002 |
| 危险操作确认 | 与工具集强相关，没有工具时无处确认 |
| 运行护栏（max_steps / 预算） | 没有自定义工具时无处施加 |
| `/directories` 端点 | 前端工作空间选择器会报错，但不影响其他功能 |
| 鉴权 | 单机自用，只监听 127.0.0.1 |

### 这一期的已知取舍

**`create_deep_agent()` 的 Agent 能力部分沿用默认配置，不做裁剪。** 本期的目的只是验证链路能通，不是产出可用 Agent。

但有一项**必须显式加上**，不属于"能力裁剪"：

- **`checkpointer=MemorySaver()`**：对话持久化基础设施。前端靠 `GET /threads/{id}/state` 的 `values.messages` 还原历史（见 `web/src/api/thread.ts`），没有 checkpointer 拿不到线程状态，成功标准第 4 条（刷新恢复历史）直接不成立。这不是 Agent 能力，是链路必需的基础设施。

其余保持默认，代价是明确的：`create_deep_agent()` 默认使用 `StateBackend`，文件存在 LangGraph state 里（源码标注 *ephemeral*），**改动不落磁盘**。所以这一期 Agent 无法真正读写你的项目文件。

这是刻意接受的——本期不追求 Agent 有用，只追求链路真实。

### 一期做完之后

| 能力 | 状态 |
|---|---|
| 前端连真实后端 | ✅ 可用 |
| Agent 对话 | ✅ 可用 |
| Agent 改本地文件 | ❌ 不落盘，002 解决 |
| Agent 执行命令 | ❌ 无此工具，002 解决 |
| 工作空间选择器 | ❌ 端点未实现，002 补 |

---

## 1. 建 4 个文件 + 修改 pyproject.toml

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

`code_agent` 是图的名字，前端要用它。

### 1.2 `stupid_code/agent.py`

```python
from deepagents import create_deep_agent
from langchain.chat_models import init_chat_model
from langgraph.checkpoint.memory import MemorySaver

model = init_chat_model("anthropic:claude-sonnet-4-6")

graph = create_deep_agent(
    model=model,
    system_prompt="你是一个编程助手。",
    checkpointer=MemorySaver(),
)
```

> 模型名换成你账号里能用的。改错了启动会直接报错，照报错改即可。
>
> `checkpointer=MemorySaver()` 是对话持久化必需的，不是 Agent 能力配置——没有它，刷新页面后历史消息恢复不了。

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

> `VITE_LANGGRAPH_URL` 是 Vite 代理的目标地址（`web/vite.config.ts` 已配好 `/api` → 此地址的转发），必须与 `langgraph dev` 的端口一致（默认 2024）。

### 1.5 修改 `pyproject.toml`（加依赖）

当前 `pyproject.toml` 的 `dependencies = []`，直接 `uv sync` 什么都不会装，`agent.py` 会 ImportError。在项目根目录执行：

```bash
uv add deepagents langchain langchain-anthropic "langgraph-cli[inmem]"
```

- `deepagents`：`create_deep_agent`
- `langchain`：`init_chat_model`
- `langchain-anthropic`：`anthropic:` 前缀的模型
- `langgraph-cli[inmem]`：`langgraph dev` 及内存 checkpointer

---

## 2. 启动

终端 1（后端，长驻进程，不要关）：

```bash
cd /Users/1token/Desktop/project/stupid-code
uv sync
langgraph dev --no-browser
```

`--no-browser` 是为了不自动弹 Studio 窗口，可以去掉但会一直弹。

终端 2（确认后端就绪）：

`langgraph dev` 启动后，**不要**靠日志里出现某行字来判断是否就绪——日志可能静默或误导。用 HTTP 健康检查作为唯一判据，轮询 `/ok` 直到返回 `{"ok": true}`：

```bash
# wait_for_ready: 最多等 30 秒，每秒探一次 /ok
for i in $(seq 1 30); do
  if curl -sf http://127.0.0.1:2024/ok | grep -q '"ok": true'; then
    echo "✅ langgraph server ready"
    break
  fi
  echo "waiting... ($i/30)"
  sleep 1
done
```

- 看到 `✅ langgraph server ready` 才表示后端真的起来了，可以继续
- 30 次都没成功：看终端 1 的报错，多半是 `agent.py` 导入失败或 API key / 模型名问题

终端 3（前端）：

```bash
cd /Users/1token/Desktop/project/stupid-code/web
pnpm install
pnpm dev
```

打开 http://localhost:5173

---

## 3. 验证

前 2 步在终端验，后 3 步在浏览器验。**每步都要看到"期望"里的结果再往下**，看不到就停下来排查。

### 步骤 1：后端起来了

```bash
curl http://127.0.0.1:2024/ok
```

**期望**：返回 `200`，body 为 `{"ok": true}`，不是连接被拒。

`/ok` 是 LangGraph API 的标准健康检查端点，只检测 server 进程本身是否存活，**不**验证 graph 是否注册成功（那是步骤 2）。

可用的查询参数：

| 参数 | 默认 | 说明 |
|---|---|---|
| `check_db` | `0` | 设为 `1` 时额外检查数据库连通性。开发期 `langgraph dev` 用内存存储，一般不需要 |

LangGraph Server 还暴露了几个系统级端点，排查时可以辅助定位：

| 端点 | 用途 |
|---|---|
| `GET /ok` | 健康检查，返回 `{"ok": true}` |
| `GET /` | root health check，同 `/ok` |
| `GET /info` | server 版本、配置信息、feature flags |
| `GET /metrics` | Prometheus / JSON 格式的运行指标 |

### 步骤 2：图注册成功

```bash
curl http://127.0.0.1:2024/assistants
```

**期望**：返回的 JSON 里有 `code_agent`。没有就是 `langgraph.json` 或 `agent.py` 的问题，看终端 1 的报错。

### 步骤 3：前端能发消息

浏览器打开 http://localhost:5173，发一句"你好"。

**期望**：能收到回复文本。前端固定用 `stream_mode: ['updates']`（见 `web/src/api/run.ts`），这是**消息级**更新——文本很可能是整条消息一次性到达，而非逐字流出。**整条到达也算通过**，本期只验证链路通，不追求逐字体验。

⚠️ 记下实际观察到的粒度：如果是整条蹦出，002 要把 `stream_mode` 改成 `['messages', 'updates']` 才有逐字效果；如果已经是分段到达，说明模型本身在 `updates` 里就分块推送，不用改。

### 步骤 4：停止按钮能用

让 Agent 生成一段较长回复，中途点停止。

**期望**：Network 面板里看到 `POST .../runs/{run_id}/cancel` 返回 200，UI 回到可输入状态。

如果 cancel 请求没发出或 404，说明前端从 `metadata` 事件里取 `run_id` 的字段名猜错了——前端代码在 `web/src/api/events.ts` 里取的是 `payload.run_id`，**记下实际返回的字段名**，这是 002 要改的。

### 步骤 5：刷新能恢复

刷新页面。

**期望**：历史消息还在。

如果历史是空的，检查 `GET /threads/{id}/state` 的返回里有没有 `values.messages`——前端 `web/src/api/thread.ts` 从这里还原消息。大概率是 `checkpointer` 没生效（确认 `agent.py` 里传了 `MemorySaver()`）。

---

这 5 步全过，设计目标里的"成功标准"就达成了。

---

## 4. 出问题了怎么办

| 现象 | 原因 | 怎么办 |
|---|---|---|
| 启动报缺 API key | `.env` 没建或 key 没填 | 检查文件名，确认不是 `.env.txt` |
| `ImportError: No module named deepagents` | 没装依赖 | 跑 `uv add deepagents langchain langchain-anthropic "langgraph-cli[inmem]"` 再 `uv sync` |
| 报模型不存在 | 模型名不对 | 改成你账号能用的模型名 |
| 前端还是假数据 | `.env.local` 没生效 | 确认 `VITE_USE_MOCK=false`，重启 `pnpm dev` |
| 前端连不上后端 | 后端没起或端口不对 | 看终端 1 有没有报错；确认 `VITE_LANGGRAPH_URL` 与 `langgraph dev` 端口一致 |
| 刷新后历史消息丢了 | checkpointer 没生效 | 确认 `agent.py` 里传了 `checkpointer=MemorySaver()` |
| 工作空间选择器报错 | 正常 | 本期没实现 `/directories` |

---

## 5. 写这份文档时验证过的事实

- `langgraph dev` 默认监听 127.0.0.1，不要加 `--host 0.0.0.0`
- `--no-browser` 参数存在
- 前端 `web/src/api/run.ts` 固定使用 `stream_mode: ['updates']` 和 `on_disconnect: 'continue'`
- 前端 `web/src/api/events.ts` 从 `metadata` 事件的 `payload.run_id` 字段取 run_id
- 前端 `web/src/api/thread.ts` 从 `GET /threads/{id}/state` 的 `values.messages` 还原历史消息

未验证、需要你实测确认的：

- `langgraph.json` 的写法是否被 `langgraph dev` 正确加载（启动时看终端 1 有无报错；如有 `langgraph validate` 命令可先跑一遍，但该命令在部分版本中不存在，以 `langgraph dev` 的实际输出为准）
- `claude-sonnet-4-6` 是否为可用模型（取决于你的账号）
- `updates` 流里文本是逐 token 还是整条消息
- `metadata` 事件里 `run_id` 的真实字段名是否就是 `run_id`
