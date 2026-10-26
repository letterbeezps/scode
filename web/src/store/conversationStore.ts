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
import {
  cancelRun as cancelRunApi,
  joinRunStream,
  resumeRun,
  streamRun,
  type RunHandlers,
} from '../api/run'
import { isPermissionLevel } from '../lib/permissions'
import { useTodoStore } from './todoStore'
import { useTaskStore, type TaskSettings } from './taskStore'
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

/** 轮询恢复的代号：切线程/用户取消/又开始新运行后，旧循环看到代号变了就退出 */
let recoveryGeneration = 0
/** 页面刷新后从 /runs 找到的活跃 run，取消时不用再查一次 */
let recoveryRunId: string | null = null

const RECOVERY_POLL_MS = 1200
/** 恢复最长等这么久；超过就收尾并提示用户刷新，避免无限轮询 */
const RECOVERY_TIMEOUT_MS = 10 * 60 * 1000

let msgSeq = 0
const nextId = (prefix: string) => `${prefix}-${Date.now().toString(36)}-${++msgSeq}`

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

function emptyAssistant(threadId: string): Message {
  return {
    id: nextId('msg'),
    thread_id: threadId,
    role: 'assistant',
    content: '',
    parts: [],
    created_at: new Date().toISOString(),
  }
}

function isActiveRun(run: { status: string }): boolean {
  return run.status === 'running' || run.status === 'pending'
}

/**
 * 用 thread metadata 回填任务参数。
 *
 * taskStore 只在内存里，刷新页面就丢。thread metadata 记着这个任务上次实际
 * 用过的 workspace / permissions（见 sendMessage），加载线程时回填。否则旧
 * 任务会退回默认目录——HITL 恢复时尤其危险：批准的命令会在错误的目录里执行。
 */
function hydrateTaskSettings(thread: Thread): void {
  const metadata = thread.metadata
  if (!metadata) return

  const patch: Partial<TaskSettings> = {}
  if (typeof metadata.workspace === 'string') patch.workspace = metadata.workspace
  if (isPermissionLevel(metadata.permissions)) patch.permissions = metadata.permissions
  if (Object.keys(patch).length === 0) return

  useTaskStore.getState().hydrate(thread.thread_id, patch)
}

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
  /** 断线/刷新后正在等后端把 run 跑完并接回结果 */
  recovering: boolean
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
  /**
   * 提交这组动作的决定（每条一个，顺序跟 action_requests 一致）。
   *
   * 卡片负责算出每条的决定（批准 / 拒绝 / 改完再执行），这里只负责送出去。
   * 数量对不上直接不送：框架会抛
   * 「Number of human decisions (N) does not match number of hanging tool calls (M)」，
   * 整个运行报错。
   */
  decideApproval: (decisions: ApprovalDecision[]) => void
  clearError: () => void
}

/** 只改 pendingMessage，不动 messages */
function patchPending(fn: (msg: Message) => Message): void {
  useConversationStore.setState((prev) =>
    prev.pendingMessage ? { pendingMessage: fn(prev.pendingMessage) } : prev,
  )
}

/** 把 pendingMessage 落位；没有内容就只清状态 */
function commitPendingMessage(): void {
  useConversationStore.setState((prev) => {
    const pid = prev.pendingThreadId
    const pendingMsg = prev.pendingMessage
    if (!pid || !pendingMsg) {
      return {
        pendingMessage: null,
        pendingThreadId: null,
        isGenerating: false,
        recovering: false,
        cancelRequested: false,
      }
    }

    // 用户中途停止：内容留着，标一个中断状态
    const interrupted = prev.cancelRequested ? { ...pendingMsg, interrupted: true } : pendingMsg
    return {
      messages: { ...prev.messages, [pid]: [...(prev.messages[pid] ?? []), interrupted] },
      pendingMessage: null,
      pendingThreadId: null,
      isGenerating: false,
      recovering: false,
      cancelRequested: false,
    }
  })
}

