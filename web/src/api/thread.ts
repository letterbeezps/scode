/**
 * 线程相关 API（总体设计文档 3.3）。
 *
 * 历史消息来自 `/threads/{id}/state` 的 `values.messages`，需要把 LangChain
 * 的消息数组还原成前端的有序渲染结构（见 restoreMessages 的注释）。
 *
 * 端点形状对着 LangGraph 平台文档核过，有两个地方和直觉不一样（都踩过）：
 *
 * 1. **建会话必须带 body。** `POST /threads` 的 requestBody 是必填的，
 *    不带 body 会被判成 `Invalid JSON in request body` → 422。
 *    官方 cURL 示例就是 `--data '{}'`。
 * 2. **列表没有 `GET /threads`。** 那个路径只接受 POST，直接 GET 会 405
 *    （响应里写着 `allow: POST`）。列表走 `POST /threads/search`。
 *
 * 另外平台的 Thread 结构没有 title 字段，标题走 metadata.title。
 */
import { request, isMockMode } from './client'
import { parseInterrupts } from './events'
import { mockThreads } from './mock'
import type {
  ApprovalRequest,
  Message,
  MessagePart,
  Thread,
  ThreadRun,
  ThreadStatus,
  ToolCall,
  ToolResult,
} from './types'

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' ? (value as Record<string, unknown>) : {}
}

/**
 * 把平台的 Thread 摊平成前端的 Thread。
 *
 * title 是我们自己的概念：平台不存标题，所以借 metadata.title 存一份，
 * 这样侧边栏的标题在刷新页面后还在。
 */
function toThread(raw: unknown): Thread {
  const rec = asRecord(raw)
  const metadata = asRecord(rec.metadata)
  const status = rec.status
  return {
    thread_id: String(rec.thread_id ?? ''),
    title: typeof metadata.title === 'string' ? metadata.title : '',
    created_at: String(rec.created_at ?? ''),
    updated_at: String(rec.updated_at ?? rec.state_updated_at ?? rec.created_at ?? ''),
    metadata,
    status: isThreadStatus(status) ? status : undefined,
  }
}

function isThreadStatus(value: unknown): value is ThreadStatus {
  return (
    value === 'idle' || value === 'busy' || value === 'interrupted' || value === 'error'
  )
}

export async function createThread(metadata?: Record<string, unknown>): Promise<Thread> {
  if (isMockMode) return mockThreads.create()
  // body 必填：空 body 会 422
  const raw = await request<unknown>('/threads', {
    method: 'POST',
    body: JSON.stringify(metadata ?? {}),
  })
  return toThread(raw)
}

export async function listThreads(limit = 50): Promise<Thread[]> {
  if (isMockMode) return mockThreads.list()
  // 没有 GET /threads（405），列表走 search
  const raw = await request<unknown>('/threads/search', {
    method: 'POST',
    body: JSON.stringify({
      limit,
      sort_by: 'updated_at',
      sort_order: 'desc',
    }),
  })
  const list = Array.isArray(raw) ? raw : asRecord(raw).threads
  return Array.isArray(list) ? list.map(toThread) : []
}

export async function deleteThread(threadId: string): Promise<void> {
  if (isMockMode) return mockThreads.remove(threadId)
  await request<void>(`/threads/${threadId}`, { method: 'DELETE' })
}

/**
 * 改线程的 metadata：标题 + 任务级运行参数（workspace / permissions）。
 *
 * 平台也会往 metadata 里塞 graph_id / assistant_id；PATCH 是**合并**语义
 * （后端 `Threads.patch` 做 `{**旧, **新}`），所以只传要写的字段，
 * 不会覆盖平台自己的键。
 */
export async function updateThreadMetadata(
  threadId: string,
  metadata: Record<string, unknown>,
): Promise<Thread> {
  if (isMockMode) return mockThreads.update(threadId, metadata)
  const raw = await request<unknown>(`/threads/${threadId}`, {
    method: 'PATCH',
    body: JSON.stringify({ metadata }),
  })
  return toThread(raw)
}

/** 读取线程状态原始负载 */
export async function getThreadState(threadId: string): Promise<unknown> {
  if (isMockMode) return mockThreads.state(threadId)
  return request<unknown>(`/threads/${threadId}/state`)
}

