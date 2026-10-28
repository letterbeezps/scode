/**
 * 任务按工作空间分组。
 *
 * 每个 thread 的 metadata 里记着它这次实际用的工作空间（见 conversationStore
 * 的 sendMessage），空字符串表示「没选工作空间」——走的是后端默认工作空间，
 * 所以这些任务归到同一个组。
 *
 * 纯逻辑，不碰 React：跟 tools.ts / diff.ts 一个路子，方便单独推演。
 */
import type { Thread } from '../api/types'

/** 默认工作空间组的 key：空字符串 = 没选工作空间 */
export const DEFAULT_WORKSPACE_KEY = ''

/** 默认工作空间组的展示名 */
export const DEFAULT_WORKSPACE_LABEL = '默认工作空间'

export interface WorkspaceGroup {
  /** 分组 key：工作空间绝对路径；默认工作空间是空串 */
  key: string
  /** 展示名：默认工作空间给固定名，其余取路径的最后一段 */
  label: string
  /** 完整路径（鼠标悬停显示）；默认工作空间没有 */
  path?: string
  threads: Thread[]
}

/**
 * 去掉路径末尾的斜杠，作为分组 key。
 *
 * 同一个目录写成 `/p/alpha` 和 `/p/alpha/` 不该分成两组——手动输入路径时
 * 末尾多打一个斜杠太常见了。根目录 "/" 剥完是空串，得保住，不然会跟
 * 「没选工作空间」那一组撞上。
 */
function normalizeKey(path: string): string {
  if (!path) return path
  const trimmed = path.replace(/\/+$/, '')
  if (trimmed) return trimmed
  return path.startsWith('/') ? '/' : path
}

/**
 * 取一个任务的分组 key：它这次用的工作空间。
 *
 * metadata 里没记或不是字符串，都算「没选」（空串 = 默认工作空间那组）。
 * 返回的是**归一化后**的路径，跟分组用的 key 是同一个值——折叠状态要按它存。
 */
export function workspaceKeyOf(thread: Thread): string {
  const value = thread.metadata?.workspace
  return normalizeKey(typeof value === 'string' ? value : '')
}

/** 路径的最后一段，用作分组名。路径以 / 结尾或压根没有 / 时退回整串。 */
function basenameOf(path: string): string {
  const trimmed = path.replace(/\/+$/, '')
  const index = trimmed.lastIndexOf('/')
  const name = index >= 0 ? trimmed.slice(index + 1) : trimmed
  return name || trimmed || path
}

/**
 * 把任务按工作空间分组。
 *
 * 组按「组内最新的 updated_at」降序排——刚用过的目录排在最上面；组内同样按
 * updated_at 降序。列表接口本来就是这个顺序，这里再排一次是为了本地新建的
 * 任务插在前面时也保持一致。
 */
export function groupThreadsByWorkspace(threads: Thread[]): WorkspaceGroup[] {
  const buckets = new Map<string, Thread[]>()
  for (const thread of threads) {
    const key = workspaceKeyOf(thread)
    const bucket = buckets.get(key)
    if (bucket) bucket.push(thread)
    else buckets.set(key, [thread])
  }

  const groups: WorkspaceGroup[] = []
  for (const [key, bucket] of buckets) {
    bucket.sort((a, b) => b.updated_at.localeCompare(a.updated_at))
    const isDefault = key === DEFAULT_WORKSPACE_KEY
    groups.push({
      key,
      label: isDefault ? DEFAULT_WORKSPACE_LABEL : basenameOf(key),
      ...(isDefault ? {} : { path: key }),
      threads: bucket,
    })
  }

  groups.sort((a, b) => {
    const left = a.threads[0]?.updated_at ?? ''
    const right = b.threads[0]?.updated_at ?? ''
    return right.localeCompare(left)
  })
  return groups
}
