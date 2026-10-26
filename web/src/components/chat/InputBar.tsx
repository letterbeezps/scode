/**
 * 输入区（前端设计文档 3.3）。
 *
 * Enter 发送 / Shift+Enter 换行；生成中发送按钮变成停止按钮。
 * 文本框自适应高度，但超过上限后内部滚动，避免挤掉消息列表。
 *
 * **斜杠菜单**：开头敲 `/` 弹出列表（↑↓ 选、回车确认、Esc 关闭），里面混着
 * 两类东西：
 * - **命令**（`/compaction`）：选中后把命令当普通消息发出去——后端认出命令
 *   就执行对应动作，所以加新命令不需要新的接口。
 * - **skill**（`/<skill 名>`）：**不发送**，只是把这个 skill 勾进本次对话
 *   （勾选的会被钉进上下文）。选中后输入框清空，可以接着敲 `/`
 *   再选一个——所以支持选多个。
 */
import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import { Brain, CornerDownLeft, Send, Square, X } from 'lucide-react'
import { cn } from '../../lib/cn'
import { SLASH_COMMANDS, skillToMenuItem, type SlashCommand } from '../../lib/commands'
import { SlashCommandMenu } from './SlashCommandMenu'
import { WorkspacePicker } from './WorkspacePicker'
import { PermissionPicker } from './PermissionPicker'
import { MemoryPanel } from '../memory/MemoryPanel'
import { useConversationStore } from '../../store/conversationStore'
import { useTaskSettings, useTaskStore } from '../../store/taskStore'
import { getSkills } from '../../api/skills'
import type { SkillInfo } from '../../api/types'

const MAX_HEIGHT_PX = 200

interface Props {
  value: string
  onChange: (value: string) => void
  /** 发送指定内容（斜杠命令走这里，命令文本不一定等于输入框里的内容） */
  onSend: (text: string) => void
  onStop: () => void
  isGenerating: boolean
  disabled?: boolean
  /** 当前任务 id，决定工作空间与权限写到哪一份设置上 */
  threadId: string | null
  placeholder?: string
}

/**
 * 从输入内容里解析出「正在敲的命令」。
 *
 * 只有**开头**是 `/`、且还没打出空格时才算在敲命令：
 * 这样 `/usr/local/bin` 这种路径不会误弹菜单（也匹配不上任何命令）。
 */
function parseCommandQuery(text: string): string | null {
  const trimmed = text.trimStart()
  if (!trimmed.startsWith('/')) return null
  if (trimmed.includes(' ') || trimmed.includes('\n')) return null
  return trimmed.slice(1)
}

