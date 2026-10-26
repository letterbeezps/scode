/**
 * 记忆面板：看和改 agent 的两份长期记忆。
 *
 * | 作用域 | 磁盘位置 | 跟着谁走 |
 * |---|---|---|
 * | 用户级 | `~/.scode/memory.md` | 用户，跨所有工作空间共用 |
 * | 项目级 | `<工作空间>/.scode-memory.md` | 项目 |
 *
 * 为什么要做这个：记忆是磁盘上的 markdown，但网页版用户看不见它——想看一眼
 * 或改一个字都得开终端翻工作空间。
 *
 * **改完不会立刻生效**：记忆是会话开始时读一次的（框架机制）。这里改完，
 * 当前会话里的 agent 读到的还是旧内容，要开新会话才生效。这句话写在面板里，
 * 免得用户以为没保存成功。
 *
 * **工作空间是任务级的**：项目级记忆跟着当前任务选的工作空间走，所以面板
 * 拿的是 taskStore 里那个值。没选工作空间时，后端退回它自己的默认工作空间
 * （跟 agent 的行为一致）。
 */
import { useEffect, useState } from 'react'
import { Brain, Check, Loader2, TriangleAlert, X } from 'lucide-react'
import { errorMessage } from '../../api/client'
import { getMemory, saveMemory } from '../../api/memory'
import type { MemoryResponse, MemoryScope } from '../../api/types'
import { cn } from '../../lib/cn'

interface Props {
  /** 当前任务的工作空间绝对路径；空串表示不指定（后端退回默认工作空间） */
  workspace: string
  onClose: () => void
}

type Drafts = Record<MemoryScope, string>

export function MemoryPanel({ workspace, onClose }: Props) {
  const [data, setData] = useState<MemoryResponse | null>(null)
  const [drafts, setDrafts] = useState<Drafts>({ user: '', project: '' })
  /** 已经加载成功的是哪个工作空间；null = 还没加载过 */
  const [loadedFor, setLoadedFor] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [saving, setSaving] = useState<MemoryScope | null>(null)
  const [saved, setSaved] = useState<MemoryScope | null>(null)

  /**
   * loading 从「加载的是不是当前工作空间」派生，而不是一个单独的 state。
   *
   * 单独一个 state 就得在 effect 里同步 setLoading(true)——那是 oxlint 的
   * set-state-in-effect（同步 setState 会多一次渲染）。派生写法没这个问题，
   * 而且工作空间中途变了也能正确回到 loading 状态。
   */
  const loading = loadedFor !== workspace

  // 取数据。放在 effect 里，但所有 setState 都在 await 之后——
  // 直接在 effect 体里调 load() 会被 oxlint 的 set-state-in-effect 盯上
  // （它不做控制流分析，只看到「effect 里调了一个会 setState 的函数」）。
  useEffect(() => {
    let cancelled = false
    void (async () => {
      try {
        const res = await getMemory(workspace)
        if (cancelled) return
        setData(res)
        setDrafts({ user: res.user.content, project: res.project.content })
        // 成功才清错误
        setError(null)
      } catch (err) {
        if (!cancelled) setError(errorMessage(err))
      } finally {
        if (!cancelled) setLoadedFor(workspace)
      }
    })()
    return () => {
      cancelled = true
    }
  }, [workspace])

  // Esc 关闭
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onClose])

  const save = async (scope: MemoryScope) => {
    setSaving(scope)
    setSaved(null)
    setError(null)
    try {
      await saveMemory({
        scope,
        content: drafts[scope],
        ...(scope === 'project' ? { workspace } : {}),
      })
      setSaved(scope)
      // 存完把 exists 标上，免得还显示「还没有记忆」
      setData((prev) =>
        prev ? { ...prev, [scope]: { ...prev[scope], exists: true } } : prev,
      )
    } catch (err) {
      setError(errorMessage(err))
    } finally {
      setSaving(null)
    }
  }

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4"
      onClick={onClose}
    >
      <div
        role="dialog"
        aria-label="记忆"
        onClick={(e) => e.stopPropagation()}
        className="flex max-h-[85vh] w-full max-w-2xl flex-col overflow-hidden rounded-lg border border-line bg-bg shadow-xl"
      >
        <div className="flex items-center gap-2 border-b border-line px-4 py-3">
          <Brain className="size-4 text-accent" />
          <h2 className="text-sm font-medium text-fg">记忆</h2>
          <button
            type="button"
            onClick={onClose}
            aria-label="关闭"
            className="ml-auto rounded-md p-1 text-fg-muted transition-colors hover:bg-raised hover:text-fg"
          >
            <X className="size-4" />
          </button>
        </div>

        <div className="scrollbar-slim min-h-0 flex-1 overflow-y-auto px-4 py-3">
          {loading && (
            <p className="flex items-center gap-2 py-6 text-xs text-fg-muted">
              <Loader2 className="size-3.5 animate-spin-slow" />
              读取中…
            </p>
          )}

          {error && (
            <p className="mb-3 flex items-start gap-2 rounded-md bg-danger/10 px-3 py-2 text-[11px] leading-relaxed text-danger">
              <TriangleAlert className="mt-0.5 size-3.5 shrink-0" />
              {error}
            </p>
          )}

          {data && !loading && (
            <div className="space-y-5">
              <MemorySection
                title="用户级"
                hint="跨所有工作空间共用。记你的角色、偏好、沟通方式、常用工具链这类跟具体项目无关的东西。"
                path={data.user.path}
                exists={data.user.exists}
                value={drafts.user}
                onChange={(v) => setDrafts((d) => ({ ...d, user: v }))}
                onSave={() => void save('user')}
                saving={saving === 'user'}
                saved={saved === 'user'}
              />
              <MemorySection
                title="项目级"
                hint="只对当前工作空间有效。记这个项目的命令、目录约定、踩过的坑。"
                path={data.project.path}
                exists={data.project.exists}
                value={drafts.project}
                onChange={(v) => setDrafts((d) => ({ ...d, project: v }))}
                onSave={() => void save('project')}
                saving={saving === 'project'}
                saved={saved === 'project'}
              />
            </div>
          )}
        </div>

        <div className="border-t border-line px-4 py-2.5">
          <p className="text-[11px] leading-relaxed text-fg-muted">
            记忆在<strong className="text-fg">会话开始时读一次</strong>
            ，改完要开新会话才生效。agent 也会用
            <code className="font-mono">write_file</code>
            往这两个文件里写，两边同时改会互相覆盖（后写的赢）。
          </p>
        </div>
      </div>
    </div>
  )
}

