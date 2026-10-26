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
import type { PickWorkspaceResult } from '../workspace'
import { permissionMeta } from '../../lib/permissions'
import { ApiError } from '../client'
import type {
  AdminModel,
  MemoryResponse,
  MemorySaveInput,
  MemorySaveResult,
  SkillInfo,
  SkillListResponse,
  ModelCreateInput,
  ModelCreateResult,
  ModelDeleteResult,
  ModelListResponse,
  ModelUpdateInput,
  ModelUpdateResult,
  RunOptions,
  Thread,
  Todo,
} from '../types'

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
    const thread: Thread = { thread_id: id, title: '', created_at: now, updated_at: now }
    threads.set(id, thread)
    rawMessages.set(id, [])
    todosByThread.set(id, [])
    return thread
  },

  list(): Thread[] {
    return [...threads.values()].sort((a, b) => b.updated_at.localeCompare(a.updated_at))
  },

  /** 对应 PATCH /threads/{id}：把标题写进 metadata */
  update(threadId: string, metadata: Record<string, unknown>): Thread {
    const thread = threads.get(threadId)
    if (!thread) {
      const message = `线程 ${threadId} 不存在`
      throw new ApiError(message, 404, { detail: message })
    }
    const merged = { ...(thread.metadata ?? {}), ...metadata }
    const next: Thread = {
      ...thread,
      title: typeof merged.title === 'string' ? merged.title : thread.title,
      metadata: merged,
      updated_at: new Date().toISOString(),
    }
    threads.set(threadId, next)
    return next
  },

  async remove(threadId: string): Promise<void> {
    threads.delete(threadId)
    rawMessages.delete(threadId)
    todosByThread.delete(threadId)
  },

  state(threadId: string): unknown {
    return {
      values: { messages: rawMessages.get(threadId) ?? [] },
      next: [],
      tasks: [],
      interrupts: [],
    }
  },
}

/* ------------------------------------------------------------ 目录选择 */

/**
 * mock 的目录选择框：模拟后端弹系统窗口后返回一个绝对路径。
 *
 * 真实后端（POST /workspaces/pick）会弹系统的文件浏览窗口，用户选完才返回。
 * mock 这里直接给一个假路径，让 UI 流程能跑通。
 */
