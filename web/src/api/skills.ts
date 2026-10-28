/**
 * skill 清单：agent 能用的那些技能。
 *
 * 契约见 stupid_code/API.md「技能清单」一节，后端由 admin/app.py 挂在
 * langgraph dev 的 /admin 前缀下。
 *
 * ## 两个作用域
 *
 * | 作用域 | 磁盘位置 | 跟着谁走 |
 * |---|---|---|
 * | 全局 | `~/.scode/.agents/skills/` | 用户，跨所有工作空间共用 |
 * | 项目级 | `<工作空间>/.agents/skills/` | 项目 |
 *
 * 项目级的那份**跟着工作空间走**，所以取列表要带上当前工作空间。
 *
 * ## 勾选的语义
 *
 * 前端勾选的 skill 随 `context.skills` 发给后端，后端会把它们的
 * `SKILL.md` **全文钉进上下文**——不用等 agent 自己去 `read_file` 读。
 * 没勾选的只在系统提示词的 skill 列表里，agent 觉得相关时会自己读。
 */
import { isMockMode, request } from './client'
import { mockSkills } from './mock'
import type { SkillListResponse } from './types'

/**
 * 列出可用的 skill。
 *
 * `workspace` 传绝对路径；空串表示「不指定」，后端会退回它自己的默认工作空间。
 */
export async function getSkills(workspace: string): Promise<SkillListResponse> {
  if (isMockMode) return mockSkills.list(workspace)

  const query = workspace ? `?workspace=${encodeURIComponent(workspace)}` : ''
  return request<SkillListResponse>(`/admin/skills${query}`)
}
