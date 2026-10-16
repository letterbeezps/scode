/**
 * Markdown 渲染（前端设计文档 2：react-markdown + remark-gfm）。
 *
 * 代码围栏统一交给 CodeBlock。围栏信息串支持 ```lang:path，
 * 这样模型在输出里带上 ```python:src/app.py 就能直接把文件名显示在代码块上。
 */
import ReactMarkdown from 'react-markdown'
import remarkGfm from 'remark-gfm'
import { CodeBlock } from './CodeBlock'
import { cn } from '../../../lib/cn'

function fenceInfo(raw: unknown): { lang: string; title?: string } {
  const info = typeof raw === 'string' ? raw.trim() : ''
  if (!info) return { lang: 'text' }
  const [lang, ...rest] = info.split(/\s+/)
  const title = rest.join(' ') || undefined
  return { lang: lang || 'text', title }
}

export function MarkdownContent({
  content,
  className,
}: {
  content: string
  className?: string
}) {
  return (
    <div className={cn('markdown-body text-[14px] leading-7 text-fg', className)}>
      <ReactMarkdown
        remarkPlugins={[remarkGfm]}
        components={{
          pre({ children }) {
            // 渲染逻辑已下沉到 code，这里返回 null 避免多套一层 <pre>
            return <>{children}</>
          },
          code({ className: codeClass, children, ...rest }) {
            const raw = String(children ?? '')

            // 围栏代码：react-markdown 会在外层 pre 里塞一个带 language-xxx 的 code
            const isBlock = /language-(\w+)/.test(codeClass ?? '')
            if (!isBlock) {
              return (
                <code
                  className="rounded bg-surface px-1.5 py-0.5 font-mono text-[13px] text-accent"
                  {...rest}
                >
                  {children}
                </code>
              )
            }

            const match = /language-(\S+)/.exec(codeClass ?? '')
            const info = fenceInfo(match?.[1])
            return <CodeBlock code={raw.replace(/\n$/, '')} lang={info.lang} title={info.title} />
          },
          ul(props) {
            return <ul className="my-2 list-disc space-y-1 pl-5" {...props} />
          },
          ol(props) {
            return <ol className="my-2 list-decimal space-y-1 pl-5" {...props} />
          },
          h1(props) {
            return <h1 className="mb-2 mt-4 text-xl font-semibold" {...props} />
          },
          h2(props) {
            return <h2 className="mb-2 mt-4 text-lg font-semibold" {...props} />
          },
          h3(props) {
            return <h3 className="mb-1.5 mt-3 text-base font-semibold" {...props} />
          },
          p(props) {
            return <p className="my-2 first:mt-0 last:mb-0" {...props} />
          },
          blockquote(props) {
            return (
              <blockquote
                className="my-2 border-l-2 border-line pl-3 text-fg-muted"
                {...props}
              />
            )
          },
          hr() {
            return <hr className="my-4 border-line" />
          },
        }}
      >
        {content}
      </ReactMarkdown>
    </div>
  )
}
