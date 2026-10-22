/**
 * 待人工确认的动作组。
 *
 * 后端在 HITL 上挂起时（`stupid_code/graph/permissions.py`），图把要执行的动作
 * 发过来；用户点「批准」或「拒绝」，前端用 `command.resume` 把决定送回去，
 * 图才从挂起点继续跑。
 *
 * 卡片在助手消息里占一段（parts 里的 approval 段），所以它出现在"模型说要
 * 干什么"和"结果出来"之间，顺序读下来是对的。
 *
 * **一次挂起可能含多条命令**（模型一轮里发了多个 execute 调用）：框架要求
 * resume 的 decision 数量与 action_requests 一样多，所以这里渲染的是一整组，
 * 批准/拒绝也是整组一起决定。
 */
import { Check, ShieldAlert, X } from 'lucide-react'
import type { ApprovalRequest } from '../../api/types'
import { cn } from '../../lib/cn'
import { commandOf } from '../../lib/tools'
import { useConversationStore } from '../../store/conversationStore'

interface Props {
  id: string
  requests: ApprovalRequest[]
  status: 'pending' | 'approved' | 'rejected'
}

export function ApprovalCard({ id, requests, status }: Props) {
  const pendingId = useConversationStore((s) => s.pendingApproval?.id)
  const decideApproval = useConversationStore((s) => s.decideApproval)

  // 只有当前待确认的那张卡能点：避免历史卡片上的按钮还能被点到
  const actionable = status === 'pending' && pendingId === id

  return (
    <div
      className={cn(
        'my-2 overflow-hidden rounded-lg border bg-bg',
        actionable ? 'border-warn/50' : 'border-line',
      )}
    >
      <div className="flex items-center gap-2 px-3 py-2">
        {status === 'approved' ? (
          <Check className="size-3.5 text-success" />
        ) : status === 'rejected' ? (
          <X className="size-3.5 text-danger" />
        ) : (
          <ShieldAlert className="size-3.5 text-warn" />
        )}
        <span className="text-xs font-medium text-fg">
          {status === 'approved'
            ? '已批准执行'
            : status === 'rejected'
              ? '已拒绝执行'
              : requests.length > 1
                ? `等待确认（${requests.length} 条命令）`
                : '等待确认'}
        </span>
        <span className="ml-auto font-mono text-[11px] text-fg-muted">
          {requests.map((r) => r.name).join(', ')}
        </span>
      </div>

      {requests.map((request, index) => {
        const command = commandOf(request.args) ?? ''
        return (
          <div key={`${id}-${index}`}>
            {command && (
              <pre className="scrollbar-slim max-h-40 overflow-auto border-t border-line bg-surface px-3 py-2 font-mono text-[11px] leading-relaxed text-fg">
                {command}
              </pre>
            )}
            {request.description && (
              <p className="whitespace-pre-line border-t border-line px-3 py-2 text-[11px] leading-relaxed text-fg-muted">
                {request.description}
              </p>
            )}
          </div>
        )
      })}

      {actionable && (
        <div className="flex gap-2 border-t border-line px-3 py-2">
          <button
            type="button"
            onClick={() => decideApproval('approve')}
            className={cn(
              'flex items-center gap-1 rounded-md border border-success/40 bg-success/10 px-2.5 py-1',
              'text-[11px] font-medium text-success transition-colors hover:bg-success/20',
            )}
          >
            <Check className="size-3" />
            批准
          </button>
          <button
            type="button"
            onClick={() => decideApproval('reject')}
            className={cn(
              'flex items-center gap-1 rounded-md border border-danger/40 bg-danger/10 px-2.5 py-1',
              'text-[11px] font-medium text-danger transition-colors hover:bg-danger/20',
            )}
          >
            <X className="size-3" />
            拒绝
          </button>
        </div>
      )}
    </div>
  )
}
