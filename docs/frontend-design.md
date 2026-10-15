# 网页版 Code Agent 前端设计文档

> 版本：v0.1
> 日期：2026-10-16

## 1. 设计目标

构建一个独立的网页前端，为用户提供与主流 Code Agent（Cursor / Cline / Trae）一致的交互体验。核心目标：

1. **对话优先**：主区域为对话窗口，支持流式输出
2. **工具可视化**：清晰展示 Agent 的文件读写、命令执行等操作
3. **左侧边栏**：会话历史 + 任务列表
4. **编码辅助**：代码高亮、文件 Diff、终端输出等专业视图
5. **轻量独立**：与后端通过 HTTP/SSE 解耦，可单独开发部署

---

## 2. 技术选型

| 类别 | 选型 | 理由 |
|------|------|------|
| 框架 | React 18 + TypeScript | 生态成熟，组件库丰富，类型安全 |
| 构建工具 | Vite | 启动快、HMR 体验好 |
| 样式 | TailwindCSS | 原子化 CSS，快速构建一致 UI |
| 状态管理 | Zustand | 轻量，适合对话类应用的集中状态 |
| 路由 | React Router | 多会话切换 |
| Markdown 渲染 | react-markdown + remark-gfm | GFM 支持、可定制代码块 |
| 代码高亮 | Shiki / highlight.js | 语法高亮质量高 |
| Diff 展示 | react-diff-viewer-continued | 文件变更对比 |
| HTTP 客户端 | fetch + EventSource | SSE 原生支持，无需额外依赖 |
| 图标 | lucide-react | 轻量现代图标库 |

> 选型可根据团队偏好调整，核心需求是 React 生态 + TypeScript。

---

## 3. 整体布局

采用经典的 **三栏式 Code Agent 布局**：

```
┌──────────┬───────────────────────────────────────────┐
│          │                                           │
│  侧边栏  │              主对话区                       │
│          │                                           │
│  - 新对话 │   ┌─────────────────────────────────┐    │
│  - 会话   │   │  消息列表（用户/助手交替）        │    │
│    列表   │   │  - 文本气泡                      │    │
│  - 任务   │   │  - 代码块（高亮+复制）            │    │
│    列表   │   │  - 工具调用卡片（可展开）          │    │
│          │   │  - 文件 Diff                     │    │
│          │   │  - 终端输出                      │    │
│          │   └─────────────────────────────────┘    │
│          │   ┌─────────────────────────────────┐    │
│          │   │  输入区（多行文本+附件+发送）      │    │
│          │   └─────────────────────────────────┘    │
└──────────┴───────────────────────────────────────────┘
```

### 3.1 左侧边栏（Sidebar）

宽度约 `280px`，可折叠。包含：

- **顶部**：Logo + "新建对话" 按钮
- **会话列表**：按时间倒序，显示标题、时间，支持点击切换、右键删除
- **任务列表（Todo）**：当前会话的 TodoList，显示待办/进行中/已完成状态
- **底部**：模型选择器、设置入口

### 3.2 主对话区（ChatArea）

- **消息列表**：垂直滚动，用户消息靠右、助手消息靠左
- **流式渲染**：助手文本逐字追加，光标闪烁
- **生成中状态**：显示停止按钮、"正在思考..." 提示
- **空状态**：欢迎语 + 快捷指令卡片

### 3.3 输入区（InputBar）

- 多行文本框（自适应高度，最大高度限制）
- 附件按钮：上传文件、截图
- 发送按钮（Enter 发送，Shift+Enter 换行）
- 生成中变为停止按钮
- 可选：模型切换下拉、@提及文件

---

## 4. 组件架构

```
App
├── Layout
│   ├── Sidebar
│   │   ├── NewChatButton
│   │   ├── ConversationList
│   │   │   └── ConversationItem
│   │   ├── TodoList
│   │   │   └── TodoItem
│   │   └── SettingsPanel
│   └── ChatArea
│       ├── MessageList
│       │   ├── UserMessage
│       │   └── AssistantMessage
│       │       ├── MarkdownContent
│       │       ├── CodeBlock
│       │       ├── ToolCallCard
│       │       │   ├── ToolCallHeader
│       │       │   └── ToolCallResult
│       │       ├── FileDiff
│       │       └── TerminalOutput
│       └── InputBar
│           ├── TextInput
│           ├── AttachButton
│           └── SendButton
```

