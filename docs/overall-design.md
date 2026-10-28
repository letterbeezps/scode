# 网页版 Code Agent 总体设计文档

> 版本：v0.2
> 日期：2026-10-16
> 变更说明：v0.1 → v0.2 补齐前后端契约、安全设计、运行护栏；修正与 `web/` 实现不一致的技术选型

---

## 1. 项目概述

本项目旨在开发一个 **网页版 Code Agent** 应用，用户通过浏览器与 AI 编码助手进行对话，Agent 能够读取、编辑项目文件，执行终端命令，辅助完成软件开发任务。

### 1.1 目标

- 提供与主流 Code Agent（如 Cursor、Cline、Trae）一致的交互体验
- 前后端分离，后端基于 Deep Agents 框架 + langgraph-cli 提供 Agent 能力
- 前端为独立网页应用，通过 HTTP 与后端通信
- 支持流式输出、工具调用可视化、文件 Diff 查看等核心体验

### 1.2 非目标（本期不做）

- 多用户协作 / 完整权限系统（单机单用户，权限仅指"危险操作是否需确认"）
- 云端部署与多租户
- 移动端适配（优先桌面端）
- 后端工具的**分布式**沙箱隔离（本期依赖操作系统权限 + 工作空间约束，见 §6）

> 说明：工作空间（workspace）**不在**非目标内。它是前端已实现的核心功能，后端必须支持，见 §5.2。

### 1.3 当前进度（与文档描述的差异）

本文档 §3 描述的是**目标设计**，代码现状落后于文档。接手时先看这里：

| 部分 | 文档描述 | 代码现状 |
|---|---|---|
| 前端 `web/` | 完整实现 | ✅ 已完成 5920 行 TS/TSX，mock 与真后端两套都能跑 |
| 后端 Agent | §3 完整设计 | ⚠️ 001–018 期均已落地（真实磁盘 + shell、长期记忆、shell 人工确认、子 agent 配置、运行期切模型、手动压缩历史、MCP、按任务生效的工作空间、用户级记忆 + 记忆面板、skill 两个作用域）。运行护栏等自研中间件仍未做 |
| 后端依赖 | Deep Agents + LangGraph | ✅ 已装齐并锁进 `uv.lock` |
| `langgraph.json` | §3.2 已给出 | ✅ 在 `stupid_code/` 目录（不是根目录），图注册 + http.app + checkpointer/store 都已配 |
| 模型配置 | §4 多供应商 | ✅ `conf/config.toml` + `/admin/models` 管理接口（002 / 003 期） |
| 子 agent | §3 委派机制 | ✅ `conf/subagents.toml` 声明，`task` 工具可调（004 期） |
| MCP 工具 | —（013 期新增） | ✅ `conf/mcp.json` 声明，http / stdio 都支持；建图时静态注册（改配置需重启），每个服务器一条长会话；`manual` 档下非只读工具走人工确认 |
| 目录浏览端点 | §4.1 已定义 | ✅ 已实现（014 期）：`POST /workspaces/pick` 弹系统原生目录选择框 |
| skill | —（018 期新增） | ✅ 全局 `~/.scode/.agents/skills/` + 项目级 `<工作空间>/.agents/skills/`；`GET /admin/skills` 列清单；用户勾选的 `SKILL.md` 全文钉进上下文 |

**这意味着：写后端时不需要"对齐已有实现"，而是要"实现前端已经假定的契约"。** 契约清单见 §4。

---

## 2. 系统架构总览

系统采用 **前后端分离** 架构，分为三层：

```
┌─────────────────────────────────────────────────────┐
│                   前端 (web/)                       │
│   React 19 / TypeScript / Vite / TailwindCSS / zustand│
│   - 对话窗口、侧边栏、工具调用展示、Diff 查看          │
│   - fetch + ReadableStream 手动解析 SSE              │
└──────────────────────┬──────────────────────────────┘
                       │ HTTP / SSE
┌──────────────────────▼──────────────────────────────┐
│           后端 (LangGraph API Server)                │
│   langgraph-cli 启动，暴露 LangGraph Platform API     │
│   - Agent 运行时（Deep Agents）                       │
│   - 对话状态持久化（thread_id / checkpointer）        │
│   - 流式事件推送（SSE）                               │
└──────────────────────┬──────────────────────────────┘
                       │
┌──────────────────────▼──────────────────────────────┐
│           Agent Core (Deep Agents)                   │
│   create_deep_agent() 构建的代码助手                  │
│   - FilesystemMiddleware：ls/read_file/write_file...  │
│   - HumanInTheLoopMiddleware：危险操作确认（§5.3）    │
│   - TodoListMiddleware：任务规划（需显式启用）        │
│   - task 工具：子 Agent 委派                          │
└─────────────────────────────────────────────────────┘
```

### 2.1 技术栈

| 层级 | 技术选型 |
|------|---------|
| 前端 | React 19.2 / TypeScript 6 / Vite 8 / TailwindCSS 4 / zustand 5 / shiki |
| 后端运行时 | Python 3.12+、Deep Agents、LangGraph、langgraph-cli |
| 服务启动 | langgraph-cli（`langgraph dev` / `langgraph up`） |
| 通信协议 | HTTP REST + Server-Sent Events (SSE) |
| 状态持久化 | LangGraph Checkpointer（开发期 InMemory，生产 Postgres） |
| 源码目录 | `web/`（不是 `frontend/`，见 §9） |

