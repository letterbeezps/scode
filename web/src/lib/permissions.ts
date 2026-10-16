/**
 * 任务权限：不是能力白名单，而是「危险操作要不要先跟用户确认」。
 *
 * 三档，直接以英文值作为选项，后端按同一套取值处理：
 *
 *   manual  命中危险操作的先确认
 *   normal  由 AI 审核这次操作是否危险，再决定要不要确认（默认）
 *   auto    不确认
 *
 * 为什么要分级而不是简单开关：同一类操作风险差别很大。跑 `pytest` 和
 * 跑 `rm -rf` 都属于「执行命令」，前者没必要打断用户，后者必须打断。
 * manual 与 normal 的差别在于谁来判断危险：前者按固定规则，后者交给 AI。
 *
 * 这是**执行前**的确认。落到后端需要在工具调用入口拦截并挂起等前端确认，
 * 前端只负责把档位原样传下去。
 */

/** 与后端约定的 configurable key，见 api/run.ts 的请求体 */
export const WORKSPACE_KEY = 'workspace'
export const PERMISSIONS_KEY = 'permissions'

/** 前端只发这三个合法值 */
export type PermissionLevel = 'manual' | 'normal' | 'auto'

export interface PermissionMeta {
  id: PermissionLevel
  /** 英文取值本身即选项文案 */
  label: PermissionLevel
  description: string
}

export const PERMISSION_LEVELS: PermissionMeta[] = [
  { id: 'manual', label: 'manual', description: '命中危险操作的，先确认再执行' },
  { id: 'normal', label: 'normal', description: 'AI 审核这次操作是否危险，再决定要不要确认' },
  { id: 'auto', label: 'auto', description: '不确认，直接执行' },
]

/**
 * 默认 normal：manual 会被打断到没法用，auto 等于把机器完全交出去。
 * 需要更严时用户自己调到 manual。
 */
export const DEFAULT_PERMISSION_LEVEL: PermissionLevel = 'normal'

export function permissionMeta(level: PermissionLevel): PermissionMeta {
  // 前端只发三个合法值，仍兜一层避免下拉出现未知文案
  return PERMISSION_LEVELS.find((item) => item.id === level) ?? PERMISSION_LEVELS[1]
}

export function isPermissionLevel(value: unknown): value is PermissionLevel {
  return value === 'manual' || value === 'normal' || value === 'auto'
}