/** 把仍没有结果的工具调用从历史里摘掉——HITL 卡片会单独展示这些动作，避免重复 */
function stripUnresolvedTools(messages: Message[]): Message[] {
  const next = [...messages]
  for (let index = next.length - 1; index >= 0; index -= 1) {
    const message = next[index]
    if (message.role !== 'assistant') continue

    const unresolved = new Set(
      (message.tool_calls ?? [])
        .filter((call) => call.status === 'pending' || call.status === 'running')
        .map((call) => call.id),
    )
    if (unresolved.size === 0) return next

    const parts = message.parts.filter(
      (part) => !(part.kind === 'tool' && unresolved.has(part.call.id)),
    )
    if (parts.length === 0) next.splice(index, 1)
    else {
      next[index] = {
        ...message,
        parts,
        tool_calls: (message.tool_calls ?? []).filter((call) => !unresolved.has(call.id)),
      }
    }
    return next
  }
  return next
}

/** 用持久化的 state.interrupts 重建审批卡片（刷新/断线后的关键一步） */
function presentInterrupt(threadId: string, requests: ApprovalRequest[], messages: Message[]): void {
  const id = nextId('approval')
  const cleaned = stripUnresolvedTools(messages)
  const pending = emptyAssistant(threadId)
  pending.parts = [{ kind: 'approval', id, requests, status: 'pending' }]

  useConversationStore.setState((prev) => {
    const thread = prev.threads.find((item) => item.thread_id === threadId)
    const next = {
      messages: { ...prev.messages, [threadId]: cleaned },
      titles: { ...prev.titles, [threadId]: deriveTitle(thread, cleaned) },
    }
    if (prev.activeThreadId !== threadId) return next
    return {
      ...next,
      pendingMessage: pending,
      pendingThreadId: threadId,
      pendingApproval: { id, threadId, requests },
      isGenerating: false,
      recovering: false,
      cancelRequested: false,
    }
  })
}

/** 以 /state 为准重新加载线程，用于恢复结束后对齐历史 */
async function refreshThread(threadId: string): Promise<void> {
  try {
    const snapshot = await threadApi.loadThreadSnapshot(threadId)

    if (snapshot.interrupts.length > 0) {
      const messages = threadApi.restoreMessages(threadId, snapshot.rawMessages, {
        unresolvedToolCalls: 'pending',
      })
      presentInterrupt(threadId, snapshot.interrupts, messages)
      return
    }

    if (snapshot.next.length > 0) {
      const runs = await threadApi.listRuns(threadId)
      const active = runs.find(isActiveRun)
      if (active) {
        void startRecoveryPolling(threadId, active.run_id)
        return
      }
    }

    const messages = threadApi.restoreMessages(threadId, snapshot.rawMessages)
    const state = useConversationStore.getState()
    // 刷新期间用户已经发了新消息：别把新运行的 pending 状态冲掉
    if (state.isGenerating || state.pendingThreadId) return

    useConversationStore.setState((prev) => {
      const thread = prev.threads.find((item) => item.thread_id === threadId)
      const next = {
        messages: { ...prev.messages, [threadId]: messages },
        titles: { ...prev.titles, [threadId]: deriveTitle(thread, messages) },
      }
      if (prev.activeThreadId !== threadId) return next
      return {
        ...next,
        pendingMessage: null,
        pendingThreadId: null,
        isGenerating: false,
        recovering: false,
        pendingApproval: null,
        cancelRequested: false,
      }
    })
  } catch {
    // 刷新失败不覆盖现有 UI；用户还能手动刷新
  }
}

