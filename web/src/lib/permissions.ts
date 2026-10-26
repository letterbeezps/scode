/**
 * 任务权限：不是能力白名单，而是「危险操作要不要先跟用户确认」。
 *
 * 三档，直接以英文值作为选项，后端按同一套取值处理：
 *
 *   manual  每条执行命令、每次删文件都先确认
 *   normal  命中危险命令的才确认（默认）
 *   auto    不确认
 *
 * 为什么要分级而不是简单开关：同一类操作风险差别很大。跑 `pytest` 和
 * 跑 `rm -rf` 都属于「执行命令」，前者没必要打断用户，后者必须打断。
 * 删文件（`delete` 工具，删目录是递归的）也归到 manual 档：它跟 `rm -rf`
 * 等价，模型换个工具就能绕开 shell 那条路的确认。
 *
 * **normal 是过滤器，不是安全边界**：它只看命令字符串，绕得开
 * （`find -delete`、先写个脚本再 `execute` 它）。要确定性就切 manual。
 *
 * 档位随运行请求发到后端的 configurable 里，后端据此决定要不要挂起等人确认
 * （见后端 `stupid_code/graph/permissions.py`）。前端只负责把档位原样传下去，
 * 以及在收到后端的确认请求时把用户的决定送回去。
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
  { id: 'manual', label: 'manual', description: '每条执行命令、每次删文件都先确认' },
  {
    id: 'normal',
    label: 'normal',
    description: '命中危险命令的（rm -rf、强制推送等）才确认；删文件不拦',
  },
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
