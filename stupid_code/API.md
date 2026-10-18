# 后端 API 清单（当前使用）

本文档列出项目**实际调用**的后端 HTTP 端点，均来自 [LangGraph Platform](https://langchain-ai.github.io/langgraph/cloud/reference/api/)，由 `langgraph dev` 直接提供；001 期没有自定义后端路由。

- 基地址：`http://127.0.0.1:2024`（开发态前端经 Vite 代理 `/api` 转发）
- 鉴权：可选 `Authorization: Bearer <VITE_LANGGRAPH_API_KEY>`，本地无鉴权时可省略
- 所有端点路径均为相对基地址

## 端点总览

| 调用方 | 方法 | 路径 | 用途 | 001 是否可用 |
|---|---|---|---|---|
| `scode` | GET | [`/ok`](#get-ok) | 存活探测 | ✅ |
| `scode` | POST | [`/assistants/search`](#post-assistantssearch) | 列出 assistant | ✅ |
| `scode` | GET | [`/assistants/{id}/graph`](#get-assistantsidgraph) | 加载图结构 | ✅ |
| 前端 | POST | [`/threads`](#post-threads) | 创建会话 | ✅ |
| 前端 | GET | [`/threads`](#get-threads) | 会话列表 | ✅ |
| 前端 | DELETE | [`/threads/{id}`](#deletethreadsid) | 删除会话 | ✅ |
| 前端 | GET | [`/threads/{id}/state`](#get-threadsidstate) | 历史消息 | ✅ |
| 前端 | POST | [`/threads/{id}/runs/stream`](#post-threadsidrunsstream) | 流式运行 | ✅ |
| 前端 | POST | [`/threads/{id}/runs/{runId}/cancel`](#post-threadsidrunsrunidcancel) | 停止运行 | ✅ |
| 前端 | GET | [`/directories`](#get-directories未实现) | 浏览目录（工作空间） | ❌ 未实现 |

---

## 健康与图注册

### `GET /ok`

存活探测。`scode` 用它判断 HTTP 服务是否已启动。

**响应 `200`**

```json
{"ok":true,"services":{}}
```

> 返回是紧凑 JSON（冒号后无空格），脚本判断时不要匹配 `"ok": true`。

### `POST /assistants/search`

列出（或按条件搜索）已注册的 assistant。`scode` 用它定位 `code_agent` 对应的 `assistant_id`。

**请求**

```http
POST /assistants/search
Content-Type: application/json

{}
```

**响应 `200`** — assistant 数组。每个元素关键字段：

```json
[
  {
    "assistant_id": "b22167ad-b492-57e7-ac21-c04420f96e39",
    "graph_id": "code_agent",
    "name": "code_agent",
    "config": {},
    "updated_at": "2026-10-17T...",
    "metadata": null
  }
]
```

> `assistant_id` 是 UUID，需要从本接口获取后再调用 `/graph` 与 `/runs/*`。

### `GET /assistants/{assistant_id}/graph`

返回指定 assistant 对应图的结构（节点、边）。`scode` 用它确认 `code_agent` 图能正常加载。

**响应 `200`**

```json
{
  "nodes": [
    {"id": "__start__", "type": "start"},
    {"id": "model", "type": "agent"},
    {"id": "tools", "type": "tools"},
    {"id": "PatchToolCallsMiddleware.before_agent", "type": "agent"},
    {"id": "_ParentNotifierMiddleware.after_agent", "type": "agent"},
    {"id": "__end__", "type": "end"}
  ],
  "edges": [
    {"source": "__start__", "target": "..."}
  ]
}
```

`nodes` 非空即表示图导入成功；空通常意味着 `agent.py` 加载失败。

---

## 会话

### `POST /threads`

创建新会话。前端「新建对话」调用。

**请求**：无 body。

**响应 `200`**

```json
{
  "thread_id": "1a2b3c4d-...",
  "created_at": "2026-10-17T...",
  "metadata": null
}
```

### `GET /threads`

列出当前用户的会话。前端进入页面时加载。

**响应 `200`** — 数组或 `{ threads: [...] }`，前端两者都兼容。

```json
[
  {"thread_id": "...", "created_at": "...", "metadata": null}
]
```

### `DELETE /threads/{thread_id}`

删除指定会话。

**响应 `204`** — 无 body。

### `GET /threads/{thread_id}/state`

读取会话完整状态，前端从 `values.messages` 还原历史消息。

**响应 `200`**

```json
{
  "values": {
    "messages": [
      {"id": "...", "type": "human", "content": "你好", "created_at": "..."},
      {"id": "...", "type": "ai", "content": "...", "tool_calls": [...]},
      {"id": "...", "type": "tool", "tool_call_id": "...", "content": "..."}
    ]
  },
  "next": null
}
```

> LangGraph 把一次 assistant 回合拆成多条消息（`ai` 文本 + `tool_calls`、`tool` 结果、`ai` 续写），前端按 `tool_call_id` 回填。

---

## 运行

### `POST /threads/{thread_id}/runs/stream`

发起一次流式运行，返回 SSE（`text/event-stream`）。前端核心对话接口。

**请求**

```http
POST /threads/{thread_id}/runs/stream
Content-Type: application/json
Accept: text/event-stream

{
  "assistant_id": "code_agent",
  "input": {"messages": [{"role": "user", "content": "你好"}]},
  "stream_mode": ["updates"],
  "on_disconnect": "continue",
  "config": {
    "configurable": {
      "workspace": "/abs/path",
      "permissions": "normal"
    }
  }
}
```

- `assistant_id`：来自 `VITE_ASSISTANT_ID`，默认 `code_agent`
- `stream_mode`：只取 `updates`（`values` 会回传全量状态，噪音大）
- `on_disconnect: "continue"`：浏览器断开后后端继续跑完，避免脏状态
- `config.configurable.workspace` / `permissions`：工作空间路径与权限档位，后端工具入口读取；001 期未启用拦截，仅透传

**响应 `200`** — SSE 流，事件类型：

| event | data | 说明 |
|---|---|---|
| `metadata` | `{"run_id": "..."}` | 运行 ID，取消时需要 |
| `updates` | `{节点名: {"messages": [...]}}` | 增量状态，前端从中提取 token / tool_call / tool_result |
| `values` | `{"messages": [...]}` | 全量状态快照 |
| `error` | `{"message": "..."}` | 运行出错 |
| `end` | — | 运行结束 |

> 前端的 [events.ts](file:///Users/1token/Desktop/project/stupid-code/web/src/api/events.ts) 同时兼容 LangGraph 原生事件（`updates`/`values`）和自定义语义事件（`messages`/`tool_call`/`tool_result`/`todos`），001 期只依赖原生 `updates`。

### `POST /threads/{thread_id}/runs/{run_id}/cancel`

通知后端中止指定运行。前端点「停止」时，先断本地 SSE，再调本接口真正中止。

**请求**：无 body。

**响应 `200`**。

---

## 未实现

### `GET /directories`（未实现）

工作空间选择器用，约定为 `GET /directories?path=<绝对路径>`，返回当前目录下的子目录列表。

**期望响应**

```json
{
  "path": "/Users/me/dev",
  "parent": "/Users/me",
  "directories": [
    {"name": "project-a", "path": "/Users/me/dev/project-a"}
  ]
}
```

`langgraph dev` 不提供该端点，001 期前端调用会报 404（属预期，见 [001 指南常见问题](file:///Users/1token/Desktop/project/stupid-code/docs/backend/001_basic_agent_server.md)），留到 002 及以后实现。

---

## 备注

- 本文档仅列**已被代码调用**的端点，完整 LangGraph Platform API 见官方文档。
- 端点参数与响应以 [web/src/api](file:///Users/1token/Desktop/project/stupid-code/web/src/api) 和 [main.py](file:///Users/1token/Desktop/project/stupid-code/stupid_code/main.py) 中的实际调用为准。
