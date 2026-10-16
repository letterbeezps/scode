/**
 * 设置项（模型选择等）。
 *
 * 模型选择属于「设置页」的独立关注点，单独放一个更小的 store，不污染对话状态。
 * 设计文档 5.5。
 */
import { create } from 'zustand'

const MODEL_KEY = 'stupid-code:model'

const DEFAULT_MODELS = [
  { id: 'claude-sonnet-5', label: 'Claude Sonnet 5', provider: 'anthropic' },
  { id: 'claude-opus-5', label: 'Claude Opus 5', provider: 'anthropic' },
  { id: 'gpt-5.1', label: 'GPT-5.1', provider: 'openai' },
  { id: 'deepseek-chat', label: 'DeepSeek Chat', provider: 'deepseek' },
]

function readStoredModel(): string {
  try {
    return localStorage.getItem(MODEL_KEY) ?? DEFAULT_MODELS[0].id
  } catch {
    return DEFAULT_MODELS[0].id
  }
}

export interface SettingsState {
  modelId: string
  models: typeof DEFAULT_MODELS
  setModel: (id: string) => void
}

export const useSettingsStore = create<SettingsState>((set) => ({
  modelId: readStoredModel(),
  models: DEFAULT_MODELS,
  setModel: (id) => {
    try {
      localStorage.setItem(MODEL_KEY, id)
    } catch {
      /* 隐私模式下忽略 */
    }
    set({ modelId: id })
  },
}))
