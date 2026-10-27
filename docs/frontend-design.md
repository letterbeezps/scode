# 网页版 Code Agent 前端设计文档

> 版本：v0.2
> 日期：2026-10-16
>
> v0.2 依据 `web/` 的实际实现重写。相对 v0.1 的主要变更：
> 「会话」更名为「任务」并与「待办」拆开命名；新增工作空间与权限两个任务级参数；
> HTTP 层弃用 EventSource；消息改用有序片段渲染；包管理改用 pnpm。
> 章节编号保持稳定，代码注释里按编号的交叉引用仍然有效。

## 1. 设计目标

构建一个独立的网页前端，为用户提供与主流 Code Agent（Cursor / Cline / Trae）一致的交互体验。核心目标：

1. **对话优先**：主区域为对话窗口，支持流式输出
2. **工具可视化**：清晰展示 Agent 的文件读写、命令执行等操作
3. **左侧边栏**：任务列表 + 待办列表
4. **编码辅助**：代码高亮、文件 Diff、终端输出等专业视图
5. **轻量独立**：与后端通过 HTTP/SSE 解耦，可单独开发部署
6. **运行边界显式化**：每次任务的工作空间与确认档位由用户当场选定，不预设、不记忆

---

## 2. 技术选型

| 类别 | 选型 | 理由 |
|------|------|------|
| 框架 | React 19 + TypeScript 6 | 生态成熟，组件库丰富，类型安全 |
| 构建工具 | Vite 8 | 启动快、HMR 体验好 |
| 样式 | TailwindCSS 4 | 原子化 CSS；v4 用 `@theme inline` 把 CSS 变量直接暴露成工具类 |
| 状态管理 | Zustand 5 | 轻量，适合对话类应用的集中状态 |
| 路由 | React Router 7 | 多任务切换 |
| 包管理 | pnpm | 装得快、磁盘省；版本锁在 `package.json` 的 `packageManager` |
| Markdown 渲染 | react-markdown + remark-gfm | GFM 支持、可定制代码块 |
| 代码高亮 | Shiki | 语法高亮质量高，动态 import 懒加载 |
| Diff 展示 | react-diff-viewer-continued | 文件变更对比，动态 import 懒加载 |
| HTTP 客户端 | **fetch + ReadableStream** | 见下 |
| 图标 | lucide-react | 轻量现代图标库 |

### 为什么彻底不用 EventSource

v0.1 写的是「fetch + EventSource」。实际实现只保留了 fetch：`EventSource` **不支持自定义 header**，
生产环境要往 `/runs/stream` 带 `Authorization` 时它根本做不到。当前实现用
`fetch` + `ReadableStream` 手动解析 SSE（见 6.3），一份代码同时覆盖有无鉴权两种场景。

> Shiki 和 `react-diff-viewer-continued` 都走动态 `import()`。后者连带 refractor 的全部
> 语言语法（十几 MB 的懒加载 chunk），只有真的出现文件改动时才下载。
> 主 chunk 从 725 kB 降到 465 kB（gzip 145 kB）。

---

## 3. 整体布局

采用经典的 **两栏式 Code Agent 布局**（v0.1 画的是"三栏"，但右侧文件预览面板本期不做，见 11）：

```
┌──────────┬───────────────────────────────────────────┐
│          │                                           │
│  侧边栏  │              主对话区                       │
│          │                                           │
│  - 新建任务│   ┌─────────────────────────────────┐    │
│  - 任务   │   │  消息列表（用户/助手交替）        │    │
│    列表   │   │  - 文本气泡                      │    │
│          │   │  - 代码块（高亮+复制）            │    │
│  ──────  │   │  - 工具调用卡片（可展开）          │    │
│  - 待办   │   │  - 文件 Diff                     │    │
│    列表   │   │  - 终端输出                      │    │
│          │   └─────────────────────────────────┘    │
│  ──────  │   ┌─────────────────────────────────┐    │
│  - 模型   │   │  输入区（多行文本 + 发送）        │    │
│  - 主题   │   │  [工作空间 ▾] [权限 ▾]           │    │
│  - 设置   │   └─────────────────────────────────┘    │
└──────────┴───────────────────────────────────────────┘
```

### 3.0 两组列表的名字不能混

| 名称 | 是什么 | 数据来源 |
|------|--------|----------|
| **任务** | 一次对话线程（thread），对应 URL 里的 `threadId` | `threads` API |
| **待办** | Agent 自己维护的执行计划 | `write_todos` 工具，经 SSE `todos` 事件同步 |

v0.1 把两者都叫"任务"，侧边栏同时出现两个同名区域，用户分不清。
现在按语义拆开：thread 叫**任务**，TodoList 叫**待办**，相关文案（按钮、空态、删除确认）同步改掉。

### 3.1 左侧边栏（Sidebar）

宽度 `280px`，可折叠（收起后 `56px`，只留图标）。自上而下：

- **顶部**：折叠按钮 + Logo
- **新建任务** 按钮
- **任务列表**：按时间倒序，显示标题、时间；点击切换，hover 出现删除
- **待办**：当前任务的 TodoList，独立滚动区
- **底部**：模型选择、亮/暗主题切换、设置页入口

折叠状态存在 `uiStore`。mock 模式下底部额外挂一条黄色提示条，避免和真实数据混淆。

### 3.2 主对话区（ChatArea）

