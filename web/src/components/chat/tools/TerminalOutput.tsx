/**
 * 终端风格输出（前端设计文档 7.2：命令类工具用终端样式展示）。
 */
import { cn } from '../../../lib/cn'

interface Props {
  command?: string
  output: string
  status: string
  className?: string
}

export function TerminalOutput({ command, output, status, className }: Props) {
  return (
    <div
      className={cn(
        'overflow-hidden rounded-md border border-line bg-black/40 font-mono text-xs',
        className,
      )}
    >
      {command && (
        <div className="flex items-center gap-1.5 border-b border-line/60 px-3 py-1.5 text-fg-muted">
          <span className="select-none text-success">$</span>
          <span className="min-w-0 flex-1 break-all">{command}</span>
        </div>
      )}
      <pre
        className={cn(
          'scrollbar-slim max-h-96 overflow-auto px-3 py-2 leading-relaxed',
          status === 'error' ? 'text-danger' : 'text-fg',
        )}
      >
        {output || (status === 'running' ? '运行中…' : '（无输出）')}
      </pre>
    </div>
  )
}
