/**
 * 输入区（前端设计文档 3.3）。
 *
 * Enter 发送 / Shift+Enter 换行；生成中发送按钮变成停止按钮。
 * 文本框自适应高度，但超过上限后内部滚动，避免挤掉消息列表。
 */
import { useEffect, useLayoutEffect, useRef } from 'react'
import { CornerDownLeft, Send, Square } from 'lucide-react'
import { cn } from '../../lib/cn'
import { WorkspacePicker } from './WorkspacePicker'
import { PermissionPicker } from './PermissionPicker'

const MAX_HEIGHT_PX = 200

interface Props {
  value: string
  onChange: (value: string) => void
  onSend: () => void
  onStop: () => void
  isGenerating: boolean
  disabled?: boolean
  /** 当前任务 id，决定工作空间与权限写到哪一份设置上 */
  threadId: string | null
  placeholder?: string
}

export function InputBar({
  value,
  onChange,
  onSend,
  onStop,
  isGenerating,
  disabled,
  threadId,
  placeholder = '描述你的任务…',
}: Props) {
  const textareaRef = useRef<HTMLTextAreaElement | null>(null)

  // 高度跟随内容，但封顶后交给内部滚动
  useLayoutEffect(() => {
    const el = textareaRef.current
    if (!el) return
    el.style.height = 'auto'
    el.style.height = `${Math.min(el.scrollHeight, MAX_HEIGHT_PX)}px`
    el.style.overflowY = el.scrollHeight > MAX_HEIGHT_PX ? 'auto' : 'hidden'
  }, [value])

  // 发送后把焦点还回输入框，连续对话不用重新点
  useEffect(() => {
    if (!isGenerating && value === '') textareaRef.current?.focus()
  }, [isGenerating, value])

  const canSend = value.trim().length > 0 && !isGenerating && !disabled

  const handleKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    // IME 组字期间回车是选词不是发送，中文输入必须避开这一下
    if (e.nativeEvent.isComposing) return
    if (e.key === 'Enter' && !e.shiftKey && !e.altKey) {
      e.preventDefault()
      if (canSend) onSend()
    }
  }

  return (
    <div className="shrink-0 border-t border-line bg-bg px-4 py-3">
      <div className="mx-auto w-full max-w-4xl">
        <div
          className={cn(
            'flex items-end gap-2 rounded-xl border bg-surface px-3 py-2 transition-colors',
            'focus-within:border-accent',
          )}
        >
          <textarea
            ref={textareaRef}
            value={value}
            onChange={(e) => onChange(e.target.value)}
            onKeyDown={handleKeyDown}
            disabled={disabled}
            rows={1}
            placeholder={placeholder}
            aria-label="输入消息"
            className="max-h-[200px] min-h-[24px] flex-1 resize-none bg-transparent py-1 text-[14px] leading-6 text-fg placeholder:text-fg-muted focus:outline-none disabled:opacity-50"
          />

          {isGenerating ? (
            <button
              type="button"
              onClick={onStop}
              aria-label="停止生成"
              className="flex size-8 shrink-0 items-center justify-center rounded-lg bg-surface text-fg transition-colors hover:bg-raised"
            >
              <Square className="size-3.5 fill-current" />
            </button>
          ) : (
            <button
              type="button"
              onClick={onSend}
              disabled={!canSend}
              aria-label="发送"
              className={cn(
                'flex size-8 shrink-0 items-center justify-center rounded-lg transition-colors',
                canSend
                  ? 'bg-accent text-bg hover:opacity-90'
                  : 'cursor-not-allowed bg-surface text-fg-muted',
              )}
            >
              <Send className="size-3.5" />
            </button>
          )}
        </div>

        <div className="mt-2 flex flex-wrap items-center gap-2 px-1">
          <WorkspacePicker threadId={threadId} disabled={isGenerating} />
          <PermissionPicker threadId={threadId} disabled={isGenerating} />
          <p className="ml-auto flex items-center gap-1 text-[11px] text-fg-muted">
            <CornerDownLeft className="size-3" />
            Enter 发送 · Shift+Enter 换行
          </p>
        </div>
      </div>
    </div>
  )
}
