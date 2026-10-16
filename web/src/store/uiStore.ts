/**
 * 界面状态（前端设计文档 5.2）。
 *
 * theme 会同步到 <html> 的 class 上，index.css 里的 CSS 变量据此换色；
 * 首屏由 index.html 里的内联脚本先定一次，避免刷新时闪白。
 */
import { create } from 'zustand'

export type Theme = 'light' | 'dark'

const THEME_KEY = 'stupid-code:theme'

function readStoredTheme(): Theme {
  try {
    const stored = localStorage.getItem(THEME_KEY)
    if (stored === 'light' || stored === 'dark') return stored
  } catch {
    // 隐私模式下 localStorage 可能抛异常，忽略即可
  }
  return 'dark' // 设计文档 8.1：暗色优先
}

function applyTheme(theme: Theme) {
  document.documentElement.classList.toggle('light', theme === 'light')
  try {
    localStorage.setItem(THEME_KEY, theme)
  } catch {
    /* 同上 */
  }
}

export interface UIState {
  sidebarCollapsed: boolean
  /** 当前展开的工具调用卡片（null = 全部折叠，设计文档 4.1） */
  activeToolCallId: string | null
  theme: Theme
  toggleSidebar: () => void
  setSidebarCollapsed: (collapsed: boolean) => void
  setActiveToolCall: (id: string | null) => void
  toggleTheme: () => void
}

const initialTheme = readStoredTheme()
applyTheme(initialTheme)

export const useUIStore = create<UIState>((set) => ({
  sidebarCollapsed: false,
  activeToolCallId: null,
  theme: initialTheme,

  toggleSidebar: () => set((s) => ({ sidebarCollapsed: !s.sidebarCollapsed })),
  setSidebarCollapsed: (collapsed) => set({ sidebarCollapsed: collapsed }),

  setActiveToolCall: (id) =>
    // 再点一次同一个卡片 = 收起（null 表示全部折叠）
    set((s) => ({ activeToolCallId: s.activeToolCallId === id ? null : id })),

  toggleTheme: () =>
    set((s) => {
      const theme: Theme = s.theme === 'dark' ? 'light' : 'dark'
      applyTheme(theme)
      return { theme }
    }),
}))

/** 方便组件直接订阅主题，避免各处重复写选择器 */
export const useIsDark = () => useUIStore((s) => s.theme === 'dark')
