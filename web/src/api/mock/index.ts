/**
 * Mock 后端适配器。
 *
 * 总体设计文档的 P0（后端 Agent 骨架）还没做，而这套 UI 的大部分逻辑
 * ——流式追加、工具卡片状态流转、todo 同步、diff 渲染、停止生成——都只在
 * 「有事件流进来」时才跑得起来。所以这里按与真实后端完全相同的接口签名，
 * 用脚本化的假事件把这些路径先点亮。
 *
 * 启用方式：`.env.local` 里设 `VITE_USE_MOCK=true`。生产构建默认关闭。
 */
import type { RunHandlers } from '../run'
import type { DirectoryListing } from '../directory'
import { permissionMeta } from '../../lib/permissions'
import type { RunOptions, Thread, Todo } from '../types'

/* ------------------------------------------------------------ 内存态 */

let seq = 0
const nextId = (prefix: string) => `${prefix}-${++seq}`

const threads = new Map<string, Thread>()
/** thread_id -> LangChain 原始消息数组，形状与真实 /state 的 values.messages 一致 */
const rawMessages = new Map<string, unknown[]>()
const todosByThread = new Map<string, Todo[]>()

function seed() {
  const id = 'thread-demo-1'
  const now = new Date(Date.now() - 1000 * 60 * 18).toISOString()
  threads.set(id, {
    thread_id: id,
    title: '给 README 补一个安装检查清单',
    created_at: now,
    updated_at: new Date(Date.now() - 1000 * 60 * 12).toISOString(),
  })
  rawMessages.set(id, [
    { type: 'human', id: 'm1', content: '帮我看看 README 里快速开始那节有没有漏步骤' },
    {
      type: 'ai',
      id: 'm2',
      content: '我读一下 README 的快速开始部分。',
      tool_calls: [
        { id: 'c1', name: 'read_file', args: { file_path: '/README.md', offset: 60, limit: 40 } },
      ],
    },
    {
      type: 'tool',
      id: 'm3',
      tool_call_id: 'c1',
      name: 'read_file',
      content: '## 快速开始\n\n```bash\nuv sync\nuv run scode\n```\n\n---\n',
    },
    {
      type: 'ai',
      id: 'm4',
      content: '确实少了一步：`uv sync` 之前需要先 `uv add deepagents python-dotenv`，否则 `main.py` 里的导入会失败。\n\n要我补上吗？',
    },
  ])
  todosByThread.set(id, [
    { content: '通读 README 快速开始章节', status: 'completed', toolCallId: 'c1' },
    { content: '补上依赖安装步骤', status: 'in_progress' },
    { content: '同步更新 README 项目结构说明', status: 'pending' },
  ])
}
seed()

/* ---------------------------------------------------------------- 线程 */

export const mockThreads = {
  create(): Thread {
    const id = nextId('thread')
    const now = new Date().toISOString()
    const thread: Thread = { thread_id: id, title: '新任务', created_at: now, updated_at: now }
    threads.set(id, thread)
    rawMessages.set(id, [])
    todosByThread.set(id, [])
    return thread
  },

  list(): Thread[] {
    return [...threads.values()].sort((a, b) => b.updated_at.localeCompare(a.updated_at))
  },

  async remove(threadId: string): Promise<void> {
    threads.delete(threadId)
    rawMessages.delete(threadId)
    todosByThread.delete(threadId)
  },

  state(threadId: string): unknown {
    return { values: { messages: rawMessages.get(threadId) ?? [] }, next: [], tasks: [] }
  },
}

/* -------------------------------------------------------------- 目录浏览 */