### 4.1 核心组件说明

#### MessageList
- 虚拟滚动（消息量大时性能保障）
- 自动滚动到底部（用户手动上滑时暂停）
- 流式消息通过 `pendingMessage` 状态实时更新

#### AssistantMessage
- 复合内容渲染：文本 + 代码块 + 工具调用混合排列
- 工具调用卡片可展开/折叠，默认折叠结果
- 文件编辑类工具自动渲染 Diff

#### ToolCallCard
- 头部：工具图标 + 名称 + 状态（运行中/成功/失败）
- 展开后：参数展示 + 执行结果
- 文件工具额外展示文件路径与 Diff
- 命令工具展示终端输出（等宽字体）

#### CodeBlock
- 语法高亮（Shiki）
- 语言标签 + 一键复制按钮
- 代码块内可点击文件名跳转到 Diff

---

## 5. 状态管理

使用 Zustand 管理全局状态，按领域拆分 store：

### 5.1 conversationStore

```typescript
interface ConversationState {
  threads: Thread[];
  activeThreadId: string | null;
  messages: Record<string, Message[]>;        // thread_id -> messages
  pendingMessage: Message | null;             // 当前流式生成中的消息
  isGenerating: boolean;
  createThread: () => Promise<string>;
  selectThread: (id: string) => void;
  deleteThread: (id: string) => void;
  sendMessage: (content: string) => Promise<void>;
  cancelRun: () => void;
}
```

### 5.2 uiStore

```typescript
interface UIState {
  sidebarCollapsed: boolean;
  activeToolCallId: string | null;   // 展开的工具调用卡片
  theme: 'light' | 'dark';
  toggleSidebar: () => void;
  setActiveToolCall: (id: string | null) => void;
}
```

### 5.3 todoStore

```typescript
interface TodoState {
  todos: Record<string, Todo[]>;    // thread_id -> todos
  updateTodos: (threadId: string, todos: Todo[]) => void;
}
```

---

## 6. API 通信层

封装 `src/api/` 目录，隔离后端细节。

### 6.1 目录结构

```
src/api/
├── client.ts          # fetch 封装、基础路径、错误处理
├── sse.ts             # EventSource / fetch-stream 封装
├── thread.ts          # 线程相关 API
├── run.ts             # 运行相关 API（含流式）
└── types.ts           # 请求/响应类型定义
```

### 6.2 核心 API 封装

```typescript
// src/api/thread.ts
export async function createThread(): Promise<Thread> {
  const res = await fetch(`${BASE_URL}/threads`, { method: 'POST' });
  return res.json();
}

// src/api/run.ts
export function streamRun(
  threadId: string,
  message: string,
  handlers: {
    onToken: (text: string) => void;
    onToolCall: (toolCall: ToolCall) => void;
    onToolResult: (result: ToolResult) => void;
    onTodos: (todos: Todo[]) => void;
    onError: (err: string) => void;
    onEnd: () => void;
  }
): () => void {
  // 使用 fetch + ReadableStream 解析 SSE
  // 返回取消函数
}
```

### 6.3 SSE 解析

langgraph-cli 的 `/runs/stream` 返回 SSE 格式，前端解析 `event:` 和 `data:` 行，根据事件类型分发到不同 handler。

> 注意：EventSource 不支持自定义 header（如鉴权），如需鉴权改用 `fetch` + `ReadableStream` 手动解析 SSE。

---

## 7. 核心功能设计

### 7.1 对话流式渲染

1. 用户发送消息 → 乐观追加到消息列表
2. 调用 `streamRun`，创建空的 `pendingMessage`
3. SSE `messages` 事件 → 追加文本到 `pendingMessage.content`
4. SSE `tool_call` 事件 → 追加 ToolCall 到 `pendingMessage.tool_calls`
5. SSE `tool_result` 事件 → 更新对应 ToolCall 的 result 与 status
6. SSE `end` 事件 → 将 `pendingMessage` 移入正式消息列表，清空