---

## 3. 后端设计

> 后端详细设计将单独成文，此处说明与前端对接及系统护栏相关的部分。

### 3.1 Agent 构建

使用 `create_deep_agent()` 构建代码助手。

**⚠️ 版本敏感提示**：Deep Agents 的 API 在演进中，参数名与默认行为都发生过变化（例如早期版本的 `instructions` 现为 `system_prompt`；`TodoListMiddleware` 从 v0.7 起改为 opt-in）。**本文档不硬编码易变的默认值**，具体签名以本项目锁定版本的官方文档为准，核实方式：`.venv/bin/python -c "import inspect, deepagents; print(inspect.signature(deepagents.create_deep_agent))"`。

**模型**：可配置的 LLM，通过 `model` 参数传入字符串或 LangChain 模型对象。API key 从环境变量读取。

**系统提示词**：`system_prompt` 参数，见 `stupid_code/config/prompts.py`。

> ⚠️ **0.7.28 已无内置基础提示词**：早期版本会在作者提示词之前垫一段框架内置提示词
> （承载工具使用规范），但 `BASE_AGENT_PROMPT` 在 `deepagents==0.7.0` 废弃（0.9.0 移除），
> `HarnessProfile.base_system_prompt` 默认也是 `None`，内置的几个 profile（claude-opus-4-7 /
> sonnet-4-6 / haiku-4-5）也都没设。**实测结论：传进去的 `system_prompt` 就是模型唯一
> 看到的系统提示词**，没有内置提示词打底。
> 核实方式：用假模型把 `request.system_message` 打出来（见 `stupid_code/config/prompts.py` 的
> docstring 里记的验证方法）。因此行为准则要自己写全，不能指望框架兜底。

**中间件（middleware）**：Deep Agents 是"一切皆中间件"架构，按需组合：

| 中间件 | 来源 | 作用 | 备注 |
|---|---|---|---|
| `FilesystemMiddleware` | 框架内置 | 提供 ls / read_file / write_file / edit_file / glob / grep / delete | **必需脚手架，不可移除**；可自定义实例来限定工具集与 backend（§5.2） |
| `HumanInTheLoopMiddleware` | LangChain 提供 | 危险操作执行前挂起等用户确认 | §5.3 详述；**顺序要求见 §6.3** |
| `TodoListMiddleware` | LangChain 提供 | 提供 `write_todos` 工具 | **需显式加入，不是默认启用** |
| 计时 / 日志中间件 | 自研 | 埋点、耗时统计 | §7 |

**工具集**：框架内置文件工具 + 通过 `tools` 参数传入的自定义工具。

> ⚠️ 通过 `create_deep_agent(tools=...)` 传入的自定义工具**不受** `FilesystemMiddleware` 的工具 allowlist 限制。自定义工具的权限必须自己实现拦截（§6.2）。

**文件系统后端（backend）**：Deep Agents 暴露给模型的是一个虚拟文件系统抽象，文件实际存哪里由 backend 决定，可选内存 / 本地磁盘 / LangGraph store / 自定义。

> ⚠️ **默认配置不满足本项目需求**。必须显式配置为真实本地磁盘后端，否则模型读写的是状态里的虚拟文件，改动不落盘，编码场景直接失效。这是 P0 阶段的第一个坑。
> 核实方式：配置完成后跑一个最小用例——让 Agent 写一个临时文件，检查磁盘上是否真的出现该文件。
>
> 📌 **007 期落地**：`stupid_code/graph/backend.py` 构造 `CompositeBackend(default=LocalShellBackend)`
> ——真实磁盘 + 本机 shell（`execute` 由此而来）。
> 框架的硬限制：**backend 支持命令执行时不能同时用 `permissions`**（shell 能绕过任何权限），
> 所以声明了 `permissions` 的子 agent 会被换成无 shell 的 backend。
> 详见 `docs/backend/PROGRESS.md` 的「007 · 真实 backend」一节。
>
> 📌 **020 期调整**：原先还有一条 `/tmp/` → `StateBackend` 的虚拟路由（会话内临时区），已删除——
> 它是唯一可能跟宿主绝对路径撞上的路由，为它单独养了一层守卫类，而它提供的临时区跟项目自己的
> 产物策略（收在 `<工作空间>/.scode/`）重复。现状见 PROGRESS 的「020 · 删掉 `/tmp/` 路由」。
>
> 📌 **016 期补充**：`CompositeBackend` 的 `artifacts_root` 决定 agent 自己的中间产物落在哪
> （对话历史 / 超大工具结果 / 二进制块，默认 `/` = 工作空间根目录）。本项目设成 `/.scode`，
> 收成一个隐藏目录，详见 `docs/backend/PROGRESS.md` 的「8.10 agent 自己的中间产物」。

**子 Agent**：框架内置 `task` 工具与 general-purpose 子 Agent，可通过 `subagents` 参数扩展。子 Agent 会继承父 Agent 的工具限制（§5.2 的 allowlist），但**不自动继承权限档位**——见 §5.3 的注意事项。

