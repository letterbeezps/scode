/**
 * 斜杠命令下拉菜单。
 *
 * 出现在输入框上方（不遮消息列表）。当前高亮的那条由键盘 ↑↓ 控制，
 * 回车/Tab 或点击都算选中。
 */
import { SLASH_COMMANDS, type SlashCommand } from '../../lib/commands'
import { cn } from '../../lib/cn'

interface Props {
  /** 过滤后命中的命令 */
  commands: SlashCommand[]
  /** 当前高亮的下标 */
  activeIndex: number
  onSelect: (command: SlashCommand) => void
  onHover: (index: number) => void
}

export function SlashCommandMenu({ commands, activeIndex, onSelect, onHover }: Props) {
  if (commands.length === 0) return null

  return (
    <div
      className="absolute bottom-full left-0 z-10 mb-2 w-full max-w-md overflow-hidden rounded-xl border border-line bg-surface shadow-xl"
      role="listbox"
      aria-label="命令列表"
    >
      <div className="border-b border-line px-3 py-1.5 text-[11px] text-fg-muted">命令</div>
      <ul>
        {commands.map((command, index) => (
          <li key={command.command}>
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
              <div className="font-mono text-[13px] text-fg">{command.command}</div>
              <div className="mt-0.5 text-[11px] leading-relaxed text-fg-muted">
                {command.description}
              </div>
            </button>
          </li>
        ))}
      </ul>
    </div>
  )
}

export { SLASH_COMMANDS }