- **消息列表**：垂直滚动，助手消息靠左通栏（代码/工具卡片需要宽度）
- **流式渲染**：助手文本逐字追加
- **生成中状态**：发送按钮变停止按钮；`pendingMessage` 还没建立时显示「正在思考…」
- **错误**：以浮层形式挂在消息列表顶部（可手动关闭），**不插进消息流**——
  避免让用户以为错误属于某一条消息
- **空状态**：欢迎语 + 4 张快捷指令卡片（梳理代码结构 / 准备一次改动 / 排查构建问题 / 补测试），
  点击**填入输入框**而不是直接发送

### 3.3 输入区（InputBar）

- 多行文本框，自适应高度（最大 200px，超出内部滚动）
- Enter 发送 / Shift+Enter 换行；**IME 组字期间的回车是选词不是发送**，必须避开
- 发送按钮 ↔ 停止按钮（生成中切换）
- **下方一行两个选择器**（详见 7.7 / 7.8）：
  - `工作空间` —— 文件夹浏览器，默认未选择
  - `权限` —— `manual` / `normal` / `auto` 三选一
- **旁边还有一个「记忆」按钮**（017 期）：点开是记忆面板，查看/编辑 agent 的
  两份长期记忆（详见 7.9）
- **斜杠菜单里混排命令和 skill**（018 期）：输入框敲 `/` 弹列表，
  里面既有 `/compaction` 这种命令，也有 `/<skill 名>`。选中 skill 是**勾选**
  （不发送消息），勾中的显示成输入框上方的 chip，带 × 删除（详见 7.10）
- 右侧常驻提示「Enter 发送 · Shift+Enter 换行 · `/` 命令与技能」

> v0.1 里的「附件按钮（上传文件、截图）」和「@提及文件」本期未实现，见 11。

---

## 4. 组件架构

```
App  (BrowserRouter)
├── RootRedirect            /                    重定向到最近任务
├── ChatPage                /chat · /chat/:threadId
│   ├── Sidebar
│   │   ├── NewChatButton
│   │   ├── ConversationItem × N          任务列表项
│   │   ├── TodoList                      待办（内联渲染，无独立 TodoItem 文件）
│   │   └── SettingsPanel
│   ├── EmptyState  |  MessageList
│   │   ├── UserMessage
│   │   └── AssistantMessage
│   │       ├── MarkdownContent → CodeBlock
│   │       └── ToolCallCard
│   │           ├── ToolCallHeader
│   │           ├── ToolCallResult
│   │           ├── FileDiff
│   │           └── TerminalOutput
│   └── InputBar
│       ├── WorkspacePicker
│       ├── PermissionPicker
│       └── MemoryPanel                  记忆面板（模态，017 期）
└── SettingsPage            /settings
```

### 4.1 核心组件说明

#### MessageList

- **虚拟滚动尚未启用。** `index.css` 里定义了 `.cv-auto`（`content-visibility: auto` +
  `contain-intrinsic-size`），但**当前没有任何元素挂这个类** —— 消息列表是普通的
  `messages.map()` 全量渲染。工具类先留着，等消息量真的上来了再挂上去，见 11.2。
  不用 JS 虚拟化的原因是代码块和 Diff 高度不定，手写高度测量容易抖动。
- **自动滚动靠 ResizeObserver 监听内容高度**，而不是把「消息条数」当依赖传给 effect ——
  流式场景下依赖表达式很难写准，写错就是每来一个 token 滚动失效。
- 判定「用户是否在底部」用**距底部距离阈值**，不用滚动方向，否则每来一个 token 都把用户拽回底部。
- 用户上滑后（不 pinned）在列表底部浮出「回到底部」按钮
- 切换任务时给 `<MessageList>` 加 `key` 直接重挂载，滚动位置自然回到底部，不用 effect 重置
- 流式中的 `pendingMessage` 单独渲染在末尾，**不参与历史列表的 memo**，
  否则每来一个 token 都要重算整条消息

#### AssistantMessage

- **复合内容渲染：文本 + 工具调用混合排列**（v0.2 起以 `parts` 为准，见 5.6）
- 工具调用卡片可展开/折叠，**默认全部折叠**（`uiStore.activeToolCallId` 为 null）
- 文件编辑类工具自动渲染 Diff

#### ToolCallCard

- 头部：按工具类型选图标 + 工具名 + 一句话摘要（命令显示命令、文件类显示路径、搜索显示 `pattern in path`）+ 状态
- 状态四态：`pending` / `running` / `success` / `error`，各有独立图标
- 展开后按类型差异化渲染结果（见 7.2）

#### CodeBlock

- 语法高亮（Shiki）。语言取自 markdown 的 fence info string，支持 ```` ```lang:path ````
  形式顺带带出文件名
- **高亮是异步的**：先渲染转义后的纯文本骨架，高亮结果回来再原地替换；
  语言不支持时保持纯文本，不做二次降级
- **主题切换要重新高亮**，否则配色对不上
- 语言标签 + 复制按钮（复制成功后短暂换成 ✓）
- Shiki 的 oniguruma wasm 是 622 kB 的懒加载 chunk，不在首屏关键路径

---

## 5. 状态管理

使用 Zustand 管理全局状态，按领域拆成五个 store。

### 5.1 conversationStore

```typescript
interface ConversationState {
  threads: Thread[]
  activeThreadId: string | null
  messages: Record<string, Message[]>        // thread_id -> messages
  titles: Record<string, string>             // 后端不返回 title，前端从首条用户消息推导
  pendingMessage: Message | null             // 正在流式生成的 assistant 消息
  pendingThreadId: string | null             // pendingMessage 属于哪个线程，切任务时不会串台
  isGenerating: boolean
  loading: boolean
  error: string | null
  cancelRequested: boolean                   // 用户点过停止：onEnd 落位时据此标记 interrupted

