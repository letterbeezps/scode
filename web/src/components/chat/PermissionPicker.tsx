/**
 * 权限档位：决定危险操作要不要先跟用户确认。
 *
 * 选项就是后端认识的三个英文值本身，这里只做展示和切换，不做二次解释。
 */
import { ShieldAlert, ShieldCheck, ShieldQuestion } from 'lucide-react'
import { cn } from '../../lib/cn'
import {
  PERMISSION_LEVELS,
  permissionMeta,
  type PermissionLevel,
} from '../../lib/permissions'
import { useTaskSettings, useTaskStore } from '../../store/taskStore'

const ICONS: Record<PermissionLevel, typeof ShieldCheck> = {
  manual: ShieldAlert,
  normal: ShieldQuestion,
  auto: ShieldCheck,
}

interface Props {
  threadId: string | null
  disabled?: boolean
}

export function PermissionPicker({ threadId, disabled }: Props) {
  const { permissions } = useTaskSettings(threadId)
  const update = useTaskStore((s) => s.update)
  const meta = permissionMeta(permissions)
  const Icon = ICONS[permissions] ?? ShieldQuestion

  return (
    <div className="flex items-center gap-1.5" title={meta.description}>
      <label
        className={cn(
          'flex items-center gap-1.5 rounded-md border border-line bg-surface px-2 py-1.5 text-[11px]',
          'text-fg-muted transition-colors hover:border-accent/60',
          disabled && 'cursor-not-allowed opacity-50',
        )}
      >
        <Icon className="size-3.5 shrink-0" />
        <span className="sr-only">权限</span>
        <select
          value={permissions}
          disabled={disabled}
          onChange={(e) => update(threadId, { permissions: e.target.value as PermissionLevel })}
          aria-label="权限"
          className="cursor-pointer appearance-none bg-transparent font-mono text-fg outline-none disabled:cursor-not-allowed"
        >
          {PERMISSION_LEVELS.map((level) => (
            <option key={level.id} value={level.id}>
              {level.label}
            </option>
          ))}
        </select>
      </label>
      {/* 说明常驻可见：悬停提示容易被忽略，而这正是这个开关的含义所在 */}
      <span className="hidden truncate text-[11px] text-fg-muted lg:inline">{meta.description}</span>
    </div>
  )
}
