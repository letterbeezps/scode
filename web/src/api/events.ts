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
 *
 * **平台原生事件有三档**（run 的 stream_mode 决定订阅哪几档）：
 *
 *  - `updates`：节点级快照，**节点跑完才推一次**。工具调用、interrupt、todo 都在这里。
 *  - `messages`：模型层的流，事件名是 `messages/partial` / `messages/metadata` /
 *    `messages/complete`。文本和思考按块流出来，但**给的是累计快照，不是增量**。
 *  - `events`：最细的一档，`on_chat_model_stream` / `on_tool_start` / `on_tool_end`。
 *
 * 前端同时订阅 `updates` + `messages`：`updates` 给工具调用和最终结果，
 * `messages` 给「正在想 / 正在写」的实时过程。两者会重复同一段文本，
 * 所以这里要去重（见 sawLiveText）。
 */
import type { SseEvent } from './sse'
import type {
  ApprovalDecisionType,
  ApprovalRequest,
  Todo,
  ToolCall,
  ToolResult,
} from './types'

export type NormalizedEvent =
  | { type: 'metadata'; runId?: string }
  | { type: 'token'; text: string }
  /** 模型的思考内容增量（不是 token，是「思考」的增量） */
  | { type: 'thinking'; text: string }
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

/** 取文本内容。协议可能是纯字符串，也可能是 [{type:'text',text:'...'}] 这样的块数组。 */
export function textOf(content: unknown): string {
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

/**
 * 思考内容。
 *
 * 两种形态都要认：
 *  - Anthropic 原生块：`{"type":"thinking","thinking":"..."}`（langchain-anthropic
 *    直接把供应商返回的块放进 content）
 *  - langchain 标准 content_blocks：`{"type":"reasoning","reasoning":"..."}`
 */
export function thinkingOf(content: unknown): string {
  if (!Array.isArray(content)) return ''
  return content
    .map((part) => {
      const rec = asRecord(part)
      if (rec.type === 'thinking' && typeof rec.thinking === 'string') return rec.thinking
      if (rec.type === 'reasoning' && typeof rec.reasoning === 'string') return rec.reasoning
      return ''
    })
    .join('')
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
 *                                "review_configs": [{"action_name","allowed_decisions"}]}}]}
 * action_requests 里没有工具调用 id，只有名字和参数——够前端画卡片了。
 *
 * `review_configs` 跟 `action_requests` **一一对应、顺序一致**（框架是按同一个
 * 循环 append 的）。它带着每条动作允许哪些决定——`execute` 允许 edit（改完
 * 再执行），`delete` 不允许。卡片按这个渲染可选项。
 */
export function parseInterrupts(payload: Record<string, unknown>): ApprovalRequest[] | null {
  const raw = payload['__interrupt__']
  if (!Array.isArray(raw) || raw.length === 0) return null

  const requests: ApprovalRequest[] = []
  for (const item of raw) {
    const value = asRecord(asRecord(item).value)
    const actionRequests = Array.isArray(value.action_requests) ? value.action_requests : []
    const reviewConfigs = Array.isArray(value.review_configs) ? value.review_configs : []
    for (const [index, rawRequest] of actionRequests.entries()) {
      const rec = asRecord(rawRequest)
      const name = typeof rec.name === 'string' ? rec.name : 'unknown'
      const review = asRecord(reviewConfigs[index])
      const allowed = Array.isArray(review.allowed_decisions)
        ? review.allowed_decisions.filter((d): d is ApprovalDecisionType => typeof d === 'string')
        : undefined
      requests.push({
        name,
        args: normalizeArgs(rec.args),
        description: typeof rec.description === 'string' ? rec.description : undefined,
        allowedDecisions: allowed,
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

  /**
   * 当前模型回合的流式快照。
   *
   * 平台的 messages 模式给的是**累计快照**——每条消息里带的是「到目前为止」
   * 的内容，不是增量。所以这里存上一份快照，自己算出真正的增量再发出去，
   * 前端才能沿用「追加」的语义（否则同一段话会被追加很多遍）。
   */
  let liveText = ''
  let liveThinking = ''
  /** 本回合的文本 / 思考是不是已经通过 messages 流实时发过了 */
  let sawLiveText = false
  let sawLiveThinking = false

  function reset() {
    sawExplicitMessages = false
    seenToolCalls.clear()
    liveText = ''
    liveThinking = ''
    sawLiveText = false
    sawLiveThinking = false
  }

  /**
   * messages 模式：模型层的流。
   *
   * 数据是一个消息块数组，每块的 content 是到这一刻为止的累计内容。
   * 跟上一份比，只有「在上一份末尾继续长」的部分才算增量——
   * 平台偶尔会重发同一份内容，靠这个判断避免重复追加。
   */
  function fromMessagePartials(payload: unknown): NormalizedEvent[] {
    const list = Array.isArray(payload) ? payload : [payload]
    const out: NormalizedEvent[] = []

    for (const raw of list) {
      const chunk = asRecord(raw)
      const content = chunk.content

      const text = textOf(content)
      if (text.length > liveText.length && text.startsWith(liveText)) {
        const delta = text.slice(liveText.length)
        liveText = text
        sawLiveText = true
        if (delta) out.push({ type: 'token', text: delta })
      }

      const thinking = thinkingOf(content)
      if (thinking.length > liveThinking.length && thinking.startsWith(liveThinking)) {
        const delta = thinking.slice(liveThinking.length)
        liveThinking = thinking
        sawLiveThinking = true
        if (delta) out.push({ type: 'thinking', text: delta })
      }
    }
    return out
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
    // 本回合的文本已经从 messages 流实时发过了，就不要再发一遍
    if (content && !sawExplicitMessages && !sawLiveText) out.push({ type: 'token', text: content })

    // 思考内容同理：messages 流里有就跳过，没有（只订阅了 updates）才补发
    const thinking = thinkingOf(msg.content)
    if (thinking && !sawLiveThinking) out.push({ type: 'thinking', text: thinking })

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

    // 这一回合的模型输出已经完整落地（节点跑完了）：
    // 下一回合的流式快照从头算，否则增量会跟上一回合的尾巴接上。
    liveText = ''
    liveThinking = ''
    sawLiveText = false
    sawLiveThinking = false

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

      // 模型层的流：文本和思考按块流出来（给的是累计快照，这里换算成增量）
      case 'messages/partial':
        return fromMessagePartials(safeJsonParse(evt.data))

      // 这两个是模型的元信息和回合结束时的完整消息，用不上：
      // 完整消息 updates 里已经有了。
      case 'messages/metadata':
      case 'messages/complete':
        return []

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
