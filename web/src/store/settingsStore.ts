/**
 * 模型配置（前端设计文档 5.5）。
 *
 * 数据源从写死的四项换成后端的 /admin/models —— 真实供应商配在
 * conf/config.toml 里，这里只是它的一张视图 + 增删改入口。
 *
 * 关于「选中哪个模型」：这里存的 modelId 是**本地偏好**，只决定下拉框显示。
 * 后端实际用哪个模型由 config.toml 的 [models].default 决定，没有任何端点
 * 能改它，所以不能把选中态说成「切换了模型」。selectedId 与 defaultId 不一致时
 * UI 要显式提示这一点，别让用户以为选了就算切了。
 */
import { create } from 'zustand'
import {
  adminErrorMessage,
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

const MODEL_KEY = 'stupid-code:model'

function readStoredModel(): string {
  try {
    return localStorage.getItem(MODEL_KEY) ?? ''
  } catch {
    // 隐私模式下 localStorage 可能抛异常
    return ''
  }
}

export interface SettingsState {
  models: AdminModel[]
  /** config.toml 的 [models].default，后端真正在用的模型 */
  defaultId: string | null
  /** config.toml 的 [models].recent，default 缺省时的回退 */
  recentId: string | null
  /** 本地偏好：下拉框选中的模型 id。不影响后端 */
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
          localStorage.setItem(MODEL_KEY, selectedId)
        } catch {
          /* 隐私模式下忽略 */
        }
      }
    } catch (err) {
      set({ error: adminErrorMessage(err) })
    } finally {
      set({ loading: false })
    }
  },

  select: (id) => {
    try {
      localStorage.setItem(MODEL_KEY, id)
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
      set({ error: adminErrorMessage(err) })
    } finally {
      set({ loading: false })
    }
  },

  addModel: async (input) => {
    set({ saving: true, error: null, notice: null })
    try {
      const res = await createModel(input)
      await get().load()
      set({ notice: `已新增模型 ${res.id}。配置写在 conf/config.toml，重启 scode 后生效。` })
      return res
    } catch (err) {
      set({ error: adminErrorMessage(err) })
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
        notice: `已保存 ${res.id}。${affected}重启 scode 后生效。`,
      })
      return res
    } catch (err) {
      set({ error: adminErrorMessage(err) })
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
      set({ notice: `已删除 ${res.id}。${peers}${warn}重启 scode 后生效。` })
      return res
    } catch (err) {
      set({ error: adminErrorMessage(err) })
      return null
    } finally {
      set({ saving: false })
    }
  },

  clearFeedback: () => set({ error: null, notice: null }),
}))
