/**
 * 侧边栏任务列表（前端设计文档 7.6）。
 *
 * 数据全部由 SSE 的 todos 事件驱动，本组件只负责按状态显示：
 * 待办 ○ / 进行中 ◐ / 已完成 ●。点已完成的条目会跳到对应工具调用
 * （工具卡片的 dom id 就是调用 id）。
 */
import { CheckCircle2, Circle, CircleDashed, Loader2 } from 'lucide-react'
import type { Todo, TodoStatus } from '../../api/types'
import { cn } from '../../lib/cn'
import { useTodosForThread } from '../../store/todoStore'
import { useConversationStore } from '../../store/conversationStore'
import { useUIStore } from '../../store/uiStore'

const ICONS: Record<TodoStatus, typeof Circle> = {
  pending: Circle,
  in_progress: Loader2,
  completed: CheckCircle2,
}

export function TodoItem({ todo }: { todo: Todo }) {
  const Icon = ICONS[todo.status] ?? Circle
  const setActiveToolCall = useUIStore((s) => s.setActiveToolCall)

  const clickable = Boolean(todo.toolCallId)
  const jump = () => {
    if (!todo.toolCallId) return
    setActiveToolCall(todo.toolCallId)
    document
      .getElementById(`tool-${todo.toolCallId}`)
      ?.scrollIntoView({ behavior: 'smooth', block: 'center' })
  }

  return (
    <li className="flex items-start gap-2 py-1 text-xs leading-relaxed">
      <Icon
        className={cn(
          'mt-0.5 size-3.5 shrink-0',
          todo.status === 'completed' && 'text-success',
          todo.status === 'in_progress' && 'animate-spin-slow text-accent',
          todo.status === 'pending' && 'text-fg-muted',
        )}
      />
      <button
        type="button"
        onClick={jump}
        disabled={!clickable}
        className={cn(
          'text-left',
          todo.status === 'completed'
            ? 'text-fg-muted line-through'
            : todo.status === 'in_progress'
              ? 'text-fg'
              : 'text-fg-muted',
          clickable && 'cursor-pointer hover:text-fg',
        )}
      >
        {todo.status === 'in_progress' && todo.activeForm ? todo.activeForm : todo.content}
      </button>
    </li>
  )
}

export function TodoList() {
  const activeThreadId = useConversationStore((s) => s.activeThreadId)
  const todos = useTodosForThread(activeThreadId)

  return (
    <div>
      <p className="flex items-center gap-1.5 pb-1 text-[11px] uppercase tracking-wide text-fg-muted">
        <CircleDashed className="size-3" />
        待办
        {todos.length > 0 && <span className="ml-auto tabular-nums">{todos.length}</span>}
      </p>

      {todos.length === 0 ? (
        <p className="py-1 text-xs text-fg-muted">暂无待办</p>
      ) : (
        <ul>
          {todos.map((todo, index) => (
            <TodoItem key={`${todo.content}-${index}`} todo={todo} />
          ))}
        </ul>
      )}
    </div>
  )
}
