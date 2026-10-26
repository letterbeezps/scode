/**
 * 记忆：读和写 agent 的两份长期记忆。
 *
 * 契约见 stupid_code/API.md「记忆管理」一节，后端由 admin/app.py 挂在
 * langgraph dev 的 /admin 前缀下。
 *
 * ## 两份记忆
 *
 * | 作用域 | 磁盘位置 | 跟着谁走 |
 * |---|---|---|
 * | `user` | `~/.scode/memory.md` | 用户，跨所有工作空间共用 |
 * | `project` | `<工作空间>/.scode-memory.md` | 项目 |
 *
 * 写用户级记忆不需要工作空间；写项目级记忆必须带 `workspace`。
 *
 * ## 改完不会立刻生效
 *
 * 记忆是**会话开始时读一次**的（框架机制，见后端 graph/memory.py）。在这里
 * 改完，当前会话里的 agent 读到的还是旧内容——要开新会话才生效。面板里会
 * 把这句话写在脸上，免得用户以为没保存成功。
 *
 * agent 自己写记忆走的是文件工具（`write_file("/user-memory/memory.md", ...)`），
 * 跟这个接口写的是同一批文件——两条路互不干扰，但同时改会互相覆盖。
 */
import { isMockMode, request } from './client'
import { mockAdminMemory } from './mock'
import type { MemoryResponse, MemorySaveInput, MemorySaveResult } from './types'

/**
 * 读两份记忆。
 *
 * `workspace` 传绝对路径；空串表示「不指定」，后端会退回它自己的默认工作空间。
 */
export async function getMemory(workspace: string): Promise<MemoryResponse> {
  if (isMockMode) return mockAdminMemory.get(workspace)

  const query = workspace ? `?workspace=${encodeURIComponent(workspace)}` : ''
  return request<MemoryResponse>(`/admin/memory${query}`)
}

/** 写一份记忆。内容写空字符串 = 清空这个文件。 */
export async function saveMemory(input: MemorySaveInput): Promise<MemorySaveResult> {
  if (isMockMode) return mockAdminMemory.save(input)

  return request<MemorySaveResult>('/admin/memory', {
    method: 'PUT',
    body: JSON.stringify(input),
  })
}
