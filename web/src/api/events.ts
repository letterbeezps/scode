/**
 * SSE 事件归一化。
 *
 * 后端尚未落地（总体设计文档的 P0），而“前端能消费的流式协议”目前有两份说法：
 *
 *  1. 前端设计文档 4.2 定义的语义事件：messages / tool_call / tool_result /
 *     todos / error / end。LangGraph 里用 `get_stream_writer()` 自定义事件即可发出，
 *     是这套 UI 真正需要的最小契约。
 *  2. LangGraph Platform `/runs/stream` 原生事件：metadata / updates / values /
 *     events / error / end。
 *
 * 两份都接，且做去重：优先采信显式语义事件，只有在没有收到过显式 `messages` 时
 * 才从 `updates` 里推导文本 token，避免同一段话被追加两遍。
 */
import type { SseEvent } from './sse'
import type { ApprovalRequest, Todo, ToolCall, ToolResult } from './types'

export type NormalizedEvent =
  | { type: 'metadata'; runId?: string }
  | { type: 'token'; text: string }
  | { type: 'tool_call'; call: ToolCall }
  | { type: 'tool_result'; id: string; result: ToolResult; error?: string }
  | { type: 'todos'; todos: Todo[] }
  /** 图挂起等人工确认（LangGraph 的 __interrupt__） */
  | { type: 'interrupt'; requests: ApprovalRequest[] }
  | { type: 'error'; message: string }
  | { type: 'end' }

/** Deep Agents 内置的任务规划工具名（总体设计文档 3.1） */
const TODO_TOOLS = new Set(['write_todos', 'write_todo', 'todo_write', 'todos'])

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' ? (value as Record<string, unknown>) : {}
}

function safeJsonParse(text: string): unknown {
  try {
    return JSON.parse(text)
  } catch {
    return undefined
  }
}

/** LangChain 的 tool call 参数在不同版本里可能是对象也可能是 JSON 字符串 */
function normalizeArgs(raw: unknown): Record<string, unknown> {
  if (typeof raw === 'string') return asRecord(safeJsonParse(raw))
  return asRecord(raw)
}

function textOf(content: unknown): string {
  if (typeof content === 'string') return content
  // 多模态内容可能是 [{type:'text',text:'...'}]
  if (Array.isArray(content)) {
    return content
      .map((part) => (typeof part === 'string' ? part : asRecord(part).text))
      .filter((part): part is string => typeof part === 'string')
      .join('')
  }
  return ''
}

function extractTodos(raw: unknown): Todo[] | null {
  const list = Array.isArray(raw)
    ? raw
    : Array.isArray(asRecord(raw).todos)
      ? (asRecord(raw).todos as unknown[])
      : null
  if (!list) return null

  const todos = list
    .map((item): Todo | null => {
      const rec = asRecord(item)
      const content = typeof rec.content === 'string' ? rec.content : null
      if (!content) return null
      return {
        content,
        status:
          rec.status === 'in_progress' || rec.status === 'completed'
            ? rec.status
            : 'pending',
        activeForm: typeof rec.activeForm === 'string' ? rec.activeForm : undefined,
      }
    })
    .filter((t): t is Todo => t !== null)

  return todos.length > 0 ? todos : null
}

/** LangChain 消息的 role/type 归一 */
function roleOf(msg: Record<string, unknown>): 'human' | 'ai' | 'tool' | 'system' {
  const raw = String(msg.role ?? msg.type ?? '')
  if (raw === 'human' || raw === 'user') return 'human'
  if (raw === 'tool' || raw === 'function') return 'tool'
  if (raw === 'system') return 'system'
  return 'ai'
}

/**
 * 从 LangGraph 的 interrupt 事件里取出要人工确认的动作。
 *
 * 平台把挂起的运行放在 chunk 的 `__interrupt__` 键下：
 *   {"__interrupt__": [{"value": {"action_requests": [{"name","args","description"}],
 *                                "review_configs": [...]}}]}
 * action_requests 里没有工具调用 id，只有名字和参数——够前端画卡片了。
 */
