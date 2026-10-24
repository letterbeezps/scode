/**
 * 设置页（设计文档 9 的 `/settings`）。
 *
 * 模型一节接的是后端 /admin/models（契约见 stupid_code/API.md「模型管理」），
 * 操作对象是仓库根的 conf/config.toml，不再是写死的本地列表。
 *
 * 下拉框里的「选中」仍只是本地偏好：后端用哪个模型由 config.toml 的
 * [models].default 决定，没有任何端点能改它，所以这里把这点写清楚。
 */
import { Link } from 'react-router-dom'
import { ArrowLeft, Monitor, Moon, Sun } from 'lucide-react'
import { apiBaseUrl, isMockMode } from '../api/client'
import { ModelManager } from '../components/settings/ModelManager'
import { useSettingsStore } from '../store/settingsStore'
import { useUIStore } from '../store/uiStore'
import { cn } from '../lib/cn'

export function SettingsPage() {
  const selectedId = useSettingsStore((s) => s.selectedId)
  const models = useSettingsStore((s) => s.models)
  const defaultId = useSettingsStore((s) => s.defaultId)
  const setModel = useSettingsStore((s) => s.select)
  const theme = useUIStore((s) => s.theme)
  const toggleTheme = useUIStore((s) => s.toggleTheme)

  return (
    <div className="h-full overflow-y-auto scrollbar-slim">
      <div className="mx-auto w-full max-w-2xl px-6 py-8">
        <Link
          to="/chat"
          className="inline-flex items-center gap-1.5 text-sm text-fg-muted transition-colors hover:text-fg"
        >
          <ArrowLeft className="size-4" />
          返回对话
        </Link>

        <h1 className="mt-4 text-xl font-semibold text-fg">设置</h1>

        <Section title="外观">
          <div className="flex gap-2">
            {(
              [
                { key: 'dark', label: '暗色', Icon: Moon },
                { key: 'light', label: '亮色', Icon: Sun },
              ] as const
            ).map(({ key, label, Icon }) => (
              <button
                key={key}
                type="button"
                onClick={() => theme !== key && toggleTheme()}
                className={cn(
                  'flex items-center gap-1.5 rounded-md border px-3 py-1.5 text-sm transition-colors',
                  theme === key
                    ? 'border-accent bg-surface text-fg'
                    : 'border-line text-fg-muted hover:bg-surface hover:text-fg',
                )}
              >
                <Icon className="size-4" />
                {label}
              </button>
            ))}
          </div>
        </Section>

        <Section title="默认模型">
          <select
            value={selectedId}
            onChange={(e) => setModel(e.target.value)}
            disabled={models.length === 0}
            className="w-full rounded-md border border-line bg-surface px-3 py-2 text-sm text-fg focus:border-accent focus:outline-none disabled:opacity-50"
          >
            {models.length === 0 && <option value="">没有可用模型</option>}
            {models.map((model) => (
              <option key={model.id} value={model.id}>
                {model.display_name ? `${model.display_name} · ${model.name}` : model.name}（{model.provider}）
              </option>
            ))}
          </select>
          <p className="mt-1.5 text-xs text-fg-muted">
            这里的选中值会随每次运行发给后端，
            <strong className="text-fg">下一条消息就用这个模型</strong>，不用重启后端。
            后端启动时带的默认模型是 <code className="font-mono">conf/config.toml</code> 的{' '}
            <code className="font-mono">[models].default</code>，
            {defaultId ? <>当前是 <code className="font-mono">{defaultId}</code>。</> : null}
          </p>
        </Section>

        <Section title="模型管理">
          <ModelManager />
        </Section>

        <Section title="后端连接">
          <dl className="space-y-1.5 text-sm">
            <Row label="API 前缀">
              <code className="font-mono text-xs">{apiBaseUrl}</code>
            </Row>
            <Row label="运行模式">
              <span className="inline-flex items-center gap-1.5">
                <Monitor className="size-3.5 text-fg-muted" />
                {isMockMode ? 'Mock（内置脚本）' : '真实后端'}
              </span>
            </Row>
          </dl>
          <p className="mt-2 text-xs text-fg-muted">
            开发态由 Vite 把 <code className="font-mono">/api</code> 代理到{' '}
            <code className="font-mono">VITE_LANGGRAPH_URL</code>（默认 localhost:2024）。
          </p>
        </Section>
      </div>
    </div>
  )
}

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <section className="mt-8">
      <h2 className="mb-2 text-sm font-medium text-fg">{title}</h2>
      {children}
    </section>
  )
}

function Row({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="flex items-center justify-between gap-4">
      <dt className="text-fg-muted">{label}</dt>
      <dd className="text-right text-fg">{children}</dd>
    </div>
  )
}
