/**
 * 工具调用卡片（前端设计文档 4.1）。
 *
 * 结果默认折叠；文件编辑类工具即使折叠也会显示一行「改了什么」的摘要，
 * 否则一条全是 write_file 的消息会安静到看不出发生过什么。
 */
import type { ToolCall } from '../../../api/types'
import { cn } from '../../../lib/cn'
import { filePathOf } from '../../../lib/tools'
import { useUIStore } from '../../../store/uiStore'
import { ToolCallHeader } from './ToolCallHeader'
import { ToolCallResult } from './ToolCallResult'

interface Props {
  call: ToolCall
}

export function ToolCallCard({ call }: Props) {
  const activeToolCallId = useUIStore((s) => s.activeToolCallId)
  const setActiveToolCall = useUIStore((s) => s.setActiveToolCall)
  const expanded = activeToolCallId === call.id

  return (
    <div
      // 侧边栏 todo 点击后按这个 id 定位过来
      id={`tool-${call.id}`}
      className={cn(
        'my-2 overflow-hidden rounded-lg border bg-bg transition-colors scroll-mt-4',
        expanded ? 'border-accent/50' : 'border-line',
      )}
    >
      <ToolCallHeader
        call={call}
        expanded={expanded}
        onToggle={() => setActiveToolCall(call.id)}
      />

      {collapsedHint(call) && !expanded && (
        <p className="truncate border-t border-line px-3 py-1.5 font-mono text-[11px] text-fg-muted">
          {collapsedHint(call)}
        </p>
      )}

      {expanded && (
        <div className="border-t border-line p-3">
          <ArgsBlock args={call.args} />
          <div className="mt-2">
            <ToolCallResult call={call} />
          </div>
        </div>
      )}
    </div>
  )
}

/** 折叠态下的一行摘要 */
function collapsedHint(call: ToolCall): string {
  const path = filePathOf(call.args)
  if (call.status === 'error') return call.error ?? '执行失败'
  if (path) return path
  return call.result?.output?.split('\n')[0] ?? ''
}

/** 原始参数，方便排查「Agent 到底传了什么」 */
function ArgsBlock({ args }: { args: Record<string, unknown> }) {
  const entries = Object.entries(args)
  if (entries.length === 0) return null

  return (
    <details className="mb-2">
      <summary className="cursor-pointer text-[11px] text-fg-muted select-none hover:text-fg">
        工具参数
      </summary>
      <pre className="scrollbar-slim mt-1.5 max-h-56 overflow-auto rounded bg-surface px-3 py-2 font-mono text-[11px] leading-relaxed text-fg-muted">
        {JSON.stringify(args, null, 2)}
      </pre>
    </details>
  )
}
