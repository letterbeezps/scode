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
| 前端 | POST | [`/threads/{id}/runs/stream`](#post-threadsidrunsstream) | 流式运行 / 恢复挂起的运行 | ✅ |
| 前端 | POST | [`/threads/{id}/runs/{runId}/cancel`](#post-threadsidrunsrunidcancel) | 停止运行 | ✅ |
| 前端 | POST | [`/workspaces/pick`](#post-workspacespick) | 弹系统文件浏览窗口选工作空间 | ✅（014 起） |
| 管理端 | GET | [`/admin/models`](#get-adminmodels) | 列出全部模型 | ✅（003 起） |
| 管理端 | GET | [`/admin/models/{id}`](#get-adminmodelsid) | 单个模型详情 | ✅（003 起） |
| 管理端 | POST | [`/admin/models`](#post-adminmodels) | 新增模型 | ✅（003 起） |
| 管理端 | PUT | [`/admin/models/{id}`](#put-adminmodelsid) | 改模型属性 | ✅（003 起） |
| 管理端 | DELETE | [`/admin/models/{id}`](#delete-adminmodelsid) | 删除模型 | ✅（003 起） |
| 前端 | GET | [`/admin/memory`](#get-adminmemory) | 读两份长期记忆 | ✅（017 起） |
| 前端 | PUT | [`/admin/memory`](#put-adminmemory) | 写一份长期记忆 | ✅（017 起） |
| 前端 | GET | [`/admin/skills`](#get-adminskills) | 列可用的 skill | ✅（018 起） |

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
      "permissions": "normal",
      "model": "minimax:MiniMax-M3"
    }
  }
}
```

- `assistant_id`：来自 `VITE_ASSISTANT_ID`，默认 `code_agent`
- `stream_mode`：只取 `updates`（`values` 会回传全量状态，噪音大）
- `on_disconnect: "continue"`：浏览器断开后后端继续跑完，避免脏状态
- `config.configurable.workspace`：**这一轮的工作空间绝对路径**（014 期起真正生效）。
  agent 的文件工具（`read_file` / `write_file` / `edit_file` / `delete` / `ls` /
  `glob` / `grep`）和 `execute`（shell 的工作目录）都落在这个目录里。
  空字符串或不带这个 key = 用后端启动时的工作空间（`SCODE_WORKSPACE` 或运行
  `uv run scode` 时所在的目录）。
  路径不存在 / 不是目录 → **这一轮直接失败**，错误信息是「工作空间不存在：xxx」，
  不会静默退回默认目录（那等于把 agent 的写操作落到用户没选过的目录里）。
  见 `stupid_code/graph/workspace.py`
- `config.configurable.permissions`：权限档位（009 期），决定 `execute` 要不要先问人——见 `stupid_code/graph/permissions.py`
- `config.configurable.model`：**选中的对话模型 id**（`供应商名:模型名`，010 期）。
  后端在**每次模型调用前**按这个 id 把模型换掉——用该供应商在 `conf/config.toml` 里的
  `base_url` / `api_key` / `protocol`——所以**切换不需要重启后端**。
  不传或传空串表示用后端启动时带的默认模型（`[models].default`）。
  见 `stupid_code/graph/model_switch.py`
- 消息正文本身也可以是**斜杠命令**（011 期）：正文恰好是 `/compaction` 时，
  后端会强制压缩一次对话历史（不等待阈值）。这是普通消息，没有单独的端点——
  命令表在前端 `web/src/lib/commands.ts`，后端认哪个命令见
  `stupid_code/graph/compaction.py` 的 `COMPACTION_COMMAND`。
  压缩掉的旧对话会落到工作空间的 `.scode/conversation_history/<session_id>.md`，
  agent 之后可以用 `read_file` 读回来

**响应 `200`** — SSE 流，事件类型：

| event | data | 说明 |
|---|---|---|
| `metadata` | `{"run_id": "..."}` | 运行 ID，取消时需要 |
| `updates` | `{节点名: {"messages": [...]}}` | 增量状态，前端从中提取 token / tool_call / tool_result |
| `updates` | `{"__interrupt__": [{"value": {"action_requests": [...], "review_configs": [...]}}]}` | 图挂起等人工确认（009 期） |
| `values` | `{"messages": [...]}` | 全量状态快照 |
| `error` | `{"message": "..."}` | 运行出错 |
| `end` | — | 运行结束 |

> 前端的 [events.ts](file:///Users/1token/Desktop/project/stupid-code/web/src/api/events.ts) 同时兼容 LangGraph 原生事件（`updates`/`values`）和自定义语义事件（`messages`/`tool_call`/`tool_result`/`todos`），001 期只依赖原生 `updates`。

### 恢复一次挂起的运行（009 期）

图因为人工确认挂起时，用**同一个端点**把决定送回去，图从挂起点继续：

```http
POST /threads/{thread_id}/runs/stream
Content-Type: application/json
Accept: text/event-stream

{
  "assistant_id": "code_agent",
  "command": {
    "resume": {
      "decisions": [{"type": "approve"}]
    }
  },
  "stream_mode": ["updates"],
  "on_disconnect": "continue",
  "config": {
    "configurable": {
      "workspace": "/abs/path",
      "permissions": "normal",
      "model": "minimax:MiniMax-M3"
    }
  }
}
```

- `command.resume.decisions`：**个数必须和挂起时的 `action_requests` 一样多**。框架在
  `HumanInTheLoopMiddleware.after_model` 里校验，对不上直接抛
  `Number of human decisions (N) does not match number of hanging tool calls (M)`，整个运行报错
- 拒绝的决定是 `{"type": "reject", "message": "理由"}`——字段叫 `message`，
  **不是 `feedback`**（框架 `RejectDecision` 的定义）。写错名字理由被静默丢掉
- 改完再执行的决定是 `{"type": "edit", "edited_action": {"name": "execute",
  "args": {"command": "改过的命令"}}}`（框架 `EditDecision` 的定义）。
  `execute` 允许 `approve` / `edit` / `reject` 三种；`delete` 只允许前两种里的
  `approve` / `reject`（015 期起 `delete` 也进 `interrupt_on`，只在 `manual` 档拦）。
  **非只读的 MCP 工具也一样**（`mcp__{服务器}__{工具}`）：`manual` 档下只给
  `approve` / `reject`，不给 `edit`——参数结构由服务器 schema 管（2026-10-26 review 后）
- **写记忆文件也会挂起**（017 期起）：`write_file` / `edit_file` 的目标是
  `.scode-memory.md`（项目级）或 `memory.md`（用户级，`~/.scode/`）时，
  `normal` 和 `manual` 档都挂起，只给 `approve` / `reject`。
  **不给 `edit`**——前端能改的只是 `file_path`（路径），改路径不等于改内容。
  写普通文件不受影响（谓词只看路径，不看工具名）
- `config.configurable.permissions`：**建议原样带回同一个档位**。后端的拦截判定在
  恢复时会再跑一次——不过 015 期起判定读的是**图状态里记的那一档**（开跑时写下的），
  客户端回传的值变了也不会改变判定。仍然建议原样带回，让恢复这一轮跟发起那一轮
  看到的是同一套配置
- `config.configurable.model`：同理**建议原样带回**。恢复时后端同样按它换模型，
  带空了就退回默认模型，跟批准前用的不是同一个模型
- 不带 `input`：平台把 `command` 转成 LangGraph 的 `Command(resume=...)` 当作本次运行的输入

### `POST /threads/{thread_id}/runs/{run_id}/cancel`

通知后端中止指定运行。前端点「停止」时，先断本地 SSE，再调本接口真正中止。

**请求**：无 body。

**响应 `200`**。

---

## 工作空间

### `POST /workspaces/pick`

弹**系统原生**的文件浏览窗口，让用户选一个目录作为工作空间（014 期）。

**为什么由后端弹窗**：浏览器的目录选择 API（File System Access API 的
`showDirectoryPicker()`、`<input webkitdirectory>`）**故意不暴露绝对路径**，
只给目录名 / 相对路径，绕不过去；而工作空间要的恰恰是绝对路径。后端跑在用户
自己机器上，它能调起系统的目录选择框（macOS 的 `choose folder`、Linux 的
zenity、Windows 的 FolderBrowserDialog），弹窗就弹在用户眼前——跟
「cd 到项目目录里再跑 claude」是同一个心智模型。

**请求**：无 body。

**响应 `200`** —— 三种情况：

```json
{"path": "/Users/me/projects/demo"}
```

用户选中了目录（`path` 是绝对路径）。

```json
{"path": null, "cancelled": true}
```

用户点了取消（**不是错误**，前端保持原来的选择）。

**响应 `503`**

```json
{"error": "系统里没有 zenity，弹不出目录选择框。"}
```

弹不出来（后端跑在无图形界面的环境里：Docker、纯 SSH 的服务器；或系统缺
zenity / osascript）。前端这时把「手动输入路径」的输入框亮出来。

**响应 `409`**

```json
{"error": "已经有一个目录选择框在等待用户选择，请先完成或取消它。"}
```

同一时刻只允许一个弹窗：弹窗会占住一个默认 executor 线程最多 600 秒，
并发请求既会弹出一堆窗口，也会把文件工具 / 记忆读写共用的线程池占满。

> 这个端点会**阻塞**到用户在弹窗里选完（上限 600 秒）。前端按钮显示
> 「等待选择…」。中途后端被关掉的话，这次请求不会有响应（`scode` 会整组
> 杀掉子进程，弹窗也随之消失）。

---

## 模型管理

由 `stupid_code/admin/app.py` 提供的自定义 ASGI 路由，通过 `langgraph.json` 的 `http.app` 字段挂载到 langgraph dev 服务。操作对象是项目根 `conf/config.toml`（不入库）。**改完配置需重启 `scode` 才能让运行中的 graph 加载新模型实例**——所有响应里的 `restart_required: true` 就是这个意思。

> **010 期起有一条例外**：运行期切换模型那条路径（`configurable.model`）**每次调用都
> 重新读 `conf/config.toml`**，所以新增模型、改 `base_url`、改 `api_key` 在**下一次运行**
> 就生效，不用重启。`restart_required` 指的是「后端启动时带的那个默认模型实例」——
> 改它仍然要重启。

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

## 记忆管理

agent 的长期记忆有**两个作用域**：

| 作用域 | 磁盘位置 | 跟着谁走 |
|---|---|---|
| `user` | `~/.scode/memory.md`（`$SCODE_HOME` 可改） | 用户，跨所有工作空间共用 |
| `project` | `<工作空间>/.scode-memory.md` | 项目 |

这两个文件就是 agent 读进系统提示词的长期记忆（见 `stupid_code/graph/memory.py`）。
下面的端点让前端**看和改**它们——记忆本来只在磁盘上，网页版用户想看一眼得开终端。

> **改完不会立刻生效**：记忆是会话开始时读一次的（框架机制）。改完要开新会话
> agent 才读得到。agent 自己也会用 `write_file` 往这两个文件里写，两边同时改会
> 互相覆盖（后写的赢）。

### `GET /admin/memory`

读两份记忆。

**Query 参数**

| 参数 | 必填 | 说明 |
|---|---|---|
| `workspace` | 否 | 项目级记忆对应的工作空间绝对路径。不给就用后端默认工作空间（`SCODE_WORKSPACE` 或启动时的 cwd） |

**响应 `200`**

```json
{
  "workspace": "/Users/me/projects/demo",
  "user": {
    "scope": "user",
    "path": "/Users/me/.scode/memory.md",
    "exists": true,
    "content": "# 用户级记忆\n\n- 注释用中文\n"
  },
  "project": {
    "scope": "project",
    "path": "/Users/me/projects/demo/.scode-memory.md",
    "exists": false,
    "content": ""
  }
}
```

- `exists` 为 `false` 表示文件还不存在（还没有记忆）——记忆文件**不会自动创建**。
- `workspace` 是后端**回显**的：它把软链展开了（macOS 的 `/tmp` → `/private/tmp`），
  跟 agent 看到的工作空间是同一个。
- 路径也是展开软链后的真实路径。

**响应 `400`** — 工作空间不合法：`{"error": "工作空间不存在：/Users/me/nope"}`

**响应 `500`** — 读文件失败：`{"error": "读记忆文件失败：..."}`

### `PUT /admin/memory`

写一份记忆。

**请求体**

```json
{
  "scope": "project",
  "content": "# 项目级记忆\n\n- 这个项目用 uv，不用 pip\n",
  "workspace": "/Users/me/projects/demo"
}
```

| 字段 | 必填 | 说明 |
|---|---|---|
| `scope` | ✅ | `"user"` 或 `"project"` |
| `content` | ✅ | 文件内容。**空字符串 = 清空这个文件**（文件留在原地，只是没内容） |
| `workspace` | 写 `project` 时要 | 工作空间绝对路径。`user` 作用域用不上这个字段 |

**响应 `200`**

```json
{
  "scope": "project",
  "path": "/Users/me/projects/demo/.scode-memory.md",
  "bytes": 42,
  "exists": true
}
```

**响应 `400`**

- `{"error": "scope 只能是 user / project，收到 'xxx'"}`
- `{"error": "content 必须是字符串"}`
- `{"error": "workspace 必须是字符串"}`
- `{"error": "工作空间不存在：/Users/me/nope"}`
- `{"error": "请求体不是合法 JSON：..."}`
- `{"error": "请求体必须是 JSON 对象"}`

**响应 `500`** — 读 / 写文件失败：`{"error": "写记忆文件失败：..."}`

---

## 技能清单

agent 能用的 skill 有**两个来源**（见 `stupid_code/graph/skills.py`）：

| 作用域 | 磁盘位置 | 跟着谁走 |
|---|---|---|
| `user` | `~/.scode/.agents/skills/`（`$SCODE_HOME` 可改） | 用户，跨所有工作空间共用 |
| `project` | `<工作空间>/.agents/skills/` | 项目 |

**全局是静态的，项目级不是**——项目级在工作空间里，而工作空间是运行期参数
（`configurable["workspace"]`），所以它每轮现算（见 `graph/skills.py` 的模块说明）。

### `GET /admin/skills`

列出可用的 skill，给前端的斜杠菜单用——用户在输入框敲 `/` 就能看到并勾选。

**Query 参数**

| 参数 | 必填 | 说明 |
|---|---|---|
| `workspace` | 否 | 项目级 skill 对应的工作空间绝对路径。不给就用后端默认工作空间（`SCODE_WORKSPACE` 或启动时的 cwd） |

**响应 `200`**

```json
{
  "workspace": "/Users/me/projects/demo",
  "skills": [
    {
      "name": "code-review",
      "description": "提交前自查：读改动、找缺陷和安全问题，只输出问题清单",
      "scope": "user",
      "source": "/user-skills/",
      "path": "/user-skills/code-review/SKILL.md"
    },
    {
      "name": "run-tests",
      "description": "这个项目的测试怎么跑、怎么挑要跑哪几个",
      "scope": "project",
      "source": "/.agents/skills/",
      "path": "/.agents/skills/run-tests/SKILL.md"
    }
  ]
}
```

| 字段 | 说明 |
|---|---|
| `name` | skill 名。同时也是**勾选时用的名字**（放进 `configurable.skills`） |
| `description` | 来自 `SKILL.md` 的 YAML frontmatter |
| `scope` | `user`（全局）/ `project`（项目级） |
| `source` | 来源目录的**虚拟路径前缀** |
| `path` | `SKILL.md` 的**虚拟路径**——不是宿主绝对路径 |

**同名时项目级覆盖全局**（框架按源顺序读，后面的覆盖前面的）。

> `path` 是虚拟路径，由 agent 的 backend 在运行期解析：项目级的相对当前工作空间根，
> 全局的走 `/user-skills/` 路由指向 `~/.scode/.agents/skills/`。**前端不要把它拼成
> 绝对路径**。

**响应 `400`** — 工作空间不合法：`{"error": "工作空间不存在：/Users/me/nope"}`

**响应 `500`** — 读目录失败：`{"error": "读 skill 目录失败：..."}`

---

## 未实现

（暂无。014 期起工作空间走 `POST /workspaces/pick`，不再需要目录列表端点。）

---

## 备注

- 本文档仅列**已被代码调用**的端点，完整 LangGraph Platform API 见官方文档。
- 端点参数与响应以 [web/src/api](file:///Users/1token/Desktop/project/stupid-code/web/src/api) 和 [admin/models.py](file:///Users/1token/Desktop/project/stupid-code/stupid_code/admin/models.py) 中的实际调用为准。

---

## 已验证的事实

实测结论**统一收在** [`docs/backend/PROGRESS.md`](../docs/backend/PROGRESS.md) §8「已验证的事实」——
那是后端的活文档，按期分节（平台与框架 / 持久化 / HITL / 模型切换 / 压缩 / MCP / 工作空间 /
记忆 / skill），每条都注明了验证时间。框架在 0.x 迭代快，改行为前先去那里核。

本文档只管**接口形状**：请求体字段、响应字段、状态码。形状类的说明在上面的端点章节里
逐个端点写着（比如 `POST /threads` 的 body 必填、`runs/stream` 的 body 形状、
`/admin/memory` 的响应字段）。

### 官方文档

- Create Thread — <https://docs.langchain.com/langsmith/agent-server-api/threads/create-thread>
- Search Threads — <https://docs.langchain.com/langsmith/agent-server-api/threads/search-threads>
- Streaming API — <https://docs.langchain.com/langsmith/streaming>
