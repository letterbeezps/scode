/**
 * 领域类型定义。
 *
 * 与《总体设计文档》5. 核心数据模型保持一致，字段名沿用 LangGraph Platform
 * 的 snake_case 约定，避免在前端做一次无意义的重命名。
 */
import type { PermissionLevel } from '../lib/permissions'

/* ------------------------------------------------------------------ 对话线程 */

export interface Thread {
  thread_id: string
  title: string
  created_at: string
  updated_at: string
}

/* ---------------------------------------------------------------------- 工具 */

export type ToolCallStatus = 'pending' | 'running' | 'success' | 'error'

export interface ToolResult {
  output: string
  /** 文件编辑时的 unified diff */
  diff?: string
  /** 本次工具调用涉及的文件路径 */
  files?: string[]
}

export interface ToolCall {
  id: string
  name: string
  args: Record<string, unknown>
  /** 执行结果，由 tool_result 事件异步填充 */
  result?: ToolResult
  status: ToolCallStatus
  error?: string
  /** 该工具调用的开始时间，用于展示耗时 */
  startedAt?: number
}

/* ---------------------------------------------------------------------- 消息 */

export type MessageRole = 'user' | 'assistant' | 'tool'

/**
 * 一条助手消息内部的有序片段。
 *
 * 设计文档 4.1 要求 AssistantMessage 按“文本 + 代码块 + 工具调用混合排列”渲染，
 * 而 5.2 的 Message 只有 `content` 和 `tool_calls` 两个平级字段——平级字段无法表达
 * “先说一段话 → 调工具 → 再接着说”的顺序，所以渲染一律以 parts 为准。
 * content / tool_calls 仍然维护，供接口层与断言使用。
 */
export type MessagePart =
  | { kind: 'text'; text: string }
  | { kind: 'tool'; call: ToolCall }

export interface Message {
  id: string
  thread_id: string
  role: MessageRole
  content: string
  tool_calls?: ToolCall[]
  tool_call_id?: string
  parts: MessagePart[]
  created_at: string
  /** 运行失败时写入，渲染为错误卡片 */
  error?: string
  /** 用户主动停止 */
  interrupted?: boolean
}

/* ------------------------------------------------------------------ 任务列表 */

export type TodoStatus = 'pending' | 'in_progress' | 'completed'

export interface Todo {
  content: string
  status: TodoStatus
  activeForm?: string
  /** 对应的工具调用 id，设计文档 7.6 要求点击 todo 能跳到该工具调用 */
  toolCallId?: string
}

/* ------------------------------------------------------------------ 任务参数 */

/**
 * 一次运行的任务参数。
 *
 * 不放在 permissions.ts 里是为了避免 lib 层反向依赖 store，
 * 而 run 请求体（api 层）需要的是这份快照。
 */
export interface RunOptions {
  /** 工作空间绝对路径。空字符串表示本次任务不选择工作空间 */
  workspace: string
  permissions: PermissionLevel
}

/* -------------------------------------------------------- LangGraph 平台协议 */

/** LangGraph Platform 返回的 thread 列表是包了一层的 */
export interface ThreadListResponse {
  threads: Thread[]
}

/** 客户端可枚举的模型（/settings 页展示） */
export interface ModelOption {
  id: string
  label: string
  provider?: string
}
