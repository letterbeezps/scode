/**
 * 对话状态（前端设计文档 5.1）。
 *
 * 流式生成的中间态单独放在 pendingMessage，而不是直接 append 进 messages：
 * 这样“已落库的历史”和“还在流式吐字的消息”不会互相污染，
 * 停止生成时直接把 pendingMessage 落位即可，不需要回滚。
 */
import { create } from 'zustand'
import * as threadApi from '../api/thread'
import { ApiError, errorMessage } from '../api/client'
import { resumeRun, streamRun, type RunHandlers } from '../api/run'
import { useTodoStore } from './todoStore'
import { useTaskStore } from './taskStore'
import { useSettingsStore } from './settingsStore'
import type {
  ApprovalDecision,
  ApprovalRequest,
  Message,
  RunOptions,
  Thread,
  Todo,
  ToolCall,
} from '../api/types'

/** streamRun 返回的取消函数不放进 state：它不是数据，进 state 会白白触发渲染 */
let cancelCurrentRun: (() => void) | null = null

let msgSeq = 0
const nextId = (prefix: string) => `${prefix}-${Date.now().toString(36)}-${++msgSeq}`

/**
 * 一组待人工确认的动作。
 *
 * 一次 interrupt 里可能含多条 action_request（模型一轮里发了多条命令）。
 * 框架要求 resume 时给出同样数量的 decision，所以整组一起存、一起恢复。
 */
export interface PendingApproval {
  /** 卡片 id，用来定位要改状态的那一段 */
  id: string
  /** 属于哪个线程（恢复时要用它发请求） */
  threadId: string
  /** 待确认的动作组，空数组没有意义 */
  requests: ApprovalRequest[]
}

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
  /** 图挂起等人工确认时的待办动作 */
  pendingApproval: PendingApproval | null

  loadThreads: () => Promise<void>
  createThread: () => Promise<string | null>
  selectThread: (id: string) => Promise<void>
  deleteThread: (id: string) => Promise<void>
  sendMessage: (content: string) => Promise<void>
  cancelRun: () => void
  /** 批准/拒绝一条待确认的动作，并把决定送回后端继续跑 */
  decideApproval: (decision: 'approve' | 'reject') => void
  clearError: () => void
}

/** 只改 pendingMessage，不动 messages */
function patchPending(fn: (msg: Message) => Message): void {
  useConversationStore.setState((prev) =>
    prev.pendingMessage ? { pendingMessage: fn(prev.pendingMessage) } : prev,
  )
}

/**
 * 一次运行的事件处理。
 *
 * 发消息和恢复挂起的运行走同一套处理：恢复后模型接着往下说，token / 工具调用
 * 继续追加到同一条 pendingMessage 上。
 */
function createRunHandlers(threadId: string): RunHandlers {
  return {
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
      useConversationStore.setState({ error: message })
    },

    onInterrupt(requests) {
      // 整组存：框架要求 resume 的 decision 数量和 action_requests 一样多，
      // 丢掉任何一个，恢复时就会报数量不匹配。
      if (requests.length === 0) return
      const id = nextId('approval')
      patchPending((msg) => ({
        ...msg,
        parts: [...msg.parts, { kind: 'approval', id, requests, status: 'pending' }],
      }))
      useConversationStore.setState({ pendingApproval: { id, threadId, requests } })
    },

    onEnd() {
      cancelCurrentRun = null
      const state = useConversationStore.getState()

      // 图挂起等人确认：消息先不落位，等批准/拒绝后继续往这条消息上追加
      if (state.pendingApproval) {
        useConversationStore.setState({ isGenerating: false })
        return
      }

      useConversationStore.setState((prev) => {
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
  }
}

/** 后端不返回 title，用首条用户消息兜底（设计文档 7.4） */
function deriveTitle(thread: Thread | undefined, msgs: Message[] | undefined): string {
  const existing = thread?.title?.trim()
  if (existing && existing !== 'Untitled' && existing !== '新任务') return existing
  const firstUser = msgs?.find((m) => m.role === 'user' && m.content.trim())
  return firstUser ? firstUser.content.trim().slice(0, 24) : '新任务'
}

/**
 * 拉历史失败时的提示。
 *
 * 404 单独说人话：平台只回 "Thread or assistant not found."，
 * 但用户真正遇到的多半是「URL 里的会话被删了」或「后端重启过」，
 * 直接透传英文报错等于让人自己猜。
 */
function loadErrorMessage(err: unknown): string {
  if (err instanceof ApiError && err.status === 404) {
    return '会话不存在或已被删除（后端重启后旧会话也可能取不到）'
  }
  return errorMessage(err)
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
  pendingApproval: null,

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
        // 这里不把 error 清空：ChatPage 挂载时 loadThreads 和 selectThread 是并发跑的，
        // 列表晚返回会顺手抹掉 selectThread 刚设的错误（会话已删除之类），错误条就再也不出现
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
      set({ error: loadErrorMessage(err) })
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

    // 工作空间与权限按任务存；发送这一刻读一次快照，跑完之前再改不影响本次运行。
    // 模型是全局偏好（侧边栏下拉框），存在 settingsStore 里，同样在发送这一刻取快照。
    const taskSettings = useTaskStore.getState().resolve(threadId)
    const runOptions: RunOptions = {
      ...taskSettings,
      model: useSettingsStore.getState().selectedId,
    }

    cancelCurrentRun = streamRun(threadId, text, runOptions, createRunHandlers(threadId))
  },

  cancelRun() {
    if (!get().isGenerating) return
    set({ cancelRequested: true })
    // 图挂起等确认时也要能停：待确认状态先清掉，否则卡片一直亮着
    set({ pendingApproval: null })
    // run.ts 的 cancel 会同步触发 onEnd，由它负责把 pendingMessage 落位
    cancelCurrentRun?.()
  },

  decideApproval(decision) {
    const pending = get().pendingApproval
    if (!pending) return

    // 先把卡片状态落定，防止连点两次发两次恢复请求
    set({ pendingApproval: null })
    patchPending((msg) => ({
      ...msg,
      parts: msg.parts.map((part) =>
        part.kind === 'approval' && part.id === pending.id
          ? { ...part, status: decision === 'approve' ? ('approved' as const) : ('rejected' as const) }
          : part,
      ),
    }))

    // 档位要原样带回去：后端的拦截判定在恢复时会再跑一次，档位变了结论就可能变
    // 模型同理：恢复时后端按 configurable 里的 model 换模型，带空了就退回默认模型
    const taskSettings = useTaskStore.getState().resolve(pending.threadId)
    const runOptions: RunOptions = {
      ...taskSettings,
      model: useSettingsStore.getState().selectedId,
    }

    // decision 的个数必须和挂起时的 action_requests 一样多，否则框架直接抛
    // 「Number of human decisions (N) does not match number of hanging tool calls (M)」。
    // 整组一起批准或一起拒绝——卡片上也是把这一组当成一个整体展示的。
    const decisions: ApprovalDecision[] = pending.requests.map(() =>
      decision === 'approve'
        ? { type: 'approve' }
        : { type: 'reject', message: '用户拒绝执行这条命令' },
    )

    cancelCurrentRun = resumeRun(
      pending.threadId,
      decisions,
      runOptions,
      createRunHandlers(pending.threadId),
    )
  },

  clearError() {
    set({ error: null })
  },
}))
