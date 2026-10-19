/**
 * 对话状态（前端设计文档 5.1）。
 *
 * 流式生成的中间态单独放在 pendingMessage，而不是直接 append 进 messages：
 * 这样“已落库的历史”和“还在流式吐字的消息”不会互相污染，
 * 停止生成时直接把 pendingMessage 落位即可，不需要回滚。
 */
import { create } from 'zustand'
import * as threadApi from '../api/thread'
import { errorMessage } from '../api/client'
import { streamRun } from '../api/run'
import { useTodoStore } from './todoStore'
import { useTaskStore } from './taskStore'
import type { Message, Thread, Todo, ToolCall } from '../api/types'

/** streamRun 返回的取消函数不放进 state：它不是数据，进 state 会白白触发渲染 */
let cancelCurrentRun: (() => void) | null = null

let msgSeq = 0
const nextId = (prefix: string) => `${prefix}-${Date.now().toString(36)}-${++msgSeq}`

export interface ConversationState {
  threads: Thread[]
  activeThreadId: string | null
  /** thread_id -> 消息列表 */
  messages: Record<string, Message[]>
  /** thread_id -> 标题（后端不返回 title，前端从首条用户消息推导） */
  titles: Record<string, string>
  /** 正在流式生成的 assistant 消息 */
  pendingMessage: Message | null
  /** pendingMessage 属于哪个线程，切线程时不会串台 */
  pendingThreadId: string | null
  isGenerating: boolean
  loading: boolean
  error: string | null
  /** 用户点过停止：onEnd 落位时据此标记 interrupted */
  cancelRequested: boolean

  loadThreads: () => Promise<void>
  createThread: () => Promise<string | null>
  selectThread: (id: string) => Promise<void>
  deleteThread: (id: string) => Promise<void>
  sendMessage: (content: string) => Promise<void>
  cancelRun: () => void
  clearError: () => void
}

/** 后端不返回 title，用首条用户消息兜底（设计文档 7.4） */
function deriveTitle(thread: Thread | undefined, msgs: Message[] | undefined): string {
  const existing = thread?.title?.trim()
  if (existing && existing !== 'Untitled' && existing !== '新任务') return existing
  const firstUser = msgs?.find((m) => m.role === 'user' && m.content.trim())
  return firstUser ? firstUser.content.trim().slice(0, 24) : '新任务'
}

