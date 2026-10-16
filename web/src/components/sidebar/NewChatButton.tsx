import { Plus } from 'lucide-react'
import { cn } from '../../lib/cn'
import { useUIStore } from '../../store/uiStore'

interface Props {
  onClick: () => void
  disabled?: boolean
}

export function NewChatButton({ onClick, disabled }: Props) {
  const collapsed = useUIStore((s) => s.sidebarCollapsed)

  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      title="新建任务"
      aria-label="新建任务"
      className={cn(
        'flex w-full items-center gap-2 rounded-md px-3 py-2 text-sm font-medium',
        'border border-line bg-bg text-fg transition-colors',
        'hover:border-accent hover:bg-raised disabled:opacity-50',
        collapsed && 'justify-center px-0',
      )}
    >
      <Plus className="size-4 shrink-0" />
      {!collapsed && <span>新建任务</span>}
    </button>
  )
}