  loadThreads: () => Promise<void>
  createThread: () => Promise<string | null>
  selectThread: (id: string) => Promise<void>
  deleteThread: (id: string) => Promise<void>
  sendMessage: (content: string) => Promise<void>
  cancelRun: () => void
  clearError: () => void
}
```

`pendingThreadId` 是 v0.2 补的：v0.1 只有一个全局 `pendingMessage`，在 A 任务生成中切到 B，
流式内容会串到 B 的界面上。

### 5.2 uiStore

```typescript
interface UIState {
  sidebarCollapsed: boolean
  activeToolCallId: string | null   // 当前展开的工具调用卡片；null = 全部折叠
  theme: Theme                      // 'dark' | 'light'
  toggleSidebar: () => void
  setSidebarCollapsed: (collapsed: boolean) => void
  setActiveToolCall: (id: string | null) => void
  toggleTheme: () => void
}
```

### 5.3 todoStore

```typescript
interface TodoState {
  todos: Record<string, Todo[]>     // thread_id -> todos
  updateTodos: (threadId: string, todos: Todo[]) => void
  clearTodos: (threadId: string) => void
}
```

### 5.4 taskStore（v0.2 新增）

工作空间和权限是**任务级参数**，不是全局设置：同一个任务里前后两条消息可能针对不同目录、
不同确认策略。但新任务在创建 thread 之前就要能配，所以额外留一份 `draft`。

018 期起**勾选的 skill 也是任务级参数**——项目级 skill 在工作空间里，工作空间是
运行期参数，skill 选择不能是全局的。

```typescript
interface TaskSettings {
  workspace: string            // 绝对路径；空字符串 = 本次任务不选工作空间
  permissions: PermissionLevel // 'manual' | 'normal' | 'auto'
  skills: string[]             // 勾选的 skill 名字（018 期）
}

interface TaskStore {
  settings: Record<string, TaskSettings>   // thread_id -> 该任务的运行参数
  draft: TaskSettings                      // 尚未落到 thread 上的新任务参数

  resolve: (threadId: string | null) => TaskSettings
  update: (threadId: string | null, patch: Partial<TaskSettings>) => void
  hydrate: (threadId: string, patch: Partial<TaskSettings>) => void
  reset: (threadId: string | null) => void
  adoptDraft: (threadId: string) => void
}
```

`threadId` 为 null 时读写 `draft`。`createThread` 时调 `adoptDraft()` 把 draft 固化到新任务上
并把 draft 重置回默认值 —— 否则这个任务会一直回退到 draft，参数被后续新任务改掉。
删除任务时一并 `reset` + `clearTodos`。

设置只在内存里，刷新页面会丢。所以发消息时把 `workspace` / `permissions` / `skills` 一并写进
thread 的 `metadata`（`PATCH /threads/{id}` 是合并语义，不会覆盖平台的键），
`loadThreads` / `selectThread` 时用 `hydrate()` 回填；已经有内存设置的任务不覆盖。
审批卡片挂着时两个选择器禁用 —— 恢复请求会原样带回这两个参数，改了就会出现
「批准的是 A 目录的命令，却在 B 目录执行」。

组件里要用 selector 订阅（`useTaskSettings(threadId)`），**不要在 selector 里调 `resolve()`**：
`resolve` 读的是 `get()` 快照，在 selector 里调用拿不到订阅关系，改了不会重渲染。

### 5.5 settingsStore

模型配置。数据源是后端 `GET /admin/models`（即 `conf/config.toml` 的视图），
增删改走 `/admin/models` 一族端点，不再是写死的本地列表。

下拉框里的「选中」**会真正生效**（010 期）：选中值写 `localStorage`，每次发消息时
随 `configurable.model` 发给后端，后端在每次模型调用前把模型换成它——
**不用重启后端**。模型是全局偏好，不按任务存（`workspace` / `permissions` 才是任务级）。

选中值存在 `localStorage`，刷新页面、后端重启都还在。`defaultId` 是后端启动时带的
默认模型（`[models].default`）；两者不一致正是「切过去了」的状态，UI 要如实显示
当前用的是哪个，别再提示「仅本地选中」那种误导的话。

### 5.6 消息的数据形状

v0.1 的 `Message` 只有 `content` 和 `tool_calls` 两个平级字段，**表达不了"先说一段话 →
调工具 → 再接着说"的顺序**，而 4.1 恰恰要求混合排列。所以额外维护有序片段：

```typescript
type MessagePart =
  | { kind: 'text'; text: string }
  | { kind: 'tool'; call: ToolCall }

