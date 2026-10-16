/**
 * 线程相关 API（总体设计文档 3.3）。
 *
 * 历史消息来自 `/threads/{id}/state` 的 `values.messages`，需要把 LangChain
 * 的消息数组还原成前端的有序渲染结构（见 restoreMessages 的注释）。
 */
import { request, isMockMode } from './client'
import { mockThreads } from './mock'
import type { Message, MessagePart, Thread, ToolCall, ToolResult } from './types'

export async function createThread(): Promise<Thread> {
  if (isMockMode) return mockThreads.create()
  return request<Thread>('/threads', { method: 'POST' })
}

export async function listThreads(): Promise<Thread[]> {
  if (isMockMode) return mockThreads.list()
  const res = await request<{ threads?: Thread[] } | Thread[]>('/threads')
  return Array.isArray(res) ? res : (res.threads ?? [])
}

export async function deleteThread(threadId: string): Promise<void> {
  if (isMockMode) return mockThreads.remove(threadId)
  await request<void>(`/threads/${threadId}`, { method: 'DELETE' })
}

/** 读取线程状态原始负载 */
export async function getThreadState(threadId: string): Promise<unknown> {
  if (isMockMode) return mockThreads.state(threadId)
  return request<unknown>(`/threads/${threadId}/state`)
}

export async function loadMessages(threadId: string): Promise<Message[]> {
  const state = await getThreadState(threadId)
  const values = (state as { values?: { messages?: unknown[] } })?.values ?? {}
  const rawMessages = Array.isArray(values.messages) ? values.messages : []
  return restoreMessages(threadId, rawMessages)
}

/* ------------------------------------------------------- LangChain 消息还原 */

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' ? (value as Record<string, unknown>) : {}
}

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
export function restoreMessages(threadId: string, rawMessages: unknown[]): Message[] {
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

  // 走到最后仍没有结果的调用：运行被中断了，按 error 收尾
  for (const { call } of callIndex.values()) {
    call.status = 'error'
    call.error = call.error ?? '运行已中断，未收到工具结果'
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
