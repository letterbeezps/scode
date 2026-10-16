/**
 * Shiki 代码高亮。
 *
 * 高亮器体积不小且只在真正出现代码块时才需要，所以：
 *   1. 用动态 import 把它拆出主 chunk；
 *   2. 全应用共用一个懒加载的单例（createHighlighter 很贵）。
 */
import type { createHighlighter as CreateHighlighter } from 'shiki/bundle/web'

/** bundle/web 的 Highlighter 与全量包是不同的泛型实例，用工厂函数的返回值推导 */
type WebHighlighter = Awaited<ReturnType<typeof CreateHighlighter>>

/** 渲染不可信文本时的转义：高亮失败要退回纯文本，不能把原样内容塞进 innerHTML */
export function escapeHtml(text: string): string {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
}

const LANGS = [
  'python',
  'typescript',
  'tsx',
  'javascript',
  'jsx',
  'json',
  'yaml',
  'bash',
  'html',
  'css',
  'markdown',
  'sql',
  'toml',
  'go',
  'rust',
] as const

export const DARK_THEME = 'github-dark'
export const LIGHT_THEME = 'github-light'

let instance: Promise<WebHighlighter> | null = null

function getHighlighter(): Promise<WebHighlighter> {
  instance ??= import('shiki/bundle/web').then(({ createHighlighter }) =>
    createHighlighter({
      themes: [DARK_THEME, LIGHT_THEME],
      langs: [...LANGS],
    }),
  )
  return instance
}

/**
 * 返回高亮后的 HTML。语言不支持或高亮器加载失败时返回 null，
 * 由调用方渲染未高亮的纯文本。
 *
 * Shiki 会把主题色写成 pre 上的内联 style，这里用 index.css 里的
 * `pre.shiki` 规则覆盖回透明，避免和代码块自身的底色打架。
 */
export async function highlightCode(
  code: string,
  lang: string,
  dark: boolean,
): Promise<string | null> {
  const normalized = (lang || 'text').toLowerCase()
  if (!LANGS.includes(normalized as (typeof LANGS)[number])) return null

  try {
    const highlighter = await getHighlighter()
    return highlighter.codeToHtml(code, {
      lang: normalized,
      theme: dark ? DARK_THEME : LIGHT_THEME,
    })
  } catch {
    return null
  }
}