interface Message {
  id: string
  thread_id: string
  role: 'user' | 'assistant' | 'tool'
  content: string            // 与 parts 同步维护，供接口层与断言使用
  tool_calls?: ToolCall[]    // 同上
  parts: MessagePart[]       // ← 渲染一律以这个为准
  created_at: string
  error?: string             // 运行失败时写入
  interrupted?: boolean      // 用户主动停止
}
```

从 LangGraph 的 `/state` 拉历史时，`restoreMessages()` 负责把 LangChain 的消息数组
（含 `tool_calls` / `tool_call_id` 的配对关系）还原成同样的有序结构。

---

## 6. API 通信层

封装 `src/api/` 目录，隔离后端细节。

### 5.7 斜杠命令与 skill

输入框**开头**敲 `/` 弹出菜单（↑↓ 选、回车/Tab 确认、Esc 关闭）。只在开头是
`/` 且还没打空格时才弹——`/usr/local/bin` 这种路径不会误弹。

菜单里**混着两类东西**：

| | 选中后发生什么 | 后端怎么认 |
|---|---|---|
| **命令**（`/compaction`） | 当普通消息发出去 | 按消息内容认（`/compaction` 的识别在后端 `stupid_code/graph/compaction.py` 的 `COMPACTION_COMMAND`，两边的字面量要一致） |
| **skill**（`/<skill 名>`） | **不发送**，勾进本次对话 | 不走消息；勾选的名字随 `configurable.skills` 发过去 |

命令表在 `web/src/lib/commands.ts`；skill 来自 `GET /admin/skills`，由
`skillToMenuItem()` 转成同一种菜单项（`kind: 'skill'`，多带一个 `scope`）。

**加新命令不用改接口**，后端按消息内容认即可。

命令消息在消息列表里渲染成「命令气泡」而不是普通聊天气泡——`/compaction`
显示成一句话看着像用户在说胡话。**skill 不是消息**，不会出现在消息列表里。

### 6.1 目录结构

```
src/api/
├── client.ts          # fetch 封装、基础路径、鉴权头注入点、mock 开关、ApiError
├── sse.ts             # 有状态 SSE 解析器（一条事件可能横跨两个 chunk）
├── events.ts          # 事件归一化：两套协议 → 一套前端语义事件，并去重
├── thread.ts          # 线程 CRUD + 历史消息还原
├── run.ts             # 运行相关 API（含流式与取消）
├── workspace.ts       # 工作空间：弹系统目录选择框（POST /workspaces/pick）
├── memory.ts          # 记忆：读两份（GET /admin/memory）、写一份（PUT /admin/memory）
├── skills.ts          # skill 清单（GET /admin/skills）
├── types.ts           # 请求/响应类型定义
└── mock/              # 无后端时的假实现（接口签名与真实后端完全一致）
```

`client.ts` 统一处理 `/api` 前缀和错误。生产态把 `VITE_API_BASE_URL` 指向后端真实地址即可，
无需改代码。鉴权头在 `authHeaders()` 一处集中出口。

### 6.2 核心 API 封装

```typescript
// src/api/run.ts
export function streamRun(
  threadId: string,
  message: string,
  options: RunOptions,          // { workspace, permissions, model, skills }
  handlers: RunHandlers,        // { onToken, onToolCall, onToolResult, onTodos, onError, onEnd, onRunId? }
): () => void                   // 返回取消函数
```

请求体：

```jsonc
POST /threads/{thread_id}/runs/stream
{
  "assistant_id": "code_agent",
  "input": { "messages": [{ "role": "user", "content": "..." }] },
  "stream_mode": ["updates"],
  "on_disconnect": "continue",
  "config": {
    "configurable": {
      "workspace": "",              // 空字符串 = 不选工作空间
      "permissions": "normal",
      "model": "",                  // 空字符串 = 用后端默认模型
      "skills": []                  // 本次对话勾选的 skill 名字（018 期）
    }
  }
}
```

`stream_mode` 只请求 `["updates"]` —— `values` 每次都回传全量状态，噪音大且没必要。
`on_disconnect: "continue"` 让浏览器断开后后端继续跑完，避免半途中断留下脏状态。

`config.configurable` 是任务参数的落点。后端在图入口读 `workspace` / `permissions` /
`model` / `skills`。**恢复挂起的运行时也要原样带回去**（`resumeRun` 同样带这几个值）——
带空了就跟批准前用的不是同一套配置。

### 6.3 SSE 解析

**解析器必须有状态。** 一条 SSE 事件的 `event:` 和 `data:` 完全可能分处两个网络 chunk，
纯函数式实现会随机丢事件。`sse.ts` 的 `SseParser` 持有跨块缓冲。

**同时兼容两套事件格式。** 后端尚未落地（总体设计文档的 P0），而"前端能消费的流式协议"
目前有两份说法：

1. 语义事件（LangGraph 里用 `get_stream_writer()` 发出）：
   `messages` / `tool_call` / `tool_result` / `todos` / `error` / `end`
2. LangGraph Platform `/runs/stream` 原生事件：
   `metadata` / `updates` / `values` / `events` / `error` / `end`

`events.ts` 两份都接并做去重：优先采信显式语义事件，**只有没收到过显式 `messages` 时**
才从 `updates` 里推导文本 token，否则同一段话会被追加两遍。

归一化后的事件类型：

```typescript
type NormalizedEvent =
  | { type: 'metadata'; runId?: string }
  | { type: 'token'; text: string }
  | { type: 'tool_call'; call: ToolCall }
  | { type: 'tool_result'; id: string; result: ToolResult; error?: string }
  | { type: 'todos'; todos: Todo[] }
  | { type: 'error'; message: string }
  | { type: 'end' }
```

### 6.4 工作空间选择（014 期改）

工作空间用**系统原生目录选择框**选：点按钮 → 后端弹系统的文件浏览窗口 →
用户选一个文件夹 → 拿到绝对路径。

```
POST /workspaces/pick

