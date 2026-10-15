# 网页版 Code Agent 总体设计文档

> 版本：v0.1（粗略版）
> 日期：2026-10-16

## 1. 项目概述

本项目旨在开发一个 **网页版 Code Agent** 应用，用户通过浏览器与 AI 编码助手进行对话，Agent 能够读取、编辑项目文件，执行终端命令，辅助完成软件开发任务。

### 1.1 目标

- 提供与主流 Code Agent（如 Cursor、Cline、Trae）一致的交互体验
- 前后端分离，后端基于 Deep Agents 框架 + langgraph-cli 提供 Agent 能力
- 前端为独立网页应用，通过 HTTP 与后端通信
- 支持流式输出、工具调用可视化、文件 Diff 查看等核心体验

### 1.2 非目标（本期不做）

- 多用户协作 / 权限系统
- 云端部署与多租户
- 移动端适配（优先桌面端）
- 完整的后端设计细节（见独立文档，本期仅作概览）

---

## 2. 系统架构总览

系统采用 **前后端分离** 架构，分为三层：

```
┌─────────────────────────────────────────────────────┐
│                   前端 (Web App)                     │
│   React / Vue 单页应用                               │
│   - 对话窗口、侧边栏、工具调用展示、Diff 查看         │
│   - HTTP + SSE 客户端                                │
└──────────────────────┬──────────────────────────────┘
                       │ HTTP / SSE
┌──────────────────────▼──────────────────────────────┐
│              后端 (LangGraph API Server)             │
│   langgraph-cli 启动，暴露 LangGraph Platform API    │
│   - Agent 运行时（Deep Agents 框架）                 │
│   - 对话状态持久化（thread_id）                       │
│   - 流式事件推送（SSE）                              │
└──────────────────────┬──────────────────────────────┘
                       │
┌──────────────────────▼──────────────────────────────┐
│              Agent Core (Deep Agents)                │
│   create_deep_agent() 构建的代码助手                 │
│   - 内置工具：ls / read_file / write_file / edit     │
│   - TodoList 任务规划、SubAgent 委派                 │
│   - 自定义工具：终端执行、Git 操作等                  │
└─────────────────────────────────────────────────────┘
```

### 2.1 技术栈

| 层级 | 技术选型 |
|------|---------|
| 前端 | React 18+ / TypeScript / Vite（待定）、TailwindCSS |
| 后端运行时 | Python 3.12+、Deep Agents、LangGraph |
| 服务启动 | langgraph-cli（`langgraph dev` / `langgraph up`） |
| 通信协议 | HTTP REST + Server-Sent Events (SSE) |
| 状态持久化 | LangGraph Checkpointer（开发期 InMemory，生产 Postgres） |

---

## 3. 后端概览

> 后端详细设计将单独成文，此处仅说明与前端对接相关的部分。

### 3.1 Agent 构建

使用 `create_deep_agent()` 构建代码助手，核心配置：

- **模型**：可配置的 LLM（如 Claude / GPT 系列）
- **系统提示词**：编码助手角色设定
- **工具集**：
  - 内置：`ls`、`read_file`、`write_file`、`edit_file`、`glob`、`grep`、`write_todos`、`task`
  - 自定义：终端命令执行、Git 操作、代码格式化等
- **中间件**：TodoListMiddleware（任务规划）、FilesystemMiddleware（文件上下文）、SubAgentMiddleware（子 Agent 委派）
- **持久化**：Checkpointer 维护 thread 对话状态，Store 维护跨会话记忆

### 3.2 服务启动

通过 `langgraph-cli` 启动 LangGraph API Server：

```bash
# 开发模式（热重载，默认端口 2024）
langgraph dev

# 生产模式（Docker Compose + Postgres，默认端口 8123）
langgraph up
```

`langgraph.json` 配置指向编译后的 Agent Graph：

```json
{
  "dependencies": ["."],
  "graphs": {
    "code_agent": "./stupid_code/agent.py:graph"
  },
  "env": "./.env"
}
```

### 3.3 对外 API（LangGraph Platform API）

langgraph-cli 启动后暴露标准 LangGraph API，前端主要使用以下端点：