/** 假文件系统，只为让文件夹选择器能跑起来；真实目录由后端列 */
const MOCK_FS: Record<string, string[]> = {
  '/': ['Applications', 'Library', 'System', 'Users', 'Volumes'],
  '/Applications': ['Safari.app', 'Utilities'],
  '/Library': ['Fonts'],
  '/System': ['Library'],
  '/Users': ['Shared', '1token'],
  '/Users/Shared': [],
  '/Users/1token': ['Desktop', 'Documents', 'Downloads', 'Movies'],
  '/Users/1token/Desktop': ['project', 'screenshots'],
  '/Users/1token/Desktop/project': ['stupid-code', 'notes-site'],
  '/Users/1token/Desktop/project/stupid-code': ['docs', 'stupid_code', 'web'],
  '/Users/1token/Desktop/project/stupid-code/docs': [],
  '/Users/1token/Desktop/project/stupid-code/stupid_code': [],
  '/Users/1token/Desktop/project/stupid-code/web': ['src', 'public'],
  '/Users/1token/Desktop/project/stupid-code/web/src': [],
  '/Users/1token/Desktop/project/stupid-code/web/public': [],
  '/Users/1token/Desktop/project/notes-site': ['src'],
  '/Users/1token/Desktop/project/notes-site/src': [],
  '/Users/1token/Desktop/screenshots': [],
  '/Users/1token/Documents': ['receipts'],
  '/Users/1token/Documents/receipts': [],
  '/Users/1token/Downloads': [],
  '/Users/1token/Movies': [],
  '/Volumes': [],
}

function normalizePath(path: string): string {
  const trimmed = path.trim().replace(/\/+$/, '')
  if (trimmed === '' || trimmed === '/') return '/'
  return trimmed.startsWith('/') ? trimmed : `/${trimmed}`
}

export async function mockBrowseDirectories(path?: string): Promise<DirectoryListing> {
  const current = normalizePath(path ?? '/')
  const names = MOCK_FS[current]
  if (!names) {
    throw new Error(`mock 文件系统里没有 ${current}`)
  }

  return {
    path: current,
    parent: current === '/' ? null : normalizePath(current.slice(0, current.lastIndexOf('/')) || '/'),
    directories: names
      .filter((name) => MOCK_FS[`${current === '/' ? '' : current}/${name}`] !== undefined)
      .map((name) => ({ name, path: `${current === '/' ? '' : current}/${name}` }))
      .sort((a, b) => a.name.localeCompare(b.name)),
  }
}

/* ---------------------------------------------------------------- 运行 */

const sleep = (ms: number, signal?: AbortSignal) =>
  new Promise<void>((resolve) => {
    const timer = setTimeout(resolve, ms)
    signal?.addEventListener('abort', () => {
      clearTimeout(timer)
      resolve()
    })
  })

const SAMPLE_FILE = `import { createDeepAgent } from 'deepagents'

export const code_agent = createDeepAgent({
  tools: [bash, git],
  systemPrompt: '你是一个编码助手',
})
`

interface Step {
  kind: 'text' | 'tool' | 'pause'
  text?: string
  name?: string
  args?: Record<string, unknown>
  output?: string
}

/** 根据用户输入挑一段脚本，够演示所有渲染分支 */
function scriptFor(prompt: string): Step[] {
  const isEdit = /改|加|补|修|实现|写/.test(prompt)
  const base: Step[] = [
    { kind: 'text', text: '我先看一下相关文件再动手。\n\n' },
    {
      kind: 'tool',
      name: 'write_todos',
      args: {
        todos: [
          { content: '读取目标文件', status: 'in_progress' },
          { content: '按需求修改并验证', status: 'pending' },
        ],
      },
      output: 'Todos have been modified successfully.',
    },
    {
      kind: 'tool',
      name: 'read_file',
      args: { file_path: '/stupid_code/agent.py' },
      output: SAMPLE_FILE,
    },
    {
      kind: 'text', text: '\n\n文件结构符合预期，接下来' },
  ]

  if (!isEdit) {
    base.push({
      kind: 'tool',
      name: 'grep',
      args: { pattern: 'create_deep_agent', path: '/' },
      output: 'stupid_code/agent.py:3:export const code_agent = createDeepAgent({',
    })
    base.push({
      kind: 'text',
      text: '\n\n`create_deep_agent` 只在 `stupid_code/agent.py` 里调用了一处。你想让我做点什么？',
    })
    return base
  }

  base.push({
    kind: 'text',
    text: '\n\n我会把模型和工具拆成独立配置：\n\n',
  })
  base.push({
    kind: 'tool',
    name: 'write_file',
    args: {
      file_path: '/stupid_code/agent.py',
      // 带上旧内容，前端才能渲染出真正的「改了几行」而不是整篇新增
      oldContent: SAMPLE_FILE,
      content: `${SAMPLE_FILE}export const DEFAULT_MODEL = 'claude-sonnet-5'\n`,
    },
    output: 'Successfully wrote 9 lines to /stupid_code/agent.py',
  })
  base.push({
    kind: 'text',
    text: '\n\n接着跑一下测试确认没写坏：\n\n',
  })
  base.push({
    kind: 'tool',
    name: 'bash',
    args: { command: 'uv run pytest -q' },
    output: '.........                                                     [100%]\n9 passed in 2.41s',
  })
  // 收尾时把任务列表全部标记完成，否则侧边栏会一直转圈
  base.push({
    kind: 'tool',
    name: 'write_todos',
    args: {
      todos: [
        { content: '读取目标文件', status: 'completed' },
        { content: '按需求修改并验证', status: 'completed' },
      ],
    },
    output: 'Todos have been modified successfully.',
  })
  base.push({
    kind: 'text',
    text: '\n\n改完了：`DEFAULT_MODEL` 已独立导出，9 个测试全部通过。',
  })
  return base
}

