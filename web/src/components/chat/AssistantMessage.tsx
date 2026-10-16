/**
 * 助手消息：按顺序渲染「文本 + 工具调用」混合的有序片段。
 *
 * 顺序来自 Message.parts，而不是把 content 和 tool_calls 平铺渲染——
 * 模型是先说一段话、再调工具、再接着说，这样才读得下去。
 */
import { Ban } from 'lucide-react'
import type { Message } from '../../api/types'
import { MarkdownContent } from './markdown/MarkdownContent'
import { ToolCallCard } from './tools/ToolCallCard'
import { CodeBlock } from './markdown/CodeBlock'

interface Props {
  message: Message
  /** 流式生成中，最后一个文本片段后面挂闪烁光标 */
  streaming?: boolean
}

export function AssistantMessage({ message, streaming }: Props) {
  const lastIndex = message.parts.length - 1

  return (
    <div className="animate-fade-up px-4 py-3">
      <div className="rounded-lg border border-line bg-raised px-4 py-3">
        {message.parts.length === 0 && !streaming && !message.error && (
          <p className="text-sm text-fg-muted">（无内容）</p>
        )}

        {message.parts.map((part, index) => {
          if (part.kind === 'text') {
            if (!part.text) return null
            const isLast = index === lastIndex
            return (
              <div key={index} className={isLast && streaming ? 'after:animate-blink after:ml-0.5 after:inline-block after:h-4 after:w-[2px] after:translate-y-0.5 after:bg-accent after:content-[""]' : undefined}>
                <MarkdownContent content={part.text} />
              </div>
            )
          }
          return <ToolCallCard key={`tool-${part.call.id}`} call={part.call} />
        })}

        {streaming && message.parts.length === 0 && (
          <p className="flex items-center gap-2 text-sm text-fg-muted">
            <span className="size-1.5 animate-blink rounded-full bg-accent" />
            正在思考…
          </p>
        )}

        {message.error && (
          <div className="mt-2 rounded-md border border-danger/40 bg-danger/10 px-3 py-2">
            <p className="mb-1 text-[11px] font-medium text-danger">运行出错</p>
            <CodeBlock code={message.error} lang="text" className="my-0 border-0 bg-transparent p-0" />
          </div>
        )}

        {message.interrupted && (
          <p className="mt-2 flex items-center gap-1.5 text-[11px] text-fg-muted">
            <Ban className="size-3" />
            已被手动停止
          </p>
        )}
      </div>
    </div>
  )
}