### 7.2 工具调用可视化

工具调用按类型差异化展示：

| 工具类型 | 展示方式 |
|---------|---------|
| `read_file` | 文件路径 + 内容预览（可折叠） |
| `write_file` / `edit_file` | 文件路径 + 彩色 Diff 视图 |
| `run_command` / `bash` | 终端风格输出（黑底等宽字体） |
| `glob` / `grep` | 结果列表（文件路径 + 匹配行） |
| `write_todos` | 同步到侧边栏任务列表 |
| `task`（子 Agent） | 嵌套子任务卡片 |

### 7.3 文件 Diff

使用 `react-diff-viewer-continued`：
- 左右分栏（旧版本 vs 新版本）或统一视图
- 行级高亮，支持折叠未变更区域
- 大文件自动截断并提示"查看完整内容"

### 7.4 会话管理

- 新建对话：调用 `createThread`，清空消息列表
- 切换会话：加载对应 `thread_id` 的历史消息
- 删除会话：删除线程及本地缓存
- 标题生成：首条用户消息截断作为标题（或后端生成）

### 7.5 停止生成

- 生成中显示停止按钮，点击调用 cancelRun
- 前端调用 `cancelRun` 关闭 SSE 流，将 `pendingMessage` 标记为已中断

### 7.6 任务列表（Todo）

- SSE `todos` 事件更新 todoStore
- 侧边栏实时展示：待办（○）、进行中（◐）、已完成（●）
- 点击 todo 可跳转到对应工具调用位置

---

## 8. 样式与设计系统

### 8.1 设计原则

- **暗色优先**：代码类应用默认暗色主题，兼顾亮色
- **紧凑密度**：信息密度高，减少留白浪费
- **状态清晰**：通过颜色与图标明确区分成功/失败/运行中

### 8.2 配色（暗色主题）

| 用途 | 色值 |
|------|------|
| 背景 | `#0d1117` |
| 侧边栏背景 | `#161b22` |
| 消息气泡（用户） | `#1f6feb` |
| 消息气泡（助手） | `#21262d` |
| 边框 | `#30363d` |
| 主文字 | `#c9d1d9` |
| 次要文字 | `#8b949e` |
| 成功 | `#3fb950` |
| 错误 | `#f85149` |
| 强调 | `#58a6ff` |

### 8.3 字体

- 正文：`-apple-system, "Segoe UI", sans-serif`
- 代码/终端：`"JetBrains Mono", "Fira Code", monospace`

### 8.4 动画

- 消息出现：淡入 + 轻微上移（150ms）
- 流式光标：闪烁动画
- 工具调用状态：旋转加载图标
- 侧边栏折叠：宽度过渡（200ms ease）

---

## 9. 路由设计

```
/                      → 重定向到最近会话或新会话
/chat                  → 新会话（无 thread_id）
/chat/:threadId        → 指定会话
/settings              → 设置页（模型、API Key 等）
```

---

## 10. 构建与部署

### 10.1 开发

```bash
cd frontend
npm install
npm run dev          # Vite 启动，默认端口 5173
```

Vite 配置代理，将 `/api` 转发到后端 `langgraph dev` 的 `2024` 端口，避免跨域：

```typescript
// vite.config.ts
export default defineConfig({
  server: {
    proxy: {
      '/api': {
        target: 'http://localhost:2024',
        changeOrigin: true,
        rewrite: (path) => path.replace(/^\/api/, '')
      }
    }
  }
})
```

### 10.2 构建

```bash
npm run build        # 输出到 dist/
```

### 10.3 部署选项

- 静态托管：Vercel / Netlify / Nginx
- 与后端同域：构建产物放入后端静态目录，统一由 langgraph 服务或反向网关提供
- 跨域部署：后端配置 CORS，前端 `BASE_URL` 指向后端域名

---

## 11. 待决项

- [ ] 前端框架最终确认（React vs Vue）
- [ ] 是否需要右侧文件预览面板
- [ ] 多模型切换的交互形式
- [ ] 历史消息分页加载策略
- [ ] 代码块主题与高亮库最终选型
