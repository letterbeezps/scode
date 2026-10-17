# 001 基础 Agent Server 启动框架

> 版本：v0.1
> 日期：2026-10-17
> 范围：**只解决"后端能被启动、前端能感知到后端存在"**。Agent 内部能力（文件读写、命令执行、权限确认）本期不讨论。

---

## 1. 本期目标与边界

### 1.1 要达成的三件事

1. `langgraph dev` 能起来，暴露 LangGraph Platform API
2. 前端能把 `VITE_USE_MOCK` 关掉，真实连上后端并完成一轮对话
3. 前端能拿到 `thread_id`、`run_id`，取消功能可用

### 1.2 明确不做

| 不做 | 原因 |
|---|---|
| 文件工具 / 命令执行工具 | 需要先确定 backend 与工作空间方案，见 `002` |
| 危险操作确认（HITL） | 依赖 `HumanInTheLoopMiddleware`，与工具集强相关 |
| 运行护栏（max_steps / 预算） | 没有自定义工具时无处施加 |
| 鉴权 | 单机自用，默认只监听 `127.0.0.1` |

### 1.3 本期假设

**假设 `create_deep_agent()` 默认够用。** 这是刻意的简化，目的是先打通链路。

⚠️ **这个假设有一个已知的高风险点**：`create_deep_agent()` 不传 `backend` 时默认使用 `StateBackend`，它把文件存在 LangGraph state 里（源码注释标注 *ephemeral*），**修改不落磁盘**。

本期不处理，但验收时必须知道：**如果对话里 Agent 说"已修改 xxx 文件"，磁盘上大概率没有变化**。这是正常的，不是 bug。真正的编码能力需要显式配置 backend，那是 `002` 的内容。

---

## 2. 架构

```
浏览器 (web/, :5173)
   │  fetch('/api/threads')  等相对路径
   ▼
Vite dev server 代理  ──rewrite 去掉 /api──>  LangGraph API Server (:2024)
                                                 │
                                                 ├─ /threads/*        平台提供
                                                 ├─ /threads/*/runs/*  平台提供
                                                 ├─ /assistants/*     平台提供
                                                 └─ /directories       ⚠️ 需自研挂载
```

**单端口、单服务**：`/directories` 挂在同一个 server 上，不另起进程。

---

## 3. 现状与差距

| 项 | 现状 | 本期要做的 |
|---|---|---|
| `pyproject.toml` 依赖 | ✅ 已补全 | — |
| `stupid_code/` 包 | 只有空壳 `main.py` | 加 `agent.py` |
| `langgraph.json` | ❌ 不存在 | 创建 |
| `.env` | ❌ 不存在（只有 `.env.example`，但在后端根目录缺失） | 创建 |
| `web/.env.local` | ❌ 不存在 | 创建，关掉 mock |
| 后端可启动 | ❌ | ✅ |
| 前端联调 | ❌ 全跑在 373 行 mock 上 | ✅ |

---

## 4. 文件清单

### 4.1 `langgraph.json`（新建）

```json
{
  "dependencies": ["."],
  "graphs": {
    "code_agent": "./stupid_code/agent.py:graph"
  },
  "env": "./.env"
}
```

`graphs` 的 key（`code_agent`）就是前端 `VITE_ASSISTANT_ID` 要对应的值。

### 4.2 `stupid_code/agent.py`（新建）

只做最小构建，不加自定义工具：

```python
"""Agent 图构建入口。

langgraph.json 通过 `./stupid_code/agent.py:graph` 引用本模块。
本期保持最小：模型 + 系统提示词，其余能力后续文档再加。
"""

from deepagents import create_deep_agent
from langchain.chat_models import init_chat_model

# 凭据只从环境变量读取，由 langgraph.json 的 env 字段注入 .env
model = init_chat_model("anthropic:claude-sonnet-4-6")

graph = create_deep_agent(
    model=model,
    system_prompt=(
        "你是一个编程助手。"
        "当前处于最小骨架阶段，尚未接入文件与命令工具，"
        "因此不要声称已经修改了任何文件。"
    ),
)
```

> ⚠️ **模型标识待核实**：`claude-sonnet-4-6` 需与账号实际可用的模型一致。核实方式：见 §7。

### 4.3 `.env`（新建）

```bash
ANTHROPIC_API_KEY=sk-ant-...
```

`.gitignore` 已忽略 `.env`，不会被提交。

### 4.4 `web/.env.local`（新建）

```
VITE_LANGGRAPH_URL=http://localhost:2024
VITE_ASSISTANT_ID=code_agent
VITE_USE_MOCK=false
```

`web/.gitignore` 已覆盖 `.env.local`。

---

## 5. 启动流程

```bash
# 终端 1：后端
cd /Users/1token/Desktop/project/stupid-code
uv sync                      # 首次执行
langgraph dev --no-browser   # --no-browser 避免自动弹 Studio
```

```bash
# 终端 2：前端
cd /Users/1token/Desktop/project/stupid-code/web
pnpm install                 # 首次执行
pnpm dev
```

启动后：

- 后端 `http://127.0.0.1:2024`
- 前端 `http://localhost:5173`
- Vite 把 `/api/*` 代理到后端并剥掉 `/api` 前缀，浏览器侧同源，无 CORS

### 5.1 为什么必须加 `--no-browser`

`langgraph dev` 默认会自动打开浏览器连 Studio。本项目用自有前端，不需要，且每次启动都弹窗很吵。

### 5.2 端口冲突时

```bash
langgraph dev --no-browser --port 2025
```

