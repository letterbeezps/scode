import { useEffect, useMemo, useRef } from 'react'
import { useUIStore } from '../../store/uiStore'
import { useConversationStore } from '../../store/conversationStore'
import { WorkspaceGroupItem } from './WorkspaceGroupItem'
import { NewChatButton } from './NewChatButton'
import { TodoList } from './TodoList'
import { SettingsPanel } from './SettingsPanel'
import { PanelLeftClose, PanelLeftOpen } from 'lucide-react'
import { cn } from '../../lib/cn'
import { groupThreadsByWorkspace, workspaceKeyOf } from '../../lib/thread-groups'

interface Props {
  onNewChat: () => void
  onSelect: (id: string) => void
}

export function Sidebar({ onNewChat, onSelect }: Props) {
  const collapsed = useUIStore((s) => s.sidebarCollapsed)
  const toggleSidebar = useUIStore((s) => s.toggleSidebar)
  const collapsedWorkspaces = useUIStore((s) => s.collapsedWorkspaces)
  const toggleWorkspaceGroup = useUIStore((s) => s.toggleWorkspaceGroup)
  const expandWorkspaceGroup = useUIStore((s) => s.expandWorkspaceGroup)
  const threads = useConversationStore((s) => s.threads)
  const titles = useConversationStore((s) => s.titles)
  const activeThreadId = useConversationStore((s) => s.activeThreadId)
  const deleteThread = useConversationStore((s) => s.deleteThread)

  /** 任务按工作空间收纳：一级是目录，二级是该目录下的任务 */
  const groups = useMemo(() => groupThreadsByWorkspace(threads), [threads])

  /**
   * 当前任务所在的工作空间分组自动展开。
   *
   * 分组折叠起来之后，任务在侧边栏里就看不见了，而主界面还开着它——所以
   * 切到某个任务时把它的分组打开。用 ref 记住「已经为哪个任务展开过」，
   * 否则每来一条消息（threads 数组会变）都会把用户手动折叠的分组重新弹开。
   */
  const expandedFor = useRef<string | null>(null)
  useEffect(() => {
    if (!activeThreadId || expandedFor.current === activeThreadId) return
    const thread = threads.find((item) => item.thread_id === activeThreadId)
    // threads 还没加载好就先不动——threads 变化会让这个 effect 再跑一遍
    if (!thread) return
    expandedFor.current = activeThreadId
    expandWorkspaceGroup(workspaceKeyOf(thread))
  }, [activeThreadId, threads, expandWorkspaceGroup])

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

      {/* 任务列表：按工作空间分二级目录（一级 = 工作空间，二级 = 该目录下的任务）*/}
      {!collapsed && (
        <div className="min-h-0 flex-1 overflow-y-auto scrollbar-slim px-3">
          {groups.length === 0 ? (
            <p className="px-1 py-2 text-xs text-fg-muted">还没有任务</p>
          ) : (
            <div className="space-y-0.5">
              <p className="px-2.5 pb-1 text-[11px] uppercase tracking-wide text-fg-muted">任务列表</p>
              {groups.map((group) => (
                <WorkspaceGroupItem
                  key={group.key || '__default__'}
                  group={group}
                  expanded={!collapsedWorkspaces.includes(group.key)}
                  titles={titles}
                  activeThreadId={activeThreadId}
                  onToggle={() => toggleWorkspaceGroup(group.key)}
                  onSelect={onSelect}
                  onDelete={(id) => void deleteThread(id)}
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