→ {"path": "/Users/1token/Desktop/project/stupid-code"}   选中了
→ {"path": null, "cancelled": true}                        用户点了取消（不是错误）
→ 503 {"error": "..."}                                     弹不出来（无图形界面等）
→ 409 {"error": "..."}                                     已经有一个弹窗在等
```

**为什么不是浏览器的目录选择 API**：File System Access API（`showDirectoryPicker()`）和
`<input webkitdirectory>` 都**故意不暴露绝对路径**（只给 name / 相对路径），这是浏览器的
安全设计，绕不过去。而工作空间要的恰恰是绝对路径。后端跑在用户自己机器上，它能弹系统窗口。

**为什么不是「后端返回目录列表」**（v0.2 的原设计）：那等于把文件系统目录树开放成
一个 HTTP 接口，得配路径白名单、403 语义、一堆安全说明，而它解决的问题（让用户选个
目录）用系统弹窗更直接。

**下拉菜单里还有两样**：

- 「最近用过的项目」——来自对话历史（每个 thread 的 `metadata.workspace`），前端从
  线程列表里直接读，不需要后端再列目录
- 「手动输入绝对路径」——后端在无图形界面环境（Docker、纯 SSH）弹不出窗口时的唯一出路

弹窗期间按钮显示「等待选择…」。用户取消**不算错误**，保留原来的选择。

### 6.5 Mock 模式

`VITE_USE_MOCK=true` 时，`src/api/mock/` 按与真实后端**完全相同的接口签名**提供假数据，
覆盖流式 token、工具调用状态流转、待办同步、Diff 渲染、停止生成等全部路径，
以及一个假的「选目录」实现（直接返回一个假路径）。

mock 回复末尾会把本次收到的 `workspace` / `permissions` 原样回显出来，方便确认参数确实传到了。
侧边栏显示黄色提示条标明当前是 mock。**生产构建务必关闭。**

---

## 7. 核心功能设计

### 7.1 对话流式渲染

1. 用户发送消息 → 乐观追加到消息列表
2. 调用 `streamRun`，创建空的 `pendingMessage`
3. 归一化后的 `token` 事件 → 追加文本到最后一个 `text` 片段
4. `tool_call` 事件 → 往 `parts` 追加 `{ kind: 'tool' }` 片段
5. `tool_result` 事件 → 按 id 定位到对应 ToolCall，更新 result 与 status
6. `todos` 事件 → 更新 `todoStore`
7. `end` 事件 → 将 `pendingMessage` 移入正式消息列表，清空

### 7.2 工具调用可视化

按工具类型差异化展示。分类逻辑在 `lib/tools.ts`，**按"包含什么关键字"判定而不是精确匹配** ——
Deep Agents 的内置工具名固定，但自定义工具（终端、git 等）的命名不受约束。

| 类型 | 判定关键字（部分） | 展示方式 |
|------|-------------------|----------|
| 读取 | `read_file` `read` `cat` `view` | 文件路径 + 内容预览 |
| 编辑 | `write_file` `edit_file` `patch` … | 文件路径 + Diff 视图 |
| 搜索 | `grep` `glob` `search` `find` `rg` | 结果列表，摘要显示 `pattern  in path` |
| 命令 | `bash` `shell` `command` `terminal` `execute` `run_` | 终端风格输出（等宽字体），摘要显示命令行 |
| 待办 | `todo` | 同步到侧边栏待办列表 |
| 子 Agent | `task` `subagent` `dispatch` | 按工具卡片渲染 |

`lib/tools.ts` 只放纯数据与判定，**图标由 `ToolCallHeader` 自己持有**：渲染层直接 import
图标组件会让 `.ts` 变成 `.tsx`，而分类逻辑并不依赖 React。

### 7.3 文件 Diff

用 `react-diff-viewer-continued`，**统一视图**（分栏视图的 `splitView` 属性留着没开 ——
窄栏下分栏每行只剩十几个字符）。

它只吃 `oldValue` / `newValue` 两个整篇文本，但后端给过来的形态有四种，`lib/diff.ts`
按优先级依次尝试：

1. 参数里直接给了新旧全文 → 整篇对比（行号才对得上）
2. 结果里给了 unified diff → 解析还原两侧全文
3. `edit_file` 只给了 `old_string` / `new_string` → 退化成片段对比
4. 什么都没有 → 不渲染 Diff

超过 2000 行截断并提示。

### 7.4 任务管理

- 新建任务：调 `createThread`，用 `adoptDraft()` 固化当前的工作空间/权限，再跳转
- 切换任务：加载对应 `thread_id` 的历史消息（`/state` + `restoreMessages`）
- 删除任务：删线程，并清掉该任务的 `taskStore` 设置与待办
- 标题：后端不返回 `title`，前端从首条用户消息截断推导，存在 `titles` 里

**`/chat` 下首发消息有个坑**：store 里 `sendMessage` 会兜底建线程，但那时 URL 还停在 `/chat`，
消息会渲染到一个读不到 `threadId` 的页面上，等于凭空消失。所以 `ChatPage.handleSend`
要**先 `createThread()` 再 `navigate()`**。

### 7.5 停止生成

- 生成中发送按钮变停止按钮，点击调 `cancelRun`
- **本地立刻断流**（恢复 UI），并在拿到 `run_id` 后通知后端真正中止 ——
  否则后端会继续跑完这次 run，白烧 token
- `pendingMessage` 落位时带 `interrupted` 标记，渲染成「已被手动停止」

> `cancel()` 里必须**主动补一次 `onEnd()`**：`abort` 之后读取循环和 `catch` 都会被
> `settled` 短路，不补这次调用 UI 会一直卡在"生成中"。这个 bug 踩过一次。

### 7.6 待办（TodoList）

- `todos` 事件更新 `todoStore`
- 侧边栏实时展示：待办 / 进行中 / 已完成
- 点击待办**跳转到对应的工具调用**：`toolCallId` 定位到 `id="tool-{id}"` 的卡片，
  同时 `setActiveToolCall` 把它展开，再 `scrollIntoView({ behavior: 'smooth', block: 'center' })`
  滚到视口中间。没有 `toolCallId` 的待办不可点击

### 7.7 工作空间（v0.2 新增）

**是文件夹浏览器，不是输入框。** 手打项目路径是危险动作 —— 打错一个字符就是授权给了错误的目录。

- **默认不选**。不预设任何目录，让用户明确选择，而不是默认就授权了某处
- 每一行**两个按钮**：左边整块 = **选中这个目录**，右边箭头 = **进入**
  （双击进入不可靠：第一次点击就会触发重渲染，第二次点击落在别的元素上）
- 选中后面板**不关**，底栏实时显示路径，可以接着往下钻、改主意，再点「完成」
- 底栏还有「取消选择」—— 清空并关闭
- 选中后按钮右上角有**常驻的 ✗ 取消入口**，不用去 hover 里找
- 下次打开从已选工作空间的**父目录**起步，省得每次从 `/` 点进来

绝对路径只能由后端给出（6.4）。**工作空间不通过环境变量预设。**

### 7.8 权限（v0.2 新增）

**三级确认策略，不是能力白名单。** 选项直接以英文值作为文案，不翻译：

| 值 | 含义 |
| --- | --- |
| `manual` | 命中危险操作的，先确认再执行 |
| `normal` | AI 审核这次操作是否危险，再决定要不要确认 |
| `auto` | 不确认，直接执行 |

默认 `normal`：`manual` 会被打断到没法用，`auto` 等于把机器完全交出去。

**为什么分级而不是简单开关**：同一类操作风险差别很大。跑 `pytest` 和跑 `rm -rf`
都属于"执行命令"，前者没必要打断用户，后者必须打断。`manual` 与 `normal` 的差别在于
**谁来判断危险**：前者按固定规则，后者交给 AI。

**这是执行前的确认，不是事后可见性。** 前端只负责把档位原样传下去（6.2），
真正的拦截点在**后端的工具调用入口**：按 `permissions` 决定直接跑，还是**挂起这次调用**
等前端确认。挂起后前端需要一个确认入口（设计文档里还没有，见 11）。

> 早先的一版设计是 `read` / `write` / `execute` / `network` 四个能力开关 + 预设 + 自定义组合。
> 已废弃：那是能力白名单，解决不了"同一种能力内部风险不同量级"的问题。

### 7.9 记忆面板（017 期）

**入口在输入区那一行**，工作空间/权限选择器旁边，一个 `Brain` 图标 + 「记忆」。

**为什么需要它**：agent 的长期记忆是磁盘上的 markdown（用户级 `~/.scode/memory.md`、
项目级 `<工作空间>/.scode-memory.md`），但网页版用户看不见它——想看一眼或改一个字
都得开终端翻工作空间。

**面板形态**：一个模态框，两段（用户级 / 项目级），每段是

- 一行标题 + 状态（`已有内容` / `还没有记忆`）
- 一句这个作用域该记什么的提示
- 磁盘上的绝对路径（等宽字体，路径长时截断，hover 看全）
- 一个 textarea
- 自己的「保存」按钮 + 「已保存」提示

底部固定一行说明：**「记忆在会话开始时读一次，改完要开新会话才生效」**。这句必须
摆在面板里——不摆的话用户改完发现 agent 还是旧内容，会以为没保存成功。

**项目级记忆是任务级的**：面板拿的是 `taskStore` 里当前任务的工作空间。没选工作
空间时不带 `workspace`，后端退回它自己的默认工作空间（跟 agent 的行为一致）。

**几个实现要点**

- **写空内容 = 清空文件**（文件留在原地，没内容了），不是删文件
- **两边同时改会互相覆盖**：agent 用 `write_file` 写这两个文件，面板也直接写文件，
  两边都是普通写者，后写的赢。这句也写在面板底部
- **`loading` 从「加载的是不是当前工作空间」派生**，不单独开一个 state——单独的
  state 就得在 effect 里同步 `setLoading(true)`，那是 oxlint 的 `set-state-in-effect`
- **取数放在 effect 里的 async IIFE**，所有 `setState` 都在 `await` 之后：oxlint
  不做控制流分析，只看到「effect 里调了一个会 setState 的函数」就会报

### 7.10 skill 勾选（018 期）

**入口是输入框敲 `/`**——和通用 code agent 的习惯一致。没有独立按钮。

**为什么走斜杠菜单**：skill 的数量随项目变（项目级 skill 跟着工作空间走），
做成固定的按钮或下拉，位置和数量都不可控。斜杠菜单本来就是「这次要用什么」的
入口，命令和 skill 混在一起，用户一个手势就能挑。

**交互**

1. 输入框开头敲 `/` → 菜单弹出，命令和 skill 混排
2. skill 行标了作用域（**全局** / **项目**），已勾选的标「已选」
3. 选中 skill = **勾选**（toggle），**不发消息**；输入框清空，菜单留着，
   可以接着敲 `/` 再选一个——所以支持多选
4. 勾中的显示成输入框**上方的 chip**，带 × 删除
5. ↑↓ 移动高亮、回车选中、Esc 关闭（键盘全程可用）

**勾选的语义是「钉进上下文 + 全部可见」**

- **钉进上下文**：勾选的 `SKILL.md` 全文（去掉 frontmatter）作为一条消息进对话
  历史——不用等 agent 自己去读，也不用赌它会不会读
- **全部可见**：没勾选的 skill 也在系统提示词的列表里，agent 觉得相关会自己
  `read_file` 加载

所以勾选不是「白名单」，是「我确定这次要用它，先给它全文」。

**几个实现要点**

- **skill 清单按工作空间取**（`GET /admin/skills?workspace=`）：项目级的那份跟着
  当前任务的工作空间走，工作空间变了要重新取。取数放在 effect 里的 async IIFE，
  跟记忆面板一个套路（oxlint 的 `set-state-in-effect`）
- **skill 选择是任务级的**（`taskStore.skills`）：项目级 skill 在工作空间里，
  工作空间是运行期参数，skill 选择不能是全局的
- **审批挂起期间禁用勾选**：恢复请求会原样带回 `skills`，改了批准的就不是同一件事了
- **`skills` 要跟着 `resumeRun` 一起带回去**（跟 workspace / permissions / model 一样）
- **菜单项的 key 要带类别**：命令和 skill 可能重名（`/compaction` 既可能是命令也
  可能是技能），只用 `command` 当 key 会撞
- **mock 模式也要回显**：mock 的 `stream` 里加一句「已把 xxx 的 SKILL.md 全文钉进
  上下文」，让前端开发时能看出勾选确实随请求发出去了

---

## 8. 样式与设计系统

### 8.1 设计原则

- **暗色优先**：代码类应用默认暗色主题，兼顾亮色
- **紧凑密度**：信息密度高，减少留白浪费
- **状态清晰**：通过颜色与图标明确区分成功/失败/运行中

### 8.2 配色（CSS 变量）

配色全部走 CSS 变量，暗色写在 `:root`，`html.light` 覆盖成亮色，
再用 Tailwind v4 的 `@theme inline` 把变量暴露成 `bg-bg` / `text-fg-muted` 这样的工具类。
**组件里不允许出现字面色值。**

| 用途 | 变量 | 暗色 | 亮色 |
|------|------|------|------|
| 背景 | `--c-bg` | `#0d1117` | `#ffffff` |
| 侧边栏 / 卡片表面 | `--c-surface` | `#161b22` | `#f6f8fa` |
| 悬浮层 | `--c-raised` | `#21262d` | `#ffffff` |
| 消息气泡（用户） | `--c-bubble` | `#1f6feb` | `#1f6feb` |
| 边框 | `--c-line` | `#30363d` | `#d0d7de` |
| 主文字 | `--c-fg` | `#c9d1d9` | `#1f2328` |
| 次要文字 | `--c-fg-muted` | `#8b949e` | `#656d76` |
| 成功 | `--c-success` | `#3fb950` | `#1a7f37` |
| 错误 | `--c-danger` | `#f85149` | `#cf222e` |
| 强调 | `--c-accent` | `#58a6ff` | `#0969da` |
| 警告 | `--c-warn` | `#d29922` | `#9a6700` |