export function InputBar({
  value,
  onChange,
  onSend,
  onStop,
  isGenerating,
  disabled,
  threadId,
  placeholder = '描述你的任务…',
}: Props) {
  const textareaRef = useRef<HTMLTextAreaElement | null>(null)
  const [activeIndex, setActiveIndex] = useState(0)
  const [dismissed, setDismissed] = useState(false)
  /** 记忆面板开没开 */
  const [memoryOpen, setMemoryOpen] = useState(false)
  /** 可用的 skill（斜杠菜单里列出来） */
  const [skills, setSkills] = useState<SkillInfo[]>([])
  /** 审批卡片挂着时任务参数不能改：恢复请求会原样带回 workspace / permissions */
  const approvalPending = useConversationStore((s) => s.pendingApproval !== null)
  /** 项目级记忆和项目级 skill 都跟着当前任务的工作空间走 */
  const { workspace, skills: selectedSkills } = useTaskSettings(threadId)

  // skill 清单：项目级的那份跟着工作空间走，工作空间变了要重新取。
  // 放在 effect 里，但 setState 都在 await 之后——直接在 effect 体里调
  // 会被 oxlint 的 set-state-in-effect 盯上（它不做控制流分析，只看到
  // 「effect 里调了一个会 setState 的函数」）。
  useEffect(() => {
    let cancelled = false
    void (async () => {
      try {
        const res = await getSkills(workspace)
        if (!cancelled) setSkills(res.skills)
      } catch {
        // 取不到就当没有 skill：菜单里只剩命令，不影响对话
        if (!cancelled) setSkills([])
      }
    })()
    return () => {
      cancelled = true
    }
  }, [workspace])

  // 高度跟随内容，但封顶后交给内部滚动
  useLayoutEffect(() => {
    const el = textareaRef.current
    if (!el) return
    el.style.height = 'auto'
    el.style.height = `${Math.min(el.scrollHeight, MAX_HEIGHT_PX)}px`
    el.style.overflowY = el.scrollHeight > MAX_HEIGHT_PX ? 'auto' : 'hidden'
  }, [value])

  // 发送后把焦点还回输入框，连续对话不用重新点
  useEffect(() => {
    if (!isGenerating && value === '') textareaRef.current?.focus()
  }, [isGenerating, value])

  const query = parseCommandQuery(value)

  // 菜单项 = 命令 + skill。已经勾选的 skill 仍然列出来（标成「已选」），
  // 再敲一次就是取消勾选。
  const menuItems = useMemo<SlashCommand[]>(
    () => [...SLASH_COMMANDS, ...skills.map(skillToMenuItem)],
    [skills],
  )

  const matched = useMemo(() => {
    if (query === null) return []
    return menuItems.filter((c) => c.command.slice(1).startsWith(query))
  }, [query, menuItems])

  const menuOpen = matched.length > 0 && !dismissed && !isGenerating

  const canSend = value.trim().length > 0 && !isGenerating && !disabled

  const handleChange = (next: string) => {
    setDismissed(false)
    // 敲的内容变了，高亮回到第一条
    setActiveIndex(0)
    onChange(next)
  }

  /** 勾上/取消勾一个 skill。**不发送消息**——skill 不是命令。 */
  const toggleSkill = (name: string) => {
    // 审批挂起时不能改任务参数：恢复请求会原样带回这一组值
    // （workspace / permissions / skills），改了批准的就不是同一件事了。
    if (isGenerating || disabled || approvalPending) return
    const current = useTaskStore.getState().resolve(threadId)
    const next = current.skills.includes(name)
      ? current.skills.filter((s) => s !== name)
      : [...current.skills, name]
    useTaskStore.getState().update(threadId, { skills: next })
    // 菜单留着，用户可以接着敲 `/` 再选一个
    setDismissed(false)
  }

  const selectCommand = (command: SlashCommand) => {
    if (isGenerating || disabled) return
    if (command.kind === 'skill') {
      // skill：勾进本次对话。输入框清空——刚才敲的是筛选词不是消息，
      // 留着它菜单会一直开着；清空后可以接着敲 `/` 再选一个。
      toggleSkill(command.command.slice(1))
      onChange('')
      return
    }
    onSend(command.command)
  }

  const handleKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    // IME 组字期间回车是选词不是发送，中文输入必须避开这一下
    if (e.nativeEvent.isComposing) return

    if (menuOpen) {
      if (e.key === 'ArrowDown') {
        e.preventDefault()
        setActiveIndex((i) => (i + 1) % matched.length)
        return
      }
      if (e.key === 'ArrowUp') {
        e.preventDefault()
        setActiveIndex((i) => (i - 1 + matched.length) % matched.length)
        return
      }
      if (e.key === 'Escape') {
        e.preventDefault()
        setDismissed(true)
        return
      }
      if ((e.key === 'Enter' || e.key === 'Tab') && !e.shiftKey) {
        e.preventDefault()
        const command = matched[activeIndex]
        if (command) selectCommand(command)
        return
      }
    }

    if (e.key === 'Enter' && !e.shiftKey && !e.altKey) {
      e.preventDefault()
      if (canSend) onSend(value)
    }
  }

  return (
    <div className="shrink-0 border-t border-line bg-bg px-4 py-3">
      <div className="mx-auto w-full max-w-4xl">
        {/* 已勾选的 skill：显示成 chip，点 × 取消。钉进上下文的那几份，
            名字也标在菜单里（能看到自己勾了哪些）。 */}
        {selectedSkills.length > 0 && (
          <div className="mb-2 flex flex-wrap items-center gap-1.5">
            <span className="text-[11px] text-fg-muted">已选技能</span>
            {selectedSkills.map((name) => (
              <span
                key={name}
                className="flex items-center gap-1 rounded-md border border-accent/50 bg-accent/10 px-1.5 py-0.5 text-[11px] text-fg"
              >
                {name}
                <button
                  type="button"
                  onClick={() => toggleSkill(name)}
                  disabled={isGenerating || disabled || approvalPending}
                  aria-label={`取消选择技能 ${name}`}
                  className="text-fg-muted transition-colors hover:text-fg disabled:opacity-50"
                >
                  <X className="size-3" />
                </button>
              </span>
            ))}
          </div>
        )}

        <div className="relative">
          <SlashCommandMenu
            commands={matched}
            activeIndex={activeIndex}
            selectedSkills={selectedSkills}
            onSelect={selectCommand}
            onHover={setActiveIndex}
          />

          <div
            className={cn(
              'flex items-end gap-2 rounded-xl border bg-surface px-3 py-2 transition-colors',
              'focus-within:border-accent',
            )}
          >
            <textarea
              ref={textareaRef}
              value={value}
              onChange={(e) => handleChange(e.target.value)}
              onKeyDown={handleKeyDown}
              disabled={disabled}
              rows={1}
              placeholder={placeholder}
              aria-label="输入消息"
              className="max-h-[200px] min-h-[24px] flex-1 resize-none bg-transparent py-1 text-[14px] leading-6 text-fg placeholder:text-fg-muted focus:outline-none disabled:opacity-50"
            />

            {isGenerating ? (
              <button
                type="button"
                onClick={onStop}
                aria-label="停止生成"
                className="flex size-8 shrink-0 items-center justify-center rounded-lg bg-surface text-fg transition-colors hover:bg-raised"
              >
                <Square className="size-3.5 fill-current" />
              </button>
            ) : (
              <button
                type="button"
                onClick={() => canSend && onSend(value)}
                disabled={!canSend}
                aria-label="发送"
                className={cn(
                  'flex size-8 shrink-0 items-center justify-center rounded-lg transition-colors',
                  canSend
                    ? 'bg-accent text-bg hover:opacity-90'
                    : 'cursor-not-allowed bg-surface text-fg-muted',
                )}
              >
                <Send className="size-3.5" />
              </button>
            )}
          </div>
        </div>

        <div className="mt-2 flex flex-wrap items-center gap-2 px-1">
          <WorkspacePicker threadId={threadId} disabled={isGenerating || approvalPending} />
          <PermissionPicker threadId={threadId} disabled={isGenerating || approvalPending} />
          <button
            type="button"
            onClick={() => setMemoryOpen(true)}
            title="查看和编辑 agent 的长期记忆（用户级 + 项目级）"
            className="flex items-center gap-1.5 rounded-md border border-line bg-surface px-2 py-1.5 text-[11px] text-fg-muted transition-colors hover:border-accent/60 hover:text-fg"
          >
            <Brain className="size-3.5" />
            记忆
          </button>
          <p className="ml-auto flex items-center gap-1 text-[11px] text-fg-muted">
            <CornerDownLeft className="size-3" />
            Enter 发送 · Shift+Enter 换行 · <span className="font-mono">/</span> 命令与技能
          </p>
        </div>
      </div>

      {memoryOpen && (
        <MemoryPanel workspace={workspace} onClose={() => setMemoryOpen(false)} />
      )}
    </div>
  )
}
