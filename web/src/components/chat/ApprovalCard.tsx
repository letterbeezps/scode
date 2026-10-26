/**
 * 待人工确认的动作组。
 *
 * 后端在 HITL 上挂起时（`stupid_code/graph/permissions.py`），图把要执行的动作
 * 发过来；用户点「提交决定」后，前端用 `command.resume` 把决定送回去，
 * 图才从挂起点继续跑。
 *
 * 卡片在助手消息里占一段（parts 里的 approval 段），所以它出现在"模型说要
 * 干什么"和"结果出来"之间，顺序读下来是对的。
 *
 * **一次挂起可能含多条命令**（模型一轮里发了多个 execute 调用）：框架要求
 * resume 的 decision 数量与 action_requests 一样多，所以这里渲染的是一整组，
 * 决定也是每条一个。
 *
 * 每条动作可以单独选：
 * - 批准：原样执行
 * - 拒绝：不执行，理由（可选）会作为 `message` 传给模型
 * - 改后执行：把命令改成文本框里的内容再执行（`edit` 决策）
 *
 * 「改后执行」是给「命令基本对、就是差个参数」的场景用的：不用「拒绝 →
 * 模型重写 → 再问」地绕一圈。
 */
import { useState } from 'react'
import { Check, Pencil, ShieldAlert, X } from 'lucide-react'
import type { ApprovalDecision, ApprovalRequest } from '../../api/types'
import { cn } from '../../lib/cn'
import { commandOf } from '../../lib/tools'
import { useConversationStore } from '../../store/conversationStore'

interface Props {
  id: string
  requests: ApprovalRequest[]
  status: 'pending' | 'approved' | 'rejected' | 'edited'
}

type Choice = 'approve' | 'reject' | 'edit'

/** 这条动作允许哪些决定（后端给的 allowed_decisions）。没给就按最保守的来。 */
function allowedOf(request: ApprovalRequest): Choice[] {
  const allowed = request.allowedDecisions
  if (!allowed || allowed.length === 0) return ['approve', 'reject']
  return allowed.filter((d): d is Choice => d === 'approve' || d === 'reject' || d === 'edit')
}

/**
 * 从动作参数里取出「可以改的那个文本」：命令或路径。
 *
 * 按工具名判断而不是靠参数里有没有 command —— `execute` 的命令为空时也该
 * 给一个输入框（用户可以自己敲一条）。
 */
function editableText(request: ApprovalRequest): { key: string; value: string } | null {
  if (request.name === 'execute') {
    const command = request.args['command']
    return { key: 'command', value: typeof command === 'string' ? command : '' }
  }
  const command = commandOf(request.args)
  if (command !== null) return { key: 'command', value: command }
  const path = request.args['file_path']
  if (typeof path === 'string') return { key: 'file_path', value: path }
  return null
}

