/**
 * 工作空间选择器。
 *
 * 主按钮直接弹**系统原生**的目录选择框（后端调 osascript / zenity /
 * FolderBrowserDialog），跟「cd 到项目目录里再跑 claude」是同一个心智模型。
 *
 * 旁边的下拉里放两样补充：
 * - **最近用过的项目**：从对话历史来（每个 thread 的 metadata 里记着它用的
 *   工作空间），不是后端列目录——后端没有「项目」的概念，只有目录。
 * - **手动输入路径**：后端跑在无图形界面的环境里（Docker、SSH 服务器）
 *   弹不出窗口时的唯一出路。
 */
import { useMemo, useState } from 'react'
import {
  Check,
  ChevronDown,
  FolderOpen,
  FolderSearch,
  History,
  Loader2,
  TriangleAlert,
  X,
} from 'lucide-react'
import { errorMessage } from '../../api/client'
import { pickWorkspace } from '../../api/workspace'
import { cn } from '../../lib/cn'
import { useConversationStore } from '../../store/conversationStore'
import { useTaskSettings, useTaskStore } from '../../store/taskStore'

interface Props {
  threadId: string | null
  disabled?: boolean
}

export function WorkspacePicker({ threadId, disabled }: Props) {
  const { workspace } = useTaskSettings(threadId)
  const update = useTaskStore((s) => s.update)
  const threads = useConversationStore((s) => s.threads)

  /** 正在等用户在后端的系统弹窗里选目录 */
  const [picking, setPicking] = useState(false)
  /** 下拉面板：最近的项目 + 手动输入 */
  const [menuOpen, setMenuOpen] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [manual, setManual] = useState('')

  const hasWorkspace = workspace.length > 0

  /**
   * 最近用过的项目：从对话历史里来。
   *
   * 每个 thread 的 metadata 记着它这次用的工作空间（见 conversationStore
   * 的 sendMessage），所以「之前聊过的项目」不需要后端再列一次目录。
   */
  const recent = useMemo(() => {
    const seen = new Set<string>()
    const out: string[] = []
    for (const thread of threads) {
      const value = thread.metadata?.workspace
      if (typeof value !== 'string' || !value || seen.has(value)) continue
      seen.add(value)
      out.push(value)
    }
    return out.slice(0, 8)
  }, [threads])

  const select = (path: string) => {
    update(threadId, { workspace: path })
    setError(null)
    setManual('')
  }

  const clear = () => {
    update(threadId, { workspace: '' })
    setError(null)
    setManual('')
  }

  /** 弹系统目录选择框 */
  const pick = async () => {
    setPicking(true)
    setError(null)
    try {
      const result = await pickWorkspace()
      // 取消不是错误：什么都不做，保留原来的选择
      if (result.cancelled) return
      if (result.path) select(result.path)
    } catch (err) {
      // 弹不出来（无图形界面 / 缺依赖）：把手动输入的路子亮出来
      setError(errorMessage(err))
      setMenuOpen(true)
    } finally {
      setPicking(false)
    }
  }

  const applyManual = () => {
    const path = manual.trim()
    if (!path) return
    select(path)
    setMenuOpen(false)
  }

  return (
    <div className="relative flex items-center gap-1">
      <button
        type="button"
        onClick={() => void pick()}
        disabled={disabled || picking}
        title={hasWorkspace ? `工作空间：${workspace}` : '选择工作空间（弹出系统文件浏览窗口）'}
        className={cn(
          'flex max-w-[15rem] items-center gap-1.5 rounded-md border px-2 py-1.5 text-[11px] transition-colors',
          'disabled:cursor-not-allowed disabled:opacity-50',
          hasWorkspace
            ? 'border-line bg-surface text-fg hover:border-accent/60'
            : 'border-dashed border-line bg-surface text-fg-muted hover:border-accent/60 hover:text-fg',
        )}
      >
        {picking ? (
          <Loader2 className="size-3.5 shrink-0 animate-spin-slow" />
        ) : hasWorkspace ? (
          <FolderOpen className="size-3.5 shrink-0 text-accent" />
        ) : (
          <FolderSearch className="size-3.5 shrink-0" />
        )}
        <span className="truncate font-mono">
          {picking ? '等待选择…' : hasWorkspace ? workspace : '选择工作空间'}
        </span>
      </button>

      {/* 下拉：最近的项目 + 手动输入 + 取消选择 */}
      <button
        type="button"
        onClick={() => setMenuOpen((v) => !v)}
        disabled={disabled}
        aria-label="工作空间菜单"
        aria-expanded={menuOpen}
        className="shrink-0 rounded-md border border-line bg-surface p-1.5 text-fg-muted transition-colors hover:border-accent/60 hover:text-fg disabled:cursor-not-allowed disabled:opacity-50"
      >
        <ChevronDown className={cn('size-3 transition-transform', menuOpen && 'rotate-180')} />
      </button>

      {menuOpen && (
        <>
          <div className="fixed inset-0 z-40" onClick={() => setMenuOpen(false)} aria-hidden />
          <div
            role="dialog"
            aria-label="工作空间"
            className="absolute bottom-full left-0 z-50 mb-2 flex w-[24rem] max-w-[calc(100vw-2rem)] flex-col overflow-hidden rounded-lg border border-line bg-surface shadow-xl"
          >
            {error && (
              <p className="flex items-start gap-2 border-b border-line px-3 py-2 text-[11px] text-danger">
                <TriangleAlert className="mt-0.5 size-3.5 shrink-0" />
                {error}
              </p>
            )}

            {recent.length > 0 && (
              <div className="border-b border-line p-1">
                <p className="flex items-center gap-1.5 px-2 py-1 text-[10px] text-fg-muted">
                  <History className="size-3" />
                  最近用过的项目
                </p>
                {recent.map((path) => (
                  <button
                    key={path}
                    type="button"
                    onClick={() => {
                      select(path)
                      setMenuOpen(false)
                    }}
                    className="flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left transition-colors hover:bg-raised"
                  >
                    <FolderOpen className="size-3.5 shrink-0 text-fg-muted" />
                    <span className="min-w-0 flex-1 truncate font-mono text-[11px] text-fg">{path}</span>
                    {workspace === path && <Check className="size-3 shrink-0 text-accent" />}
                  </button>
                ))}
              </div>
            )}

            <div className="p-2">
              <p className="px-1 pb-1.5 text-[10px] text-fg-muted">手动输入绝对路径</p>
              <div className="flex items-center gap-1.5">
                <input
                  value={manual}
                  onChange={(e) => setManual(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter') applyManual()
                  }}
                  placeholder="/Users/me/projects/demo"
                  spellCheck={false}
                  className="min-w-0 flex-1 rounded-md border border-line bg-raised px-2 py-1.5 font-mono text-[11px] text-fg outline-none placeholder:text-fg-muted focus:border-accent/60"
                />
                <button
                  type="button"
                  onClick={applyManual}
                  disabled={!manual.trim()}
                  className="shrink-0 rounded-md bg-accent px-2.5 py-1.5 text-[11px] font-medium text-bg transition-opacity hover:opacity-90 disabled:cursor-not-allowed disabled:opacity-40"
                >
                  使用
                </button>
              </div>
            </div>

            <div className="flex items-center gap-2 border-t border-line px-2 py-1.5">
              <span
                className={cn(
                  'min-w-0 flex-1 truncate font-mono text-[10px]',
                  hasWorkspace ? 'text-fg' : 'text-fg-muted',
                )}
                title={workspace || '未选择'}
              >
                {workspace || '未选择工作空间（用后端默认目录）'}
              </span>
              <button
                type="button"
                onClick={() => {
                  clear()
                  setMenuOpen(false)
                }}
                disabled={!hasWorkspace}
                className="flex shrink-0 items-center gap-1 rounded-md px-2 py-1 text-[11px] text-fg-muted transition-colors hover:bg-raised hover:text-fg disabled:opacity-40"
              >
                <X className="size-3" />
                取消选择
              </button>
            </div>
          </div>
        </>
      )}
    </div>
  )
}