export async function mockPickWorkspace(): Promise<PickWorkspaceResult> {
  await sleep(300)
  return { path: '/Users/1token/Desktop/project/stupid-code', cancelled: false }
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

      // 勾选的 skill 会被后端**钉进上下文**（SKILL.md 全文进对话历史）。
      // mock 里回显一下，让前端开发时能看出勾选确实随请求发出去了。
      if (options.skills.length > 0) {
        await emitText(
          `（mock）已把 ${options.skills.join('、')} 的 SKILL.md 全文钉进上下文。\n\n`,
          8,
        )
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
          `工作空间 ${options.workspace || '未选择'}；` +
          `模型 ${options.model || '后端默认'}。`,
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

/* ------------------------------------------------------------ 模型管理 */

/**
 * conf/config.toml 的内存镜像，按真实后端 config.py 的语义实现：
 *
 * - provider 分组保存连接字段，但接口层摊平成「每个模型自带全部字段」
 * - api_key 脱敏规则同款：长度 ≤4 显示 ****，否则 ***末4位
 * - 新增时 provider 已存在则校验 protocol / base_url 一致，否则报 ConfigError
 * - PUT 只写 body 里出现的字段；连接字段是供应商级的，所以 co_affected 是整段
 * - 删完某个供应商的 models[] 为空时自动清理该段
 * - 删模型**不会**调整 default / recent（与真实后端一致），留给 UI 提示
 */
interface MockProvider {
  protocol: AdminModel['protocol']
  display_name?: string | null
  base_url?: string | null
  api_key: string
  models: string[]
}

const mockConfig: { default: string | null; recent: string | null; providers: Record<string, MockProvider> } = {
  default: 'minimax:MiniMax-M3',
  recent: 'minimax:MiniMax-M3',
  providers: {
    minimax: {
      protocol: 'anthropic',
      display_name: 'MiniMax',
      base_url: 'https://api.minimax.cn/anthropic',
      api_key: 'sk-mock-minimax-1234',
      models: ['MiniMax-M3', 'MiniMax-M2.5'],
    },
    deepseek: {
      protocol: 'openai',
      display_name: 'DeepSeek',
      base_url: 'https://api.deepseek.com',
      api_key: 'sk-mock-deepseek-5678',
      models: ['deepseek-chat'],
    },
  },
}

function mockMask(key: string): string {
  return key.length <= 4 ? '****' : `***${key.slice(-4)}`
}

function mockConfigError(message: string): never {
  // 与 request() 抛出的是同一种错误，上层的错误处理只需要认 ApiError
  throw new ApiError(message, 400, { error: message })
}

function mockParseId(modelId: string): { provider: string; model: string } {
  const [provider, ...rest] = modelId.split(':')
  const model = rest.join(':')
  if (!provider || !model) {
    mockConfigError(`模型 ID '${modelId}' 不合法，应为 "供应商名:模型名"`)
  }
  return { provider, model }
}

function mockToModel(providerName: string, p: MockProvider, model: string, reveal: boolean): AdminModel {
  return {
    id: `${providerName}:${model}`,
    name: model,
    provider: providerName,
    protocol: p.protocol,
    display_name: p.display_name ?? null,
    base_url: p.base_url ?? null,
    api_key: reveal ? p.api_key : mockMask(p.api_key),
  }
}

export const mockAdminModels = {
  async list(reveal = false): Promise<ModelListResponse> {
    const models: AdminModel[] = []
    for (const [name, p] of Object.entries(mockConfig.providers)) {
      for (const model of p.models) models.push(mockToModel(name, p, model, reveal))
    }
    return {
      default: mockConfig.default,
      recent: mockConfig.recent,
      models,
      restart_required: true,
    }
  },

  async get(id: string, reveal = false): Promise<AdminModel> {
    const { provider, model } = mockParseId(id)
    const p = mockConfig.providers[provider]
    if (!p || !p.models.includes(model)) {
      const message = `模型 '${id}' 不存在`
      throw new ApiError(message, 404, { error: message })
    }
    return mockToModel(provider, p, model, reveal)
  },

  async create(body: ModelCreateInput): Promise<ModelCreateResult> {
    const name = body?.name
    if (!name) mockConfigError('name 必填（模型名）')
    if (body.protocol !== 'anthropic' && body.protocol !== 'openai') {
      mockConfigError(`protocol 只支持 anthropic / openai，当前为 '${body.protocol}'`)
    }
    if (!body.provider) mockConfigError('provider 必填（供应商名）')
    if (!body.api_key) mockConfigError(`api_key 必填（模型 ${name}）`)

    const existing = mockConfig.providers[body.provider]
    if (!existing) {
      mockConfig.providers[body.provider] = {
        protocol: body.protocol,
        display_name: body.display_name ?? null,
        base_url: body.base_url ?? null,
        api_key: body.api_key,
        models: [name],
      }
      return { id: `${body.provider}:${name}`, created: true, restart_required: true }
    }

    if (existing.protocol !== body.protocol) {
      mockConfigError(
        `供应商 '${body.provider}' 已存在且 protocol='${existing.protocol}'，` +
          `与请求 '${body.protocol}' 不一致`,
      )
    }
    if (body.base_url && existing.base_url && body.base_url !== existing.base_url) {
      mockConfigError(
        `供应商 '${body.provider}' 已存在且 base_url='${existing.base_url}'，` +
          `与请求 '${body.base_url}' 不一致（要改用 PUT）`,
      )
    }
    if (existing.models.includes(name)) mockConfigError(`模型 ${body.provider}:${name} 已存在`)
    existing.models.push(name)
    return { id: `${body.provider}:${name}`, created: true, restart_required: true }
  },

  async update(id: string, body: ModelUpdateInput): Promise<ModelUpdateResult> {
    const { provider, model } = mockParseId(id)
    const p = mockConfig.providers[provider]
    if (!p || !p.models.includes(model)) {
      const message = `模型 '${id}' 不存在`
      throw new ApiError(message, 404, { error: message })
    }

    if (body.protocol !== undefined) {
      if (body.protocol !== 'anthropic' && body.protocol !== 'openai') {
        mockConfigError(`protocol 只支持 anthropic / openai，当前为 '${body.protocol}'`)
      }
      p.protocol = body.protocol
    }
    if (body.base_url !== undefined) p.base_url = body.base_url
    if (body.display_name !== undefined) p.display_name = body.display_name
    if (body.api_key !== undefined) {
      if (!body.api_key) mockConfigError('api_key 不能为空')
      p.api_key = body.api_key
    }

    return {
      id,
      updated: true,
      co_affected: p.models.filter((m) => m !== model).map((m) => `${provider}:${m}`),
      restart_required: true,
    }
  },

  async delete(id: string): Promise<ModelDeleteResult> {
    const { provider, model } = mockParseId(id)
    const p = mockConfig.providers[provider]
    if (!p || !p.models.includes(model)) {
      const message = `模型 '${id}' 不存在`
      throw new ApiError(message, 404, { error: message })
    }

    p.models = p.models.filter((m) => m !== model)
    let remaining = p.models.map((m) => `${provider}:${m}`)
    if (p.models.length === 0) {
      delete mockConfig.providers[provider]
      remaining = []
    }
    return { id, deleted: true, remaining_peers: remaining, restart_required: true }
  },
}

/* ---------------------------------------------------------------- 记忆 */

/**
 * 两份记忆的内存镜像，按真实后端 admin/memory.py 的语义实现：
 *
 * - 用户级一份（跨工作空间共用），项目级每个工作空间一份
 * - 文件不存在时 exists=false、content 为空串
 * - 写空内容 = 清空文件（文件留着，只是没内容）
 * - 写项目级记忆没带 workspace → 400，中文原因
 */
const mockUserMemory = { path: '/Users/1token/.scode/memory.md', content: '' }
const mockProjectMemories = new Map<string, { path: string; content: string }>()

const MOCK_DEFAULT_WS = '/Users/1token/Desktop/project/stupid-code'

export const mockAdminMemory = {
  async get(workspace: string): Promise<MemoryResponse> {
    await sleep(120)
    const ws = workspace.trim()
    const project = ws ? mockProjectMemories.get(ws) : undefined
    return {
      workspace: ws || MOCK_DEFAULT_WS,
      user: {
        scope: 'user',
        path: mockUserMemory.path,
        exists: mockUserMemory.content.length > 0,
        content: mockUserMemory.content,
      },
      project: {
        scope: 'project',
        path: project?.path ?? `${ws || MOCK_DEFAULT_WS}/.scode-memory.md`,
        exists: (project?.content.length ?? 0) > 0,
        content: project?.content ?? '',
      },
    }
  },

  async save(input: MemorySaveInput): Promise<MemorySaveResult> {
    await sleep(120)
    if (input.scope === 'user') {
      mockUserMemory.content = input.content
      return {
        scope: 'user',
        path: mockUserMemory.path,
        bytes: new TextEncoder().encode(input.content).length,
        exists: true,
      }
    }
    const ws = (input.workspace ?? '').trim()
    if (!ws) {
      const message = '写项目级记忆需要带 workspace'
      throw new ApiError(message, 400, { error: message })
    }
    const path = `${ws}/.scode-memory.md`
    mockProjectMemories.set(ws, { path, content: input.content })
    return {
      scope: 'project',
      path,
      bytes: new TextEncoder().encode(input.content).length,
      exists: true,
    }
  },
}

/* ---------------------------------------------------------------- 技能 */

/**
 * skill 的假数据，按真实后端 admin/skills.py 的语义实现：
 *
 * - 全局一份（跨工作空间共用），项目级每个工作空间一份
 * - 项目级跟着工作空间走：换一个工作空间，列表就换一批
 */
const MOCK_GLOBAL_SKILLS: SkillInfo[] = [
  {
    name: 'code-review',
    description: '提交前自查：读改动、找缺陷和安全问题，只输出问题清单',
    scope: 'user',
    source: '/user-skills/',
    path: '/user-skills/code-review/SKILL.md',
  },
  {
    name: 'writing-plans',
    description: '写实现计划：把需求拆成带验收标准的步骤',
    scope: 'user',
    source: '/user-skills/',
    path: '/user-skills/writing-plans/SKILL.md',
  },
]

const MOCK_PROJECT_SKILLS: SkillInfo[] = [
  {
    name: 'run-tests',
    description: '这个项目的测试怎么跑、怎么挑要跑哪几个',
    scope: 'project',
    source: '/.agents/skills/',
    path: '/.agents/skills/run-tests/SKILL.md',
  },
]

export const mockSkills = {
  async list(workspace: string): Promise<SkillListResponse> {
    await sleep(120)
    const ws = workspace.trim() || MOCK_DEFAULT_WS
    return {
      workspace: ws,
      // 项目级 skill 的路径是**虚拟路径**（`/.agents/skills/...`），
      // 由后端按运行期工作空间解析——前端不用（也不能）把它拼成绝对路径。
      skills: [...MOCK_GLOBAL_SKILLS, ...MOCK_PROJECT_SKILLS],
    }
  },
}
