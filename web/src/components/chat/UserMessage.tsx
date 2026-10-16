import type { Message } from '../../api/types'
import { MarkdownContent } from './markdown/MarkdownContent'

export function UserMessage({ message }: { message: Message }) {
  return (
    <div className="animate-fade-up flex justify-end px-4 py-3">
      <div className="max-w-[85%] rounded-lg bg-bubble px-4 py-2.5 text-white">
        <MarkdownContent
          content={message.content}
          className="text-[14px] leading-7 text-white [&_a]:text-white [&_code]:bg-white/15 [&_code]:text-white"
        />
      </div>
    </div>
  )
}
