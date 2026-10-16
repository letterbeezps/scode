/**
 * 文件变更 Diff（前端设计文档 7.3）。
 *
 * 用 react-diff-viewer-continued：它自带虚拟滚动、行级高亮和未变更区域折叠，
 * 大文件不会把页面拖垮。
 *
 * 整个组件用 React.lazy 延迟引入：它连带 refractor 的全部语言语法（十几 MB 的
 * 懒加载 chunk）和 emotion，只有真的出现文件改动时才值得下载。
 *
 * 大文件额外截断：diff 计算再快，在几十万行文本上也要跑，
 * 这里在 2000 行处截断，避免把一整个仓库塞进 DOM。
 */
import { Suspense, lazy, useMemo } from 'react'
import { Loader2 } from 'lucide-react'
import type { ToolCall } from '../../../api/types'
import { buildDiffInput } from '../../../lib/diff'
import { useIsDark } from '../../../store/uiStore'

const ReactDiffViewer = lazy(() => import('react-diff-viewer-continued'))

const MAX_LINES = 2000

function DiffSkeleton() {
  return (
    <div className="flex items-center justify-center gap-2 border border-line bg-surface py-8 text-xs text-fg-muted">
      <Loader2 className="size-3.5 animate-spin-slow" />
      正在计算 diff…
    </div>
  )
}

export function FileDiff({ call }: { call: ToolCall }) {
  const dark = useIsDark()
  const input = useMemo(() => buildDiffInput(call), [call])

  if (!input) return null

  const oldLines = input.oldValue.split('\n')
  const newLines = input.newValue.split('\n')
  const truncated = oldLines.length > MAX_LINES || newLines.length > MAX_LINES

  const oldValue = truncated ? oldLines.slice(0, MAX_LINES).join('\n') : input.oldValue
  const newValue = truncated ? newLines.slice(0, MAX_LINES).join('\n') : input.newValue

  return (
    <div className="overflow-hidden rounded-md border border-line">
      <Suspense fallback={<DiffSkeleton />}>
        <ReactDiffViewer
          oldValue={oldValue}
          newValue={newValue}
          splitView={false}
          useDarkTheme={dark}
          // 折叠未变更区域，只看改动附近
          showDiffOnly
          extraLinesSurroundingDiff={3}
          // refractor 语言名，交给 diff 组件自己着色，跟随 useDarkTheme
          highlightLanguage={
            input.language && input.language !== 'text' ? input.language : undefined
          }
          leftTitle={input.fileName ? `${input.fileName}（改动前）` : '改动前'}
          rightTitle={input.fileName ? `${input.fileName}（改动后）` : '改动后'}
          // 让 diff 用本项目的配色，而不是它自带的蓝灰底
          styles={{
            variables: {
              dark: {
                diffViewerBackground: 'transparent',
                diffViewerTitleBackground: 'var(--c-surface)',
                diffViewerTitleBorderColor: 'var(--c-line)',
                diffViewerTitleColor: 'var(--c-fg-muted)',
                gutterBackground: 'transparent',
                gutterBackgroundDark: 'transparent',
                emptyLineBackground: 'transparent',
                addedBackground: 'color-mix(in srgb, var(--c-success) 14%, transparent)',
                removedBackground: 'color-mix(in srgb, var(--c-danger) 14%, transparent)',
                wordAddedBackground: 'color-mix(in srgb, var(--c-success) 34%, transparent)',
                wordRemovedBackground: 'color-mix(in srgb, var(--c-danger) 34%, transparent)',
              },
              light: {
                diffViewerBackground: 'transparent',
                diffViewerTitleBackground: 'var(--c-surface)',
                diffViewerTitleBorderColor: 'var(--c-line)',
                diffViewerTitleColor: 'var(--c-fg-muted)',
                gutterBackground: 'transparent',
                gutterBackgroundDark: 'transparent',
                emptyLineBackground: 'transparent',
                addedBackground: 'color-mix(in srgb, var(--c-success) 12%, transparent)',
                removedBackground: 'color-mix(in srgb, var(--c-danger) 12%, transparent)',
                wordAddedBackground: 'color-mix(in srgb, var(--c-success) 30%, transparent)',
                wordRemovedBackground: 'color-mix(in srgb, var(--c-danger) 30%, transparent)',
              },
            },
          }}
        />
      </Suspense>

      {truncated && (
        <p className="border-t border-line bg-surface px-3 py-1.5 text-[11px] text-fg-muted">
          文件超过 {MAX_LINES} 行，diff 已截断。
        </p>
      )}
    </div>
  )
}
