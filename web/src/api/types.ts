/**
 * 领域类型定义。
 *
 * 与《总体设计文档》5. 核心数据模型保持一致，字段名沿用 LangGraph Platform
 * 的 snake_case 约定，避免在前端做一次无意义的重命名。
 */
import type { PermissionLevel } from '../lib/permissions'

/* ------------------------------------------------------------------ 对话线程 */

export type ThreadStatus = 'idle' | 'busy' | 'interrupted' | 'error'

/**
 * 一个会话（LangGraph 的 thread）。
 *
 * 平台的 Thread 结构里**没有 title 字段**，标题是前端自己定义的，
 * 存在 thread 的 metadata.title 里（见 api/thread.ts 的 toThread）。
 * 这样标题跟着 thread 走，刷新页面还在——只存在前端内存里的话重载就没了。
 */
export interface Thread {
  thread_id: string
  /** 来自 metadata.title，没有就是空串 */
  title: string
  created_at: string
  updated_at: string
  /** 平台会往里塞 graph_id / assistant_id，以及我们的 title */
  metadata?: Record<string, unknown>
  status?: ThreadStatus
}

/** 平台 run 的状态。页面恢复时用它判断是否还有任务在跑。 */
export type RunStatus = 'pending' | 'running' | 'error' | 'success' | 'timeout' | 'interrupted'

export interface ThreadRun {
  run_id: string
  thread_id: string
  status: RunStatus
  created_at?: string
  updated_at?: string
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
 * 一条待人工确认的工具调用。
 *
 * 后端命中 HITL（图挂起等人批准）时，通过 LangGraph 的 `__interrupt__` 事件
 * 把要审的动作发过来。批准/拒绝之后前端用 `command.resume` 把决定送回去。
 */
export interface ApprovalRequest {
  /** 工具名，如 execute */
  name: string
  /** 工具参数（如 execute 的 command） */
  args: Record<string, unknown>
  /** 后端给的说明，命中危险模式时会写明原因 */
  description?: string
}

/**
 * 人工确认的决定。
 *
 * 字段名必须和框架的 `RejectDecision` 一致：拒绝理由叫 `message`，
 * 叫 `feedback` 的话框架认不出来，理由会被静默丢掉，模型只看到
 * 「用户拒绝了这次工具调用」。
 */
export type ApprovalDecision =
  | { type: 'approve' }
  | { type: 'reject'; message?: string }

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
  /**
   * 一次待确认的动作组。
   *
   * 一次 interrupt 里可能含多个 action_request（模型一轮里发了多条命令），
   * 框架要求 resume 时给出**同样数量**的 decision，少一个就报
   * `Number of human decisions (N) does not match number of hanging tool calls (M)`。
   * 所以卡片存的是一组，不是一条。
   */
  | { kind: 'approval'; id: string; requests: ApprovalRequest[]; status: 'pending' | 'approved' | 'rejected' }

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
  /**
   * 选中的对话模型 id（`供应商名:模型名`）。
   * 空字符串表示不指定，后端就用它启动时带的默认模型。
   */
  model: string
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
  /**
   * 改完配置是否要重启才生效。
   * 指「后端启动时带的默认模型」——运行期切换过去的模型每次调用都重读配置，
   * 下一次运行就用新的（见后端 graph/model_switch.py）。
   */
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
