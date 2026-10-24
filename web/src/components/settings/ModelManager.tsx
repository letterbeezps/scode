/**
 * 模型管理面板：conf/config.toml 里的模型增删改查。
 *
 * 两个不能忽略的语义，UI 上必须说出来，否则用户会误判：
 *
 * 1. **改配置 ≠ 换模型。** 改的是 `conf/config.toml`，不是运行中的实例。
 *    但切换模型那条路径（后端 `graph/model_switch.py`）每次调用都重读这个文件，
 *    所以**切换过去的模型下一次运行就用新配置**；只有「后端启动时带的默认模型」
 *    才要重启 scode 才换得掉——提示里要说清这个区别。
 * 2. **连接字段是供应商级的。** 接口摊平成「每个模型自带全部字段」，
 *    但 toml 里 protocol / base_url / api_key / display_name 属于整个
 *    [models.providers.<name>] 段。所以这里按供应商分组展示，
 *    改一个模型会带动整段——PUT 响应里的 co_affected 就是这个意思。
 */
import { useEffect, useMemo, useState } from 'react'
import { Eye, EyeOff, Loader2, Pencil, Plus, RefreshCw, Trash2 } from 'lucide-react'
import { useSettingsStore } from '../../store/settingsStore'
import { ModelForm } from './ModelForm'
import type { AdminModel, ModelCreateInput, ModelUpdateInput } from '../../api/types'
import { cn } from '../../lib/cn'

type FormMode = { kind: 'closed' } | { kind: 'create' } | { kind: 'edit'; model: AdminModel }

