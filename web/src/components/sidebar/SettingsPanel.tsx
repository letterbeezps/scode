/**
 * 侧边栏底部的设置区（前端设计文档 3.1：模型选择器 + 设置入口）。
 *
 * 模型列表来自后端 /admin/models（conf/config.toml），不再是写死的四项。
 *
 * **选中即生效，不用重启后端**：选中值存在 localStorage 里，每次发消息时随
 * 运行配置（configurable）一起发给后端；后端在每次模型调用前把模型换成它
 * （见后端 stupid_code/graph/model_switch.py）。所以这里显示的「当前模型」
 * 就是下一条消息真正会用的模型。
 *
 * defaultId 是后端启动时带的默认模型（config.toml 的 [models].default）。
 * 选中的跟它不一样时，说明已经切过去了——如实显示当前用的是哪个，别再提示
 * 「仅本地选中」那种误导的话。
 */
import { useEffect } from 'react'
import { Link } from 'react-router-dom'
import { Moon, Settings, Sun } from 'lucide-react'
import { isMockMode } from '../../api/client'
import { useSettingsStore } from '../../store/settingsStore'
import { useUIStore } from '../../store/uiStore'

export function SettingsPanel() {
  const models = useSettingsStore((s) => s.models)
  const defaultId = useSettingsStore((s) => s.defaultId)
  const selectedId = useSettingsStore((s) => s.selectedId)
  const setModel = useSettingsStore((s) => s.select)
  const load = useSettingsStore((s) => s.load)
  const theme = useUIStore((s) => s.theme)
  const toggleTheme = useUIStore((s) => s.toggleTheme)

  // 首次挂载拉一次列表。设置页也会 load()，重复请求无副作用。
  useEffect(() => {
    void load()
  }, [load])

  // 没选中的话（列表还没加载、或一个模型都没有）就退回后端默认模型
  const effectiveId = selectedId || defaultId || ''

  return (
    <div className="space-y-2">
      <label className="block">
        <span className="sr-only">选择模型</span>
        <select
          value={selectedId}
          onChange={(e) => setModel(e.target.value)}
          disabled={models.length === 0}
          className={cnSelect()}
        >
          {models.length === 0 && <option value="">没有可用模型</option>}
          {models.map((model) => (
            <option key={model.id} value={model.id}>
              {model.display_name ? `${model.display_name} · ${model.name}` : model.name}
            </option>
          ))}
        </select>
      </label>

      {effectiveId && (
        <p className="text-[11px] leading-relaxed text-fg-muted">
          后续对话用 <code className="font-mono">{effectiveId}</code>
          {defaultId && defaultId !== effectiveId && (
            <>（后端默认 {defaultId}）</>
          )}
          。
        </p>
      )}

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
    'disabled:cursor-not-allowed disabled:opacity-50',
  ].join(' ')
}