/**
 * 一次线程状态快照。
 *
 * `next` / `interrupts` 不能丢：页面刷新或断线后，前端要靠它们判断
 * 「run 还在跑」还是「图挂在人工确认上」。只读 values.messages 会把这些信息丢掉，
 * 刷新后就既接不回运行、也画不出审批卡片。
 */
export interface ThreadSnapshot {
  rawMessages: unknown[]
  /** 非空表示图还没跑完（正在执行或挂在中断上） */
  next: string[]
  /** 平台已经持久化的 interrupt，刷新后用它重建审批卡片 */
  interrupts: ApprovalRequest[]
}

export async function loadThreadSnapshot(threadId: string): Promise<ThreadSnapshot> {
  const state = asRecord(await getThreadState(threadId))
  const values = asRecord(state.values)
  const rawMessages = Array.isArray(values.messages) ? values.messages : []
  const next = Array.isArray(state.next)
    ? state.next.filter((item): item is string => typeof item === 'string')
    : []
  const rawInterrupts = Array.isArray(state.interrupts) ? state.interrupts : []
  const interrupts = parseInterrupts({ __interrupt__: rawInterrupts }) ?? []
  return { rawMessages, next, interrupts }
}

/**
 * 列出某个 thread 的 run。
 *
 * 页面刷新后本地没有 run_id，只能从这里找还在跑的那个，再决定是否轮询/接回。
 * 按创建时间倒序，调用方取第一个活跃的即可。
 */
export async function listRuns(threadId: string): Promise<ThreadRun[]> {
  if (isMockMode) return []
  const raw = await request<unknown>(`/threads/${threadId}/runs?limit=20`)
  const list = Array.isArray(raw) ? raw : []
  const runs: ThreadRun[] = []
  for (const item of list) {
    const rec = asRecord(item)
    const runId = typeof rec.run_id === 'string' ? rec.run_id : ''
    const status = rec.status
    if (!runId || !isRunStatus(status)) continue
    runs.push({
      run_id: runId,
      thread_id: typeof rec.thread_id === 'string' ? rec.thread_id : threadId,
      status,
      created_at: typeof rec.created_at === 'string' ? rec.created_at : undefined,
      updated_at: typeof rec.updated_at === 'string' ? rec.updated_at : undefined,
    })
  }
  return runs.sort((a, b) => (b.created_at ?? '').localeCompare(a.created_at ?? ''))
}

function isRunStatus(value: unknown): value is ThreadRun['status'] {
  return (
    value === 'pending' ||
    value === 'running' ||
    value === 'error' ||
    value === 'success' ||
    value === 'timeout' ||
    value === 'interrupted'
  )
}

/* ------------------------------------------------------- LangChain 消息还原 */

function textOf(content: unknown): string {
  if (typeof content === 'string') return content
  if (Array.isArray(content)) {
    return content
      .map((part) => (typeof part === 'string' ? part : asRecord(part).text))
      .filter((part): part is string => typeof part === 'string')
      .join('')
  }
  return ''
}

function roleOf(msg: Record<string, unknown>): 'human' | 'ai' | 'tool' | 'system' {
  const raw = String(msg.role ?? msg.type ?? '')
  if (raw === 'human' || raw === 'user') return 'human'
  if (raw === 'tool' || raw === 'function') return 'tool'
  if (raw === 'system') return 'system'
  return 'ai'
}

let seq = 0
function nextId(prefix: string): string {
  seq += 1
  return `${prefix}-${seq}`
}

/**
 * 把 LangChain 的扁平消息数组还原成 Message[]。
 *
 * 关键点是顺序：LangGraph 把一次 assistant 回合拆成
 * `ai(文本 + tool_calls)` + `tool(...)` + `ai(续写)` …多条消息，
 * 必须边走边把 tool 结果回填到对应的工具调用上，否则工具卡片会被渲染成孤立条目。
 */
export interface RestoreMessagesOptions {
  /**
   * 走到消息末尾仍没有结果的工具调用怎么收尾。
   *
   * - `error`：默认。运行确实结束了却没收到结果，标红。
   * - `pending`：线程还在跑或挂在中断上，这只是暂时没结果，不能误报成失败。
   */
  unresolvedToolCalls?: 'error' | 'pending'
}