### 8.3 字体

- 正文：`-apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, …, "PingFang SC", …`
- 代码/终端：`"JetBrains Mono", "Fira Code", ui-monospace, Menlo, monospace`

### 8.4 动画

- 消息出现：淡入 + 轻微上移（150ms）
- 加载态：旋转图标
- 侧边栏折叠：宽度过渡（200ms ease-out）

### 8.5 主题切换的一个坑

**不要给 `<html>` 写死 `.dark` 之类的类名。** 切换逻辑只挂/摘 `.light`，
写死的暗色类会一直生效导致切不过去（这个坑踩过一次）。
正确做法是：暗色是 `:root` 的默认值，`html.light` 只负责覆盖成亮色。

`index.html` 里有一段内联脚本在首屏绘制前从 `localStorage` 定好主题，避免刷新闪白。

---

## 9. 路由设计

```
/                      → RootRedirect，重定向到最近任务或新任务
/chat                  → 新任务（不落 thread_id）
/chat/:threadId        → 指定任务
/settings              → 设置页（模型、主题、运行模式）
*                      → RootRedirect
```

路由上的 `threadId` 是唯一真源：`ChatPage` 监听它同步 store，切任务时顺带给
`<MessageList>` 加 `key` 重挂载。

---

## 10. 构建与部署

