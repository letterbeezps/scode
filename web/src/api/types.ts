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

/* ------------------------------------------------------------------ 模型管理 */

/**
 * 一个模型的完整描述（`GET /admin/models` 扁平数组里的一项）。
 *
 * 接口层按「模型」而不是「供应商」暴露：toml 内部虽然按 provider 分组避免
 * 重复写 api_key / base_url，但每次返回都把连接字段摊平到每个模型上，
 * 前端不需要（也不该）理解分组结构。
 *
 * api_key 默认脱敏（`***末4位`），只有带 `?reveal=true` 才返回明文。
 */
export interface AdminModel {
  /** `供应商名:模型名`，与 conf/config.toml 里 [models].default 同格式 */
  id: string
  name: string
  provider: string
  /** 只接受 anthropic / openai */
  protocol: ModelProtocol
  display_name?: string | null
  /** 留空则用协议官方端点 */
  base_url?: string | null
  api_key?: string | null
}

export type ModelProtocol = 'anthropic' | 'openai'

/** `GET /admin/models` 的响应 */
export interface ModelListResponse {
  /** config.toml 里 [models].default，后端实际使用的模型 */
  default: string | null
  /** config.toml 里 [models].recent，default 缺省时的回退 */
  recent: string | null
  models: AdminModel[]
  /** 配置是启动时读的，改完必须重启才生效 */
  restart_required: boolean
}

/** 新增模型的请求体（config.py add_model 的入参） */
export interface ModelCreateInput {
  name: string
  protocol: ModelProtocol
  provider: string
  base_url?: string
  api_key: string
  display_name?: string
}

/**
 * 修改模型的请求体。
 *
 * 字段**只影响出现的那些**：后端 update_model 逐个判断 `"key" in body`，
 * 所以 api_key 留空时必须整个字段不发，而不是发空串（空串会报 ConfigError）。
 */
export interface ModelUpdateInput {
  protocol?: ModelProtocol
  base_url?: string
  api_key?: string
  display_name?: string
}

/** POST /admin/models 的 201 响应 */
export interface ModelCreateResult {
  id: string
  created: boolean
  restart_required: boolean
}

/** PUT /admin/models/{id} 的 200 响应 */
export interface ModelUpdateResult {
  id: string
  updated: boolean
  /** 受影响的其他同级模型：连接字段按 provider 分组，改一个会波及整段 */
  co_affected: string[]
  restart_required: boolean
}

/** DELETE /admin/models/{id} 的 200 响应 */
export interface ModelDeleteResult {
  id: string
  deleted: boolean
  /** 剩余同级模型；空数组表示该供应商段已被自动清理 */
  remaining_peers: string[]
  restart_required: boolean
}
