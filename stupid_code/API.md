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
| 前端 | POST | [`/threads/search`](#post-threadssearch) | 会话列表 | ✅ |
| 前端 | DELETE | [`/threads/{id}`](#deletethreadsid) | 删除会话 | ✅ |
| 前端 | PATCH | [`/threads/{id}`](#patch-threadsid) | 改 metadata（存标题） | ✅ |
| 前端 | GET | [`/threads/{id}/state`](#get-threadsidstate) | 历史消息 | ✅ |
| 前端 | POST | [`/threads/{id}/runs/stream`](#post-threadsidrunsstream) | 流式运行 | ✅ |
| 前端 | POST | [`/threads/{id}/runs/{runId}/cancel`](#post-threadsidrunsrunidcancel) | 停止运行 | ✅ |
| 前端 | GET | [`/directories`](#get-directories未实现) | 浏览目录（工作空间） | ❌ 未实现 |
| 管理端 | GET | [`/admin/models`](#get-adminmodels) | 列出全部模型 | ✅（003 起） |
| 管理端 | GET | [`/admin/models/{id}`](#get-adminmodelsid) | 单个模型详情 | ✅（003 起） |
| 管理端 | POST | [`/admin/models`](#post-adminmodels) | 新增模型 | ✅（003 起） |
| 管理端 | PUT | [`/admin/models/{id}`](#put-adminmodelsid) | 改模型属性 | ✅（003 起） |
| 管理端 | DELETE | [`/admin/models/{id}`](#delete-adminmodelsid) | 删除模型 | ✅（003 起） |

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

**请求**：body **必填**（哪怕是空的）。平台把 requestBody 标成 required，
不发 body 会被判成 `Invalid JSON in request body` → 422。

```http
POST /threads
Content-Type: application/json

{}
```

body 字段（`ThreadCreate`）：

| 字段 | 必填 | 说明 |
|---|---|---|
| `thread_id` | 否 | 不传就随机生成 UUID |
| `metadata` | 否 | 线程元数据。**标题存在这里**（`metadata.title`），平台没有独立的 title 字段 |
| `if_exists` | 否 | `raise`（默认）/ `do_nothing`，处理 thread_id 冲突 |

**响应 `200`**

```json
{
  "thread_id": "1a2b3c4d-...",
  "created_at": "2026-10-17T...",
  "updated_at": "2026-10-17T...",
  "metadata": {},
  "status": "idle"
}
```

### `POST /threads/search`

列出（或搜索）当前用户的会话。前端进入页面时加载。

**没有 `GET /threads`** —— 那个路径只接受 POST，直接 GET 会 405
（响应头里写着 `allow: POST`）。列表必须走 search。

**请求**：body 必填。

```http
POST /threads/search
Content-Type: application/json

{"limit": 50, "sort_by": "updated_at", "sort_order": "desc"}
```

| 字段 | 默认 | 说明 |
|---|---|---|
| `limit` | 10 | 最多返回多少条，上限 1000 |
| `offset` | 0 | 偏移 |
| `sort_by` | — | `thread_id` / `status` / `created_at` / `updated_at` / `state_updated_at` |
| `sort_order` | — | `asc` / `desc` |
| `metadata` | — | 按 metadata 过滤 |
| `status` | — | `idle` / `busy` / `interrupted` / `error` |

**响应 `200`** — Thread 数组。

```json
[
  {
    "thread_id": "...",
    "created_at": "2026-10-17T...",
    "updated_at": "2026-10-17T...",
    "metadata": {"title": "帮我看看 README"},
    "status": "idle"
  }
]
```

> Thread **没有 title 字段**，标题是前端自己定义的，存 `metadata.title`，
> 用 `PATCH /threads/{id}` 写。这样侧边栏的标题刷新页面后还在。

### `PATCH /threads/{thread_id}`

改线程的 metadata，前端用它把标题持久化到后端。

**请求**

```http
PATCH /threads/1a2b3c4d-...
Content-Type: application/json

{"metadata": {"title": "帮我看看 README"}}
```

**响应 `200`** — 改完的 Thread。

> 平台自己也会往 metadata 里塞 `graph_id` / `assistant_id`，
> 所以这里只增量写要改的键，不要整块覆盖。

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

## 模型管理

由 `stupid_code/admin/app.py` 提供的自定义 ASGI 路由，通过 `langgraph.json` 的 `http.app` 字段挂载到 langgraph dev 服务。操作对象是项目根 `conf/config.toml`（不入库）。**改完配置需重启 `scode` 才能让运行中的 graph 加载新模型实例**——所有响应里的 `restart_required: true` 就是这个意思。

接口对外细粒度是**模型**：每个模型自带全部连接字段（`name` / `protocol` / `provider` / `base_url` / `api_key`）。toml 内部按 `provider` 分组只是为了避免重复写 `key` / `base_url`，接口层不暴露该结构。

> 模型 id 形如 `provider:model_name`，与 `conf/config.toml` 里 `[models].default = "minimax:MiniMax-M3"` 的格式一致。URL 里冒号是合法字符，无需转义。

> `api_key` 默认脱敏（末 4 位，长度 ≤4 时显示 `****`）；带 `?reveal=true` 才返回完整 key。

### `GET /admin/models`

列出全部模型，扁平数组，每项自带全部连接字段（key 默认脱敏）。

**响应 `200`**

```json
{
  "default": "minimax:MiniMax-M3",
  "recent": "minimax:MiniMax-M3",
  "models": [
    {
      "id": "minimax:MiniMax-M3",
      "name": "MiniMax-M3",
      "provider": "minimax",
      "protocol": "anthropic",
      "display_name": "MiniMax",
      "base_url": "https://api.minimax.cn/anthropic",
      "api_key": "***ax密钥"
    },
    {
      "id": "minimax:MiniMax-M2.5",
      "name": "MiniMax-M2.5",
      "provider": "minimax",
      "protocol": "anthropic",
      "display_name": "MiniMax",
      "base_url": "https://api.minimax.cn/anthropic",
      "api_key": "***ax密钥"
    }
  ],
  "restart_required": true
}
```

### `GET /admin/models/{id}`

单个模型详情。

**路径参数**

| 名 | 说明 |
|---|---|
| `id` | 模型 id，形如 `minimax:MiniMax-M3` |

**查询参数**

| 名 | 默认 | 说明 |
|---|---|---|
| `reveal` | `false` | 设为 `true` 返回完整 `api_key` |

**响应 `200`**

```json
{
  "id": "minimax:MiniMax-M3",
  "name": "MiniMax-M3",
  "provider": "minimax",
  "protocol": "anthropic",
  "display_name": "MiniMax",
  "base_url": "https://api.minimax.cn/anthropic",
  "api_key": "***ax密钥"
}
```

**响应 `404`** — `{"error": "模型 'minimax:foo' 不存在"}`
**响应 `400`** — id 格式不合法（缺冒号 / 空段），`{"error": "模型 ID 'xxx' 不合法，应为 \"供应商名:模型名\""}`

### `POST /admin/models`

新增模型。若该 `provider` 不存在则自动创建供应商段，已存在则把 `name` 加到该供应商的 `models[]` 列表。

**请求**

```http
POST /admin/models
Content-Type: application/json

{
  "name": "moonshot-v1-8k",
  "protocol": "openai",
  "provider": "moonshot",
  "base_url": "https://api.moonshot.cn/v1",
  "api_key": "sk-...",
  "display_name": "Moonshot"
}
```

| 字段 | 必填 | 说明 |
|---|---|---|
| `name` | 是 | 模型名（供应商给的标识） |
| `protocol` | 是 | 只接受 `anthropic` / `openai` |
| `provider` | 是 | 供应商名，作为 toml `[models.providers.<name>]` 段的 key |
| `base_url` | 否 | 第三方端点；不填则用协议官方端点 |
| `api_key` | 是 | 明文，写入 `conf/config.toml`（已 gitignore） |
| `display_name` | 否 | 展示名，留给后续前端模型选择器 |

> 若 `provider` 已存在，body 里的 `protocol` / `base_url` 必须与现有段一致，否则返回 `400`——这避免静默覆盖连接字段。要改用 `PUT`。

**响应 `201`**

```json
{"id": "moonshot:moonshot-v1-8k", "created": true, "restart_required": true}
```

**响应 `400`** — ConfigError，例如：
- `protocol` 不是 `anthropic` / `openai`
- `name` 或 `provider` 或 `api_key` 缺失
- 同名模型已存在：`{"error": "模型 minimax:MiniMax-M3 已存在"}`
- 与已有供应商段连接字段冲突：`{"error": "供应商 'minimax' 已存在且 protocol='anthropic'，与请求 'openai' 不一致"}`

### `PUT /admin/models/{id}`

改模型属性。可改字段：`protocol`、`base_url`、`api_key`、`display_name`。`model_name` 自身不可改（要改请删后增）。

**请求**

```http
PUT /admin/models/minimax:MiniMax-M3
Content-Type: application/json

{"api_key": "sk-rotated-key"}
```

**响应 `200`**

```json
{
  "id": "minimax:MiniMax-M3",
  "updated": true,
  "co_affected": ["minimax:MiniMax-M2.5"],
  "restart_required": true
}
```

> `co_affected` 列出受影响的其他同级模型 id。因为 toml 按 `provider` 分组，`protocol` / `base_url` / `api_key` / `display_name` 实际属于整个供应商段，改一个模型会影响该供应商下所有同级模型——响应里明确告知，避免误以为是局部修改。

**响应 `404`** — `{"error": "模型 'minimax:foo' 不存在"}`
**响应 `400`** — ConfigError（如 `protocol` 不合法）

### `DELETE /admin/models/{id}`

删除模型。若删除后该供应商 `models[]` 变空，自动删除整个供应商段，保持 toml 一致性。

**响应 `200`**

```json
{
  "id": "minimax:MiniMax-M2.5",
  "deleted": true,
  "remaining_peers": ["minimax:MiniMax-M3"],
  "restart_required": true
}
```

> `remaining_peers` 列出剩余同级模型 id。空数组表示该供应商段已被自动清理。

**响应 `404`** — `{"error": "模型 'minimax:foo' 不存在"}`

> 删除后 `[models].default` / `[models].recent` 不会自动调整——如果删的模型恰好是 `default`，下次启动会报 ConfigError；需要手动改 `default` 指向仍存在的模型 id。

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
- 端点参数与响应以 [web/src/api](file:///Users/1token/Desktop/project/stupid-code/web/src/api) 和 [admin/models.py](file:///Users/1token/Desktop/project/stupid-code/stupid_code/admin/models.py) 中的实际调用为准。

---

## 已验证的事实（2026-10-19 实测）

对着真后端逐条打过，凭空猜的地方都改了：

- `POST /threads` 的 body **必填**，空 body → 422 `Invalid JSON in request body`
- `GET /threads` → **405**（`allow: POST`）；列表走 `POST /threads/search`
- Thread **没有 title 字段**，标题要自己存 `metadata.title`，用 `PATCH /threads/{id}` 写
- 平台错误体的字段是 `{"detail": "..."}`，不是我们 `/admin/*` 用的 `{"error": "..."}` —— 前端两种都认
- `GET /threads/{id}/state` 的 `values.messages` 是标准 LangChain 消息数组
  （`type` 取 `human`/`ai`/`tool`，`content` 是字符串），前端能直接还原
- `POST /threads/{id}/runs/stream` 的 body 形状
  （`assistant_id` + `input.messages` + `stream_mode` + `on_disconnect` + `config.configurable`）被平台接受
- `assistant_id` 传 graph_id（`code_agent`）也能跑，平台会自己解析到对应的 assistant
- run 结束（尤其出错）时服务端直接关连接，浏览器把这个记成 `net::ERR_ABORTED`——
  **这是正常收尾，不是前端 bug**。error 事件在关闭之前已经送到，前端能正常显示
- 平台 `error` 事件是 `{"error": "AnthropicAuthenticationError", "message": "An internal error occurred"}`，
  只显示 message 等于什么都没说，两个字段要合起来给用户看
- **重启后 thread 会整体"消失"，除非保留 `.langgraph_api/`**：checkpoint 快照确实持久化在
  `stupid_code/data/langgraph.db`（`checkpoints` / `writes` 两张表），但 **thread 索引**
  （会话列表、metadata、status）存在工作空间的 `.langgraph_api/.langgraph_ops.pckl` 里。
  删掉该目录再重启，`POST /threads/search` 返回空数组、`GET /threads/{id}/state` 报 404
  `Thread or assistant not found.`——数据还躺在 SQLite 里，平台却认不出这些 thread 了。
  保留该目录后，两者都恢复正常（`same-named .langgraph_checkpoint.*.pckl` 是空的，
  说明 checkpoint 确实只走 SQLite）
- 附带结论：thread 索引按**工作空间**分（跟着 cwd 走），checkpoint 按**代码文件**定位
  （全局一份）。两者不在同一个工作空间时索引会与 checkpoint 失配

### 官方文档

- Create Thread — <https://docs.langchain.com/langsmith/agent-server-api/threads/create-thread>
- Search Threads — <https://docs.langchain.com/langsmith/agent-server-api/threads/search-threads>
- Streaming API — <https://docs.langchain.com/langsmith/streaming>
