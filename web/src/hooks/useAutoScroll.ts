/**
 * 消息列表的自动滚动（前端设计文档 4.1）。
 *
 * 要求：自动滚到底部，但用户手动上滑时暂停；一旦暂停就显示「回到底部」按钮。
 * 判定用「距底部距离 > 阈值」，而不是滚动方向——流式输出时内容自己在变高，
 * 按方向判定会让每来一个 token 都把用户拽回底部。
 *
 * 「内容变高就跟随」用 ResizeObserver 监听内容容器，而不是让调用方把内容长度
 * 当成依赖传进来：流式场景下依赖表达式很难写准，写错就是滚动失效。
 *
 * 切换会话时不要在这里用 effect 重置滚动状态（那是一次纯 UI 的级联渲染），
 * 由调用方给列表加 key 直接重挂载，状态自然回到初始值。
 */
import { useCallback, useLayoutEffect, useRef, useState } from 'react'

const BOTTOM_THRESHOLD_PX = 80

export function useAutoScroll<T extends HTMLElement>() {
  const containerRef = useRef<T | null>(null)
  const contentRef = useRef<HTMLDivElement | null>(null)
  const [pinned, setPinned] = useState(true)
  // observer 回调里读 state 会拿到闭包快照，用 ref 兜住实时值
  const pinnedRef = useRef(true)

  const syncPinned = useCallback((next: boolean) => {
    pinnedRef.current = next
    setPinned(next)
  }, [])

  const scrollToBottom = useCallback(
    (behavior: ScrollBehavior = 'smooth') => {
      const el = containerRef.current
      if (!el) return
      el.scrollTo({ top: el.scrollHeight, behavior })
      syncPinned(true)
    },
    [syncPinned],
  )

  const handleScroll = useCallback(() => {
    const el = containerRef.current
    if (!el) return
    syncPinned(el.scrollHeight - el.scrollTop - el.clientHeight <= BOTTOM_THRESHOLD_PX)
  }, [syncPinned])

  // 内容高度变化（token 追加、工具卡片展开、Diff 渲染完成）时保持跟随
  useLayoutEffect(() => {
    const content = contentRef.current
    if (!content || typeof ResizeObserver === 'undefined') return

    const observer = new ResizeObserver(() => {
      const el = containerRef.current
      if (!el || !pinnedRef.current) return
      // 内容自己变高时用 auto；smooth 会在每个 token 上排队一次动画，反而卡顿
      el.scrollTo({ top: el.scrollHeight, behavior: 'auto' })
    })
    observer.observe(content)
    return () => observer.disconnect()
  }, [])

  // 切换会话 / 清空列表：调用方重挂载即可，这里不需要再 reset

  return { containerRef, contentRef, pinned, scrollToBottom, handleScroll }
}
