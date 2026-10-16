/**
 * 目录浏览：给工作空间选择器用。
 *
 * 为什么必须走后端：浏览器的 File System Access API 和
 * `<input webkitdirectory>` 都**故意不暴露绝对路径**（只给 name / 相对路径），
 * 这是防泄漏设计，改不了。而工作空间需要的就是绝对路径 ——
 * 后端跑在用户自己机器上，它知道文件系统，所以由它列目录。
 *
 * 约定端点：GET /directories?path=<绝对路径>
 * 不传 path 表示从根目录开始。
 */
import { request, isMockMode } from './client'
import { mockBrowseDirectories } from './mock'

export interface DirectoryEntry {
  name: string
  path: string
}

export interface DirectoryListing {
  /** 当前列出的目录 */
  path: string
  /** 上级目录，根目录时为 null */
  parent: string | null
  directories: DirectoryEntry[]
}

export async function browseDirectories(path?: string): Promise<DirectoryListing> {
  if (isMockMode) return mockBrowseDirectories(path)

  const query = path ? `?path=${encodeURIComponent(path)}` : ''
  const res = await request<Partial<DirectoryListing>>(`/directories${query}`)

  // 后端少给字段会让上层直接崩，这里兜住
  return {
    path: res.path ?? path ?? '/',
    parent: res.parent ?? null,
    directories: Array.isArray(res.directories) ? res.directories : [],
  }
}

/** 把绝对路径切成面包屑：/Users/me/dev -> [{name:'Users'}, ...] */
export function pathCrumbs(path: string): Array<{ name: string; path: string }> {
  const parts = path.split('/').filter(Boolean)
  const crumbs: Array<{ name: string; path: string }> = []
  let acc = ''
  for (const part of parts) {
    acc += `/${part}`
    crumbs.push({ name: part, path: acc })
  }
  return crumbs
}
