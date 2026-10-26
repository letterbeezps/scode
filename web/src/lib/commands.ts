/**
 * 斜杠命令：输入框里敲 `/` 弹出的下拉列表。
 *
 * 列表里混着两种东西：
 *
 * - **命令**（`/compaction`）：命令本体就是一条**普通消息**——前端把它当普通
 *   消息发出去，后端认出命令就执行对应动作。所以加新命令不需要新的接口，
 *   只需要在这里加一条，再在后端认出它。
 * - **skill**（`/<skill 名>`）：**不是消息**。选中它只是把这个 skill 勾进
 *   本次对话（勾选的会被钉进上下文），输入框里的文字不动。
 *
 * 后端认哪个命令：见后端 `stupid_code/graph/compaction.py` 的 `COMPACTION_COMMAND`。
 * 两边的字面量要一致，改一边记得改另一边。
 */
import type { SkillInfo, SkillScope } from '../api/types'

export interface SlashCommand {
  /** 命令本体，含开头的斜杠。发给后端的就是它（skill 除外——skill 不发送） */
  command: string
  /** 下拉列表里的标题 */
  title: string
  /** 一句话说明这个命令干什么 */
  description: string
  /** 命令还是 skill。默认按命令处理 */
  kind?: 'command' | 'skill'
  /** skill 的作用域（只有 kind === 'skill' 时有） */
  scope?: SkillScope
}

export const SLASH_COMMANDS: SlashCommand[] = [
  {
    command: '/compaction',
    title: '压缩对话历史',
    description: '把之前的对话总结成一段摘要，释放上下文窗口（旧消息会存成文件，需要时还能读回来）',
    kind: 'command',
  },
]

/**
 * 把一个 skill 变成菜单里的一项。
 *
 * 显示成 `/<skill 名>`——跟通用 code agent 的习惯一致：敲 `/` 就能选技能。
 */
export function skillToMenuItem(skill: SkillInfo): SlashCommand {
  return {
    command: `/${skill.name}`,
    title: skill.name,
    description: skill.description,
    kind: 'skill',
    scope: skill.scope,
  }
}

/**
 * 判断一条消息是不是斜杠命令。
 *
 * 用来把命令渲染成「命令气泡」而不是普通聊天气泡——`/compaction` 显示成一句话
 * 看着像用户在说胡话。
 */
export function isSlashCommand(content: string): boolean {
  const text = content.trim()
  return SLASH_COMMANDS.some((cmd) => cmd.command === text)
}
