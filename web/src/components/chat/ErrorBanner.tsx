/**
 * 全局错误提示条。
 *
 * 抽成独立组件是因为它不能只挂在 MessageList 上：会话为空时
 * （首次打开、或 URL 指向的会话已被删除）MessageList 根本不渲染，
 * 错误会跟着一起消失，用户只看到一片空白。
 */
import { TriangleAlert } from 'lucide-react'

interface Props {
  error: string | null
  onDismiss: () => void
}

export function ErrorBanner({ error, onDismiss }: Props) {
  if (!error) return null

  return (
    <div className="absolute inset-x-0 top-0 z-10 flex justify-center px-4 pt-3">
      <div className="flex items-start gap-2 rounded-md border border-danger/40 bg-danger/10 px-3 py-2 text-xs text-danger">
        <TriangleAlert className="mt-0.5 size-3.5 shrink-0" />
        <span className="max-w-lg break-words">{error}</span>
        <button type="button" onClick={onDismiss} className="shrink-0 underline underline-offset-2">
          知道了
        </button>
      </div>
    </div>
  )
}