### 10.1 开发

```bash
cd web
pnpm install
pnpm dev            # Vite 启动，默认端口 5173
```

前端在 `web/`，是**独立的前端项目**，用 pnpm 管理，不参与 uv 的依赖管理。

> **mock 默认是关的。** `VITE_USE_MOCK` 不设即为 `false`，前端会直接去连后端然后满屏报错。
> 后端还没做时二选一：
>
> ```bash
> VITE_USE_MOCK=true pnpm dev          # 方式一：命令行直接给
> cp .env.example .env.local           # 方式二：写进环境文件（.env.example 里已是 true）
> ```

Vite 配置代理，把 `/api` 转发到后端 `langgraph dev` 的 `2024` 端口，避免跨域。
目标地址可用 `VITE_LANGGRAPH_URL` 覆盖：

```typescript
// vite.config.ts
server: {
  port: 5173,
  proxy: {
    '/api': {
      target: env.VITE_LANGGRAPH_URL || 'http://localhost:2024',
      changeOrigin: true,
      rewrite: (path) => path.replace(/^\/api/, ''),
    },
  },
}
```

### 10.2 构建

```bash
pnpm build           # tsc -b && vite build，产物在 dist/
pnpm lint            # oxlint
```

`build` 时会提示 chunk 超过 500 kB —— 那是 Shiki 的 oniguruma wasm（622 kB）和
refractor 的语言包，属于按需加载，不在首屏关键路径上。

