/**
 * SSE 解析。
 *
 * 设计文档 6.3：EventSource 不支持自定义 header（如鉴权），需要鉴权时改用
 * fetch + ReadableStream 手动解析。这里直接实现后者，一条路径覆盖两种场景。
 *
 * 协议本身很薄：`event:` / `data:` / `id:` / 注释行，空行分隔一条事件，
 * data 可多行（拼接时用 \n 连接）。注意一条事件完全可能横跨两个网络 chunk，
 * 所以解析器必须持有跨块状态，不能是纯函数。
 */

export interface SseEvent {
  event: string
  data: string
  id?: string
}

interface PendingEvent {
  event: string
  data: string[]
  id?: string
}

export class SseParser {
  private buffer = ''
  private pending: PendingEvent = { event: '', data: [] }

  /** 后端换行风格可能是 CRLF 或单独 CR，统一成 \n 再切分 */
  private static normalize(chunk: string): string {
    return chunk.replace(/\r\n/g, '\n').replace(/\r/g, '\n')
  }

  feed(chunk: string): SseEvent[] {
    this.buffer += SseParser.normalize(chunk)
    const events: SseEvent[] = []

    // 最后一个 \n\n 之后是未成形的残余
    let boundary = this.buffer.lastIndexOf('\n\n')
    if (boundary === -1) return events

    const complete = this.buffer.slice(0, boundary)
    this.buffer = this.buffer.slice(boundary + 2)

    for (const segment of complete.split('\n\n')) {
      const evt = this.consumeSegment(segment)
      if (evt) events.push(evt)
    }
    return events
  }

  /** 流结束时冲掉最后一条没有以空行收尾的事件 */
  flush(): SseEvent[] {
    const events: SseEvent[] = []
    if (this.buffer.trim()) {
      const evt = this.consumeSegment(this.buffer)
      if (evt) events.push(evt)
    }
    this.buffer = ''
    const tail = this.takePending()
    if (tail) events.push(tail)
    return events
  }

  /** 把一个事件段（不含结尾空行）并入当前 pending，段结束时产出事件 */
  private consumeSegment(segment: string): SseEvent | null {
    let sawField = false

    for (const rawLine of segment.split('\n')) {
      // 注释行（以 : 开头）用于心跳，忽略
      if (!rawLine || rawLine.startsWith(':')) continue

      const colon = rawLine.indexOf(':')
      const field = colon === -1 ? rawLine : rawLine.slice(0, colon)
      // 协议规定冒号后有一个可选空格
      const value = colon === -1 ? '' : rawLine.slice(colon + 1).replace(/^ /, '')

      if (field === 'event') {
        this.pending.event = value
        sawField = true
      } else if (field === 'data') {
        this.pending.data.push(value)
        sawField = true
      } else if (field === 'id') {
        this.pending.id = value
        sawField = true
      }
    }

    // 段里没有任何字段，说明这是累积缓冲里跨块事件的中间一段，不该产出事件
    return sawField ? this.takePending() : null
  }

  private takePending(): SseEvent | null {
    if (this.pending.data.length === 0 && this.pending.event === '') return null
    const evt: SseEvent = {
      event: this.pending.event || 'message',
      data: this.pending.data.join('\n'),
      id: this.pending.id,
    }
    this.pending = { event: '', data: [] }
    return evt
  }
}

export async function* readSseStream(
  body: ReadableStream<Uint8Array>,
): AsyncGenerator<SseEvent, void, undefined> {
  const reader = body.getReader()
  const decoder = new TextDecoder()
  const parser = new SseParser()

  try {
    while (true) {
      const { done, value } = await reader.read()
      if (done) break
      for (const evt of parser.feed(decoder.decode(value, { stream: true }))) yield evt
    }
    // 补上多字节字符的残余解码，再冲掉最后一条事件
    for (const evt of parser.feed(decoder.decode())) yield evt
    for (const evt of parser.flush()) yield evt
  } finally {
    reader.releaseLock()
  }
}