| 方法 | 路径 | 用途 |
|------|------|------|
| POST | `/threads` | 创建新的对话线程 |
| POST | `/threads/{thread_id}/runs` | 创建一次 Agent 运行 |
| POST | `/threads/{thread_id}/runs/stream` | 流式运行（SSE） |
| GET | `/threads/{thread_id}/state` | 获取线程当前状态 |
| POST | `/threads/{thread_id}/runs/{run_id}/cancel` | 取消运行 |
| GET | `/threads/{thread_id}/history` | 获取历史消息 |

---

## 4. 通信协议

### 4.1 请求-响应模式

- 前端通过 HTTP POST 发起对话，携带用户消息与 `thread_id`
- 后端返回 `run_id`，随后通过 SSE 推送事件流

### 4.2 SSE 事件流

Agent 运行过程中产生的事件通过 SSE 实时推送，前端据此渲染：

| 事件类型 | 说明 | 前端处理 |
|---------|------|---------|
| `messages` | 模型生成的文本 token | 流式追加到消息气泡 |
| `tool_call` | Agent 调用工具（读文件、执行命令等） | 渲染工具调用卡片 |
| `tool_result` | 工具执行结果 | 展示结果、Diff、终端输出 |
| `todos` | 任务计划更新 | 更新侧边栏任务列表 |
| `error` | 运行异常 | 展示错误提示 |
| `end` | 运行结束 | 恢复输入区可编辑状态 |

### 4.3 鉴权

- 开发阶段：可选，本地直连
- 生产阶段：通过 `LANGSMITH_API_KEY` 或反向网关做鉴权

---

## 5. 核心数据模型

### 5.1 对话线程（Thread）

```typescript
interface Thread {
  thread_id: string;        // LangGraph thread 标识
  title: string;            // 对话标题（首条消息生成）
  created_at: string;
  updated_at: string;
}
```

### 5.2 消息（Message）

```typescript
interface Message {
  id: string;
  thread_id: string;
  role: 'user' | 'assistant' | 'tool';
  content: string;          // 文本内容（Markdown）
  tool_calls?: ToolCall[];  // 助手消息附带的工具调用
  tool_call_id?: string;    // 工具结果消息关联的调用 ID
  created_at: string;
}
```

### 5.3 工具调用（ToolCall）

```typescript
interface ToolCall {
  id: string;
  name: string;             // 工具名：read_file / edit_file / run_command ...
  args: Record<string, any>;
  result?: ToolResult;      // 执行结果（异步填充）
  status: 'pending' | 'running' | 'success' | 'error';
}

interface ToolResult {
  output: string;
  diff?: string;            // 文件编辑时的 unified diff
  files?: string[];         // 涉及的文件路径
}
```

---

## 6. 目录结构规划

```
stupid-code/
├── docs/                      # 设计文档
│   ├── overall-design.md      # 本文档
│   └── frontend-design.md     # 前端设计文档
├── stupid_code/               # 后端 Python 包
│   ├── agent.py               # create_deep_agent 构建入口
│   ├── tools/                 # 自定义工具
│   └── ...
├── frontend/                  # 前端 Web 应用（独立子项目）
│   ├── src/
│   │   ├── components/
│   │   ├── pages/
│   │   ├── api/               # 后端通信层
│   │   ├── store/             # 状态管理
│   │   └── ...
│   ├── package.json
│   └── vite.config.ts
├── langgraph.json             # langgraph-cli 配置
├── pyproject.toml
└── .env
```

---

## 7. 开发阶段

| 阶段 | 内容 | 产出 |
|------|------|------|
| P0 | 后端 Agent 骨架 + langgraph-cli 跑通 | 可对话的后端服务 |
| P1 | 前端基础布局 + 对话流式渲染 | 可用的聊天界面 |
| P2 | 工具调用可视化 + 文件 Diff | 完整编码交互体验 |
| P3 | 会话历史、任务列表、完善样式 | 接近产品级体验 |

---

## 8. 风险与待决项

- **SSE 跨域**：前端需配置 CORS 或使用同源代理
- **大文件 Diff 性能**：需考虑虚拟滚动或截断展示
- **会话持久化**：开发期 InMemory 重启丢失，生产需 Postgres
- **技术选型待定**：前端框架（React vs Vue）、UI 库、状态管理方案待前端设计文档确定