export function ModelManager() {
  const models = useSettingsStore((s) => s.models)
  const defaultId = useSettingsStore((s) => s.defaultId)
  const recentId = useSettingsStore((s) => s.recentId)
  const reveal = useSettingsStore((s) => s.reveal)
  const loading = useSettingsStore((s) => s.loading)
  const saving = useSettingsStore((s) => s.saving)
  const error = useSettingsStore((s) => s.error)
  const notice = useSettingsStore((s) => s.notice)
  const load = useSettingsStore((s) => s.load)
  const toggleReveal = useSettingsStore((s) => s.toggleReveal)
  const addModel = useSettingsStore((s) => s.addModel)
  const editModel = useSettingsStore((s) => s.editModel)
  const removeModel = useSettingsStore((s) => s.removeModel)
  const clearFeedback = useSettingsStore((s) => s.clearFeedback)

  const [mode, setMode] = useState<FormMode>({ kind: 'closed' })
  /** 删除是两步确认：第一下只把按钮切成「确认删除」，不给弹窗 */
  const [confirmId, setConfirmId] = useState<string | null>(null)

  useEffect(() => {
    void load()
  }, [load])

  // 接口摊平返回，按 provider 分组还原成 toml 的形状，展示时也能一眼看出
  // 「这几个模型共用同一份连接字段」
  const groups = useMemo(() => {
    const byProvider = new Map<string, AdminModel[]>()
    for (const m of models) {
      const bucket = byProvider.get(m.provider)
      if (bucket) bucket.push(m)
      else byProvider.set(m.provider, [m])
    }
    return [...byProvider.entries()]
  }, [models])

  const handleSubmit = async (input: ModelCreateInput | ModelUpdateInput, isEdit: boolean) => {
    const target = mode.kind === 'edit' ? mode.model.id : null
    const res = isEdit
      ? await editModel(target as string, input as ModelUpdateInput)
      : await addModel(input as ModelCreateInput)
    // 失败时留在表单里让用户改，成功才收起
    if (res) setMode({ kind: 'closed' })
  }

  const handleDelete = async (id: string) => {
    if (confirmId !== id) {
      setConfirmId(id)
      return
    }
    setConfirmId(null)
    await removeModel(id)
  }

  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-center gap-2">
        <button
          type="button"
          onClick={() => setMode({ kind: 'create' })}
          className="inline-flex items-center gap-1.5 rounded-md bg-accent px-2.5 py-1.5 text-xs text-white transition-opacity hover:opacity-90"
        >
          <Plus className="size-3.5" />
          新增模型
        </button>

        <button
          type="button"
          onClick={() => void toggleReveal()}
          className="inline-flex items-center gap-1.5 rounded-md border border-line px-2.5 py-1.5 text-xs text-fg-muted transition-colors hover:bg-surface hover:text-fg"
        >
          {reveal ? <EyeOff className="size-3.5" /> : <Eye className="size-3.5" />}
          {reveal ? '隐藏密钥' : '显示密钥'}
        </button>

        <button
          type="button"
          onClick={() => void load()}
          disabled={loading}
          aria-label="刷新"
          className="inline-flex items-center gap-1.5 rounded-md border border-line px-2.5 py-1.5 text-xs text-fg-muted transition-colors hover:bg-surface hover:text-fg disabled:opacity-50"
        >
          {loading ? <Loader2 className="size-3.5 animate-spin-slow" /> : <RefreshCw className="size-3.5" />}
          刷新
        </button>

        {defaultId && (
          <span className="text-[11px] text-fg-muted">
            后端当前使用 <code className="font-mono text-fg">{defaultId}</code>
            {recentId && recentId !== defaultId && (
              <>
                ，回退 <code className="font-mono">{recentId}</code>
              </>
            )}
          </span>
        )}
      </div>

      {error && (
        <Banner tone="danger" onDismiss={clearFeedback}>
          {error}
        </Banner>
      )}
      {notice && (
        <Banner tone="warn" onDismiss={clearFeedback}>
          {notice}
        </Banner>
      )}

      {mode.kind !== 'closed' && (
        <ModelForm
          editing={mode.kind === 'edit' ? mode.model : null}
          saving={saving}
          onSubmit={handleSubmit}
          onCancel={() => setMode({ kind: 'closed' })}
        />
      )}

      {groups.length === 0 && !loading && (
        <p className="rounded-md border border-line bg-surface px-3 py-4 text-center text-xs text-fg-muted">
          还没有配置模型。先建一份 <code className="font-mono">conf/config.toml</code>，
          或用上面的「新增模型」。
        </p>
      )}

      {groups.map(([provider, items]) => (
        <section
          key={provider}
          className="overflow-hidden rounded-md border border-line bg-surface"
        >
          {/* 供应商头：这些连接字段是该段下所有模型共用的 */}
          <header className="flex flex-wrap items-center gap-2 border-b border-line bg-raised px-3 py-2">
            <span className="font-mono text-xs font-medium text-fg">
              {items[0]?.display_name || provider}
            </span>
            <code className="font-mono text-[10px] text-fg-muted">{provider}</code>
            <span className="rounded border border-line px-1.5 py-0.5 text-[10px] text-fg-muted">
              {items[0]?.protocol}
            </span>
            {items[0]?.base_url && (
              <code className="font-mono text-[10px] text-fg-muted">{items[0].base_url}</code>
            )}
          </header>

          <ul className="divide-y divide-line">
            {items.map((model) => (
              <li key={model.id} className="flex flex-wrap items-center gap-2 px-3 py-2">
                <div className="min-w-0 flex-1">
                  <div className="flex items-center gap-1.5">
                    <span className="truncate text-xs font-medium text-fg">{model.name}</span>
                    {model.id === defaultId && <Badge tone="accent">default</Badge>}
                    {model.id === recentId && <Badge tone="muted">recent</Badge>}
                  </div>
                  <div className="mt-0.5 flex items-center gap-2 text-[10px] text-fg-muted">
                    <code className="font-mono">{model.api_key ?? '（无密钥）'}</code>
                    <code className="font-mono opacity-60">{model.id}</code>
                  </div>
                </div>

                <div className="flex shrink-0 items-center gap-1">
                  <button
                    type="button"
                    onClick={() => setMode({ kind: 'edit', model })}
                    aria-label={`编辑 ${model.id}`}
                    className="rounded p-1.5 text-fg-muted transition-colors hover:bg-raised hover:text-fg"
                  >
                    <Pencil className="size-3.5" />
                  </button>

                  {confirmId === model.id ? (
                    <>
                      <button
                        type="button"
                        onClick={() => void handleDelete(model.id)}
                        disabled={saving}
                        className="rounded bg-danger px-2 py-1 text-[11px] text-white transition-opacity hover:opacity-90 disabled:opacity-50"
                      >
                        确认删除
                      </button>
                      <button
                        type="button"
                        onClick={() => setConfirmId(null)}
                        className="rounded px-1.5 py-1 text-[11px] text-fg-muted hover:text-fg"
                      >
                        取消
                      </button>
                    </>
                  ) : (
                    <button
                      type="button"
                      onClick={() => void handleDelete(model.id)}
                      aria-label={`删除 ${model.id}`}
                      className="rounded p-1.5 text-fg-muted transition-colors hover:bg-danger/10 hover:text-danger"
                    >
                      <Trash2 className="size-3.5" />
                    </button>
                  )}
                </div>
              </li>
            ))}
          </ul>
        </section>
      ))}

      <p className="text-[11px] leading-relaxed text-fg-muted">
        改动写在仓库根的 <code className="font-mono">conf/config.toml</code>（已 gitignore）。
        <strong className="text-fg">切换过去的模型下一次运行就用新配置</strong>；
        只有后端启动时带的默认模型，需要{' '}
        <strong className="text-fg">重启 scode</strong> 才换得掉。
      </p>
    </div>
  )
}

function Badge({ tone, children }: { tone: 'accent' | 'muted'; children: React.ReactNode }) {
  return (
    <span
      className={cn(
        'rounded px-1.5 py-0.5 text-[10px]',
        tone === 'accent' ? 'bg-accent/15 text-accent' : 'bg-raised text-fg-muted',
      )}
    >
      {children}
    </span>
  )
}

function Banner({
  tone,
  onDismiss,
  children,
}: {
  tone: 'danger' | 'warn'
  onDismiss: () => void
  children: React.ReactNode
}) {
  return (
    <div
      className={cn(
        'flex items-start gap-2 rounded-md border px-3 py-2 text-xs leading-relaxed',
        tone === 'danger'
          ? 'border-danger/30 bg-danger/10 text-danger'
          : 'border-warn/30 bg-warn/10 text-warn',
      )}
    >
      <p className="min-w-0 flex-1">{children}</p>
      <button
        type="button"
        onClick={onDismiss}
        aria-label="关闭提示"
        className="shrink-0 rounded px-1 opacity-70 hover:opacity-100"
      >
        ×
      </button>
    </div>
  )
}