> 📌 **004 期落地**：子 agent 的声明放 `conf/subagents.toml`（`stupid_code/config/subagent.py` 解析），
> `model` 字段复用 `config.toml` 的供应商连接信息。**框架不会把子 agent 名单写进系统提示词**，
> 名单只出现在 `task` 工具的 description 里（跟着配置自动更新）。
> 实测（MiniMax-M3）：光靠工具描述，主 agent 基本不会主动委派，倾向自己干；把名单点名写进
> 提示词也**没有**明显改变。起决定作用的是用户请求里明确要求委派。详见
> `docs/backend/PROGRESS.md` 的「004 · 子 agent 配置」一节。

### 3.2 服务启动

通过 `langgraph-cli` 启动 LangGraph API Server：

```bash
# 开发模式（热重载，默认端口 2024）
langgraph dev

# 生产模式（Docker Compose + Postgres，默认端口 8123）
langgraph up
```

`langgraph.json` 配置指向 Agent Graph（**该文件当前尚不存在，需创建**）：

```json
{
  "dependencies": ["."],
  "graphs": {
    "code_agent": "./stupid_code/graph/agent.py:graph"
  },
  "env": "./.env"
}
```

前端默认把 `/api` 前缀的所有请求通过 Vite 代理转发到 langgraph-cli，因此开发态无需跨域配置（§6.1）。

### 3.3 前端调用约定的参数传递

前端通过 run 的 `context` 传递任务参数（后端用 `context_schema=RunContext` 声明结构），在图入口处读取：

| context 字段 | 取值 | 含义 |
|---|---|---|
| `workspace` | 绝对路径字符串，空字符串表示未选择 | 工作空间根路径（§5.2） |
| `permissions` | `'manual'` \| `'normal'` \| `'auto'` | 危险操作确认档位（§5.3） |
| `model` | `'供应商名:模型名'`，空字符串表示未选择 | 运行期切换对话模型（010 期） |
| `skills` | 字符串数组 | 本次对话勾选的 skill 名字（018 期） |

> ⚠️ **命名冲突警告**：前端传的 `permissions`（确认档位）与 Deep Agents `create_deep_agent(permissions=...)` 参数（文件读写的路径 ACL 规则）**是两个完全不同的东西**，只是重名。后端代码里建议把档位变量命名为 `permission_level` 以免混淆，但对前端暴露的 context key 保持 `permissions` 不变（前端已硬编码）。

> **`workspace` / `permissions` / `skills` 是任务级参数**（按 thread 存），`model` 是全局偏好。
> **恢复挂起的运行时，这几个都要原样带回去**——后端在恢复时会重新读它们。
> **`context` 和 `config.configurable` 不能同时非空**：同一请求两者并存会被 Agent Server 拒绝（400）。

---

## 4. 前后端契约

> 这是本文档最重要的部分。**前端已实现，后端必须照此实现**，否则返工。

### 4.1 API 端点全表

| 方法 | 路径 | 用途 | 状态 |
|---|---|---|---|
| POST | `/threads` | 创建对话线程 | LangGraph 提供 |
| GET | `/threads` | 列出对话线程（前端侧边栏） | LangGraph 提供 |
| DELETE | `/threads/{thread_id}` | 删除对话线程 | LangGraph 提供 |
| POST | `/threads/{thread_id}/runs` | 创建运行（**也用于提交确认决策**，§5.3） | LangGraph 提供 |
| POST | `/threads/{thread_id}/runs/stream` | 流式运行（SSE） | LangGraph 提供 |
| GET | `/threads/{thread_id}/state` | 获取线程当前状态 | LangGraph 提供 |
| POST | `/threads/{thread_id}/runs/{run_id}/cancel` | 取消运行 | LangGraph 提供 |
| GET | `/threads/{thread_id}/runs/{run_id}/stream` | **重新接入已有运行的流**（断线恢复，§6.4） | LangGraph 提供 |
| POST | `/workspaces/pick` | **弹系统原生目录选择框，选一个工作空间** | **自研实现**（014 期） |
| GET | `/admin/skills` | **列可用的 skill（全局 + 项目级）** | **自研实现**（018 期） |

> 端点列表已与 `web/src/api/*.ts` 的实际调用逐一核对（2026-10-16；`/admin/skills` 于 2026-10-26 补）。

**历史消息从哪里来**：前端不调用 `/threads/{tid}/history`，而是从 `GET /threads/{tid}/state` 返回的 `values.messages` 里自行转换（见 `web/src/api/thread.ts`）。后端无需额外处理，但要知道前端依赖这个结构——`values.messages` 必须是完整的 LangChain 消息数组。

### 4.1.1 工作空间怎么选（014 期定的方案）

**点工作空间按钮 → 弹系统原生文件浏览窗口 → 选一个文件夹。**

```
POST /workspaces/pick
  → {"path": "/abs/path"}              选中了
  → {"path": null, "cancelled": true}  用户点了取消（不是错误）
  → 503 {"error": "..."}               弹不出来（无图形界面等）
  → 409 {"error": "..."}               已经有一个弹窗在等（同一时刻只允许一个）
```

**为什么由后端弹窗**：浏览器的 File System Access API 与 `<input webkitdirectory>` 都**故意不暴露绝对路径**（只给 name / 相对路径），这是防泄漏设计，无法绕过。而工作空间需要的就是绝对路径。

后端跑在用户自己机器上，它能调起系统的目录选择框（macOS 的 `choose folder`、Linux 的 zenity、Windows 的 FolderBrowserDialog），弹窗就弹在用户眼前——跟「cd 到项目目录里再跑 claude」是同一个心智模型。

