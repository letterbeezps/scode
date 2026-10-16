/**
 * 空状态：欢迎语 + 快捷指令卡片（前端设计文档 3.2）。
 *
 * 卡片内容按当前项目（stupid-code，一个 Deep Agents 学习项目）定制，
 * 点一下就把 prompt 填进输入区，不直接发送——让用户先能改。
 */
import { FileCode2, GitBranch, TerminalSquare, TestTube2 } from 'lucide-react'

const SUGGESTIONS = [
  {
    icon: FileCode2,
    title: '梳理代码结构',
    prompt: '读一下 stupid_code 目录，梳理一下当前项目的模块划分和入口。',
  },
  {
    icon: GitBranch,
    title: '准备一次改动',
    prompt: '我准备给 stupid_code 加一个自定义工具，先帮我列一份改动清单。',
  },
  {
    icon: TerminalSquare,
    title: '排查构建问题',
    prompt: '帮我看看 uv run pytest 报错该怎么修。',
  },
  {
    icon: TestTube2,
    title: '补测试',
    prompt: '给 stupid_code 现有的 main.py 补一组单元测试。',
  },
]

export function EmptyState({ onPick }: { onPick: (prompt: string) => void }) {
  return (
    <div className="flex h-full flex-col items-center justify-center px-6 py-12">
      <h1 className="text-xl font-semibold text-fg">stupid-code</h1>
      <p className="mt-1.5 max-w-md text-center text-sm leading-relaxed text-fg-muted">
        基于 Deep Agents 的 code agent 网页前端。让我读代码、改文件、跑命令。
      </p>

      {/* 主区被侧边栏挤窄后两列很挤，用 lg 而不是 sm 断点 */}
      <div className="mt-8 grid w-full max-w-2xl grid-cols-1 gap-2 lg:grid-cols-2">
        {SUGGESTIONS.map((item) => {
          const Icon = item.icon
          return (
            <button
              key={item.title}
              type="button"
              onClick={() => onPick(item.prompt)}
              className="flex items-start gap-3 rounded-lg border border-line bg-surface p-3 text-left transition-colors hover:border-accent hover:bg-raised"
            >
              <Icon className="mt-0.5 size-4 shrink-0 text-fg-muted" />
              <span className="min-w-0">
                <span className="block text-sm font-medium text-fg">{item.title}</span>
                <span className="mt-0.5 block text-xs leading-relaxed text-fg-muted">
                  {item.prompt}
                </span>
              </span>
            </button>
          )
        })}
      </div>
    </div>
  )
}
