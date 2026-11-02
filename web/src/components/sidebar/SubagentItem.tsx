/**
 * 子 agent 会话条目（左侧栏第三层）。
 *
 * 一条 task 工具调用 = 一个子 agent 会话。挂在它所属的主会话下面，
 * 点开就是那份 transcript（跟主会话里 task 卡片展开看到的是同一份）。
 */
import { MessageSquare } from 'lucide-react'
import type { SubagentSession } from '../../api/types'
import { cn } from '../../lib/cn'

interface Props {
  session: SubagentSession
  /** 所属主会话的 id */
  threadId: string
  /** 所属主会话当前是不是展开的 */
  active: boolean
  /** 点开子 agent 会话 */
  onSelect: (threadId: string, toolCallId: string) => void
}

export function SubagentItem({ session, threadId, active, onSelect }: Props) {
  return (
    <button
      type="button"
      onClick={() => onSelect(threadId, session.tool_call_id)}
      title={session.description ?? session.agent}
      className={cn(
        'flex w-full items-center gap-2 rounded-md py-1.5 pl-2.5 pr-2 text-left text-[13px] transition-colors',
        active ? 'bg-raised text-fg' : 'text-fg-muted hover:bg-raised hover:text-fg',
      )}
    >
      <MessageSquare className="size-3.5 shrink-0 opacity-70" />
      <span className="shrink-0 font-mono text-[11px]">{session.agent}</span>
      <span className="min-w-0 flex-1 truncate text-[11px] opacity-70">
        {session.description ?? `${session.messages.length} 条消息`}
      </span>
    </button>
  )
}
