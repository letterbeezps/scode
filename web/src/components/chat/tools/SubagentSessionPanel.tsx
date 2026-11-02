/**
 * 子 agent 的会话过程（内嵌在主会话的 task 工具卡片里）。
 *
 * 主 agent 调 `task` 委派出去之后，子 agent 内部想了什么、做了什么，
 * 全部收在这里——父图只拿得到它最后那句汇报，中间过程原本是看不到的。
 *
 * transcript 由后端写进图状态（`scode_subagent_sessions` 通道），
 * 前端按**父图里那条 task 工具调用的 id**对上号，见
 * `stupid_code/graph/subagent_trace.py`。
 */
import { useState } from 'react'
import { Brain, ChevronRight, MessageSquare, Wrench } from 'lucide-react'
import type { SubagentMessage, SubagentSession } from '../../../api/types'
import { cn } from '../../../lib/cn'

interface Props {
  session: SubagentSession
}

export function SubagentSessionPanel({ session }: Props) {
  const [open, setOpen] = useState(false)

  return (
    <div className="mt-2 overflow-hidden rounded-lg border border-line bg-surface/50">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        aria-expanded={open}
        className="flex w-full items-center gap-2 px-3 py-2 text-left transition-colors hover:bg-surface"
      >
        <ChevronRight
          className={cn('size-3.5 shrink-0 text-fg-muted transition-transform', open && 'rotate-90')}
        />
        <MessageSquare className="size-3.5 shrink-0 text-accent" />
        <span className="shrink-0 font-mono text-[11px] font-medium text-fg">
          子 agent：{session.agent}
        </span>
        <span className="min-w-0 flex-1 truncate text-[11px] text-fg-muted">
          {session.description ?? `${session.messages.length} 条消息`}
        </span>
        <span className="shrink-0 text-[10px] tabular-nums text-fg-muted">
          {session.messages.length} 条
        </span>
      </button>

      {open && (
        <div className="space-y-2 border-t border-line px-3 py-2">
          {session.messages.map((message, index) => (
            <SubagentMessageView key={index} message={message} />
          ))}
        </div>
      )}
    </div>
  )
}

/** 子 agent 的一条消息 */
function SubagentMessageView({ message }: { message: SubagentMessage }) {
  if (message.role === 'user') {
    return (
      <div className="rounded bg-raised/60 px-2.5 py-1.5">
        <p className="mb-0.5 text-[10px] uppercase tracking-wide text-fg-muted">任务</p>
        <p className="whitespace-pre-wrap text-[12px] leading-relaxed text-fg">{message.content}</p>
      </div>
    )
  }

  if (message.role === 'tool') {
    return (
      <div className="rounded border border-line/60 px-2.5 py-1.5">
        <p className="mb-0.5 flex items-center gap-1 text-[10px] uppercase tracking-wide text-fg-muted">
          <Wrench className="size-3" />
          {message.name || 'tool'}
        </p>
        <pre className="scrollbar-slim max-h-40 overflow-auto whitespace-pre-wrap font-mono text-[11px] leading-relaxed text-fg-muted">
          {message.content}
        </pre>
      </div>
    )
  }

  if (message.role === 'ai') {
    return (
      <div className="space-y-1.5">
        {message.thinking && (
          <details className="rounded border border-line/60 px-2.5 py-1.5">
            <summary className="flex cursor-pointer list-none items-center gap-1 text-[10px] uppercase tracking-wide text-fg-muted">
              <Brain className="size-3" />
              思考过程（{message.thinking.length} 字）
            </summary>
            <p className="mt-1.5 max-h-64 overflow-auto whitespace-pre-wrap text-[12px] leading-relaxed text-fg-muted">
              {message.thinking}
            </p>
          </details>
        )}

        {message.content && (
          <div className="rounded bg-raised/60 px-2.5 py-1.5">
            <p className="whitespace-pre-wrap text-[12px] leading-relaxed text-fg">{message.content}</p>
          </div>
        )}

        {message.tool_calls && message.tool_calls.length > 0 && (
          <div className="space-y-1">
            {message.tool_calls.map((call, index) => (
              <div key={call.id || index} className="rounded border border-line/60 px-2.5 py-1.5">
                <p className="mb-0.5 flex items-center gap-1 font-mono text-[10px] text-fg-muted">
                  <Wrench className="size-3" />
                  {call.name}
                </p>
                <pre className="scrollbar-slim max-h-40 overflow-auto whitespace-pre-wrap font-mono text-[11px] leading-relaxed text-fg-muted">
                  {JSON.stringify(call.args, null, 2)}
                </pre>
              </div>
            ))}
          </div>
        )}
      </div>
    )
  }

  return (
    <div className="rounded border border-line/60 px-2.5 py-1.5">
      <p className="whitespace-pre-wrap text-[12px] leading-relaxed text-fg-muted">{message.content}</p>
    </div>
  )
}