**为什么不是「后端返回目录列表」**（原设计里的 `GET /directories?path=...`）：那等于把文件系统目录树开放成一个 HTTP 接口，得配路径白名单、403 语义、一堆安全说明，而它解决的问题（让用户选个目录）用系统弹窗更直接。后端不需要"知道有哪些目录"。

**「之前聊过的项目」列表不走后端**：工作空间记在每个 thread 的 `metadata.workspace` 里，前端从线程列表里直接读（见 `web/src/components/chat/WorkspacePicker.tsx`）。

**安全要求**：这个端点会**阻塞**到用户在弹窗里选完（上限 600 秒），别做成同步阻塞整个事件循环的写法（§6.1 的 `127.0.0.1` 限制照旧）。

### 4.2 SSE 事件契约

**后端以 LangGraph 原生事件为准**，前端做归一化转换。

原生事件类型：`metadata` / `updates` / `values` / `error` / `end`。

前端 `api/events.ts` 已实现的归一化逻辑（后端无需额外配合）：

| 原生事件 | 前端归一化结果 |
|---|---|
| `metadata` | 提取 `run_id`，用于取消运行 |
| `updates` 中的 `ai` 消息 | → `token`（文本追加）+ `tool_call` + `todos` |
| `updates` 中的 `tool` 消息 | → `tool_result` |
| `values` | → `todos`（幂等快照） |
| `error` | → `error` |
| `end` | → `end` |

前端同时兼容一份**可选的自定义语义事件**（`messages` / `tool_call` / `tool_result` / `todos` / `error` / `end`）。若后端发送这类事件，前端优先采信；若两者同时发送，前端会自动去重（收到过显式 `messages` 就不再从 `updates` 推导 token）。

> **建议**：后端**只发 LangGraph 原生事件**。原生事件是平台契约，升级时不会变；自定义封装是自担风险。前端保留兼容层无妨，但后端不必依赖它。

**关于流式粒度**：前端当前用 `stream_mode: ['updates']`。这是**消息级**更新，不是逐 token。若需要真正的 token 级流式，应改用 `stream_mode: ['messages', 'updates']`——但这会增加前端归一化复杂度。**当前决策：接受消息级追加**，P1 阶段如需逐 token 效果再升级。

> 核实方式：P0 联调时观察 `updates` 事件中 AI 消息的到达粒度。若是一条消息分多次到达则流式体验自然；若整条消息一次性到达，文本会有明显的"整段蹦出"感。

### 4.3 断线行为参数

前端创建运行时固定传：

```typescript
{
  on_disconnect: 'continue',   // 浏览器断开后后端继续跑完
  stream_mode: ['updates'],
}
```

LangGraph 的 `on_disconnect` 与 `stream_resumable` 有四种组合：

| on_disconnect | stream_resumable | 行为 |
|---|---|---|
| `cancel`（默认） | `false`（默认） | 断连即终止运行 |
| `continue` | `false` | **当前配置**：Agent 继续跑，但断连期间的事件丢失、无法回放 |
| `cancel` | `true` | 事件被缓冲，但 Agent 被取消，无新事件 |
| `continue` | `true` | 完整可恢复流 |

**当前配置的已知缺口**：用户刷新页面后，正在进行的运行既接不回流（`stream_resumable: false`），也不知道它还在跑。补救方式见 §6.4。若要根治，需打开 `stream_resumable: true`（代价：事件被持久化缓冲，内存/存储开销增加），并由前端在重连时调用 join 接口。本期先不打开，用 §6.4 的低成本方案兜住。

---

## 5. 核心机制设计

### 5.1 消息数据模型

**以 `parts` 为主，`content` / `tool_calls` 为派生。**

v0.1 的设计只有平级的 `content` + `tool_calls`，无法表达"先说一段话 → 调工具 → 再接着说"的顺序。前端实现时已改用有序片段（见 `web/src/api/types.ts`），文档同步：

```typescript
type MessagePart =
  | { kind: 'text'; text: string }
  | { kind: 'tool'; call: ToolCall }

interface Message {
  id: string
  thread_id: string
  role: 'user' | 'assistant' | 'tool'
  parts: MessagePart[]        // 渲染一律以此为准
  content: string             // 派生：所有 text part 拼接
  tool_calls?: ToolCall[]     // 派生：所有 tool part
  tool_call_id?: string
  created_at: string
  error?: string              // 运行失败时写入
  interrupted?: boolean       // 用户主动停止
}
```

其余数据模型（Thread / ToolCall / ToolResult）与前端实现一致，见 `web/src/api/types.ts`，本文档不重复。

### 5.2 工作空间隔离

前端已实现工作空间选择器，并把绝对路径通过 `context.workspace` 传给后端。**014 期已落地**（见 `stupid_code/graph/workspace.py`）。

**实际做法**：