function parseInterrupts(payload: Record<string, unknown>): ApprovalRequest[] | null {
  const raw = payload['__interrupt__']
  if (!Array.isArray(raw) || raw.length === 0) return null

  const requests: ApprovalRequest[] = []
  for (const item of raw) {
    const value = asRecord(asRecord(item).value)
    const actionRequests = Array.isArray(value.action_requests) ? value.action_requests : []
    for (const rawRequest of actionRequests) {
      const rec = asRecord(rawRequest)
      const name = typeof rec.name === 'string' ? rec.name : 'unknown'
      requests.push({
        name,
        args: normalizeArgs(rec.args),
        description: typeof rec.description === 'string' ? rec.description : undefined,
      })
    }
  }
  return requests.length > 0 ? requests : null
}

export interface Normalizer {
  push: (evt: SseEvent) => NormalizedEvent[]
  reset: () => void
}

export function createEventNormalizer(): Normalizer {
  // 收到过显式语义事件后，就不再从原生事件里推导同类数据
  let sawExplicitMessages = false
  const seenToolCalls = new Set<string>()

  function reset() {
    sawExplicitMessages = false
    seenToolCalls.clear()
  }

  /** 从 LangChain 消息（updates / values 里）提取事件 */
  function fromLangChainMessage(msg: Record<string, unknown>): NormalizedEvent[] {
    const role = roleOf(msg)
    const out: NormalizedEvent[] = []

    if (role === 'human') {
      // 用户消息由前端自己乐观追加，这里只回放一次用于对齐
      return out
    }

    if (role === 'tool') {
      const id = typeof msg.tool_call_id === 'string' ? msg.tool_call_id : ''
      if (!id) return out
      const content = textOf(msg.content)
      out.push({
        type: 'tool_result',
        id,
        result: {
          output: content,
          files: Array.isArray(msg.files) ? (msg.files as string[]) : undefined,
          diff: typeof msg.diff === 'string' ? msg.diff : undefined,
        },
      })
      return out
    }

    // ai
    const content = textOf(msg.content)
    if (content && !sawExplicitMessages) out.push({ type: 'token', text: content })

    const toolCalls = Array.isArray(msg.tool_calls) ? msg.tool_calls : []
    for (const rawCall of toolCalls) {
      const rec = asRecord(rawCall)
      const id = typeof rec.id === 'string' ? rec.id : ''
      const name = typeof rec.name === 'string' ? rec.name : 'unknown'
      if (!id || seenToolCalls.has(id)) continue
      seenToolCalls.add(id)

      const args = normalizeArgs(rec.args ?? rec.arguments)
      const call: ToolCall = { id, name, args, status: 'running', startedAt: Date.now() }
      out.push({ type: 'tool_call', call })

      // 任务规划工具的内容即 todo 列表，直接同步到侧边栏
      if (TODO_TOOLS.has(name)) {
        const todos = extractTodos(args)
        if (todos) out.push({ type: 'todos', todos })
      }
    }
    return out
  }

  /** LangGraph 原生 updates：{ 节点名: { messages: [...] } } */
  function fromUpdates(payload: Record<string, unknown>): NormalizedEvent[] {
    // interrupt 单独占一个 chunk，键就是 __interrupt__
    const requests = parseInterrupts(payload)
    if (requests) return [{ type: 'interrupt', requests }]

    const out: NormalizedEvent[] = []
    for (const nodeUpdate of Object.values(payload)) {
      const messages = asRecord(nodeUpdate).messages
      if (!Array.isArray(messages)) continue
      for (const msg of messages) out.push(...fromLangChainMessage(asRecord(msg)))
    }
    return out
  }

  /** LangGraph 原生 values：完整状态，只用于补 todo 这类幂等快照 */
  function fromValues(payload: Record<string, unknown>): NormalizedEvent[] {
    // 平台在某些模式下会把 interrupt 放进 values
    const requests = parseInterrupts(payload)
    if (requests) return [{ type: 'interrupt', requests }]

    const messages = payload.messages
    if (!Array.isArray(messages)) return []

    const out: NormalizedEvent[] = []
    // 取最后一条 ai 消息里的 todo 写入，避免整段历史重复推送
    for (const msg of messages) {
      const rec = asRecord(msg)
      if (roleOf(rec) !== 'ai') continue
      const toolCalls = Array.isArray(rec.tool_calls) ? rec.tool_calls : []
      for (const rawCall of toolCalls) {
        const call = asRecord(rawCall)
        const name = typeof call.name === 'string' ? call.name : ''
        if (!TODO_TOOLS.has(name)) continue
        const todos = extractTodos(normalizeArgs(call.args ?? call.arguments))
        if (todos) out.push({ type: 'todos', todos })
      }
    }
    return out
  }

  /** 显式语义事件（前端设计文档 4.2） */
  function fromCustomEvent(evt: SseEvent): NormalizedEvent[] {
    const payload = asRecord(safeJsonParse(evt.data))

    switch (evt.event) {
      case 'messages':
      case 'message': {
        sawExplicitMessages = true
        const text =
          typeof payload.text === 'string'
            ? payload.text
            : typeof payload.content === 'string'
              ? payload.content
              : textOf(payload.content ?? payload.delta)
        return text ? [{ type: 'token', text }] : []
      }

      case 'tool_call': {
        sawExplicitMessages = true
        const id = String(payload.id ?? crypto.randomUUID())
        const name = String(payload.name ?? 'unknown')
        if (seenToolCalls.has(id)) return []
        seenToolCalls.add(id)

        const call: ToolCall = {
          id,
          name,
          args: normalizeArgs(payload.args),
          status: 'running',
          startedAt: Date.now(),
        }
        const out: NormalizedEvent[] = [{ type: 'tool_call', call }]
        if (TODO_TOOLS.has(name)) {
          const todos = extractTodos(call.args)
          if (todos) out.push({ type: 'todos', todos })
        }
        return out
      }

      case 'tool_result': {
        const id = String(payload.id ?? payload.tool_call_id ?? '')
        if (!id) return []
        return [
          {
            type: 'tool_result',
            id,
            result: {
              output: String(payload.output ?? payload.content ?? ''),
              diff: typeof payload.diff === 'string' ? payload.diff : undefined,
              files: Array.isArray(payload.files) ? (payload.files as string[]) : undefined,
            },
            error: typeof payload.error === 'string' ? payload.error : undefined,
          },
        ]
      }

      case 'todos': {
        const todos = extractTodos(payload)
        return todos ? [{ type: 'todos', todos }] : []
      }

      case 'error': {
        // 平台发的是 {"error": "AnthropicAuthenticationError", "message": "An internal error occurred"}
        // ——只显示 message 等于什么都没说，只显示 error 又丢了描述。两个都在就拼起来。
        const err = typeof payload.error === 'string' ? payload.error : ''
        const detail = typeof payload.message === 'string' ? payload.message : ''
        const message = err && detail && err !== detail ? `${err}：${detail}` : err || detail || '未知错误'
        return [{ type: 'error', message }]
      }

      case 'end':
        return [{ type: 'end' }]

      default:
        return []
    }
  }

  function push(evt: SseEvent): NormalizedEvent[] {
    // 自定义事件常包一层 { event: "<name>", data: {...} }
    if (evt.event === 'data' || evt.event === 'events' || evt.event === 'custom') {
      const payload = asRecord(safeJsonParse(evt.data))
      const innerName = typeof payload.event === 'string' ? payload.event : ''
      if (innerName) {
        const inner: SseEvent = {
          event: innerName,
          data: typeof payload.data === 'string' ? payload.data : JSON.stringify(payload.data ?? {}),
        }
        return push(inner)
      }
    }

    switch (evt.event) {
      case 'metadata': {
        const payload = asRecord(safeJsonParse(evt.data))
        const runId = typeof payload.run_id === 'string' ? payload.run_id : undefined
        return [{ type: 'metadata', runId }]
      }

      case 'updates': {
        const payload = asRecord(safeJsonParse(evt.data))
        return fromUpdates(payload)
      }

      case 'values': {
        const payload = asRecord(safeJsonParse(evt.data))
        return fromValues(payload)
      }

      // 原生 error 事件的数据结构与自定义 error 一致，交给同一条分支解析
      case 'error':
        return fromCustomEvent({ ...evt, event: 'error' })

      case 'end':
        return [{ type: 'end' }]

      default:
        return fromCustomEvent(evt)
    }
  }

  return { push, reset }
}
