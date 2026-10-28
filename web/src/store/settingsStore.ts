/**
 * 模型配置（前端设计文档 5.5）。
 *
 * 数据源从写死的四项换成后端的 /admin/models —— 真实供应商配在
 * conf/config.toml 里，这里只是它的一张视图 + 增删改入口。
 *
 * 关于「选中哪个模型」：selectedId 是**真正生效**的选择。每次发消息时它随
 * context 一起发给后端，后端在每次模型调用前把模型换成它
 * （见后端 `stupid_code/graph/model_switch.py`），所以切换不需要重启后端，
 * 下一条消息就用新供应商的 base_url / api_key / protocol。
 *
 * 选中值存在 localStorage 里，刷新页面、换会话都还在。defaultId 是后端启动
 * 时带的默认模型（config.toml 的 [models].default）；两者不一致正是「切过去了」
 * 的状态，UI 要如实显示当前用的是哪个。
 */
import { create } from 'zustand'
import { errorMessage } from '../api/client'
import {
  createModel,
  deleteModel,
  listModels,
  pruneUpdateInput,
  updateModel,
} from '../api/models'
import type {
  AdminModel,
  ModelCreateInput,
  ModelCreateResult,
  ModelDeleteResult,
  ModelUpdateInput,
  ModelUpdateResult,
} from '../api/types'

const STORAGE_KEY = 'stupid-code:model'
/** localStorage 里的键。与 lib/model.ts 的 MODEL_KEY（context 字段）不是一回事。 */

function readStoredModel(): string {
  try {
    return localStorage.getItem(STORAGE_KEY) ?? ''
  } catch {
    // 隐私模式下 localStorage 可能抛异常
    return ''
  }
}

export interface SettingsState {
  models: AdminModel[]
  /** config.toml 的 [models].default，后端启动时带的模型 */
  defaultId: string | null
  /** config.toml 的 [models].recent，default 缺省时的回退 */
  recentId: string | null
  /** 当前选中的模型 id。会被随每次运行发给后端，真正决定用哪个模型 */
  selectedId: string
  /** api_key 是否已按 reveal=true 取回明文 */
  reveal: boolean
  loading: boolean
  saving: boolean
  /** 最近一次失败的原因，可直接展示给用户 */
  error: string | null
  /** 最近一次成功的提示，比如「已删除，剩余 …」「还需重启 scode」 */
  notice: string | null

  load: () => Promise<void>
  select: (id: string) => void
  toggleReveal: () => Promise<void>
  addModel: (input: ModelCreateInput) => Promise<ModelCreateResult | null>
  editModel: (id: string, input: ModelUpdateInput) => Promise<ModelUpdateResult | null>
  removeModel: (id: string) => Promise<ModelDeleteResult | null>
  clearFeedback: () => void
}

export const useSettingsStore = create<SettingsState>((set, get) => ({
  models: [],
  defaultId: null,
  recentId: null,
  selectedId: readStoredModel(),
  reveal: false,
  loading: false,
  saving: false,
  error: null,
  notice: null,

  load: async () => {
    set({ loading: true, error: null })
    try {
      const res = await listModels()
      const ids = res.models.map((m) => m.id)

      // 之前选的模型可能已经被后端删掉了，这时回落到后端 default，
      // 免得下拉框停在一个不存在的值上。
      const current = get().selectedId
      const selectedId = ids.includes(current) ? current : (res.default ?? ids[0] ?? '')

      set({ models: res.models, defaultId: res.default, recentId: res.recent, selectedId })
      if (selectedId && selectedId !== current) {
        try {
          localStorage.setItem(STORAGE_KEY, selectedId)
        } catch {
          /* 隐私模式下忽略 */
        }
      }
    } catch (err) {
      set({ error: errorMessage(err) })
    } finally {
      set({ loading: false })
    }
  },

  /**
   * 选中一个模型：从下一条消息起就用它。
   *
   * 只改本地状态，不发请求——后端每次运行都从 context 拿到当前选中的
   * 模型，所以这里存下就等于「下一次运行会用它」。
   */
  select: (id) => {
    try {
      localStorage.setItem(STORAGE_KEY, id)
    } catch {
      /* 隐私模式下忽略 */
    }
    set({ selectedId: id, notice: null, error: null })
  },

  /**
   * 切换 api_key 明文显示。
   *
   * 明文只在用户主动打开时按需取一次，不在组件里缓存：不 reveal 时下拉和列表
   * 拿到的都是 `***末4位`，重新 load 后自动回到脱敏状态。
   */
  toggleReveal: async () => {
    if (get().reveal) {
      set({ reveal: false })
      await get().load()
      return
    }
    set({ loading: true, error: null })
    try {
      const res = await listModels(true)
      set({ models: res.models, reveal: true })
    } catch (err) {
      set({ error: errorMessage(err) })
    } finally {
      set({ loading: false })
    }
  },

  addModel: async (input) => {
    set({ saving: true, error: null, notice: null })
    try {
      const res = await createModel(input)
      await get().load()
      set({ notice: `已新增模型 ${res.id}。在侧边栏切换过去即可使用，不用重启后端。` })
      return res
    } catch (err) {
      set({ error: errorMessage(err) })
      return null
    } finally {
      set({ saving: false })
    }
  },

  editModel: async (id, input) => {
    set({ saving: true, error: null, notice: null })
    try {
      const res = await updateModel(id, pruneUpdateInput(input))
      await get().load()
      // co_affected 是用户最容易误读的地方：改一个其实改了整段
      const affected =
        res.co_affected.length > 0 ? `同时影响 ${res.co_affected.join('、')}。` : ''
      set({
        notice:
          `已保存 ${res.id}。${affected}切换过去的模型下一次运行就用新配置；` +
          `后端启动时带的默认模型仍需重启 scode。`,
      })
      return res
    } catch (err) {
      set({ error: errorMessage(err) })
      return null
    } finally {
      set({ saving: false })
    }
  },

  removeModel: async (id) => {
    set({ saving: true, error: null, notice: null })
    try {
      const res = await deleteModel(id)
      const wasDefault = get().defaultId === id
      await get().load()
      // 删掉 default 本身不会被后端纠正，下次启动会直接 ConfigError
      const warn = wasDefault
        ? `注意：${id} 正是 [models].default，删掉后下次启动会报 ConfigError，` +
          `需要手动把 default 指向仍存在的模型。`
        : ''
      const peers =
        res.remaining_peers.length > 0 ? `剩余同级模型 ${res.remaining_peers.join('、')}。` : ''
      set({ notice: `已删除 ${res.id}。${peers}${warn}侧边栏选到已删的模型会退回默认模型。` })
      return res
    } catch (err) {
      set({ error: errorMessage(err) })
      return null
    } finally {
      set({ saving: false })
    }
  },

  clearFeedback: () => set({ error: null, notice: null }),
}))