- **根目录是运行期属性**：框架把 backend 的根目录存在 `self.cwd` 里，所有路径解析都从它出发。本项目把它做成 property，每次取值读当前运行的工作空间（工具热路径读平台镜像的 `configurable.workspace`）——同一张图能服务不同项目目录的对话。
- **文件工具的路径由框架自己兜住**：`virtual_mode=True` 时 `FilesystemBackend._resolve_path` 会 `resolve()` 展开软链再校验是否落在根目录内，`..` / `~` / 越界绝对路径都进不来。
- **workspace 自己也 realpath**：否则软链目录会失效（macOS 上 `/tmp` → `/private/tmp`，不解析的话框架的越界检查会误判）。
- **工作空间路径不会被路由吃掉**：路由按虚拟前缀匹配，`/user-memory/` 和 `/user-skills/` 在磁盘上并不存在，宿主绝对路径不会撞上它们；工作空间自己的绝对路径由 `_resolve_path` 剥掉前缀后按虚拟路径处理。
- **每轮运行开跑前重新校验**：存在性 / 目录类型 / 软链解析都在 `before_agent` 里重做（放线程），结果刷进缓存供热路径读取——只缓存首次结果的话，目录被删掉后校验会永远命中缓存、形同虚设。
- **一次 run 内锁定**：`context` 是运行级参数，一轮对话中途改不了。
- **空字符串 = 用后端默认工作空间**（`SCODE_WORKSPACE` 或启动时的 cwd），不是拒绝一切操作——原生跑法（`cd project && uv run scode`）里用户没有前端可选。
- **刷新页面后从 thread metadata 回填**：前端把 `workspace` / `permissions` 写进 thread 的 metadata，`loadThreads` / `selectThread` 时回填本地的任务参数；审批挂起期间选择器禁用，恢复时带回的就是发起 run 时的值。
- **工作空间不合法 = 这一轮直接失败**（「工作空间不存在：xxx」），**不静默退回默认目录**——那等于把 agent 的写操作落到用户没选过的目录里。

**没做的**：§6.1 之外没有更细的沙箱。deepagents 是 "trust the LLM" 模型，agent 有 shell 就能碰整个文件系统；工作空间是"默认在哪干活"，不是安全边界。

**Deep Agents 自带机制**：`create_deep_agent(permissions=[...])` 提供文件读写的路径 ACL（glob 模式 + allow/deny，first-match-wins）。本项目只在**子 agent** 上用它（`conf/subagents.toml` 里 `reviewer` 的只读），主 agent 走的是「根目录就是工作空间」这条路——因为主 agent 有 shell，框架明确拒绝「backend 支持命令执行 + 文件权限」这种组合（见 `graph/backend.py`）。

### 5.3 危险操作确认机制

前端已实现三档权限选择器，并把档位通过 `context.permissions` 传给后端：

| 档位 | 前端描述 | 期望语义 |
|---|---|---|
| `manual` | 命中危险操作的，先确认再执行 | 按**固定规则**判定危险，命中即中断确认 |
| `normal` | AI 审核这次操作是否危险，再决定要不要确认 | 由 **LLM 判断**是否危险，默认档位 |
| `auto` | 不确认，直接执行 | 不挂起，但**仍需审计日志** |

前端代码注释明确指出："后端需要在工具调用入口按 permissions 拦截并挂起等前端确认，否则这两项只是摆设。"

**后端实现方式**：

LangChain 提供 `HumanInTheLoopMiddleware`，通过 `interrupt_on` 声明哪些工具需要确认：

- `True`：每次调用都挂起
- `False`：自动执行
- dict：可指定 `allowed_decisions`、说明文案、条件 `when`

支持的人工决策有四种：`approve`（原样执行）/ `edit`（改参数后执行）/ `reject`（不执行，把理由反馈给模型）/ `respond`（把人工回复当作工具结果返回）。

**三档映射到实现**：

| 档位 | 实现 |
|---|---|
| `auto` | 不配置 `interrupt_on`，或全部置 `False` |
| `manual` | 用**固定规则**判定危险：`interrupt_on` 中对所有写入类/命令类工具置 `True`，或用 `when` 回调按工具名/命令特征判断 |
| `normal` | 用 **LLM 审核**：在 `interrupt_on` 的 `when` 回调里调用一个轻量模型判断本次操作是否危险 |

**⚠️ 三个必须写进实现的坑**：

1. **`when` 回调必须是同步函数**，不能直接在里面调异步模型。`normal` 档的 LLM 审核需要特殊设计——推荐改为：在图里加一个审核节点，或用 `interrupt_before` 在节点粒度挂起。**这一档的实现方案需要在 P0 阶段先做技术验证**，不要假设能直接塞进 `when`。

2. **`when` 在恢复执行时会再次运行，且必须对同一次调用返回一致结果。** 如果首次判断为"需要确认"、恢复时变成"不需要"，审批结果会被忽略、工具直接执行——**即使用户点了拒绝**。所以审核结论必须持久化，不能靠重算。

3. **恢复时中间件会再次运行，副作用会被重复触发。** 官方明确警告：审批点之前运行的 middleware 若有副作用，一次恢复可能重复执行。因此：
   - 有副作用的操作（写文件、执行命令）必须放在 interrupt **之后**
   - `HumanInTheLoopMiddleware` 必须放在 `ToolRetryMiddleware` / `ToolErrorMiddleware` **之前**，否则重试可能绕过审批

4. **中断恢复不提供幂等保证。** 官方原话是"中断恢复并不是对副作用的自动去重保证"。副作用工具自己要用幂等键或去重机制。

**确认请求的传递**：

