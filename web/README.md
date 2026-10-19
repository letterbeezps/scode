# web — 网页版 Code Agent 前端

按 [`docs/frontend-design.md`](../docs/frontend-design.md) 实现的独立 SPA。
后端契约见 [`docs/overall-design.md`](../docs/overall-design.md)。

技术栈：Vite 8 + React 19 + TypeScript 6 + TailwindCSS 4 + Zustand 5 + React Router 7。
包管理用 [pnpm](https://pnpm.io/)：`pnpm-lock.yaml` 锁定依赖，具体 pnpm 版本锁在 `package.json` 的 `packageManager` 字段。

## 快速开始

```bash
cd web
pnpm install
cp .env.example .env.local    # 按需修改
pnpm dev                      # http://localhost:5173
```

开发态 Vite 把 `/api/*` 代理到 `VITE_LANGGRAPH_URL`（默认 `http://localhost:2024`），
即 `langgraph dev` 的端口，避免跨域。

### 没有后端也能跑

后端没起（或只想看 UI）时，用内置 mock 数据体验完整交互：

```bash
VITE_USE_MOCK=true pnpm dev
```

`src/api/mock/` 按与真实后端**完全相同的接口签名**实现了假数据，
覆盖了流式 token、工具调用状态流转、todo 同步、diff 渲染、停止生成等全部路径。
工作空间选择器在 mock 下走一棵写死的假文件树（`MOCK_FS`），
回复末尾还会把这次收到的 `workspace` / `permissions` 原样回显出来，方便确认参数确实传到了。
侧边栏会显示黄色提示条，避免和真实数据混淆。生产构建务必关掉。

## 脚本

| 命令 | 说明 |
|------|------|
| `pnpm dev` | 开发服务器 |
| `pnpm build` | 类型检查 + 产物构建到 `dist/` |
| `pnpm lint` | oxlint |
| `pnpm preview` | 本地预览构建产物 |

依赖升级走 `pnpm update <包名>`，改完记得跑一遍 `pnpm build`。

## 环境变量

见 `.env.example`。要点：

- `VITE_USE_MOCK` —— 默认 `false`，只有演示时才开
- `VITE_API_BASE_URL` —— 留空走同源 `/api` 代理；跨域部署时才显式设置
- `VITE_ASSISTANT_ID` —— 对应 `langgraph.json` 里的 `graphs` key，默认 `code_agent`

工作空间**不通过环境变量预设**，只能在界面上点选，见下文「工作空间」。

## 两个任务级参数：工作空间 + 权限

输入区下方有两个选择器，按**任务**（threadId）存，不是全局设置 ——
同一个任务里前后两条消息可能针对不同目录、不同确认策略。
新任务在创建 thread 之前就要能配，所以额外留一份 `draft`，
`createThread()` 时用 `adoptDraft()` 固化并把 draft 重置回默认值，
否则两个任务的运行边界会互相串。删除任务时一并清掉。

### 工作空间：文件夹浏览器，不是输入框

手打项目路径是危险动作 —— 打错一个字符就是授权给了错误的目录。
所以「工作空间」是个点开的文件夹浏览器：

- **默认不选**。不预设任何目录，让用户明确选择，而不是默认就授权了某处
- 每一行两个按钮：左边整块 = **选中这个目录**，右边箭头 = **进入**
  （双击进入不可靠，第一次点击就会触发重渲染，第二次点击落在别的元素上）
- 选中后面板**不关**，底栏实时显示路径，可以接着往下钻、改主意，再点「完成」
- 选中后按钮右上角有常驻的 ✗ 取消入口，不用去 hover 里找
- 下次打开从已选工作空间的**父目录**起步

绝对路径必须由后端给出 —— 浏览器的 File System Access API 和 `<input webkitdirectory>`
都故意不暴露绝对路径。这是前端拿到绝对路径的唯一途径，因此新增了一个端点约定：

```
GET /directories?path=<绝对路径>

→ {
    "path": "/Users/1token/Desktop/project",
    "parent": "/Users/1token/Desktop",
    "directories": [
      { "name": "stupid-code", "path": "/Users/1token/Desktop/project/stupid-code" }
    ]
  }
```

`path` 省略时等价于根目录。只返回子目录，不返回文件。
路径不可读时返回 4xx/5xx，前端在面板内就地显示错误，不会白屏。

**后端尚未实现这个端点**，`GET /directories` 目前只是契约；
mock 模式（`VITE_USE_MOCK=true`）下由 `api/mock` 里的一棵假文件树顶上。

### 权限：三级确认策略，不是能力白名单

选项就是后端认识的三个值本身，界面上一律显示英文，不翻译：

| 值 | 含义 |
|---|---|
| `manual` | 命中危险操作的，先确认再执行 |
| `normal` | AI 审核这次操作是否危险，再决定要不要确认 |
| `auto` | 不确认，直接执行 |

默认 `normal`。`manual` 会被打断到没法用，`auto` 等于把机器完全交出去。

这不是「read/write/execute/network 四个能力开关」，
而是**执行前要不要停下来问一句**。前端只负责把值原样传下去，
真正的拦截点在后端的工具调用入口：

```jsonc
// POST /threads/{id}/runs/stream
{
  "config": {
    "configurable": {
      "workspace": "/Users/1token/Desktop/project/stupid-code",  // 空字符串 = 不选
      "permissions": "normal"
    }
  }
}
```

后端在工具执行前按 `permissions` 决定：直接跑、还是**挂起这次调用**等前端确认。
挂起后前端需要一个确认入口（设计文档里还没有，这是待补的一环）。
注意这是执行前的闸门，和「工具调用事后可见」是两件事。

## 目录结构

```
src/
├── api/                  # 与后端通信，全部细节隔离在这一层
│   ├── types.ts          # 领域类型（Thread / Message / ToolCall / Todo）
│   ├── client.ts         # fetch 封装、前缀、错误处理、mock 开关
│   ├── sse.ts            # SSE 解析器（有状态，一条事件可能横跨两个 chunk）
│   ├── events.ts         # 事件归一化：LangGraph 原生事件 → 前端语义事件
│   ├── thread.ts         # 线程 CRUD + 历史消息还原
│   ├── run.ts            # 流式运行与取消（带 workspace / permissions）
│   ├── directory.ts      # 工作空间选择器用的目录浏览
│   └── mock/             # 无后端时的假实现
├── store/                # Zustand：conversation / ui / todo / settings / task
├── lib/
│   ├── cn.ts             # className 合并、文件扩展名 → shiki 语言名
│   ├── permissions.ts    # 三级确认策略的取值与说明
│   ├── tools.ts          # 工具名 → 类型分类（纯逻辑，不含 React）
│   ├── diff.ts           # 从工具参数/结果拼出 diff 的新旧文本
│   └── highlight.ts      # Shiki 单例（动态 import）
├── hooks/
│   └── useAutoScroll.ts  # 流式自动滚动 + 用户上滑暂停
├── components/
│   ├── sidebar/          # 任务列表、待办列表、设置入口
│   └── chat/             # 消息列表、输入区、工作空间/权限选择器、markdown、工具可视化
└── pages/                # ChatPage / RootRedirect / SettingsPage
```

### 「任务」和「待办」不是一回事

侧边栏的**任务列表**就是会话（thread），点「新建任务」开一个新的。
下面的**待办**是 Agent 自己维护的 TodoList（`write_todos` 工具驱动的），两者会同时出现，
所以早期版本把会话也叫「任务」造成了歧义，现在按语义拆开了。


## 实现说明

### 消息用有序片段，而不是平铺字段

设计文档 5.2 的 `Message` 只有 `content` 和 `tool_calls` 两个平级字段，
但 4.1 要求按「文本 + 代码块 + 工具调用混合排列」渲染。
平铺字段表达不了「先说一段话 → 调工具 → 再接着说」的顺序，
所以额外维护了 `parts: MessagePart[]`，**渲染一律以 parts 为准**，
`content` / `tool_calls` 仍同步维护，供接口层和断言使用。

### SSE 同时兼容两套事件格式

「前端能消费的流式协议」有两份说法：

1. 设计文档 4.2 的语义事件：`messages` / `tool_call` / `tool_result` / `todos` / `error` / `end`
   （LangGraph 里用 `get_stream_writer()` 发出）
2. LangGraph Platform `/runs/stream` 的原生事件：`metadata` / `updates` / `values` / `error` / `end`

后端现在走的是第 2 套（平台原生），但 `api/events.ts` 两份都接并做了去重：
优先采信显式语义事件，只有没收到过显式 `messages` 时才从 `updates` 里推导文本 token，
否则同一段话会被追加两遍。

发起运行时只请求 `stream_mode: ["updates"]` —— `values` 每次都回传全量状态，噪音大。
平台还支持 `messages-tuple` 拿 token 级增量（**事件名是 `messages`，不是 `messages-tuple`**），
目前没切，先保证「整段到达」这条路径是通的。

### SSE 解析器必须有状态

一条 SSE 事件的 `event:` 和 `data:` 完全可能分处两个网络 chunk。
`sse.ts` 的 `SseParser` 持有跨块缓冲，纯函数式实现会随机丢事件。

### 用 fetch 而非 EventSource

`EventSource` 不支持自定义 header，生产环境的鉴权没法带。
`run.ts` 用 `fetch` + `ReadableStream` 手动解析，同时覆盖两种场景。

### Diff 的四种输入形态

`react-diff-viewer` 只吃整篇的新旧文本，但后端给过来的东西有四种，
`lib/diff.ts` 按优先级依次尝试：

1. 参数里直接给了新旧全文 → 整篇对比（行号才对得上）
2. 结果里给了 unified diff → 解析还原两侧全文
3. `edit_file` 只给了 `old_string` / `new_string` → 退化成片段对比
4. 只有新内容 → 当作「从空文件写入」的全量 diff

超过 2000 行会截断并提示。

### 主题

配色全部走 CSS 变量（`src/index.css`），暗色写在 `:root`，`html.light` 覆盖成亮色。
**不要给 `<html>` 写死 `.dark` 之类的类名** —— 切换时只会追加 `.light`，
写死的暗色类会一直生效导致切不过去（这个坑踩过一次）。

`index.html` 里有一段内联脚本在首屏绘制前定好主题，避免刷新闪白。

### 自动滚动

`useAutoScroll` 用 ResizeObserver 监听内容高度变化，而不是让调用方把内容长度当依赖传进来
——流式场景下依赖表达式很难写准，写错就是滚动失效。
判定「用户是否在底部」用距底部距离阈值，不用滚动方向，
否则每来一个 token 都会把用户拽回底部。

切换会话时给 `<MessageList>` 加 `key` 直接重挂载，不用 effect 重置滚动状态。

### 懒加载

Shiki 和 `react-diff-viewer-continued` 都用动态 import 拆出主 chunk。
后者连带 refractor 的全部语言语法（十几 MB 的懒加载 chunk），
只有真的出现文件改动时才下载。主 chunk 从 725 kB 降到 465 kB（gzip 145 kB）。

`build` 时仍会提示 chunk 超过 500 kB —— 那是 Shiki 的 oniguruma wasm（622 kB）
和 refractor 的语言包，属于按需加载，不在首屏关键路径上。

## 尚未实现

对应设计文档 11 的待决项，以及本期明确不做的：

- **`GET /directories` 的后端实现**（前端契约已定，见上文）
- **危险操作确认的前端入口**：`permissions` 已经会传给后端，
  但 `manual` 触发时后端要能挂起工具调用、前端要能展示确认卡片 —— 这套协议还没设计
- 右侧文件预览面板
- 历史消息分页加载
- 多模型切换的真正透传（`/settings` 里的模型选择目前只写 localStorage，
  后端这一轮实际用哪个模型由 `conf/config.toml` 的 `default` 决定）
- 移动端适配（本期优先桌面端）

## 已知取舍

- **工作空间和权限只存在内存里**，刷新页面就回到默认值。
  这两个是「这一次运行」的边界，不是用户偏好，写进 localStorage 反而容易让人
  以为某次执行还带着上次的授权。等后端能回读任务配置了再谈持久化。
- **虚拟滚动还没启用**：`index.css` 里定义了 `.cv-auto`（`content-visibility: auto`），
  但目前没有元素挂这个类，消息列表是全量渲染。
  不走 JS 虚拟化是因为代码块和 diff 高度不定，手写高度测量容易抖动；
  等消息量上来了，把这个类加到 `MessageList` 的消息容器就行。
- **模型下拉和后端实际用的模型不是一回事**：下拉读的是 `/admin/models` 拉来的列表
  （不再是写死的几项），在下拉里选一个只写 localStorage；后端这一轮实际用哪个
  模型由 `conf/config.toml` 的 `default` 决定，改完要重启后端才生效。
- **Diff 统一视图**，分栏视图留着 `splitView` 属性没开 —— 窄栏下分栏每行只剩十几个字符。
