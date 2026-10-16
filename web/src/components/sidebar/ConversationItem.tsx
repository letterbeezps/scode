import { MessageSquare, Trash2 } from 'lucide-react'
import { useState } from 'react'
import { cn } from '../../lib/cn'
import type { Thread } from '../../api/types'
import { useUIStore } from '../../store/uiStore'

interface Props {
  thread: Thread
  title: string
  active: boolean
  onSelect: () => void
  onDelete: () => void
}

function formatTime(iso: string): string {
  const date = new Date(iso)
  if (Number.isNaN(date.getTime())) return ''
  const now = new Date()
  const sameDay = date.toDateString() === now.toDateString()
  if (sameDay) {
    return date.toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' })
  }
  const diffDays = Math.floor((now.getTime() - date.getTime()) / 86_400_000)
  if (diffDays < 7) return `${diffDays} 天前`
  return date.toLocaleDateString('zh-CN', { month: 'numeric', day: 'numeric' })
}

export function ConversationItem({ thread, title, active, onSelect, onDelete }: Props) {
  const [menuOpen, setMenuOpen] = useState(false)
  const collapsed = useUIStore((s) => s.sidebarCollapsed)

  if (collapsed) {
    return (
      <button
        type="button"
        onClick={onSelect}
        title={title}
        aria-label={title}
        aria-current={active}
        className={cn(
          'flex w-full items-center justify-center rounded-md py-2 transition-colors',
          active ? 'bg-raised text-fg' : 'text-fg-muted hover:bg-raised hover:text-fg',
        )}
      >
        <MessageSquare className="size-4" />
      </button>
    )
  }

  return (
    <div
      className="group relative"
      onContextMenu={(e) => {
        e.preventDefault()
        setMenuOpen(true)
      }}
    >
      <button
        type="button"
        onClick={onSelect}
        aria-current={active}
        className={cn(
          'flex w-full items-center gap-2 rounded-md py-2 pl-2.5 pr-8 text-left text-sm transition-colors',
          active ? 'bg-raised text-fg' : 'text-fg-muted hover:bg-raised hover:text-fg',
        )}
      >
        <MessageSquare className="size-4 shrink-0 opacity-70" />
        <span className="min-w-0 flex-1 truncate">{title}</span>
        <span className="shrink-0 text-[11px] tabular-nums opacity-0 transition-opacity group-hover:opacity-70">
          {formatTime(thread.updated_at)}
        </span>
      </button>

      <button
        type="button"
        onClick={() => setMenuOpen(true)}
        aria-label="任务操作"
        className={cn(
          'absolute right-1.5 top-1/2 -translate-y-1/2 rounded p-1 text-fg-muted',
          'opacity-0 transition-opacity hover:text-danger focus-visible:opacity-100 group-hover:opacity-100',
          menuOpen && 'opacity-100',
        )}
      >
        <Trash2 className="size-3.5" />
      </button>

      {menuOpen && (
        <ConfirmDelete
          title={title}
          onCancel={() => setMenuOpen(false)}
          onConfirm={() => {
            setMenuOpen(false)
            onDelete()
          }}
        />
      )}
    </div>
  )
}

/** 删除任务不可撤销，用一次轻量确认兜住误触 */
function ConfirmDelete({
  title,
  onCancel,
  onConfirm,
}: {
  title: string
  onCancel: () => void
  onConfirm: () => void
}) {
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-4">
      <div className="w-full max-w-sm rounded-lg border border-line bg-surface p-4 shadow-xl">
        <p className="text-sm text-fg">删除任务「{title.length > 24 ? `${title.slice(0, 24)}…` : title}」？</p>
        <p className="mt-1 text-xs text-fg-muted">该任务的记录将一并清除，无法恢复。</p>
        <div className="mt-4 flex justify-end gap-2">
          <button
            type="button"
            onClick={onCancel}
            className="rounded-md px-3 py-1.5 text-sm text-fg-muted hover:bg-raised hover:text-fg"
          >
            取消
          </button>
          <button
            type="button"
            onClick={onConfirm}
            className="rounded-md bg-danger px-3 py-1.5 text-sm font-medium text-white hover:opacity-90"
          >
            删除
          </button>
        </div>
      </div>
    </div>
  )
}