### 10.3 环境变量

见 `.env.example`（`.env.local` 不入库）。

| 变量 | 默认 | 说明 |
|------|------|------|
| `VITE_LANGGRAPH_URL` | `http://localhost:2024` | 开发态代理目标 |
| `VITE_API_BASE_URL` | `/api` | 留空走同源代理；跨域部署才显式设置 |
| `VITE_ASSISTANT_ID` | `code_agent` | 对应 `langgraph.json` 的 `graphs` key |
| `VITE_USE_MOCK` | `false` | **只有演示才开**，生产必须 false |
| `VITE_LANGGRAPH_API_KEY` | 空 | 经 `Authorization: Bearer` 透传 |

工作空间**不通过环境变量预设**，只能在界面上点选（7.7）。

### 10.4 部署选项

- 静态托管：Vercel / Netlify / Nginx，产物是纯静态文件
- 与后端同域：构建产物放入后端静态目录，由网关做同样的 `/api` 转发
- 跨域部署：后端配置 CORS，前端 `VITE_API_BASE_URL` 指向后端域名

---

## 11. 待决项

### 11.1 已定的

- [x] 前端框架：React 19 + TypeScript 6（不再是"React vs Vue"待定）
- [x] 代码块主题与高亮库：Shiki
- [x] 包管理：pnpm
- [x] 任务运行参数：工作空间 + 三级权限（`manual` / `normal` / `auto`）
- [x] 对话模型切换（010 期）：选中即生效，不用重启后端
- [x] 斜杠命令菜单（011 期）：`/compaction` 手动压缩对话历史
- [x] 工作空间按任务生效（014 期）：弹系统目录框选目录，agent 的写操作落在那个目录里
- [x] 记忆面板（017 期）：查看/编辑用户级 + 项目级两份长期记忆
- [x] skill 勾选（018 期）：斜杠菜单里混排 skill，勾中的 `SKILL.md` 全文钉进上下文

### 11.2 待定的

- [ ] 右侧文件预览面板（本期布局已按两栏设计，接上不影响）
- [ ] 历史消息分页加载策略
- [ ] 附件上传与 @提及文件
- [ ] 移动端适配（本期优先桌面端）
- [ ] **虚拟滚动**：`index.css` 里的 `.cv-auto` 已定义但尚未挂到消息项上，目前是全量渲染。
      等消息量真的上来了，把这个类加到 `MessageList` 的消息容器即可

> 原先这里挂着「危险操作确认的前端入口 —— 协议还没设计」，009 期已经落地：
> 后端 HITL 挂起 → 前端弹确认卡片 → `command.resume` 送回决定。015 期又加了
> **逐条选择**（批准 / 拒绝 / 改后执行）和**拒绝理由**，详见
> `docs/backend/PROGRESS.md` 的 009 期。2026-10-26 起 **`manual` 档下非只读的
> MCP 工具也会走同一张卡片**（工具名是 `mcp__{服务器}__{工具}`，描述里带服务器名
> 和参数；这种卡片只给批准 / 拒绝，不给改后执行）。

---

## 12. 实现现状

`web/` 是本文档 1–10 节的实现。按当前代码逐条对照：

| 能力 | 状态 |
|------|------|
| 任务列表 / 新建 / 切换 / 删除 | ✅ |
| 流式对话、停止生成、错误浮层 | ✅ |
| 工具卡片四态、按类型差异化渲染 | ✅ |
| Diff（统一视图，四种输入形态，2000 行截断） | ✅ |
| Shiki 代码高亮 + 复制 | ✅ |
| 待办实时同步 + 点击跳转到对应工具调用 | ✅ |
| 亮/暗主题 | ✅ |
| 工作空间选择器（系统原生目录框，014 期） | ✅ |
| 权限三级下拉 + 参数传递 | ✅（后端拦截点 009 期已落地） |
| 人工确认卡片（批准 / 拒绝 / 改后执行 + 拒绝理由，009/015 期） | ✅ |
| 记忆面板（用户级 + 项目级，017 期） | ✅ |
| skill 勾选（斜杠菜单 + chip + 随请求下发，018 期） | ✅ |
| 模型管理界面（直连 `/admin/models`） | ✅ |
| Mock 模式 | ✅ |
| 自动滚动（ResizeObserver）+ 回到底部 | ✅ |
| 虚拟滚动 | ❌ `.cv-auto` 已定义但未挂载（见 11.2） |
| 与真实后端联调 | ✅（后端已到 018 期，见 `docs/backend/PROGRESS.md`） |

> 这张表是**前端能力清单的单一事实源**。后端进度快照
> （[`docs/backend/PROGRESS.md`](backend/PROGRESS.md) §1.3）只留与后端耦合的条目，
> 不再复刻这张表——复刻就多一个会漂移的地方。
