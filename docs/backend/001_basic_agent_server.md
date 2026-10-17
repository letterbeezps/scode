# 001 基础 Agent Server 启动框架

> 目标：`langgraph dev` 跑起来，前端关掉 mock 能真实对话。
> 不做：文件工具、命令执行、权限确认。

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

`code_agent` 是图的名字，前端要用它。

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

> 模型名换成你账号里能用的。改错了启动会直接报错，照报错改即可。

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

终端 1：

```bash
cd /Users/1token/Desktop/project/stupid-code
uv sync
langgraph dev --no-browser
```

`--no-browser` 是为了不自动弹 Studio 窗口，可以去掉但会一直弹。

终端 2：

```bash
cd /Users/1token/Desktop/project/stupid-code/web
pnpm install
pnpm dev
```

打开 http://localhost:5173

---

## 3. 验证

按顺序走，每步都要看到结果再往下：

**1. 后端起来了**

```bash
curl http://127.0.0.1:2024/ok
```

**2. 图注册成功**

```bash
curl http://127.0.0.1:2024/assistants
```

返回的 JSON 里要有 `code_agent`。

**3. 前端能发消息**

浏览器发一句话，回复能流式显示出来。

**4. 停止按钮能用**

点停止，Network 面板里能看到 cancel 请求返回 200。

**5. 刷新能恢复**

刷新页面，历史消息还在。

---

## 4. 做完之后的已知状态

- Agent 没法读写你本机的文件，改代码类的活它做不了 —— 这是下一期要解决的
- 工作空间选择器会报错 —— `/directories` 后端端点没实现，下一期补
- 刷新页面时正在跑的任务会丢 —— 下下期补

这三条都是预期的，不是坏了。

---

## 5. 出问题了怎么办

| 现象 | 原因 | 怎么办 |
|---|---|---|
| 启动报缺 API key | `.env` 没建或 key 没填 | 检查 `.env` 文件名，确认不是 `.env.txt` |
| 报模型不存在 | 模型名不对 | 改成你账号能用的模型名 |
| 前端还是假数据 | `.env.local` 没生效 | 确认 `VITE_USE_MOCK=false`，重启 `pnpm dev` |
| 前端连不上后端 | 后端没起或端口不对 | 看终端 1 有没有报错 |
| 工作空间选择器报错 | 正常 | 本期没实现 `/directories` |

---

## 6. 验证过的事实

写之前实际确认过的：

- `langgraph.json` 的这个写法通过了 `langgraph validate`（输出 `1 graph found`）
- `langgraph dev` 默认监听 127.0.0.1，不要加 `--host 0.0.0.0`
- `--no-browser` 参数存在