```
前端                LangGraph Server              图 / 工具
 │ POST /runs/stream │                             │
 ├──────────────────>│                             │
 │                   │──── 调用危险工具 ──────────>│
 │                   │<─── interrupt 挂起 ────────┤
 │<── updates 中含 __interrupt__ ───────────────────┤
 │                   │      （含 tool 名、参数、     │
 │                   │        allowed_decisions）   │
 │ 渲染确认卡片       │                             │
 │                   │                             │
 │ 用户决策           │                             │
 ├──── POST /threads/{tid}/runs ──────────────────>│
 │      {command: {resume: {decisions: [...]}}}     │
 │                   │──── 从 interrupt 处继续 ────>│
 │<──── tool_call / tool_result / end ─────────────┤
```

**前端尚需补充的部分**：当前前端只有档位选择器，**还没有确认卡片组件**，也没有提交决策的 API 封装。这是 P2 的前端工作量，§10 已列入。

**恢复请求的形态**（两种模式）：

- **batched 模式**（默认）：一次返回全部待审工具，`resume` 传 `{decisions: [...]}`，**顺序必须与 `action_requests` 一致**
- **per_call 模式**：每个工具调用独立 interrupt ID，`resume` 传 `{[interrupt_id]: {...}}`

官方推荐新应用使用 `per_call`（可单独审批、不会因顺序映射混淆）。但 `per_call` 对 langchain 版本有下限要求（`>=1.4.6`）。**本期先用 batched 模式跑通，per_call 作为后续优化**，核实方式：查本项目锁定版本的 langchain 版本号与官方 changelog。

**未回答的中断会保持 pending**，工具不会执行，用户可以稍后回答。这正好支持"页面刷新后再决定"的场景——但前提是能恢复连接，见 §6.4。

### 5.4 运行护栏（有界自主）

**没有上限的 Agent 循环是事故，不是特性。** 一个能读文件、能执行命令的 Agent 失控时，烧钱和破坏文件都可能发生。必须定义：

| 护栏 | 建议初值 | 触发后行为 |
|---|---|---|
| 工具调用次数上限 | 50 次 / run | 中止，返回当前最佳结果 + 说明已达上限 |
| 单 run token 预算 | 见下方说明 | 中止，返回当前最佳结果 |
| 墙钟上限 | 5 分钟 / run | 中止 |
| 无进展检测 | 连续 N 步无文件变更且无新命令 | 中止并提示可能陷入循环 |
| 单个工具超时 | 命令类 120s，文件类 30s | 返回超时错误，让模型自行决策 |

**token 预算必须按实际模型定价换算**，不同模型差价很大。`[待核实]` 换算系数需查所用模型的官方定价页后配置，不要凭记忆写数字。

**护栏的实现层次**：

- 次数 / 超时 / 预算 → 用 LangGraph 的 `recursion_limit` 与自定义中间件
- 无进展检测 → 自研中间件，统计文件变更与命令执行的有序哈希

**中止时的行为**：不能静默失败。必须产出结构化的终止原因（`max_steps` / `budget_exhausted` / `timeout` / `no_progress`），前端据此显示明确提示，并**保留已完成的部分结果**——用户已经能拿到一半工作成果，这比全部丢弃有价值得多。

### 5.5 错误处理矩阵

| 场景 | 处理策略 |
|---|---|
| LLM 调用超时 | 显式超时值 + 指数退避重试 2 次（**必须带抖动**）；只重试幂等的临时失败 |
| 工具执行超时 | 返回超时错误给模型，让它自行决策（换路径、改方案）；不自动重试 |
| 工具执行失败（业务错误） | 把错误作为 ToolMessage 返回给模型，不中断整个 run |
| SSE 连接中断 | 前端已设 `on_disconnect: 'continue'`，后端继续跑；前端需处理重连（§6.4） |
| 单次运行失败 | 保留已完成的部分结果，不整体丢弃 |
| 达到护栏上限 | 见 §5.4，返回部分结果 + 终止原因 |
| 中断校验失败 | 恢复请求非法时平台返回校验错误，前端应能重新提交同一 interrupt ID 的决策 |
| 后端进程崩溃 | 前端须显示"连接断开"明确提示，不能静默卡在生成中 |

**异常分类原则**：分三类处理——可重试（网络抖动）、需人工（权限确认、参数非法）、终止（预算耗尽、护栏触发）。不同类别走不同路径，不要一律重试。

---

## 6. 安全设计

> 一个能在本机执行命令的 Web 服务，安全章节不能只有一句话。
>
> **当前的安全姿态表（每条边界的现状）见
> [`docs/backend/PROGRESS.md`](backend/PROGRESS.md) §5「安全姿态」**，已知缺口见同节 §6。
> 本节只写**设计意图和理由**——同一件事不要在两处各写一遍。

### 6.1 监听地址

**默认只绑 `127.0.0.1`，禁止 `0.0.0.0`。**

这是最重要的一条。绑定 `0.0.0.0` 意味着同一网络内任何人都能访问，而访问者能做的事包括：在你的机器上执行任意命令、读写你的文件、枚举你的文件系统。

若确需局域网访问，必须显式开启并同时满足：配置强鉴权 + 启用 HTTPS + 在文档与日志中明确告警。

### 6.2 鉴权与 CSRF

**前端已用自定义 header（`Authorization: Bearer <key>`）而非 cookie 鉴权，这是正确的**，浏览器不会自动为跨站请求附带此类 header，因此 CSRF 风险已被规避。

保持这个选择，**不要为了"简化"改成 cookie 鉴权**——那会立刻引入 CSRF 风险：长驻凭据 + 跨站请求 = 任意网页可以让你机器跑代码。

