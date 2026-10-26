/**
 * 任务运行参数：工作空间 + 权限档位 + 勾选的 skill。
 *
 * 按任务存：同一个会话里前后两条消息可能针对不同目录、不同确认策略、
 * 不同 skill，所以不能做成全局设置。但新任务在创建 thread 之前就要能配，
 * 因此额外留一份 draft，threadId 为空时就读写它。
 */
import { create } from 'zustand'
import { DEFAULT_PERMISSION_LEVEL, type PermissionLevel } from '../lib/permissions'

export interface TaskSettings {
  /** 工作空间绝对路径。空字符串表示本次任务不选择工作空间 */
  workspace: string
  permissions: PermissionLevel
  /**
   * 本次对话勾选的 skill 名字。
   *
   * 勾选的会被**钉进上下文**（`SKILL.md` 全文直接进对话历史）。
   */
  skills: string[]
}

function defaultSettings(): TaskSettings {
  // 默认不给工作空间：让用户明确选，而不是默认就授权了某个目录
  return { workspace: '', permissions: DEFAULT_PERMISSION_LEVEL, skills: [] }
}

export interface TaskStore {
  /** thread_id -> 该任务的运行参数 */
  settings: Record<string, TaskSettings>
  /** 尚未落到 thread 上的新任务参数 */
  draft: TaskSettings

  /** threadId 为 null 时读写 draft */
  resolve: (threadId: string | null) => TaskSettings
  update: (threadId: string | null, patch: Partial<TaskSettings>) => void
  /**
   * 用 thread metadata 回填任务参数；该任务已经有内存设置时不覆盖。
   *
   * 设置本身只存在内存里，刷新页面就没了。thread metadata 里记着这个任务
   * 上次实际用过的 workspace / permissions（见 conversationStore.sendMessage），
   * 加载线程时用它回填，否则旧任务会退回默认目录。
   */
  hydrate: (threadId: string, patch: Partial<TaskSettings>) => void
  reset: (threadId: string | null) => void
  /**
   * 把 draft 固化到指定任务上，并把 draft 重置为默认值。
   * 建任务时调用：否则该任务会一直回退到 draft，参数被后续新任务改掉。
   */
  adoptDraft: (threadId: string) => void
}

export const useTaskStore = create<TaskStore>((set, get) => ({
  settings: {},
  draft: defaultSettings(),

  resolve: (threadId) => {
    const state = get()
    if (!threadId) return state.draft
    return state.settings[threadId] ?? state.draft
  },

  update: (threadId, patch) =>
    set((state) => {
      const current = threadId ? (state.settings[threadId] ?? state.draft) : state.draft
      const next: TaskSettings = { ...current, ...patch }
      if (threadId) return { settings: { ...state.settings, [threadId]: next } }
      return { draft: next }
    }),

  hydrate: (threadId, patch) =>
    set((state) => {
      // 内存里已经有设置（本次会话里改过）就不覆盖——metadata 可能是旧的
      if (state.settings[threadId]) return {}
      return {
        settings: {
          ...state.settings,
          [threadId]: { ...defaultSettings(), ...patch },
        },
      }
    }),

  reset: (threadId) =>
    set((state) => {
      if (!threadId) return { draft: defaultSettings() }
      const settings = { ...state.settings }
      delete settings[threadId]
      return { settings }
    }),

  adoptDraft: (threadId) =>
    set((state) => ({
      settings: { ...state.settings, [threadId]: { ...state.draft } },
      draft: defaultSettings(),
    })),
}))

/**
 * 组件里直接订阅当前任务的参数。
 *
 * 用 selector 而不是 resolve()：resolve 读的是 get() 快照，
 * 在 selector 里调用拿不到订阅关系，改了不会重渲染。
 */
export function useTaskSettings(threadId: string | null): TaskSettings {
  return useTaskStore((state) =>
    threadId ? (state.settings[threadId] ?? state.draft) : state.draft,
  )
}
