import { useCallback, useEffect, useState } from 'react'
import { useNavigate, useParams } from 'react-router-dom'
import { Loader2 } from 'lucide-react'
import { Sidebar } from '../components/sidebar/Sidebar'
import { MessageList } from '../components/chat/MessageList'
import { ErrorBanner } from '../components/chat/ErrorBanner'
import { InputBar } from '../components/chat/InputBar'
import { EmptyState } from '../components/chat/EmptyState'
import { useConversationStore } from '../store/conversationStore'

export function ChatPage() {
  const { threadId } = useParams<{ threadId?: string }>()
  const navigate = useNavigate()

  const threads = useConversationStore((s) => s.threads)
  const activeThreadId = useConversationStore((s) => s.activeThreadId)
  const messages = useConversationStore((s) => s.messages)
  const pendingMessage = useConversationStore((s) => s.pendingMessage)
  const isGenerating = useConversationStore((s) => s.isGenerating)
  const recovering = useConversationStore((s) => s.recovering)
  const loading = useConversationStore((s) => s.loading)
  const error = useConversationStore((s) => s.error)
  const loadThreads = useConversationStore((s) => s.loadThreads)
  const createThread = useConversationStore((s) => s.createThread)
  const selectThread = useConversationStore((s) => s.selectThread)
  const sendMessage = useConversationStore((s) => s.sendMessage)
  const cancelRun = useConversationStore((s) => s.cancelRun)
  const clearError = useConversationStore((s) => s.clearError)

  const [draft, setDraft] = useState('')

  // 首次进入拉一次线程列表
  useEffect(() => {
    void loadThreads()
  }, [loadThreads])

  // 路由上的 threadId 是唯一真源，切会话时同步 store
  useEffect(() => {
    if (!threadId) return
    if (threadId === activeThreadId) return
    void selectThread(threadId)
  }, [threadId, activeThreadId, selectThread])

  const threadMessages = threadId ? (messages[threadId] ?? []) : []
  const isEmpty = threadMessages.length === 0 && !pendingMessage && !isGenerating

  const handleNewChat = useCallback(async () => {
    if (isGenerating) cancelRun()
    setDraft('')
    const id = await createThread()
    if (id) navigate(`/chat/${id}`)
  }, [isGenerating, cancelRun, createThread, navigate])

  const handleSelect = useCallback(
    (id: string) => {
      if (isGenerating) cancelRun()
      navigate(`/chat/${id}`)
    },
    [isGenerating, cancelRun, navigate],
  )

  /**
   * 发送一条消息。
   *
   * 文本由调用方给（输入框传当前内容，斜杠命令菜单传命令本体）——
   * 命令不一定等于输入框里的字，命令选中时输入框还停在用户敲的半截上。
   */
  const handleSend = useCallback(
    async (text: string) => {
      if (!text.trim()) return
      setDraft('')

      // /chat（无 threadId）下首发消息时要先建线程并跳过去。
      // store 里 sendMessage 也会兜底建线程，但那时 URL 还停在 /chat，
      // 消息会渲染到一个读不到 threadId 的页面上，等于凭空消失。
      if (!threadId && !activeThreadId) {
        const created = await createThread()
        if (!created) return
        navigate(`/chat/${created}`)
      }
      void sendMessage(text)
    },
    [threadId, activeThreadId, createThread, navigate, sendMessage],
  )

  return (
    <div className="flex h-full">
      <Sidebar onNewChat={handleNewChat} onSelect={handleSelect} />

      <main className="relative flex min-w-0 flex-1 flex-col">
        {/* 错误条浮在主区域顶部：空会话时 MessageList 不渲染，
            错误若挂在它上面会跟着消失，用户只看到白屏 */}
        <ErrorBanner error={error} onDismiss={clearError} />

        {isEmpty ? (
          <div className="min-h-0 flex-1">
            <EmptyState onPick={setDraft} />
          </div>
        ) : (
          // key 变化即重挂载：切换会话时滚动位置自然回到底部，无需 effect 重置
          <MessageList
            key={threadId ?? 'new'}
            messages={threadMessages}
            pendingMessage={pendingMessage}
            isGenerating={isGenerating}
            recovering={recovering}
          />
        )}

        {loading && threads.length > 0 && (
          <div className="flex items-center justify-center gap-2 border-t border-line py-2 text-xs text-fg-muted">
            <Loader2 className="size-3 animate-spin-slow" />
            加载中…
          </div>
        )}

        <InputBar
          value={draft}
          onChange={setDraft}
          onSend={handleSend}
          onStop={cancelRun}
          isGenerating={isGenerating}
          threadId={threadId ?? activeThreadId}
        />
      </main>
    </div>
  )
}
