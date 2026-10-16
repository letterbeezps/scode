import { useUIStore } from '../../store/uiStore'
import { useConversationStore } from '../../store/conversationStore'
import { ConversationItem } from './ConversationItem'
import { NewChatButton } from './NewChatButton'
import { TodoList } from './TodoList'
import { SettingsPanel } from './SettingsPanel'
import { PanelLeftClose, PanelLeftOpen } from 'lucide-react'
import { cn } from '../../lib/cn'

interface Props {
  onNewChat: () => void
  onSelect: (id: string) => void
}

export function Sidebar({ onNewChat, onSelect }: Props) {
  const collapsed = useUIStore((s) => s.sidebarCollapsed)
  const toggleSidebar = useUIStore((s) => s.toggleSidebar)
  const threads = useConversationStore((s) => s.threads)
  const titles = useConversationStore((s) => s.titles)
  const activeThreadId = useConversationStore((s) => s.activeThreadId)
  const deleteThread = useConversationStore((s) => s.deleteThread)

  return (
    <aside
      className={cn(
        'flex shrink-0 flex-col border-r border-line bg-surface',
        'transition-[width] duration-200 ease-out',
        collapsed ? 'w-14' : 'w-[280px]',
      )}
    >
      {/* 顶部：Logo + 新建任务 */}
      <div className={cn('flex items-center gap-2 border-b border-line p-3', collapsed && 'flex-col px-2')}>
        <button
          type="button"
          onClick={toggleSidebar}
          title={collapsed ? '展开侧边栏' : '收起侧边栏'}
          aria-label={collapsed ? '展开侧边栏' : '收起侧边栏'}
          className="rounded-md p-1.5 text-fg-muted transition-colors hover:bg-raised hover:text-fg"
        >
          {collapsed ? <PanelLeftOpen className="size-4" /> : <PanelLeftClose className="size-4" />}
        </button>
        {!collapsed && (
          <>
            <span className="font-mono text-sm font-semibold tracking-tight text-fg">stupid-code</span>
            <span className="ml-auto text-[10px] text-fg-muted">web</span>
          </>
        )}
      </div>

      <div className="space-y-2 p-3">
        <NewChatButton onClick={onNewChat} />
      </div>

      {/* 任务列表（一个 thread = 一个任务）*/}
      {!collapsed && (
        <div className="min-h-0 flex-1 overflow-y-auto scrollbar-slim px-3">
          {threads.length === 0 ? (
            <p className="px-1 py-2 text-xs text-fg-muted">还没有任务</p>
          ) : (
            <div className="space-y-0.5">
              <p className="px-2.5 pb-1 text-[11px] uppercase tracking-wide text-fg-muted">任务列表</p>
              {threads.map((thread) => (
                <ConversationItem
                  key={thread.thread_id}
                  thread={thread}
                  title={titles[thread.thread_id] ?? thread.title ?? '新任务'}
                  active={thread.thread_id === activeThreadId}
                  onSelect={() => onSelect(thread.thread_id)}
                  onDelete={() => void deleteThread(thread.thread_id)}
                />
              ))}
            </div>
          )}
        </div>
      )}

      {collapsed && <div className="flex-1" />}

      {/* Agent 的待办（与上面的「任务」不是一回事：这是 Agent 自己的执行计划）*/}
      {!collapsed && (
        <div className="max-h-[38%] shrink-0 overflow-y-auto scrollbar-slim border-t border-line px-3 py-3">
          <TodoList />
        </div>
      )}

      {/* 底部：设置 */}
      {!collapsed && (
        <div className="shrink-0 border-t border-line p-3">
          <SettingsPanel />
        </div>
      )}
    </aside>
  )
}