/** 轮询 /state，直到 run 结束或挂在人工确认上 */
async function startRecoveryPolling(threadId: string, runId?: string): Promise<void> {
  if (useConversationStore.getState().activeThreadId !== threadId) return

  const generation = ++recoveryGeneration
  recoveryRunId = runId ?? null
  cancelCurrentRun = null

  const current = useConversationStore.getState()
  useConversationStore.setState({
    isGenerating: true,
    recovering: true,
    // 同页断线时保留已经流出来的部分内容；页面刷新时这里本来就是 null
    pendingMessage: current.pendingThreadId === threadId ? current.pendingMessage : null,
    pendingThreadId: threadId,
    error: null,
    cancelRequested: false,
  })

  const deadline = Date.now() + RECOVERY_TIMEOUT_MS
  let polls = 0
  while (generation === recoveryGeneration) {
    const state = useConversationStore.getState()
    if (state.activeThreadId !== threadId) {
      // 用户已经切走：只清理属于这条线程的全局状态，别影响新线程
      if (state.pendingThreadId === threadId) {
        useConversationStore.setState({
          pendingMessage: null,
          pendingThreadId: null,
          isGenerating: false,
          recovering: false,
        })
      }
      return
    }

    try {
      const snapshot = await threadApi.loadThreadSnapshot(threadId)

      if (snapshot.interrupts.length > 0) {
        const messages = threadApi.restoreMessages(threadId, snapshot.rawMessages, {
          unresolvedToolCalls: 'pending',
        })
        presentInterrupt(threadId, snapshot.interrupts, messages)
        recoveryRunId = null
        return
      }

      if (snapshot.next.length === 0) {
        const messages = threadApi.restoreMessages(threadId, snapshot.rawMessages)
        useConversationStore.setState((prev) => {
          const thread = prev.threads.find((item) => item.thread_id === threadId)
          return {
            messages: { ...prev.messages, [threadId]: messages },
            titles: { ...prev.titles, [threadId]: deriveTitle(thread, messages) },
            pendingMessage: null,
            pendingThreadId: null,
            isGenerating: false,
            recovering: false,
            pendingApproval: null,
            cancelRequested: false,
          }
        })
        recoveryRunId = null
        return
      }

      // 每几轮确认一次 run 是否还活着：后端重启会丢掉 inmem 队列里的运行，
      // 这种时候 state.next 可能永远不为空，不能一直等到超时
      polls += 1
      if (polls % 5 === 0) {
        try {
          const runs = await threadApi.listRuns(threadId)
          const stillActive = runId
            ? runs.some((run) => run.run_id === runId && isActiveRun(run))
            : runs.some(isActiveRun)
          if (!stillActive) {
            const messages = threadApi.restoreMessages(threadId, snapshot.rawMessages)
            useConversationStore.setState((prev) => {
              const thread = prev.threads.find((item) => item.thread_id === threadId)
              return {
                messages: { ...prev.messages, [threadId]: messages },
                titles: { ...prev.titles, [threadId]: deriveTitle(thread, messages) },
                pendingMessage: null,
                pendingThreadId: null,
                isGenerating: false,
                recovering: false,
                pendingApproval: null,
                cancelRequested: false,
                error: '上次运行已中断，未收到最终结果',
              }
            })
            recoveryRunId = null
            return
          }
        } catch {
          // 查询失败就继续按 state 轮询
        }
      }
    } catch {
      // 网络还没恢复：继续重试
    }

    if (Date.now() >= deadline) break
    await sleep(RECOVERY_POLL_MS)
  }

  if (generation !== recoveryGeneration) return
  recoveryRunId = null
  const timeoutMessage = '等待运行完成超时，请刷新会话查看最新状态'
  useConversationStore.setState((prev) => {
    const pid = prev.pendingThreadId
    const message = prev.pendingMessage
    if (!pid || !message) {
      return {
        isGenerating: false,
        recovering: false,
        pendingMessage: null,
        pendingThreadId: null,
        error: timeoutMessage,
      }
    }
    // 超时也别把已经流出来的内容丢掉，落位并标错误
    return {
      messages: {
        ...prev.messages,
        [pid]: [...(prev.messages[pid] ?? []), { ...message, error: timeoutMessage }],
      },
      pendingMessage: null,
      pendingThreadId: null,
      isGenerating: false,
      recovering: false,
      error: timeoutMessage,
    }
  })
}

/** 用户取消恢复：停掉轮询，并把后端还在跑的 run 也取消 */
async function cancelRecovery(threadId: string | null): Promise<void> {
  recoveryGeneration += 1
  const runId = recoveryRunId
  recoveryRunId = null
  cancelCurrentRun = null

  const state = useConversationStore.getState()
  if (state.pendingMessage && state.pendingThreadId) {
    useConversationStore.setState((prev) => {
      const pid = prev.pendingThreadId
      const message = prev.pendingMessage
      if (!pid || !message) return prev
      return {
        messages: {
          ...prev.messages,
          [pid]: [...(prev.messages[pid] ?? []), { ...message, interrupted: true }],
        },
        pendingMessage: null,
        pendingThreadId: null,
        isGenerating: false,
        recovering: false,
        pendingApproval: null,
        cancelRequested: false,
      }
    })
  } else {
    useConversationStore.setState({
      isGenerating: false,
      recovering: false,
      pendingMessage: null,
      pendingThreadId: null,
      pendingApproval: null,
      cancelRequested: false,
    })
  }

  if (!threadId) return
  try {
    if (runId) {
      await cancelRunApi(threadId, runId)
    } else {
      const runs = await threadApi.listRuns(threadId)
      const active = runs.find(isActiveRun)
      if (active) await cancelRunApi(threadId, active.run_id)
    }
  } catch {
    // 后端已经不可达时本地状态已经收尾，不再额外报错
  }
}