export function restoreMessages(
  threadId: string,
  rawMessages: unknown[],
  options: RestoreMessagesOptions = {},
): Message[] {
  const out: Message[] = []
  /** tool_call_id -> 该调用在 out/parts 中的位置，用于回填结果 */
  const callIndex = new Map<string, { message: Message; call: ToolCall }>()

  for (const raw of rawMessages) {
    const msg = asRecord(raw)
    const role = roleOf(msg)
    const createdAt =
      typeof msg.created_at === 'string'
        ? msg.created_at
        : new Date().toISOString()

    if (role === 'tool') {
      const id = typeof msg.tool_call_id === 'string' ? msg.tool_call_id : ''
      const output = textOf(msg.content)
      const target = id ? callIndex.get(id) : undefined

      if (target) {
        const result: ToolResult = {
          output,
          diff: typeof msg.diff === 'string' ? msg.diff : undefined,
          files: Array.isArray(msg.files) ? (msg.files as string[]) : undefined,
        }
        target.call.result = result
        // 工具把失败写进返回值时（而非抛异常）也算失败
        target.call.status = msg.status === 'error' || looksLikeFailure(output) ? 'error' : 'success'
        callIndex.delete(id)
      } else {
        out.push({
          id: nextId('msg'),
          thread_id: threadId,
          role: 'tool',
          content: output,
          tool_call_id: id,
          parts: [{ kind: 'text', text: output }],
          created_at: createdAt,
        })
      }
      continue
    }

    if (role === 'system') continue

    if (role === 'human') {
      const content = textOf(msg.content)
      out.push({
        id: typeof msg.id === 'string' ? msg.id : nextId('msg'),
        thread_id: threadId,
        role: 'user',
        content,
        parts: content ? [{ kind: 'text', text: content }] : [],
        created_at: createdAt,
      })
      continue
    }

    // assistant
    const content = textOf(msg.content)
    const rawCalls = Array.isArray(msg.tool_calls) ? msg.tool_calls : []
    const parts: MessagePart[] = content ? [{ kind: 'text', text: content }] : []

    const toolCalls: ToolCall[] = rawCalls.map((item) => {
      const rec = asRecord(item)
      const rawArgs = rec.args ?? rec.arguments
      const args =
        typeof rawArgs === 'string'
          ? (safeParse(rawArgs) as Record<string, unknown>) ?? {}
          : asRecord(rawArgs)

      return {
        id: typeof rec.id === 'string' ? rec.id : nextId('call'),
        name: typeof rec.name === 'string' ? rec.name : 'unknown',
        args,
        status: 'pending' as const,
      }
    })

    const message: Message = {
      id: typeof msg.id === 'string' ? msg.id : nextId('msg'),
      thread_id: threadId,
      role: 'assistant',
      content,
      parts,
      created_at: createdAt,
    }

    for (const call of toolCalls) {
      message.parts.push({ kind: 'tool', call })
      callIndex.set(call.id, { message, call })
    }
    message.tool_calls = toolCalls
    out.push(message)
  }

  // 走到最后仍没有结果的调用：运行被中断了按 error 收尾；
  // 线程还在跑（或挂在 HITL 上）时保持 pending，别把「还没到」误报成「失败」
  for (const { call } of callIndex.values()) {
    if (options.unresolvedToolCalls === 'pending') {
      call.status = 'pending'
    } else {
      call.status = 'error'
      call.error = call.error ?? '运行已中断，未收到工具结果'
    }
  }

  return out
}

function safeParse(text: string): unknown {
  try {
    return JSON.parse(text)
  } catch {
    return undefined
  }
}

/**
 * Deep Agents 的内置工具不抛异常，而是把失败信息写进返回值，
 * 这里做一次启发式判断，让历史记录里的失败调用也能显示成红色状态。
 */
function looksLikeFailure(output: string): boolean {
  const head = output.trim().slice(0, 200).toLowerCase()
  return (
    head.startsWith('error') ||
    head.startsWith('traceback') ||
    head.includes('tool error') ||
    head.includes('command failed')
  )
}
