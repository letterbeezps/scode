/**
 * 工具调用卡片头部：图标 + 名称 + 关键参数 + 状态。
 *
 * 展开状态收在 uiStore 里（设计文档 5.2 的 activeToolCallId），
 * 全局只展开一张卡片，消息长了也不会到处支棱着结果面板。
 */
import { createElement } from 'react'
import {
  CheckCircle2,
  ChevronRight,
  CircleDashed,
  FilePen,
  FileText,
  FolderSearch,
  ListTodo,
  Loader2,
  Search,
  Terminal,
  Wrench,
  XCircle,
  type LucideIcon,
} from 'lucide-react'
import type { ToolCall } from '../../../api/types'
import { cn } from '../../../lib/cn'
import { KIND_LABEL, classifyTool, summarizeCall } from '../../../lib/tools'
import type { ToolKind } from '../../../lib/tools'

/**
 * 模块级常量：图标组件的引用必须稳定。
 * 之前写成 `const Icon = ICONS[kind]` 再 `<Icon />`，等于在 render 里新建组件，
 * 每次重渲染都会把子树整个重建。
 */
const ICONS: Record<ToolKind, LucideIcon> = {
  read: FileText,
  write: FilePen,
  search: Search,
  command: Terminal,
  todo: ListTodo,
  task: FolderSearch,
  other: Wrench,
}

interface Props {
  call: ToolCall
  expanded: boolean
  onToggle: () => void
}

function StatusIcon({ status }: { status: string }) {
  switch (status) {
    case 'running':
      return <Loader2 className="size-3.5 animate-spin-slow text-warn" />
    case 'success':
      return <CheckCircle2 className="size-3.5 text-success" />
    case 'error':
      return <XCircle className="size-3.5 text-danger" />
    default:
      return <CircleDashed className="size-3.5 text-fg-muted" />
  }
}

export function ToolCallHeader({ call, expanded, onToggle }: Props) {
  const kind = classifyTool(call.name)
  const summary = summarizeCall(call.name, call.args)

  return (
    <button
      type="button"
      onClick={onToggle}
      aria-expanded={expanded}
      className="flex w-full items-center gap-2 px-3 py-2 text-left transition-colors hover:bg-surface/60"
    >
      <ChevronRight
        className={cn('size-3.5 shrink-0 text-fg-muted transition-transform', expanded && 'rotate-90')}
      />
      {createElement(ICONS[kind], { className: 'size-4 shrink-0 text-fg-muted' })}
      <span className="shrink-0 font-mono text-xs font-medium text-fg">{call.name}</span>
      <span className="hidden shrink-0 rounded bg-surface px-1.5 py-0.5 text-[10px] text-fg-muted sm:inline">
        {KIND_LABEL[kind]}
      </span>

      {summary && (
        <span className="min-w-0 flex-1 truncate font-mono text-[11px] text-fg-muted">{summary}</span>
      )}

      <span className="ml-auto shrink-0" title={`状态：${call.status}`}>
        <StatusIcon status={call.status} />
      </span>
    </button>
  )
}