- 开发阶段：可选，本地直连
- 生产阶段：`Authorization` header 或反向网关鉴权
- 凭据只从环境变量读取，**禁止硬编码、禁止进日志**

前端另有一点做得好：SSE 用 `fetch + ReadableStream` 手动解析而非 `EventSource`，正是因为 `EventSource` 不支持自定义 header。这个选择必须保持。

### 6.3 中间件顺序

`HumanInTheLoopMiddleware` 必须放在 `ToolRetryMiddleware` / `ToolErrorMiddleware` **之前**，使其包裹这些中间件。

否则被重试、或作为无效回答处理的工具调用可能**绕过审批**直接执行——这是安全漏洞，不只是风格问题。

**skill 中间件排在记忆中间件之前**（018 期）：记忆块要留在系统提示词的**最后一块**
（prompt-caching 的断点落在那一块上），skill 块在它之前，同样在缓存范围内。
⚠️ **别给 `create_deep_agent(skills=...)`**——传了 deepagents 会在 core 栈挂一份自己的
`SkillsMiddleware`，我们的中间件只能顶替它，而顶替保留的是 core 栈的位置（更内层），
skill 块就会跑到记忆块后面。

### 6.4 断线恢复

当前 `stream_resumable: false`，用户刷新页面会丢失进行中的运行。低成本兜底方案（P1 实现）：

1. 前端记录每次运行的 `run_id`（已从 `metadata` 事件获取并存储）
2. 页面加载时检查当前 thread 是否有未完成的 run（调 `GET /threads/{tid}/state`）
3. 有则提示用户"检测到未完成的运行"，提供"重新接入"按钮
4. 用户确认后调用 `GET /threads/{thread_id}/runs/{run_id}/stream` 接回

接回的流只能拿到**接上之后**的事件。之前错过的部分，通过 `GET /threads/{tid}/state` 的 `values.messages` 补齐（这是前端已经在用的历史来源，§4.1）。需要注意补齐的是"完整消息"而非"事件序列"，因此若中断期间发生了工具调用，可能只能看到最终结果而非过程。`[待核实]` 平台是否提供更细粒度的历史事件接口。

### 6.5 路径与命令安全

| 风险 | 防护 |
|---|---|
| `../` 路径逃逸 | realpath 归一化 + 前缀校验（§5.2） |
| 符号链接逃逸 | 校验前必须 `os.path.realpath()` 而非 `abspath()` |
| 读取敏感文件（.ssh / .env / .aws） | 在工作空间约束内则天然隔离；显式黑名单 `[待核实: 具体清单需按项目实际环境确定]` |
| 读取工作空间之外的目录 | 两条**只覆盖一个目录**的例外：`/user-memory/`（`~/.scode/`，可写——用户级记忆）和 `/user-skills/`（`~/.scode/.agents/skills/`，只读——全局 skill）。工作空间内的路径依然出不去（017/018 期） |
| 危险 shell 命令（`rm -rf` / `curl \| sh`） | 命中危险模式的命令走 `manual` 档确认；模式规则需按项目实际需要制定 |
| 日志泄露 | 工具入参出参中的凭据、token 需脱敏后再落日志（§7） |

> ⚠️ 沙箱问题：Deep Agents 的 sandbox backend 与 filesystem permissions 是**两套独立机制**，filesystem 的权限规则**不适用于 sandbox**。若使用 sandbox 执行命令，不能依赖文件 ACL 来限制 shell 能访问什么，需要额外的 backend policy hook。`[待核实: 本项目最终是否启用 sandbox backend，以及启用后的隔离强度]`

---

## 7. 可观测性与评测

### 7.1 埋点

至少埋这些，缺了出问题无法定位：

| 项 | 说明 |
|---|---|
| `trace_id` | 贯穿全链路。thread_id + run_id 已有，需在日志中显式串联 |
| 工具调用埋点 | 工具名、耗时、成败。前端 `ToolCall.startedAt` 已在收集耗时，可上报 |
| token 用量与成本 | 按 run 汇总，用于成本控制 |
| 中断与审批埋点 | 哪些工具触发了确认、用户 approve/reject 的比例（拒绝率高说明提示词或工具设计有问题） |
| 护栏触发埋点 | 哪种护栏触发、触发时已消耗多少 |

**关键指标**：

- 运行成功率
- 工具调用失败率
- 平均 / P95 工具耗时
- 单 run 平均成本
- 人工拒绝率

### 7.2 评测集

Code Agent 的质量很难靠"点几下感觉不错"判断。

**P2 之前**准备一组固定任务（建议 ≥ 20 条），覆盖：

- 正常：补单元测试、修报错、加功能
- 边界：大文件、超长函数、多文件联动修改
- 对抗：提示注入（让 Agent 读一个含恶意指令的文件）、越权（要求访问工作空间外的路径）

每次改提示词、换模型、调中间件都跑一遍回归。否则改完根本不知道是变好还是变坏。

---

## 8. 提示词版本化

系统提示词、工具描述、护栏阈值都是代码，必须版本化：

```
stupid_code/prompts/
  system/
    v1.0.0.md
    v1.1.0.md
    meta.json      # {"current": "v1.1.0", "history": [...]}
```

- 每个版本记录：变更说明、适用模型、评测基线结果、上线时间
- span 中必须埋 `prompt_version`，出问题时能定位到具体版本
- 支持按版本号一键切回，无需改代码重新发版

