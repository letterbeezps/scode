/**
 * 设置页（设计文档 9 的 `/settings`）。
 *
 * 模型选择会写进 localStorage，但目前还没有把它透传给后端：
 * LangGraph 的 run 请求体里模型由后端配置决定，前端选择只在 UI 层生效。
 * 等后端接上 model 参数后，这里补一个字段即可。
 */
import { Link } from 'react-router-dom'
import { ArrowLeft, Monitor, Moon, Sun } from 'lucide-react'
import { apiBaseUrl, isMockMode } from '../api/client'
import { useSettingsStore } from '../store/settingsStore'
import { useUIStore } from '../store/uiStore'
import { cn } from '../lib/cn'

export function SettingsPage() {
  const modelId = useSettingsStore((s) => s.modelId)
  const models = useSettingsStore((s) => s.models)
  const setModel = useSettingsStore((s) => s.setModel)
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

        <Section title="模型">
          <select
            value={modelId}
            onChange={(e) => setModel(e.target.value)}
            className="w-full rounded-md border border-line bg-surface px-3 py-2 text-sm text-fg focus:border-accent focus:outline-none"
          >
            {models.map((model) => (
              <option key={model.id} value={model.id}>
                {model.label}（{model.provider}）
              </option>
            ))}
          </select>
          <p className="mt-1.5 text-xs text-fg-muted">
            选择目前只在本地生效。后端的模型由 <code className="font-mono">langgraph.json</code>{' '}
            与服务端环境变量决定。
          </p>
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
