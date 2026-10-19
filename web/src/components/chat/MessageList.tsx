/**
 * 消息列表（前端设计文档 4.1）。
 *
 * 流式生成中的 pendingMessage 单独渲染在末尾，且不参与历史列表的 memo，
 * 否则每来一个 token 都要重算整条消息的渲染结果。
 */
import { ArrowDown, Loader2 } from 'lucide-react'
import type { Message } from '../../api/types'
import { cn } from '../../lib/cn'
import { useAutoScroll } from '../../hooks/useAutoScroll'
import { UserMessage } from './UserMessage'
import { AssistantMessage } from './AssistantMessage'

interface Props {
  messages: Message[]
  pendingMessage: Message | null
  isGenerating: boolean
}

export function MessageList({ messages, pendingMessage, isGenerating }: Props) {
  const { containerRef, contentRef, pinned, scrollToBottom, handleScroll } = useAutoScroll<HTMLDivElement>()

  return (
    <div className="relative min-h-0 flex-1">
      <div
        ref={containerRef}
        onScroll={handleScroll}
        className="scrollbar-slim h-full overflow-y-auto"
      >
        <div ref={contentRef} className="mx-auto w-full max-w-4xl px-2 py-4">
          {messages.map((message) =>
            message.role === 'user' ? (
              <UserMessage key={message.id} message={message} />
            ) : (
              <AssistantMessage key={message.id} message={message} />
            ),
          )}

          {pendingMessage && <AssistantMessage message={pendingMessage} streaming />}

          {isGenerating && !pendingMessage && (
            <div className="flex items-center gap-2 px-4 py-3 text-sm text-fg-muted">
              <Loader2 className="size-4 animate-spin-slow" />
              正在思考…
            </div>
          )}
        </div>
      </div>

      {!pinned && (
        <button
          type="button"
          onClick={() => scrollToBottom()}
          aria-label="回到底部"
          className={cn(
            'absolute bottom-4 left-1/2 -translate-x-1/2 rounded-full border border-line',
            'bg-surface px-3 py-1.5 text-xs text-fg shadow-lg transition-colors hover:bg-raised',
          )}
        >
          <ArrowDown className="mr-1 inline size-3.5" />
          回到底部
        </button>
      )}
    </div>
  )
}