function MemorySection({
  title,
  hint,
  path,
  exists,
  value,
  onChange,
  onSave,
  saving,
  saved,
}: {
  title: string
  hint: string
  path: string
  exists: boolean
  value: string
  onChange: (value: string) => void
  onSave: () => void
  saving: boolean
  saved: boolean
}) {
  return (
    <section>
      <div className="mb-1.5 flex items-baseline gap-2">
        <h3 className="text-xs font-medium text-fg">{title}</h3>
        <span className="text-[10px] text-fg-muted">
          {exists ? '已有内容' : '还没有记忆'}
        </span>
      </div>
      <p className="mb-2 text-[11px] leading-relaxed text-fg-muted">{hint}</p>
      <p
        className="mb-1.5 truncate font-mono text-[10px] text-fg-muted"
        title={path}
      >
        {path}
      </p>
      <textarea
        value={value}
        onChange={(e) => onChange(e.target.value)}
        spellCheck={false}
        rows={6}
        placeholder="还没有内容。写下希望 agent 一直记住的事。"
        className="scrollbar-slim w-full resize-y rounded-md border border-line bg-surface px-3 py-2 font-mono text-[11px] leading-relaxed text-fg outline-none placeholder:text-fg-muted focus:border-accent/60"
      />
      <div className="mt-1.5 flex items-center justify-end gap-2">
        {saved && (
          <span className="flex items-center gap-1 text-[10px] text-success">
            <Check className="size-3" />
            已保存
          </span>
        )}
        <button
          type="button"
          onClick={onSave}
          disabled={saving}
          className={cn(
            'flex items-center gap-1 rounded-md bg-accent px-2.5 py-1 text-[11px] font-medium text-bg transition-opacity',
            saving ? 'cursor-not-allowed opacity-50' : 'hover:opacity-90',
          )}
        >
          {saving && <Loader2 className="size-3 animate-spin-slow" />}
          保存
        </button>
      </div>
    </section>
  )
}
