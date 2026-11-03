/**
 * 验收标准选择器（rubric）。
 *
 * 任务级参数：写进 taskStore（跟 workspace / permissions / skills 同一份），
 * 发送时由 api/run.ts 放进 run 的 **input**（非空设置 / 空串清除，语义见
 * 那里的注释）。UI 所见即所是——显示「验收已开」就是真在验，清空就是真关了。
 *
 * 面板就是一个 textarea + 保存/清除。标准怎么写由用户自己决定，这里只给
 * 一句提示：写成可逐条核验的句子（grader 是按 criterion 拆开逐条打分的）。
 */
import { useState } from 'react'
import { CheckCircle2, ClipboardCheck, X } from 'lucide-react'
import { cn } from '../../lib/cn'
import { useTaskSettings, useTaskStore } from '../../store/taskStore'

interface Props {
  threadId: string | null
  disabled?: boolean
}

export function RubricPicker({ threadId, disabled }: Props) {
  const { rubric } = useTaskSettings(threadId)
  const update = useTaskStore((s) => s.update)

  const [open, setOpen] = useState(false)
  /** 面板里的草稿：确认才落到 store，Esc / 点外面直接丢掉 */
  const [draft, setDraft] = useState('')

  /** 打开时把当前值播种进草稿（在事件里做，别放 effect——那会触发
   * set-state-in-effect）。每次打开都重新播种，丢弃上次没保存的编辑。 */
  const toggle = () => {
    setOpen((prev) => {
      if (!prev) setDraft(rubric)
      return !prev
    })
  }

  const apply = () => {
    update(threadId, { rubric: draft.trim() })
    setOpen(false)
  }

  const clear = () => {
    setDraft('')
    update(threadId, { rubric: '' })
    setOpen(false)
  }

  return (
    <div className="relative flex items-center">
      <button
        type="button"
        onClick={toggle}
        disabled={disabled}
        title={rubric ? `验收标准：${rubric}` : '设置任务验收标准（回答交付前逐条核验，不过自动返工）'}
        className={cn(
          'flex items-center gap-1.5 rounded-md border px-2 py-1.5 text-[11px] transition-colors',
          'disabled:cursor-not-allowed disabled:opacity-50',
          rubric
            ? 'border-line bg-surface text-fg hover:border-accent/60'
            : 'border-dashed border-line bg-surface text-fg-muted hover:border-accent/60 hover:text-fg',
        )}
      >
        {rubric ? (
          <CheckCircle2 className="size-3.5 shrink-0 text-accent" />
        ) : (
          <ClipboardCheck className="size-3.5 shrink-0" />
        )}
        {rubric ? '验收已开' : '验收'}
      </button>

      {open && (
        <>
          <div className="fixed inset-0 z-40" onClick={() => setOpen(false)} aria-hidden />
          <div
            role="dialog"
            aria-label="任务验收标准"
            className="absolute bottom-full left-0 z-50 mb-2 flex w-[30rem] max-w-[calc(100vw-2rem)] flex-col overflow-hidden rounded-lg border border-line bg-surface shadow-xl"
          >
            <div className="border-b border-line px-3 py-2">
              <p className="text-[12px] font-medium text-fg">任务验收标准</p>
              <p className="mt-0.5 text-[11px] leading-4 text-fg-muted">
                设置后，每次回答交付前会由独立的评审 agent 按这里的标准逐条核验，
                不通过自动返工（最多 3 轮）。清空即关闭。
              </p>
            </div>

            <textarea
              autoFocus
              value={draft}
              onChange={(e) => setDraft(e.target.value)}
              onKeyDown={(e) => {
                // Ctrl/⌘+Enter 直接保存；普通 Enter 留给换行（标准往往是多行列表）
                if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) {
                  e.preventDefault()
                  apply()
                }
              }}
              rows={5}
              placeholder={'例如：\n1. 所有公开函数有类型注解\n2. 测试全部通过\n3. 改动不扩散到任务之外的文件'}
              spellCheck={false}
              className="m-2 min-h-[96px] resize-y rounded-md border border-line bg-raised px-2 py-1.5 text-[12px] leading-5 text-fg outline-none placeholder:text-fg-muted focus:border-accent/60"
            />

            <div className="flex items-center gap-2 border-t border-line px-2 py-1.5">
              <button
                type="button"
                onClick={clear}
                disabled={!rubric && !draft.trim()}
                className="flex shrink-0 items-center gap-1 rounded-md px-2 py-1.5 text-[11px] text-fg-muted transition-colors hover:bg-raised hover:text-fg disabled:opacity-40"
              >
                <X className="size-3" />
                清除
              </button>
              <span className="min-w-0 flex-1" />
              <button
                type="button"
                onClick={apply}
                className="shrink-0 rounded-md bg-accent px-2.5 py-1.5 text-[11px] font-medium text-bg transition-opacity hover:opacity-90"
              >
                保存
              </button>
            </div>
          </div>
        </>
      )}
    </div>
  )
}
