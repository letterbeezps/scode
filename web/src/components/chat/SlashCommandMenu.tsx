/**
 * 斜杠命令下拉菜单。
 *
 * 出现在输入框上方（不遮消息列表）。当前高亮的那条由键盘 ↑↓ 控制，
 * 回车/Tab 或点击都算选中。
 *
 * 列表里混着两类东西：**命令**（选中后当普通消息发出去）和 **skill**
 * （选中后勾进本次对话，不发送）。两者的区别在行内标出来——skill 标了
 * 作用域，已勾选的标「已选」。
 */
import { type SlashCommand } from '../../lib/commands'
import { cn } from '../../lib/cn'

interface Props {
  /** 过滤后命中的命令 */
  commands: SlashCommand[]
  /** 当前高亮的下标 */
  activeIndex: number
  /** 已勾选的 skill 名字——在菜单里标出来，免得看不出自己勾了哪些 */
  selectedSkills: string[]
  onSelect: (command: SlashCommand) => void
  onHover: (index: number) => void
}

export function SlashCommandMenu({
  commands,
  activeIndex,
  selectedSkills,
  onSelect,
  onHover,
}: Props) {
  if (commands.length === 0) return null

  return (
    <div
      className="absolute bottom-full left-0 z-10 mb-2 w-full max-w-md overflow-hidden rounded-xl border border-line bg-surface shadow-xl"
      role="listbox"
      aria-label="命令列表"
    >
      <div className="border-b border-line px-3 py-1.5 text-[11px] text-fg-muted">
        命令与技能
      </div>
      <ul>
        {commands.map((command, index) => {
          const isSkill = command.kind === 'skill'
          const skillName = isSkill ? command.command.slice(1) : ''
          const isSelected = isSkill && selectedSkills.includes(skillName)
          return (
            // 命令和 skill 可能重名（`/compaction` 既可能是命令也可能是技能），
            // 所以 key 带上类别，否则两行会撞 key。
            <li key={`${command.kind ?? 'command'}:${command.command}`}>
              <button
                type="button"
                role="option"
                aria-selected={index === activeIndex}
                onMouseEnter={() => onHover(index)}
                onClick={() => onSelect(command)}
                className={cn(
                  'w-full px-3 py-2 text-left transition-colors',
                  index === activeIndex ? 'bg-raised' : 'hover:bg-raised',
                )}
              >
                <div className="flex items-center gap-2">
                  <span className="font-mono text-[13px] text-fg">{command.command}</span>
                  {isSkill && (
                    <span className="rounded border border-line px-1 text-[10px] text-fg-muted">
                      {command.scope === 'user' ? '全局' : '项目'}
                    </span>
                  )}
                  {isSelected && (
                    <span className="rounded bg-accent/15 px-1 text-[10px] text-accent">
                      已选
                    </span>
                  )}
                </div>
                <div className="mt-0.5 text-[11px] leading-relaxed text-fg-muted">
                  {command.description}
                </div>
              </button>
            </li>
          )
        })}
      </ul>
    </div>
  )
}
