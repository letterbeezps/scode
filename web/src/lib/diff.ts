/**
 * 从工具调用参数/结果里拼出 diff 需要的「旧文本 / 新文本」。
 *
 * react-diff-viewer 只吃 oldValue / newValue 两个整篇文本，但后端给过来的形态
 * 有五种（设计文档 5.3 只规定了 ToolResult.diff 这一种）：
 *
 *   1. 参数里直接给了完整新旧内容（write_file 的 content + 旧内容）
 *   2. 结果里给了 unified diff 字符串
 *   3. edit_file 只给了 old_string / new_string（局部替换）
 *   4. 只有新内容 + 文件路径（当作「从空文件写入」）
 *   5. 什么都没有 → 不渲染 diff
 *
 * 优先级从上到下，能拿到整篇就用整篇（行号才对得上），只拿到片段就退化成片段对比。
 */
import type { ToolCall } from '../api/types'
import { langFromPath } from './cn'
import { filePathOf } from './tools'

export interface DiffInput {
  oldValue: string
  newValue: string
  fileName?: string
  language?: string
}

function firstString(...values: unknown[]): string | undefined {
  for (const value of values) {
    if (typeof value === 'string') return value
  }
  return undefined
}

/** 解析 unified diff，还原出两侧全文 */
export function parseUnifiedDiff(diff: string): { oldValue: string; newValue: string } | null {
  if (!diff.includes('\n') && !diff.includes('@')) return null

  const oldLines: string[] = []
  const newLines: string[] = []
  let sawChange = false

  for (const line of diff.split('\n')) {
    // 文件头 @@ -a,b +c,d @@ 不含实际内容
    if (line.startsWith('@@')) continue
    if (line.startsWith('--- ') || line.startsWith('+++ ')) continue
    if (line.startsWith('\\')) continue

    if (line.startsWith('+')) {
      sawChange = true
      newLines.push(line.slice(1))
    } else if (line.startsWith('-')) {
      sawChange = true
      oldLines.push(line.slice(1))
    } else if (line.startsWith(' ') || line === '') {
      const content = line === '' ? '' : line.slice(1)
      oldLines.push(content)
      newLines.push(content)
    }
  }

  return sawChange ? { oldValue: oldLines.join('\n'), newValue: newLines.join('\n') } : null
}

export function buildDiffInput(call: ToolCall): DiffInput | null {
  const args = call.args
  const filePath = filePathOf(args)
  const language = filePath ? langFromPath(filePath) : undefined

  // 1. 参数里直接给了新旧全文
  const oldContent = firstString(args.oldContent, args.old_content, args.previous_content)
  const newContent = firstString(args.newContent, args.new_content, args.content)
  if (oldContent !== undefined && newContent !== undefined) {
    return { oldValue: oldContent, newValue: newContent, fileName: filePath ?? undefined, language }
  }

  // 2. 结果里给了 unified diff
  const unified = call.result?.diff
  if (unified) {
    const parsed = parseUnifiedDiff(unified)
    if (parsed) return { ...parsed, fileName: filePath ?? undefined, language }
  }

  // 3. 局部替换：拿 old_string / new_string 做片段对比
  const oldString = firstString(args.old_string, args.oldString, args.replace)
  const newString = firstString(args.new_string, args.newString)
  if (oldString !== undefined && newString !== undefined) {
    return { oldValue: oldString, newValue: newString, fileName: filePath ?? undefined, language }
  }

  // 4. 整篇新内容 + 文件路径：当作「从空文件写入」的全量 diff
  if (newContent !== undefined && filePath) {
    return { oldValue: '', newValue: newContent, fileName: filePath, language }
  }

  return null
}