改端口要同步改 `web/.env.local` 的 `VITE_LANGGRAPH_URL`。

---

## 6. `/directories` 端点（本期可选）

前端 `api/directory.ts` 已按 `GET /directories?path=<绝对路径>` 调用（工作空间选择器需要绝对路径，浏览器 API 故意不暴露）。本期不实现则该选择器报错，其余功能不受影响。

若本期要实现，`langgraph.json` 支持挂载自定义 ASGI 应用：

```json
{
  "dependencies": ["."],
  "graphs": {
    "code_agent": "./stupid_code/agent.py:graph"
  },
  "env": "./.env",
  "http": {
    "app": "./stupid_code/custom_app.py:app"
  }
}
```

**安全注意**（这两个字段在 schema 里确实存在，用得上）：

| 字段 | 作用 |
|---|---|
| `enable_custom_route_auth` | 是否对自定义路由应用鉴权中间件。自定义路由**默认不鉴权**，单机场景可接受，但要知道这个开关存在 |
| `mount_prefix` | 自定义路由的挂载前缀，可避开 `/threads` 等平台保留路径 |

⚠️ 该端点能枚举用户整个文件系统目录树。**必须只监听 `127.0.0.1`**（§8）。

响应结构前端已按此解析，不可改字段名：

```typescript
interface DirectoryListing {
  path: string
  parent: string | null
  directories: Array<{ name: string; path: string }>
}
```

---

## 7. 验收标准

按顺序执行，每步都要有实际观察：

| # | 操作 | 期望 |
|---|---|---|
| 1 | `langgraph dev --no-browser` | 启动无报错；日志显示监听 2024 |
| 2 | `curl http://127.0.0.1:2024/ok` | 返回健康状态 |
| 3 | `curl http://127.0.0.1:2024/assistants` | JSON 里出现 `code_agent` |
| 4 | 浏览器打开 `localhost:5173` | 侧边栏可新建会话 |
| 5 | 发一条消息 | 文本正常流式渲染 |
| 6 | 查看 Network | `POST /api/threads/{id}/runs/stream` 返回 200，`Content-Type: text/event-stream` |
| 7 | 点停止 | 请求发出 cancel，`run_id` 有值 |
| 8 | 刷新页面 | 历史消息能恢复（从 `/state` 的 `values.messages`） |
| 9 | 问 Agent "改一下 xxx 文件" | 正常回复，**但磁盘无变化**（符合 §1.3 假设） |

### 7.1 本期要顺便确认的三个未知

前端 1044 行通信代码全部跑在 mock 上，以下三点只有真连上才知道：

| 未知 | 怎么验 | 影响 |
|---|---|---|
| `stream_mode: ['updates']` 的文本粒度 | 观察第 5 步是逐字还是整段蹦出 | 决定要不要改成 `['messages','updates']` |
| `metadata` 事件里 `run_id` 的真实字段名 | 看第 7 步能否成功 cancel | 字段名错则取消静默失效 |
| `updates` 里 tool_call 的参数名是 `args` 还是 `arguments` | 本期无工具调用，验不了 | 推迟到 `002` |

`events.ts` 里同时兼容 `args` / `arguments`，说明写的时候就不确定——这个不确定性要留到有工具调用时才能消除。

---

## 8. 安全

### 8.1 只监听 127.0.0.1

`langgraph dev` 的 `--host` 帮助文本原文：

> Default 127.0.0.1 is recommended for security. Only use 0.0.0.0 in trusted networks

**保持默认，不要加 `--host 0.0.0.0`。** 本期 Agent 没有命令执行工具，风险低于后续阶段；但一旦接入 shell 工具，绑定 `0.0.0.0` 就等于对外开放命令执行。

### 8.2 凭据

- 只从 `.env` / 环境变量读
- 不硬编码、不进日志、不提交（`.gitignore` 已覆盖 `.env`）
- 模型 API key 泄漏的代价是真金白银

### 8.3 本期风险等级

低。理由：无可执行工具、仅本机监听、单用户使用。

后续接入命令执行工具时，本节需要重写——那时 Agent 等同于"一个能在你机器上执行任意命令的服务"。

---

## 9. 已知限制

| 限制 | 影响 | 何时处理 |
|---|---|---|
| Agent 无法读写真实文件 | 不能真正改代码 | `002` |
| Agent 无命令工具 | 不能跑测试/git | `002` |
| `/directories` 未实现 | 工作空间选择器报错 | 可选，或 `002` |
| 刷新页面丢失进行中的运行 | 当前配置 `stream_resumable: false`，接不回流 | `003` |
| 无鉴权 | 仅本机可接受 | 单机场景不做 |
| 模型标识可能不存在 | 启动即报错 | §7 第 1 步会暴露 |

---

## 10. 下一步

1. 按 §4 建四个文件，跑通 §7 的 9 步验收
2. 记录 §7.1 三个未知的真实答案，回填本文档
3. 另起 `002-agent-runtime.md`：backend 选型、工作空间隔离、工具集、护栏

---

## 附：待核实清单

- `[待核实]` `claude-sonnet-4-6` 是否为当前账号可用模型 —— 核实方式：看 `ANTHROPIC_API_KEY` 对应账号的模型列表；或查 Anthropic 官方文档的模型页。本文档不硬编码模型名
- `[待核实]` `langgraph.json` 的 `http.app` 挂载点是否接受 `module:attr` 形式 —— 核实方式：创建后跑 `langgraph validate` 检查配置
- `[待核实]` `graph` 变量名是否必须叫 `graph` —— 取决于 graphs 配置的解析规则；核实方式：同上看 `validate` 结果
