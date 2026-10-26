/**
 * 输入区（前端设计文档 3.3）。
 *
 * Enter 发送 / Shift+Enter 换行；生成中发送按钮变成停止按钮。
 * 文本框自适应高度，但超过上限后内部滚动，避免挤掉消息列表。
 *
 * **斜杠命令**：开头敲 `/` 弹出命令列表（↑↓ 选、回车确认、Esc 关闭）。
 * 选中后把命令当普通消息发出去——后端认出命令就执行对应动作，
 * 所以加新命令不需要新的接口。
 */
import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import { Brain, CornerDownLeft, Send, Square } from 'lucide-react'
import { cn } from '../../lib/cn'
import { SLASH_COMMANDS, type SlashCommand } from '../../lib/commands'
import { SlashCommandMenu } from './SlashCommandMenu'
import { WorkspacePicker } from './WorkspacePicker'
import { PermissionPicker } from './PermissionPicker'
import { MemoryPanel } from '../memory/MemoryPanel'
import { useConversationStore } from '../../store/conversationStore'
import { useTaskSettings } from '../../store/taskStore'

const MAX_HEIGHT_PX = 200

interface Props {
  value: string
  onChange: (value: string) => void
  /** 发送指定内容（斜杠命令走这里，命令文本不一定等于输入框里的内容） */
  onSend: (text: string) => void
  onStop: () => void
  isGenerating: boolean
  disabled?: boolean
  /** 当前任务 id，决定工作空间与权限写到哪一份设置上 */
  threadId: string | null
  placeholder?: string
}

/**
 * 从输入内容里解析出「正在敲的命令」。
 *
 * 只有**开头**是 `/`、且还没打出空格时才算在敲命令：
 * 这样 `/usr/local/bin` 这种路径不会误弹菜单（也匹配不上任何命令）。
 */
function parseCommandQuery(text: string): string | null {
  const trimmed = text.trimStart()
  if (!trimmed.startsWith('/')) return null
  if (trimmed.includes(' ') || trimmed.includes('\n')) return null
  return trimmed.slice(1)
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
  const [activeIndex, setActiveIndex] = useState(0)
  const [dismissed, setDismissed] = useState(false)
  /** 记忆面板开没开 */
  const [memoryOpen, setMemoryOpen] = useState(false)
  /** 审批卡片挂着时任务参数不能改：恢复请求会原样带回 workspace / permissions */
  const approvalPending = useConversationStore((s) => s.pendingApproval !== null)
  /** 项目级记忆跟着当前任务的工作空间走 */
  const { workspace } = useTaskSettings(threadId)

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

  const query = parseCommandQuery(value)
  const matched = useMemo(() => {
    if (query === null) return []
    return SLASH_COMMANDS.filter((c) => c.command.slice(1).startsWith(query))
  }, [query])

  const menuOpen = matched.length > 0 && !dismissed && !isGenerating

  const canSend = value.trim().length > 0 && !isGenerating && !disabled

  const handleChange = (next: string) => {
    setDismissed(false)
    // 敲的内容变了，高亮回到第一条
    setActiveIndex(0)
    onChange(next)
  }

  const selectCommand = (command: SlashCommand) => {
    if (isGenerating || disabled) return
    onSend(command.command)
  }

  const handleKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    // IME 组字期间回车是选词不是发送，中文输入必须避开这一下
    if (e.nativeEvent.isComposing) return

    if (menuOpen) {
      if (e.key === 'ArrowDown') {
        e.preventDefault()
        setActiveIndex((i) => (i + 1) % matched.length)
        return
      }
      if (e.key === 'ArrowUp') {
        e.preventDefault()
        setActiveIndex((i) => (i - 1 + matched.length) % matched.length)
        return
      }
      if (e.key === 'Escape') {
        e.preventDefault()
        setDismissed(true)
        return
      }
      if ((e.key === 'Enter' || e.key === 'Tab') && !e.shiftKey) {
        e.preventDefault()
        const command = matched[activeIndex]
        if (command) selectCommand(command)
        return
      }
    }

    if (e.key === 'Enter' && !e.shiftKey && !e.altKey) {
      e.preventDefault()
      if (canSend) onSend(value)
    }
  }

  return (
    <div className="shrink-0 border-t border-line bg-bg px-4 py-3">
      <div className="mx-auto w-full max-w-4xl">
        <div className="relative">
          <SlashCommandMenu
            commands={matched}
            activeIndex={activeIndex}
            onSelect={selectCommand}
            onHover={setActiveIndex}
          />

          <div
            className={cn(
              'flex items-end gap-2 rounded-xl border bg-surface px-3 py-2 transition-colors',
              'focus-within:border-accent',
            )}
          >
            <textarea
              ref={textareaRef}
              value={value}
              onChange={(e) => handleChange(e.target.value)}
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
                onClick={() => canSend && onSend(value)}
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
        </div>

        <div className="mt-2 flex flex-wrap items-center gap-2 px-1">
          <WorkspacePicker threadId={threadId} disabled={isGenerating || approvalPending} />
          <PermissionPicker threadId={threadId} disabled={isGenerating || approvalPending} />
          <button
            type="button"
            onClick={() => setMemoryOpen(true)}
            title="查看和编辑 agent 的长期记忆（用户级 + 项目级）"
            className="flex items-center gap-1.5 rounded-md border border-line bg-surface px-2 py-1.5 text-[11px] text-fg-muted transition-colors hover:border-accent/60 hover:text-fg"
          >
            <Brain className="size-3.5" />
            记忆
          </button>
          <p className="ml-auto flex items-center gap-1 text-[11px] text-fg-muted">
            <CornerDownLeft className="size-3" />
            Enter 发送 · Shift+Enter 换行 · <span className="font-mono">/</span> 命令
          </p>
        </div>
      </div>

      {memoryOpen && (
        <MemoryPanel workspace={workspace} onClose={() => setMemoryOpen(false)} />
      )}
    </div>
  )
}