export function ApprovalCard({ id, requests, status }: Props) {
  const pendingId = useConversationStore((s) => s.pendingApproval?.id)
  const decideApproval = useConversationStore((s) => s.decideApproval)

  // 只有当前待确认的那张卡能点：避免历史卡片上的按钮还能被点到
  const actionable = status === 'pending' && pendingId === id

  // 每条动作的选择 + 改写后的内容。默认全批准——用户看一眼命令点提交就行。
  const [choices, setChoices] = useState<Choice[]>(() => requests.map(() => 'approve'))
  const [drafts, setDrafts] = useState<string[]>(() =>
    requests.map((r) => editableText(r)?.value ?? ''),
  )
  const [reason, setReason] = useState('')

  const setChoice = (index: number, choice: Choice) => {
    setChoices((prev) => prev.map((c, i) => (i === index ? choice : c)))
  }

  const submit = () => {
    const decisions: ApprovalDecision[] = requests.map((request, index) => {
      const choice = choices[index] ?? 'approve'
      if (choice === 'reject') {
        return reason.trim() ? { type: 'reject', message: reason.trim() } : { type: 'reject' }
      }
      if (choice === 'edit') {
        const editable = editableText(request)
        const args = { ...request.args }
        if (editable) args[editable.key] = drafts[index] ?? editable.value
        return { type: 'edit', edited_action: { name: request.name, args } }
      }
      return { type: 'approve' }
    })
    decideApproval(decisions)
  }

  const hasEdit = requests.some((r) => allowedOf(r).includes('edit'))
  const allApproved = choices.every((c) => c === 'approve')

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
        ) : status === 'edited' ? (
          <Pencil className="size-3.5 text-warn" />
        ) : (
          <ShieldAlert className="size-3.5 text-warn" />
        )}
        <span className="text-xs font-medium text-fg">
          {status === 'approved'
            ? '已批准执行'
            : status === 'rejected'
              ? '已拒绝执行'
              : status === 'edited'
                ? '已修改后执行'
                : requests.length > 1
                  ? `等待确认（${requests.length} 条命令）`
                  : '等待确认'}
        </span>
        <span className="ml-auto font-mono text-[11px] text-fg-muted">
          {requests.map((r) => r.name).join(', ')}
        </span>
      </div>

      {requests.map((request, index) => {
        const editable = editableText(request)
        const allowed = allowedOf(request)
        const choice = choices[index] ?? 'approve'
        return (
          <div key={`${id}-${index}`}>
            {editable && (
              <textarea
                value={drafts[index] ?? ''}
                onChange={(e) =>
                  setDrafts((prev) => prev.map((d, i) => (i === index ? e.target.value : d)))
                }
                readOnly={!actionable}
                spellCheck={false}
                rows={2}
                className="scrollbar-slim max-h-40 w-full resize-y border-t border-line bg-surface px-3 py-2 font-mono text-[11px] leading-relaxed text-fg outline-none focus:bg-bg"
              />
            )}
            {request.description && (
              <p className="whitespace-pre-line border-t border-line px-3 py-2 text-[11px] leading-relaxed text-fg-muted">
                {request.description}
              </p>
            )}
            {actionable && (
              <div className="flex gap-1.5 border-t border-line px-3 py-1.5">
                {allowed.includes('approve') && (
                  <ChoiceButton
                    active={choice === 'approve'}
                    tone="success"
                    onClick={() => setChoice(index, 'approve')}
                  >
                    <Check className="size-3" />
                    批准
                  </ChoiceButton>
                )}
                {allowed.includes('reject') && (
                  <ChoiceButton
                    active={choice === 'reject'}
                    tone="danger"
                    onClick={() => setChoice(index, 'reject')}
                  >
                    <X className="size-3" />
                    拒绝
                  </ChoiceButton>
                )}
                {allowed.includes('edit') && (
                  <ChoiceButton
                    active={choice === 'edit'}
                    tone="warn"
                    onClick={() => setChoice(index, 'edit')}
                  >
                    <Pencil className="size-3" />
                    改后执行
                  </ChoiceButton>
                )}
              </div>
            )}
          </div>
        )
      })}

      {actionable && (
        <div className="border-t border-line px-3 py-2">
          {choices.some((c) => c === 'reject') && (
            <input
              value={reason}
              onChange={(e) => setReason(e.target.value)}
              placeholder="拒绝理由（可选，会作为 message 告诉模型为什么）"
              className="mb-2 w-full rounded-md border border-line bg-surface px-2 py-1 text-[11px] text-fg outline-none placeholder:text-fg-muted focus:border-warn/50"
            />
          )}
          <div className="flex justify-end">
            <button
              type="button"
              onClick={submit}
              className={cn(
                'flex items-center gap-1 rounded-md border px-2.5 py-1',
                'text-[11px] font-medium transition-colors',
                allApproved
                  ? 'border-success/40 bg-success/10 text-success hover:bg-success/20'
                  : 'border-warn/40 bg-warn/10 text-warn hover:bg-warn/20',
              )}
            >
              {allApproved ? <Check className="size-3" /> : <ShieldAlert className="size-3" />}
              {allApproved ? '批准并执行' : '提交决定'}
            </button>
          </div>
          {hasEdit && (
            <p className="mt-1.5 text-right text-[10px] text-fg-muted">
              改后执行会把文本框里的内容当作新命令
            </p>
          )}
        </div>
      )}
    </div>
  )
}

function ChoiceButton({
  active,
  tone,
  onClick,
  children,
}: {
  active: boolean
  tone: 'success' | 'danger' | 'warn'
  onClick: () => void
  children: React.ReactNode
}) {
  const toneClass = {
    success: 'border-success/40 bg-success/10 text-success hover:bg-success/20',
    danger: 'border-danger/40 bg-danger/10 text-danger hover:bg-danger/20',
    warn: 'border-warn/40 bg-warn/10 text-warn hover:bg-warn/20',
  }[tone]
  return (
    <button
      type="button"
      onClick={onClick}
      className={cn(
        'flex items-center gap-1 rounded-md border px-2 py-0.5 text-[11px] font-medium transition-colors',
        active ? toneClass : 'border-line bg-surface text-fg-muted hover:text-fg',
      )}
    >
      {children}
    </button>
  )
}