---

## 9. 目录结构

**实际布局**看 [`docs/backend/PROGRESS.md`](backend/PROGRESS.md) §2.1（活目录树，随代码演进）
和同节 §2.2（`langgraph.json` 的三条硬编码路径、`__file__` 定位目录的层数约束）。
本文档不复刻目录树——抄一份就多一个会漂移的地方。

**目标设计里规划了、但尚未建的目录**：`stupid_code/middlewares/`（自研中间件）、
`stupid_code/tools/`（自定义工具）、`stupid_code/prompts/`（版本化提示词，见 §8）。
中间件目前落在 `graph/workspace.py` 里。

> `langgraph.json` 直接引用了 `./graph/agent.py:graph`、`./graph/persistence.py:checkpointer`、
> `./admin/app.py:app` 三条路径，挪动这些文件必须同步改配置（细节见 PROGRESS §2.2）。


---

## 10. 开发阶段

| 阶段 | 内容 | 产出 | 验收标准 |
|---|---|---|---|
| P0 | 后端 Agent 骨架跑通 | 可对话的后端服务 | ① filesystem 确认落到真实磁盘（§3.1）② `langgraph dev` 可用 ③ 前端切非 mock 模式能完成一轮对话 ④ 工具调用能渲染 |
| P1 | 工作空间 + 危险操作确认 | 安全可控的编码能力 | ① 路径逃逸被拦截 ② `manual` 档能触发中断并被前端确认卡片处理 ③ 断线重连可用 |
| P2 | 前端确认卡片、Diff 完善 | 完整编码交互体验 | ① 审批卡片支持 approve/reject ② 文件修改可视化 Diff ③ `normal` 档 LLM 审核可用 |
| P3 | 评测集、可观测性、会话历史 | 接近产品级体验 | ① 评测集 ≥ 20 条且跑出基线 ② 关键指标埋点完成 |

**风险提示**：P1 的 `normal` 档（LLM 审核）技术不确定性最高，建议在 P0 结束时先做技术验证，不要留到 P2 才发现走不通。

---

## 11. 风险与待决项

### 11.1 待核实项

- ~~`[待核实]` deepagents 的本地磁盘 backend 具体配置方式~~ —— **已核实并落地**（007 期）：
  `CompositeBackend(default=LocalShellBackend(root_dir=工作空间, virtual_mode=True, inherit_env=True))`，
  见 `docs/backend/PROGRESS.md`
- ~~`[待核实]` deepagents 默认配置的 filesystem 是否为真实磁盘~~ —— **已核实**：默认是
  `StateBackend`（虚拟 FS，写操作不落盘）；必须显式传 `backend=`
- `[待核实]` `TodoListMiddleware` 是否在本项目锁定版本中仍为 opt-in —— 核实方式：查官方 changelog
- `[待核实]` `per_call` 中断模式所需的 langchain 版本下限是否满足 —— 核实方式：查本项目锁定的 langchain 版本号
- ~~`[待核实]` **shell 的人工确认**~~ —— **已核实并落地**（009 期）：后端按
  `context.permissions` 的档位决定拦不拦，图挂起等前端批准/拒绝。
  见 `docs/backend/PROGRESS.md` 的「009 · shell 的人工确认（HITL）」一节
- `[待核实]` 重连 join 接口能否补齐错过的历史事件 —— 核实方式：P1 联调实测
- `[待核实]` 各模型官方定价（用于 token → 成本换算）
- `[待核实]` `stream_mode: ['updates']` 的文本到达粒度 —— 核实方式：P0 联调观察
- `[待核实]` 敏感文件黑名单与危险命令模式的具体清单 —— 需按项目实际环境确定

### 11.2 风险

| 风险 | 概率 | 影响 | 应对 |
|---|---|---|---|
| filesystem 默认是虚拟的，写文件不落盘 | 中 | 高 | P0 第一件事就验证（§3.1） |
| `normal` 档 LLM 审核难以在 `when` 回调中实现 | 高 | 中 | P0 末提前验证，准备备选方案（§5.3） |
| `when` 恢复时判定不一致导致拒绝被忽略 | 中 | 高 | 审核结论必须持久化，不重算（§5.3） |
| 中间件顺序错误导致绕过审批 | 中 | 高 | 顺序写入代码规范并加测试（§6.3） |
| 意外绑定 `0.0.0.0` 导致命令执行暴露 | 低 | 极高 | 配置层强制 127.0.0.1（§6.1） |
| Agent 失控循环烧钱 | 中 | 中 | 护栏四件套（§5.4） |
| 目录选择框把文件系统暴露给前端 | 低 | 低 | 只弹系统原生窗口（不返回目录列表），后端仍只监听 `127.0.0.1`（§4.1.1） |
| 刷新页面丢失运行状态 | 高 | 低 | §6.4 低成本兜底；根治需开 `stream_resumable` |
| 大文件 Diff 渲染卡顿 | 中 | 低 | 虚拟滚动或截断展示 |
| 会话持久化 | — | — | 开发期 InMemory 重启丢失，生产换 Postgres |

### 11.3 已定事项（不再讨论）

- 前端框架：**React 19**（不是 Vue）
- 前端目录名：`web/`
- 通信方式：SSE + fetch 手动解析（保持不用 EventSource）
- 鉴权方式：自定义 header（保持不用 cookie）