interface RunHandlerOptions {
  /** 断线后接回来的 run：结束后以 /state 为准刷新，避免本地流式结果不全 */
  recovered?: boolean
}

/**
 * 一次运行的事件处理。
 *
 * 发消息、断线重连、恢复挂起的运行走同一套处理：token / 工具调用继续追加到
 * 同一条 pendingMessage 上。
 */
function createRunHandlers(threadId: string, options: RunHandlerOptions = {}): RunHandlers {
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
      patchPending((msg) => {
        // join 回来的流可能重发断线前已经见过的调用，按 id 去重
        if (msg.parts.some((part) => part.kind === 'tool' && part.call.id === call.id)) {
          return msg
        }
        return {
          ...msg,
          parts: [...msg.parts, { kind: 'tool', call }],
          tool_calls: [...(msg.tool_calls ?? []), call],
        }
      })
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
      useConversationStore.setState({ error: message, recovering: false })
    },

    onInterrupt(requests) {
      // 整组存：框架要求 resume 的 decision 数量和 action_requests 一样多，
      // 丢掉任何一个，恢复时就会报数量不匹配。
      if (requests.length === 0) return
      const id = nextId('approval')
      const state = useConversationStore.getState()

      if (state.pendingMessage) {
        patchPending((msg) => ({
          ...msg,
          parts: [...msg.parts, { kind: 'approval', id, requests, status: 'pending' }],
        }))
      } else {
        const pending = emptyAssistant(threadId)
        pending.parts = [{ kind: 'approval', id, requests, status: 'pending' }]
        useConversationStore.setState({ pendingMessage: pending, pendingThreadId: threadId })
      }

      useConversationStore.setState({
        pendingApproval: { id, threadId, requests },
        isGenerating: false,
        recovering: false,
      })
    },

    onConnectionLost(runId) {
      if (options.recovered) {
        // join 回来的流也断了：退回轮询 state，至少能拿到最终结果
        void startRecoveryPolling(threadId, runId)
        return
      }

      if (runId) {
        useConversationStore.setState({ recovering: true })
        cancelCurrentRun = joinRunStream(
          threadId,
          runId,
          createRunHandlers(threadId, { recovered: true }),
        )
        return
      }

      void startRecoveryPolling(threadId)
    },

    onEnd() {
      cancelCurrentRun = null
      const state = useConversationStore.getState()

      // 图挂起等人确认：消息先不落位，等批准/拒绝后继续往这条消息上追加
      if (state.pendingApproval) {
        useConversationStore.setState({ isGenerating: false, recovering: false })
        return
      }

      const cancelled = state.cancelRequested
      commitPendingMessage()

      // 接回来的 run 结束后以 /state 为准对齐：join_stream 不补发断线前的内容
      if (options.recovered && !cancelled) {
        void refreshThread(threadId)
      }
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
  recovering: false,
  loading: false,
  error: null,
  cancelRequested: false,
  pendingApproval: null,

  async loadThreads() {
    set({ loading: true })
    try {
      const threads = await threadApi.listThreads()
      // 刷新页面后 taskStore 是空的：用线程 metadata 回填工作空间/权限
      threads.forEach(hydrateTaskSettings)
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
    // 浏览器后退/前进不一定走 ChatPage 的 handleSelect，这里兜底停掉当前运行
    if (get().isGenerating) get().cancelRun()

    // 切线程先清掉上一条线程的全局 pending，读到的 state 会重新决定要显示什么
    set({
      activeThreadId: id,
      error: null,
      loading: true,
      pendingMessage: null,
      pendingThreadId: null,
      pendingApproval: null,
      isGenerating: false,
      recovering: false,
      cancelRequested: false,
    })

    // 刷新后 taskStore 是空的；先试一次。loadThreads 可能比这个请求慢，
    // 所以下面拿到快照之后还会再试（两次都是幂等的，已有设置不会被覆盖）。
    const known = get().threads.find((t) => t.thread_id === id)
    if (known) hydrateTaskSettings(known)

    try {
      // 每次都读 state：缓存不能代表“run 是否还在跑”，刷新/断线恢复必须看 next/interrupts
      const snapshot = await threadApi.loadThreadSnapshot(id)
      // 读盘期间用户已经切走：别把旧线程的结果塞进当前 UI
      if (get().activeThreadId !== id) return

      const thread = get().threads.find((t) => t.thread_id === id)
      if (thread) hydrateTaskSettings(thread)

      const active = snapshot.next.length > 0 || snapshot.interrupts.length > 0
      const messages = threadApi.restoreMessages(id, snapshot.rawMessages, {
        unresolvedToolCalls: active ? 'pending' : 'error',
      })

      set((state) => {
        const thread = state.threads.find((t) => t.thread_id === id)
        return {
          messages: { ...state.messages, [id]: messages },
          titles: { ...state.titles, [id]: deriveTitle(thread, messages) },
        }
      })

      if (snapshot.interrupts.length > 0) {
        presentInterrupt(id, snapshot.interrupts, messages)
        return
      }

      if (snapshot.next.length > 0) {
        // state 说还没跑完：再确认有没有活跃 run。有就轮询到结束；
        // 没有的话说明是一次中断的旧状态，不能一直转圈。
        const runs = await threadApi.listRuns(id)
        if (get().activeThreadId !== id) return
        const activeRun = runs.find(isActiveRun)
        if (activeRun) {
          void startRecoveryPolling(id, activeRun.run_id)
          return
        }

        const settled = threadApi.restoreMessages(id, snapshot.rawMessages)
        set((state) => ({
          messages: { ...state.messages, [id]: settled },
          pendingMessage: null,
          pendingThreadId: null,
          isGenerating: false,
          recovering: false,
          error: '上次运行已中断，未收到工具结果',
        }))
        return
      }

      set({
        pendingMessage: null,
        pendingThreadId: null,
        isGenerating: false,
        recovering: false,
        pendingApproval: null,
        cancelRequested: false,
      })
    } catch (err) {
      set({ error: loadErrorMessage(err) })
    } finally {
      set({ loading: false })
    }
  },

  async deleteThread(id) {
    // 删当前正在跑/恢复的线程时先停掉运行，否则轮询会一直打一个已删除的 thread
    if (get().activeThreadId === id && get().isGenerating) get().cancelRun()

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
    if (state.pendingApproval) {
      set({ error: '请先批准或拒绝待确认的操作' })
      return
    }

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

    const pending = emptyAssistant(threadId)

    set((prev) => ({
      messages: {
        ...prev.messages,
        [threadId!]: [...(prev.messages[threadId!] ?? []), userMessage],
      },
      titles: { ...prev.titles, [threadId!]: deriveTitle(prev.threads.find((t) => t.thread_id === threadId), [userMessage]) },
      pendingMessage: pending,
      pendingThreadId: threadId,
      isGenerating: true,
      recovering: false,
      cancelRequested: false,
      error: null,
    }))

    // 工作空间与权限按任务存；发送这一刻读一次快照，跑完之前再改不影响本次运行。
    // 模型是全局偏好（侧边栏下拉框），存在 settingsStore 里，同样在发送这一刻取快照。
    const taskSettings = useTaskStore.getState().resolve(threadId)
    const runOptions: RunOptions = {
      ...taskSettings,
      model: useSettingsStore.getState().selectedId,
    }

    // 标题写进后端的 metadata：平台的 Thread 没有 title 字段，
    // 只存前端内存的话刷新页面侧边栏就全变成"新任务"了。
    // 写失败不影响主流程，标题退回从首条消息推导。
    //
    // 工作空间和权限也一起写：它们按任务存，但 taskStore 只在内存里（刷新就丢）。
    // 记进 thread metadata 后，加载线程时能回填（hydrateTaskSettings），HITL
    // 恢复时批准的命令才不会跑错目录；「最近用过的项目」也从这里读。
    // PATCH 返回的是合并后的完整 metadata，顺手更新本地列表，免得最近项目
    // 要刷新页面才出现。
    const title = get().titles[threadId!]
    const metadata: Record<string, unknown> = {
      workspace: taskSettings.workspace,
      permissions: taskSettings.permissions,
    }
    if (title && title !== '新任务') metadata.title = title
    // **先落盘再开跑**：审批挂起时刷新页面，档位和工作空间是从 metadata 回填的
    // （taskStore 只在内存里）。PATCH 跑在 run 前面，就不会出现「run 已经挂起、
    // metadata 还没写进去，刷新后回填成默认档位」——那会让恢复时的判定跟发起
    // 时对不上。写失败不阻塞主流程（catch 掉），标题退回从首条消息推导。
    await threadApi
      .updateThreadMetadata(threadId!, metadata)
      .then((updated) => {
        set((prev) => ({
          threads: prev.threads.map((thread) =>
            thread.thread_id === updated.thread_id
              ? { ...thread, metadata: updated.metadata }
              : thread,
          ),
        }))
      })
      .catch(() => {})

    cancelCurrentRun = streamRun(threadId, text, runOptions, createRunHandlers(threadId))
  },

  cancelRun() {
    const state = get()
    if (!state.isGenerating) return
    set({ cancelRequested: true, pendingApproval: null, recovering: false })

    // 有活的流（首次运行或 join 回来的流）就交给它收尾；
    // 纯轮询恢复没有 cancelCurrentRun，需要自己停循环并调 cancel 接口
    if (cancelCurrentRun) {
      recoveryGeneration += 1
      cancelCurrentRun()
      return
    }
    void cancelRecovery(state.pendingThreadId ?? state.activeThreadId)
  },

  decideApproval(decisions) {
    const pending = get().pendingApproval
    if (!pending) return
    // 数量必须跟挂起时的 action_requests 一样多，否则框架直接抛
    // 「Number of human decisions (N) does not match number of hanging tool calls (M)」。
    if (decisions.length !== pending.requests.length) return

    // 先把卡片状态落定，防止连点两次发两次恢复请求；恢复请求本身也是流式运行
    set({ pendingApproval: null, recovering: false, isGenerating: true, pendingThreadId: pending.threadId })
    if (!get().pendingMessage) {
      // 从 /state 恢复出来的审批卡片可能没有 pendingMessage（历史里直接挂卡片时）
      const pendingMessage = emptyAssistant(pending.threadId)
      set({ pendingMessage, pendingThreadId: pending.threadId })
    }
    const status: 'approved' | 'rejected' | 'edited' =
      decisions.every((d) => d.type === 'approve')
        ? 'approved'
        : decisions.some((d) => d.type === 'reject')
          ? 'rejected'
          : 'edited'
    patchPending((msg) => ({
      ...msg,
      parts: msg.parts.map((part) =>
        part.kind === 'approval' && part.id === pending.id
          ? { ...part, status }
          : part,
      ),
    }))

    // 工作空间和档位要原样带回去：恢复时后端会用它们继续跑（权限判定还会再跑
    // 一次）。审批挂起期间两个选择器是禁用的，刷新后则靠 thread metadata 回填，
    // 所以这里读到的就是发起 run 时的值——否则批准的命令会跑到别的目录里。
    // 模型同理：恢复时后端按 configurable 里的 model 换模型，带空了就退回默认模型。
    //
    // （后端另外把档位记进了图状态，档位就算回传错了也不会改变判定；这里原样
    //  带回去是为了让恢复这一轮跟发起那一轮看到的是同一套配置。）
    const taskSettings = useTaskStore.getState().resolve(pending.threadId)
    const runOptions: RunOptions = {
      ...taskSettings,
      model: useSettingsStore.getState().selectedId,
    }

    cancelCurrentRun = resumeRun(
      pending.threadId,
      decisions,
      runOptions,
      // 恢复请求本身也会流式返回；结束后以 state 对齐，补上挂起前后没进 pending 的内容
      createRunHandlers(pending.threadId, { recovered: true }),
    )
  },

  clearError() {
    set({ error: null })
  },
}))
