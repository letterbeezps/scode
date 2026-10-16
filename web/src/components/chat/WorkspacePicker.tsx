/**
 * 工作空间选择器：点开是文件夹浏览器，不是输入框。
 *
 * 用户不该手打项目路径 —— 打错一个字符就是授权给了错误的目录。
 * 所以这里改成从后端列目录、直接点选，绝对路径由后端给出
 * （浏览器的目录选择 API 故意不暴露绝对路径，见 api/directory.ts 的说明）。
 *
 * 默认不选工作空间。选中后按钮上显示路径，可以随时取消。
 */
import { useEffect, useState } from 'react'
import {
  Check,
  ChevronRight,
  Folder,
  FolderOpen,
  FolderSearch,
  Loader2,
  TriangleAlert,
  X,
} from 'lucide-react'
import { browseDirectories, pathCrumbs, type DirectoryListing } from '../../api/directory'
import { cn } from '../../lib/cn'
import { useTaskSettings, useTaskStore } from '../../store/taskStore'

interface Props {
  threadId: string | null
  disabled?: boolean
}

export function WorkspacePicker({ threadId, disabled }: Props) {
  const { workspace } = useTaskSettings(threadId)
  const update = useTaskStore((s) => s.update)

  const [open, setOpen] = useState(false)
  /** 正在浏览的目录，不等于已选中的工作空间 */
  const [cursor, setCursor] = useState('/')
  const [listing, setListing] = useState<DirectoryListing | null>(null)
  /** 上一次请求完成的目录，用来派生 loading，而不是再开一个 state */
  const [settledPath, setSettledPath] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)

  const hasWorkspace = workspace.length > 0
  const loading = settledPath !== cursor

  // cursor 是唯一真源：导航就是改它，列表由它派生
  useEffect(() => {
    if (!open) return
    let alive = true

    browseDirectories(cursor)
      .then((result) => {
        if (!alive) return
        setListing(result)
        setError(null)
        setSettledPath(cursor)
      })
      .catch((err: unknown) => {
        if (!alive) return
        setListing(null)
        setError(err instanceof Error ? err.message : String(err))
        setSettledPath(cursor)
      })

    return () => {
      alive = false
    }
  }, [open, cursor])

  // 打开时从已选工作空间的父目录开始，省得每次从 / 点进来
  useEffect(() => {
    if (!open) return
    setCursor(hasWorkspace ? workspace.slice(0, workspace.lastIndexOf('/')) || '/' : '/')
    // 只在开关切换时决定起点，不要跟着 workspace 的每次输入跑
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open])

  // 选中后不关面板：先选一个大致目录，再往下钻一层改主意，是选路径的常态。
  // 关掉的话底部的「完成」就成了永远按不到的死按钮。
  const select = (path: string) => update(threadId, { workspace: path })

  const clear = () => update(threadId, { workspace: '' })

  return (
    <div className="relative">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        disabled={disabled}
        aria-expanded={open}
        aria-haspopup="dialog"
        title={hasWorkspace ? `工作空间：${workspace}` : '未选择工作空间，Agent 将使用后端默认目录'}
        className={cn(
          'flex max-w-[15rem] items-center gap-1.5 rounded-md border px-2 py-1.5 text-[11px] transition-colors',
          'disabled:cursor-not-allowed disabled:opacity-50',
          hasWorkspace
            ? 'border-line bg-surface text-fg hover:border-accent/60'
            : 'border-dashed border-line bg-surface text-fg-muted hover:border-accent/60 hover:text-fg',
        )}
      >
        {hasWorkspace ? (
          <FolderOpen className="size-3.5 shrink-0 text-accent" />
        ) : (
          <FolderSearch className="size-3.5 shrink-0" />
        )}
        <span className="truncate font-mono">
          {hasWorkspace ? workspace : '选择工作空间'}
        </span>
      </button>

      {/* 选中后给一个明确的取消入口，不藏在 hover 里 */}
      {hasWorkspace && !open && (
        <button
          type="button"
          onClick={clear}
          disabled={disabled}
          aria-label="取消工作空间"
          title="取消工作空间"
          className="absolute -right-1.5 -top-1.5 z-10 rounded-full border border-line bg-surface p-0.5 text-fg-muted transition-colors hover:text-danger disabled:pointer-events-none"
        >
          <X className="size-2.5" />
        </button>
      )}

      {open && (
        <>
          <div className="fixed inset-0 z-40" onClick={() => setOpen(false)} aria-hidden />
          <div
            role="dialog"
            aria-label="选择工作空间"
            className="absolute bottom-full left-0 z-50 mb-2 flex w-[26rem] max-w-[calc(100vw-2rem)] flex-col overflow-hidden rounded-lg border border-line bg-surface shadow-xl"
          >
            {/* 面包屑 */}
            <div className="flex items-center gap-1 border-b border-line px-2 py-1.5">
              <Folder className="size-3.5 shrink-0 text-fg-muted" />
              <button
                type="button"
                onClick={() => setCursor('/')}
                className={cn(
                  'shrink-0 rounded px-1 text-[11px] hover:text-fg',
                  cursor === '/' ? 'text-fg' : 'text-fg-muted',
                )}
              >
                根目录
              </button>
              {pathCrumbs(cursor).map((crumb) => (
                <span key={crumb.path} className="flex shrink-0 items-center">
                  <ChevronRight className="size-3 text-fg-muted" />
                  <button
                    type="button"
                    onClick={() => setCursor(crumb.path)}
                    className={cn(
                      'rounded px-1 text-[11px] hover:text-fg',
                      crumb.path === cursor ? 'text-fg' : 'text-fg-muted',
                    )}
                  >
                    {crumb.name}
                  </button>
                </span>
              ))}
              <button
                type="button"
                onClick={() => setOpen(false)}
                aria-label="关闭"
                className="ml-auto shrink-0 rounded p-1 text-fg-muted hover:text-fg"
              >
                <X className="size-3.5" />
              </button>
            </div>

            {/* 目录列表 */}
            <div className="scrollbar-slim max-h-64 min-h-32 overflow-y-auto p-1">
              {loading && (
                <p className="flex items-center justify-center gap-2 py-8 text-xs text-fg-muted">
                  <Loader2 className="size-3.5 animate-spin-slow" />
                  读取中…
                </p>
              )}

              {!loading && error && (
                <p className="flex items-start gap-2 px-2 py-6 text-xs text-danger">
                  <TriangleAlert className="mt-0.5 size-3.5 shrink-0" />
                  {error}
                </p>
              )}

              {!loading && !error && listing && listing.parent && (
                <button
                  type="button"
                  onClick={() => setCursor(listing.parent!)}
                  className="flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left text-[11px] text-fg-muted transition-colors hover:bg-raised hover:text-fg"
                >
                  <ChevronRight className="size-3.5 rotate-180" />
                  返回上级
                </button>
              )}

              {!loading &&
                !error &&
                listing?.directories.map((entry) => (
                  // 行内两个按钮：左边整块是「选中这个目录」，右边箭头才是「进入」。
                  // 用双击进入不可靠 —— 第一次点击就会触发重渲染，第二次点击落在别的元素上。
                  <div
                    key={entry.path}
                    className="group flex items-center rounded-md transition-colors hover:bg-raised"
                  >
                    <button
                      type="button"
                      onClick={() => select(entry.path)}
                      title={`选择 ${entry.path}`}
                      className="flex min-w-0 flex-1 items-center gap-2 py-1.5 pl-2 text-left"
                    >
                      <Folder
                        className={cn(
                          'size-3.5 shrink-0',
                          workspace === entry.path ? 'text-accent' : 'text-fg-muted',
                        )}
                      />
                      <span className="min-w-0 flex-1 truncate text-[11px] text-fg">{entry.name}</span>
                      {workspace === entry.path && <Check className="size-3 shrink-0 text-accent" />}
                    </button>
                    <button
                      type="button"
                      onClick={() => setCursor(entry.path)}
                      aria-label={`进入 ${entry.name}`}
                      title={`进入 ${entry.path}`}
                      className="shrink-0 rounded-r-md px-2 py-1.5"
                    >
                      <ChevronRight className="size-3 text-fg-muted" />
                    </button>
                  </div>
                ))}

              {!loading && !error && listing?.directories.length === 0 && (
                <p className="py-8 text-center text-xs text-fg-muted">这个目录下没有子目录</p>
              )}
            </div>

            {/* 操作：单击文件夹即选中，面板停留方便继续往下点；「完成」才关 */}
            <div className="flex items-center gap-2 border-t border-line px-2 py-1.5">
              <span
                className={cn(
                  'min-w-0 flex-1 truncate font-mono text-[10px]',
                  hasWorkspace ? 'text-fg' : 'text-fg-muted',
                )}
                title={workspace || '未选择'}
              >
                {workspace || '未选择工作空间'}
              </span>
              <button
                type="button"
                onClick={() => {
                  clear()
                  setOpen(false)
                }}
                disabled={!hasWorkspace}
                className="shrink-0 rounded-md px-2 py-1 text-[11px] text-fg-muted transition-colors hover:bg-raised hover:text-fg disabled:opacity-40"
              >
                取消选择
              </button>
              <button
                type="button"
                onClick={() => setOpen(false)}
                disabled={!hasWorkspace}
                className="shrink-0 rounded-md bg-accent px-2.5 py-1 text-[11px] font-medium text-bg transition-opacity hover:opacity-90 disabled:cursor-not-allowed disabled:opacity-40"
              >
                完成
              </button>
            </div>
          </div>
        </>
      )}
    </div>
  )
}
