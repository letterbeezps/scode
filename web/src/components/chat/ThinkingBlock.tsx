/**
 * 思考过程块：把模型的 thinking 内容折叠展示。
 *
 * 思考内容来自模型的 reasoning（Anthropic 的 thinking 块），
 * 后端开了思考预算（conf/config.toml 的 [models.thinking]）才会有。
 *
 * 展开策略：流式生成中默认展开——能看着它一段段长出来；
 * 这一轮结束后收起，正文才读得下去。想再看就点一下标题行。
 */
import { useState } from 'react'
import { Brain, ChevronRight } from 'lucide-react'
import { cn } from '../../lib/cn'

interface Props {
  text: string
  /** 流式生成中：默认展开 */
  streaming?: boolean
}

export function ThinkingBlock({ text, streaming }: Props) {
  const [expanded, setExpanded] = useState(streaming ?? false)

  if (!text) return null

  return (
    <div className="my-2 overflow-hidden rounded-lg border border-line bg-surface/60">
      <button
        type="button"
        onClick={() => setExpanded((value) => !value)}
        aria-expanded={expanded}
        className="flex w-full items-center gap-2 px-3 py-1.5 text-left transition-colors hover:bg-surface"
      >
        <ChevronRight
          className={cn(
            'size-3.5 shrink-0 text-fg-muted transition-transform',
            expanded && 'rotate-90',
          )}
        />
        <Brain className="size-3.5 shrink-0 text-fg-muted" />
        <span className="text-xs text-fg-muted">思考过程</span>
        <span className="ml-auto shrink-0 text-[10px] text-fg-muted">{text.length} 字</span>
      </button>

      {expanded && (
        <div className="scrollbar-slim max-h-96 overflow-auto border-t border-line px-3 py-2 text-xs leading-relaxed whitespace-pre-wrap text-fg-muted">
          {text}
        </div>
      )}
    </div>
  )
}
