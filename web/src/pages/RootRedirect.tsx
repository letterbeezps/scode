/**
 * `/` 重定向：有历史会话就落到最近的一个，否则开新会话（设计文档 9）。
 */
import { useEffect, useRef } from 'react'
import { useNavigate } from 'react-router-dom'
import { Loader2 } from 'lucide-react'
import { useConversationStore } from '../store/conversationStore'

export function RootRedirect() {
  const navigate = useNavigate()
  const threads = useConversationStore((s) => s.threads)
  const loading = useConversationStore((s) => s.loading)
  const loadThreads = useConversationStore((s) => s.loadThreads)
  const createThread = useConversationStore((s) => s.createThread)
  const redirected = useRef(false)

  useEffect(() => {
    void loadThreads()
  }, [loadThreads])

  useEffect(() => {
    // 等线程列表加载完再决定去向，避免闪一下空会话
    if (loading || redirected.current) return
    redirected.current = true

    const latest = threads[0]
    if (latest) {
      navigate(`/chat/${latest.thread_id}`, { replace: true })
      return
    }
    void createThread().then((id) => {
      navigate(id ? `/chat/${id}` : '/chat', { replace: true })
    })
  }, [loading, threads, navigate, createThread])

  return (
    <div className="flex h-full items-center justify-center gap-2 text-sm text-fg-muted">
      <Loader2 className="size-4 animate-spin-slow" />
      正在打开…
    </div>
  )
}
