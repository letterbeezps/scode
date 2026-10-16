/**
 * 任务列表状态（前端设计文档 5.3、7.6）。
 *
 * todos 由 SSE 的 todos 事件驱动，和对话消息分开存：
 * 消息列表是一次性追加的，todo 是反复覆盖的，放一起会让整条消息重渲染。
 */
import { create } from 'zustand'
import type { Todo } from '../api/types'

export interface TodoState {
  /** thread_id -> todos */
  todos: Record<string, Todo[]>
  updateTodos: (threadId: string, todos: Todo[]) => void
  clearTodos: (threadId: string) => void
}

export const useTodoStore = create<TodoState>((set) => ({
  todos: {},

  updateTodos: (threadId, todos) =>
    set((state) => ({ todos: { ...state.todos, [threadId]: todos } })),

  clearTodos: (threadId) =>
    set((state) => {
      const next = { ...state.todos }
      delete next[threadId]
      return { todos: next }
    }),
}))

/** 按线程取 todos，顺带做空数组兜底；名字必须以 use 开头，它是个 Hook */
export function useTodosForThread(threadId: string | null): Todo[] {
  return useTodoStore((s) => (threadId ? (s.todos[threadId] ?? EMPTY) : EMPTY))
}

const EMPTY: Todo[] = []
