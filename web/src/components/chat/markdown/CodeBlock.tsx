/**
 * 代码块：语言标签 + 一键复制 + Shiki 高亮（前端设计文档 4.1）。
 *
 * 高亮是异步的，所以先渲染转义后的纯文本骨架，再原地替换为高亮结果；
 * 语言不支持时保持纯文本，不做二次降级。
 */
import { useEffect, useRef, useState } from 'react'
import { Check, Copy } from 'lucide-react'
import { cn } from '../../../lib/cn'
import { escapeHtml, highlightCode } from '../../../lib/highlight'
import { useIsDark } from '../../../store/uiStore'

interface Props {
  code: string
  lang?: string
  /** markdown 里用 ```lang:path 形式带出的文件名 */
  title?: string
  className?: string
}

export function CodeBlock({ code, lang, title, className }: Props) {
  const dark = useIsDark()
  const [html, setHtml] = useState<string | null>(null)
  const [copied, setCopied] = useState(false)
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null)

  useEffect(() => {
    let alive = true
    // 主题切换要重新高亮，否则配色对不上
    highlightCode(code, lang ?? 'text', dark).then((result) => {
      if (alive) setHtml(result)
    })
    return () => {
      alive = false
    }
  }, [code, lang, dark])

  useEffect(
    () => () => {
      if (timer.current) clearTimeout(timer.current)
    },
    [],
  )

  const copy = async () => {
    try {
      await navigator.clipboard.writeText(code)
      setCopied(true)
      if (timer.current) clearTimeout(timer.current)
      timer.current = setTimeout(() => setCopied(false), 1600)
    } catch {
      // 非安全上下文下 clipboard 不可用，忽略即可
    }
  }

  return (
    <div
      className={cn(
        'group/code my-3 overflow-hidden rounded-lg border border-line bg-surface',
        className,
      )}
    >
      <div className="flex items-center gap-2 border-b border-line px-3 py-1.5">
        {title && <span className="truncate font-mono text-[11px] text-fg-muted">{title}</span>}
        <span className="text-[11px] uppercase tracking-wide text-fg-muted">{lang ?? 'text'}</span>
        <button
          type="button"
          onClick={copy}
          aria-label="复制代码"
          className="ml-auto rounded p-1 text-fg-muted opacity-0 transition-opacity hover:text-fg focus-visible:opacity-100 group-hover/code:opacity-100"
        >
          {copied ? <Check className="size-3.5 text-success" /> : <Copy className="size-3.5" />}
        </button>
      </div>

      <div className="scrollbar-slim overflow-x-auto px-3.5 py-3 text-[13px] leading-relaxed">
        {html ? (
          <div
            // Shiki 自身生成的高亮 HTML；原始文本已在词法分析阶段转义
            dangerouslySetInnerHTML={{ __html: html }}
          />
        ) : (
          <pre
            className="font-mono"
            dangerouslySetInnerHTML={{ __html: escapeHtml(code) }}
          />
        )}
      </div>
    </div>
  )
}