export const mockRuns = {
  stream(
    threadId: string,
    message: string,
    options: RunOptions,
    handlers: RunHandlers,
  ): () => void {
    const controller = new AbortController()
    const signal = controller.signal
    const raw = rawMessages.get(threadId) ?? []
    const now = new Date().toISOString()

    void (async () => {
      handlers.onRunId?.(nextId('run'))

      raw.push({ type: 'human', id: nextId('m'), content: message, created_at: now })

      // 一轮运行对应一条 ai 消息，文本与 tool_calls 都挂在它身上，
      // 这样 /state 的形状与真实后端一致（restoreMessages 依赖它回填工具结果）
      let ai: Record<string, unknown> | null = null
      const ensureAi = (): Record<string, unknown> => {
        if (!ai) {
          ai = {
            type: 'ai',
            id: nextId('m'),
            content: '',
            tool_calls: [],
            created_at: now,
          }
          raw.push(ai)
        }
        return ai
      }

      const emitText = async (text: string, delayMs: number) => {
        const target = ensureAi()
        target.content = `${String(target.content ?? '')}${text}`
        for (const ch of text) {
          if (signal.aborted) break
          handlers.onToken(ch)
          await sleep(delayMs, signal)
        }
      }

      for (const step of scriptFor(message)) {
        if (signal.aborted) break

        if (step.kind === 'text') {
          await emitText(step.text ?? '', 12)
          continue
        }

        if (step.kind === 'tool') {
          const callId = nextId('c')
          const name = step.name ?? 'unknown'
          const args = step.args ?? {}

          handlers.onToolCall({ id: callId, name, args, status: 'running', startedAt: Date.now() })
          await sleep(500, signal)
          if (signal.aborted) break

          const output = step.output ?? ''
          handlers.onToolResult({ id: callId, output })

          if (name === 'write_todos') {
            const todos = Array.isArray(args.todos) ? (args.todos as Todo[]) : []
            if (todos.length) {
              todosByThread.set(threadId, todos)
              handlers.onTodos(todos)
            }
          }

          const target = ensureAi()
          const calls = (target.tool_calls as unknown[]) ?? []
          calls.push({ id: callId, name, args })
          target.tool_calls = calls

          raw.push({
            type: 'tool',
            id: nextId('m'),
            tool_call_id: callId,
            name,
            content: output,
            created_at: now,
          })
        }
      }

      // 收尾时把本次运行的边界说清楚，顺便验证参数确实传到了后端
      await emitText(
        `\n\n本次运行：${permissionMeta(options.permissions).description}；` +
          `工作空间 ${options.workspace || '未选择'}。`,
        6,
      )

      if (ai) raw.push(ai)
      rawMessages.set(threadId, raw)

      const existing = threads.get(threadId)
      if (existing) {
        existing.title = existing.title === '新任务' ? message.slice(0, 24) || '新任务' : existing.title
        existing.updated_at = new Date().toISOString()
      } else {
        threads.set(threadId, {
          thread_id: threadId,
          title: message.slice(0, 24) || '新任务',
          created_at: now,
          updated_at: new Date().toISOString(),
        })
      }

      handlers.onEnd()
    })()

    return () => controller.abort()
  },
}
