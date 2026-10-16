/**
 * 工具调用分类（前端设计文档 7.2）。
 *
 * Deep Agents 的内置工具名（总体设计文档 3.1）是 ls / read_file / write_file /
 * edit_file / glob / grep / write_todos / task，但自定义工具（终端、git 等）
 * 的命名不受约束，所以这里按「包含什么关键字」判定，而不是精确匹配。
 *
 * 这里只放纯数据与判定，图标由 ToolCallHeader 自己持有：
 * 渲染层直接 import 图标组件会让 .ts 变成 .tsx，而分类逻辑并不依赖 React。
 */

export type ToolKind = 'read' | 'write' | 'search' | 'command' | 'todo' | 'task' | 'other'

const RULES: Array<{ kind: ToolKind; keywords: string[] }> = [
  { kind: 'todo', keywords: ['todo'] },
  { kind: 'task', keywords: ['task', 'subagent', 'sub_agent', 'dispatch'] },
  { kind: 'command', keywords: ['bash', 'shell', 'command', 'terminal', 'execute', 'run_'] },
  { kind: 'write', keywords: ['write_file', 'edit_file', 'edit', 'write', 'patch', 'create_file'] },
  { kind: 'search', keywords: ['grep', 'glob', 'search', 'find', 'rg'] },
  { kind: 'read', keywords: ['read_file', 'read', 'cat', 'view'] },
]

export function classifyTool(name: string): ToolKind {
  const n = name.toLowerCase()
  for (const rule of RULES) {
    if (rule.keywords.some((kw) => n.includes(kw))) return rule.kind
  }
  return 'other'
}

export const KIND_LABEL: Record<ToolKind, string> = {
  read: '读取文件',
  write: '编辑文件',
  search: '搜索',
  command: '执行命令',
  todo: '更新任务',
  task: '子 Agent',
  other: '工具',
}

/** 从工具参数里尽量取出文件路径，Deep Agents 各工具的字段名并不统一 */
export function filePathOf(args: Record<string, unknown>): string | null {
  const candidates = ['file_path', 'path', 'filename', 'file', 'target_file']
  for (const key of candidates) {
    const value = args[key]
    if (typeof value === 'string' && value) return value
  }
  return null
}

export function commandOf(args: Record<string, unknown>): string | null {
  for (const key of ['command', 'cmd', 'script']) {
    const value = args[key]
    if (typeof value === 'string' && value) return value
  }
  return null
}

/** 一个卡片标题：优先展示最能说明问题的那部分参数 */
export function summarizeCall(name: string, args: Record<string, unknown>): string {
  const kind = classifyTool(name)
  if (kind === 'command') return commandOf(args) ?? ''
  if (kind === 'write' || kind === 'read') return filePathOf(args) ?? ''
  if (kind === 'search') {
    const pattern = args.pattern ?? args.query ?? args.glob
    const path = args.path ?? args.cwd
    if (typeof pattern === 'string' && typeof path === 'string') return `${pattern}  in ${path}`
    return typeof pattern === 'string' ? pattern : ''
  }
  return ''
}
