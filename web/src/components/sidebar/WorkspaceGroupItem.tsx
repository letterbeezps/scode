/**
 * 侧边栏里的工作空间分组（一级目录）。
 *
 * 一个工作空间下面可能攒了好几个任务——按目录收纳起来，比一长串平铺的
 * 任务好找。分组可以折叠，折叠状态记在 uiStore（刷新后还在）。
 */
import { ChevronDown, ChevronRight, Folder, FolderOpen } from 'lucide-react'
import { cn } from '../../lib/cn'
import type { WorkspaceGroup } from '../../lib/thread-groups'
import { ConversationItem } from './ConversationItem'

interface Props {
  group: WorkspaceGroup
  expanded: boolean
  /** thread_id → 标题 */
  titles: Record<string, string>
  activeThreadId: string | null
  onToggle: () => void
  onSelect: (id: string) => void
  onDelete: (id: string) => void
}

export function WorkspaceGroupItem({
  group,
  expanded,
  titles,
  activeThreadId,
  onToggle,
  onSelect,
  onDelete,
}: Props) {
  const isDefault = !group.path

  return (
    <div className="mb-0.5">
      <button
        type="button"
        onClick={onToggle}
        aria-expanded={expanded}
        title={isDefault ? '没选工作空间的任务，用后端默认目录' : group.path}
        className={cn(
          'flex w-full items-center gap-1.5 rounded-md px-1.5 py-1.5 text-left transition-colors',
          'hover:bg-raised',
        )}
      >
        {expanded ? (
          <ChevronDown className="size-3.5 shrink-0 text-fg-muted" />
        ) : (
          <ChevronRight className="size-3.5 shrink-0 text-fg-muted" />
        )}
        {expanded ? (
          <FolderOpen className="size-3.5 shrink-0 text-accent" />
        ) : (
          <Folder className="size-3.5 shrink-0 text-fg-muted" />
        )}
        <span className="min-w-0 flex-1 truncate text-[13px] font-medium text-fg">{group.label}</span>
        <span className="shrink-0 text-[10px] tabular-nums text-fg-muted">{group.threads.length}</span>
      </button>

      {expanded && (
        <div className="ml-3 border-l border-line/60 pl-1.5">
          {group.threads.map((thread) => (
            <ConversationItem
              key={thread.thread_id}
              thread={thread}
              title={titles[thread.thread_id] ?? thread.title ?? '新任务'}
              active={thread.thread_id === activeThreadId}
              onSelect={() => onSelect(thread.thread_id)}
              onDelete={() => onDelete(thread.thread_id)}
            />
          ))}
        </div>
      )}
    </div>
  )
}
