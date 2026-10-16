/**
 * 工具调用结果区（前端设计文档 7.2）。
 *
 * 按工具类型差异化展示：
 *   read_file  → 文件路径 + 内容预览
 *   write/edit → 彩色 Diff
 *   bash 等    → 终端输出
 *   grep/glob  → 结果列表
 */
import { useState } from 'react'
import { ChevronDown } from 'lucide-react'
import type { ToolCall } from '../../../api/types'
import { cn } from '../../../lib/cn'
import { classifyTool, commandOf, filePathOf } from '../../../lib/tools'
import { FileDiff } from './FileDiff'
import { TerminalOutput } from './TerminalOutput'

/** 预览超过这个行数就折叠起来 */
const PREVIEW_LINES = 30

export function ToolCallResult({ call }: { call: ToolCall }) {
  const kind = classifyTool(call.name)
  const output = call.result?.output ?? ''
  const filePath = filePathOf(call.args)

  if (call.status === 'running' || call.status === 'pending') {
    return (
      <p className="animate-pulse text-xs text-fg-muted">
        {kind === 'command' ? '命令执行中…' : '执行中…'}
      </p>
    )
  }

  if (call.error) {
    return <p className="rounded-md bg-danger/10 px-3 py-2 font-mono text-xs text-danger">{call.error}</p>
  }

  if (kind === 'command') {
    return <TerminalOutput command={commandOf(call.args) ?? undefined} output={output} status={call.status} />
  }

  // 文件编辑：优先走 Diff
  if (kind === 'write') {
    return (
      <div className="space-y-2">
        <FileDiff call={call} />
        {output && <p className="font-mono text-[11px] text-fg-muted">{output}</p>}
      </div>
    )
  }

  if (kind === 'todo' || kind === 'task') {
    return output ? <p className="text-xs text-fg-muted">{output}</p> : null
  }

  return (
    <div className="space-y-1.5">
      {filePath && <p className="font-mono text-[11px] text-fg-muted">{filePath}</p>}
      <CollapsiblePreview text={output} emptyText="（无输出）" />
    </div>
  )
}

/** 长输出折叠：默认截断，点开看全部 */
function CollapsiblePreview({ text, emptyText }: { text: string; emptyText: string }) {
  const [expanded, setExpanded] = useState(false)
  const lines = text ? text.split('\n') : []

  if (!text) return <p className="text-xs text-fg-muted">{emptyText}</p>

  const truncated = !expanded && lines.length > PREVIEW_LINES
  const shown = truncated ? lines.slice(0, PREVIEW_LINES).join('\n') : text

  return (
    <div className="space-y-1">
      <pre className="scrollbar-slim max-h-80 overflow-auto rounded-md bg-surface px-3 py-2 font-mono text-xs leading-relaxed text-fg">
        {shown}
      </pre>
      {lines.length > PREVIEW_LINES && (
        <button
          type="button"
          onClick={() => setExpanded((v) => !v)}
          className={cn('inline-flex items-center gap-1 text-[11px] text-fg-muted hover:text-fg')}
        >
          <ChevronDown className={cn('size-3 transition-transform', expanded && 'rotate-180')} />
          {expanded ? '收起' : `展开剩余 ${lines.length - PREVIEW_LINES} 行`}
        </button>
      )}
    </div>
  )
}