export const useConversationStore = create<ConversationState>((set, get) => ({
  threads: [],
  activeThreadId: null,
  messages: {},
  titles: {},
  pendingMessage: null,
  pendingThreadId: null,
  isGenerating: false,
  loading: false,
  error: null,
  cancelRequested: false,

  async loadThreads() {
    set({ loading: true })
    try {
      const threads = await threadApi.listThreads()
      set((state) => ({
        threads,
        titles: {
          ...state.titles,
          ...Object.fromEntries(threads.map((t) => [t.thread_id, deriveTitle(t, state.messages[t.thread_id])])),
        },
        error: null,
      }))
    } catch (err) {
      set({ error: errorMessage(err) })
    } finally {
      set({ loading: false })
    }
  },

  async createThread() {
    set({ error: null })
    try {
      const thread = await threadApi.createThread()
      // 把 draft 固化到新任务上再重置：否则这个任务的参数会一直"跟着" draft 变，
      // 下一条新任务改了工作空间或权限，回头看这条任务的运行边界也跟着变了
      useTaskStore.getState().adoptDraft(thread.thread_id)

      set((state) => ({
        threads: [thread, ...state.threads],
        activeThreadId: thread.thread_id,
        messages: { ...state.messages, [thread.thread_id]: [] },
        titles: { ...state.titles, [thread.thread_id]: deriveTitle(thread, []) },
      }))
      return thread.thread_id
    } catch (err) {
      set({ error: errorMessage(err) })
      return null
    }
  },

  async selectThread(id) {
    set({ activeThreadId: id, error: null })
    // 已缓存过就直接用，避免每次切换都打后端
    if (get().messages[id]) return

    set({ loading: true })
    try {
      const messages = await threadApi.loadMessages(id)
      set((state) => {
        const thread = state.threads.find((t) => t.thread_id === id)
        return {
          messages: { ...state.messages, [id]: messages },
          titles: { ...state.titles, [id]: deriveTitle(thread, messages) },
        }
      })
    } catch (err) {
      set({ error: errorMessage(err) })
    } finally {
      set({ loading: false })
    }
  },

  async deleteThread(id) {
    try {
      await threadApi.deleteThread(id)
      // 任务删了，它的运行参数和待办也不该留在内存里
      useTaskStore.getState().reset(id)
      useTodoStore.getState().clearTodos(id)

      set((state) => {
        const messages = { ...state.messages }
        delete messages[id]
        const titles = { ...state.titles }
        delete titles[id]
        const threads = state.threads.filter((t) => t.thread_id !== id)
        return {
          threads,
          messages,
          titles,
          activeThreadId: state.activeThreadId === id ? (threads[0]?.thread_id ?? null) : state.activeThreadId,
        }
      })
      const next = get().activeThreadId
      if (next) await get().selectThread(next)
    } catch (err) {
      set({ error: errorMessage(err) })
    }
  },

  async sendMessage(content) {
    const text = content.trim()
    const state = get()
    if (!text || state.isGenerating) return

    let threadId = state.activeThreadId
    if (!threadId) {
      const created = await get().createThread()
      if (!created) return
      threadId = created
    }

    const now = new Date().toISOString()
    const userMessage: Message = {
      id: nextId('msg'),
      thread_id: threadId,
      role: 'user',
      content: text,
      parts: [{ kind: 'text', text }],
      created_at: now,
    }

    const pending: Message = {
      id: nextId('msg'),
      thread_id: threadId,
      role: 'assistant',
      content: '',
      parts: [],
      created_at: now,
    }

    set((prev) => ({
      messages: {
        ...prev.messages,
        [threadId!]: [...(prev.messages[threadId!] ?? []), userMessage],
      },
      titles: { ...prev.titles, [threadId!]: deriveTitle(prev.threads.find((t) => t.thread_id === threadId), [userMessage]) },
      pendingMessage: pending,
      pendingThreadId: threadId,
      isGenerating: true,
      error: null,
    }))

    // 标题写进后端的 metadata：平台的 Thread 没有 title 字段，
    // 只存前端内存的话刷新页面侧边栏就全变成"新任务"了。
    // 写失败不影响主流程，标题退回从首条消息推导。
    const title = get().titles[threadId!]
    if (title && title !== '新任务') {
      void threadApi.updateThreadMetadata(threadId!, { title }).catch(() => {})
    }

    // 工作空间与权限按任务存；发送这一刻读一次快照，跑完之前再改不影响本次运行
    const runOptions = useTaskStore.getState().resolve(threadId)

    /** 只改 pendingMessage，不动 messages */
    const patchPending = (fn: (msg: Message) => Message) =>
      set((prev) => (prev.pendingMessage ? { pendingMessage: fn(prev.pendingMessage) } : prev))

    cancelCurrentRun = streamRun(threadId, text, runOptions, {
      onToken(chunk) {
        patchPending((msg) => {
          const parts = [...msg.parts]
          const last = parts[parts.length - 1]
          // token 只会接在上一个文本片段后面，接在工具卡片后面说明该起新段了
          if (last && last.kind === 'text') {
            parts[parts.length - 1] = { kind: 'text', text: last.text + chunk }
          } else {
            parts.push({ kind: 'text', text: chunk })
          }
          return { ...msg, content: msg.content + chunk, parts }
        })
      },

      onToolCall(call: ToolCall) {
        patchPending((msg) => ({
          ...msg,
          parts: [...msg.parts, { kind: 'tool', call }],
          tool_calls: [...(msg.tool_calls ?? []), call],
        }))
      },

      onToolResult({ id, output, diff, files, error }) {
        patchPending((msg) => {
          const parts = msg.parts.map((part) => {
            if (part.kind !== 'tool' || part.call.id !== id) return part
            return {
              kind: 'tool' as const,
              call: {
                ...part.call,
                status: error ? ('error' as const) : ('success' as const),
                result: { output, diff, files },
                error,
              },
            }
          })
          const toolCalls = (msg.tool_calls ?? []).map((call) =>
            call.id === id
              ? { ...call, status: error ? ('error' as const) : ('success' as const), result: { output, diff, files }, error }
              : call,
          )
          return { ...msg, parts, tool_calls: toolCalls }
        })
      },

      onTodos(todos: Todo[]) {
        // 侧边栏任务列表由 todoStore 独立维护，这里不重复存一份
        useTodoStore.getState().updateTodos(threadId, todos)
      },

      onError(message) {
        patchPending((msg) => ({ ...msg, error: message }))
        set({ error: message })
      },

      onEnd() {
        cancelCurrentRun = null
        set((prev) => {
          const pid = prev.pendingThreadId
          const pendingMsg = prev.pendingMessage
          if (!pid || !pendingMsg) return { pendingMessage: null, pendingThreadId: null, isGenerating: false }

          // 用户中途停止：内容留着，标一个中断状态
          const interrupted = prev.cancelRequested ? { ...pendingMsg, interrupted: true } : pendingMsg
          return {
            messages: { ...prev.messages, [pid]: [...(prev.messages[pid] ?? []), interrupted] },
            pendingMessage: null,
            pendingThreadId: null,
            isGenerating: false,
            cancelRequested: false,
          }
        })
      },
    })
  },

  cancelRun() {
    if (!get().isGenerating) return
    set({ cancelRequested: true })
    // run.ts 的 cancel 会同步触发 onEnd，由它负责把 pendingMessage 落位
    cancelCurrentRun?.()
  },

  clearError() {
    set({ error: null })
  },
}))
