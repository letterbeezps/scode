/**
 * 侧边栏底部的设置区（前端设计文档 3.1：模型选择器 + 设置入口）。
 */
import { Link } from 'react-router-dom'
import { Moon, Settings, Sun } from 'lucide-react'
import { isMockMode } from '../../api/client'
import { useSettingsStore } from '../../store/settingsStore'
import { useUIStore } from '../../store/uiStore'

export function SettingsPanel() {
  const modelId = useSettingsStore((s) => s.modelId)
  const models = useSettingsStore((s) => s.models)
  const setModel = useSettingsStore((s) => s.setModel)
  const theme = useUIStore((s) => s.theme)
  const toggleTheme = useUIStore((s) => s.toggleTheme)

  return (
    <div className="space-y-2">
      <label className="block">
        <span className="sr-only">选择模型</span>
        <select
          value={modelId}
          onChange={(e) => setModel(e.target.value)}
          className={cnSelect()}
        >
          {models.map((model) => (
            <option key={model.id} value={model.id}>
              {model.label}
            </option>
          ))}
        </select>
      </label>

      <div className="flex items-center gap-1">
        <button
          type="button"
          onClick={toggleTheme}
          title={theme === 'dark' ? '切换到亮色' : '切换到暗色'}
          aria-label="切换主题"
          className="flex flex-1 items-center gap-1.5 rounded-md px-2 py-1.5 text-xs text-fg-muted transition-colors hover:bg-raised hover:text-fg"
        >
          {theme === 'dark' ? <Moon className="size-3.5" /> : <Sun className="size-3.5" />}
          {theme === 'dark' ? '暗色' : '亮色'}
        </button>

        <Link
          to="/settings"
          className="flex items-center gap-1.5 rounded-md px-2 py-1.5 text-xs text-fg-muted transition-colors hover:bg-raised hover:text-fg"
        >
          <Settings className="size-3.5" />
          设置
        </Link>
      </div>

      {isMockMode && (
        <p className="rounded-md bg-warn/10 px-2 py-1.5 text-[11px] leading-relaxed text-warn">
          Mock 模式：数据来自内置脚本，未连接后端。
        </p>
      )}
    </div>
  )
}

function cnSelect(): string {
  return [
    'w-full rounded-md border border-line bg-bg px-2 py-1.5 text-xs text-fg',
    'transition-colors hover:border-accent focus:border-accent focus:outline-none',
  ].join(' ')
}
