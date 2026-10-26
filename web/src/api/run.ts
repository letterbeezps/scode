/**
 * 运行相关 API（总体设计文档 3.3、前端设计文档 6.2）。
 *
 * streamRun 用 fetch + ReadableStream 手写 SSE 解析而不是 EventSource：
 * 后者不支持自定义 header，而生产环境大概率要给 /runs/stream 带鉴权。
 */
import { apiBaseUrl, authHeaders, isMockMode } from './client'
import { createEventNormalizer } from './events'
import { readSseStream } from './sse'
import { mockRuns } from './mock'
import { MODEL_KEY } from '../lib/model'
import { PERMISSIONS_KEY, WORKSPACE_KEY } from '../lib/permissions'
import { SKILLS_KEY } from '../lib/skills'
import type {
  ApprovalDecision,
  ApprovalRequest,
  RunOptions,
  Todo,
  ToolCall,
  ToolResult,
} from './types'

const ASSISTANT_ID = (import.meta.env.VITE_ASSISTANT_ID as string | undefined) ?? 'code_agent'

/** onToolResult 需要能定位到对应的调用，故把 id 一并放进 payload */
export type ToolResultEvent = ToolResult & { id: string; error?: string }

/** 人工确认的决定（字段名与框架的 Decision 一致，见 api/types.ts） */
export type { ApprovalDecision }

export interface RunHandlers {
  onToken: (text: string) => void
  onToolCall: (call: ToolCall) => void
  onToolResult: (result: ToolResultEvent) => void
  onTodos: (todos: Todo[]) => void
  onError: (err: string) => void
  onEnd: () => void
  /** LangGraph 的 metadata 事件里带着 run_id，取消运行需要 */
  onRunId?: (runId: string) => void
  /** 图挂起等人工确认（后端命中 HITL） */
  onInterrupt?: (requests: ApprovalRequest[]) => void
  /**
   * SSE 网络层断开（不是后端发来的 error 事件）。
   *
   * 后端因为 `on_disconnect: "continue"` 还在继续跑，调用方可以拿 runId
   * 重新接上或轮询线程状态；不实现这个回调时按普通错误收尾。
   */
  onConnectionLost?: (runId?: string) => void
}

/**
 * 发起一次流式运行，返回取消函数。
 *
 * 取消做两件事：断掉本地 SSE 连接（立刻恢复 UI），并在拿到 run_id 后通知后端
 * 真正中止——否则后端会继续跑完这次 run，白烧 token。
 */
export function streamRun(
  threadId: string,
  message: string,
  options: RunOptions,
  handlers: RunHandlers,
): () => void {
  if (isMockMode) return mockRuns.stream(threadId, message, options, handlers)

  const body = JSON.stringify({
    assistant_id: ASSISTANT_ID,
    input: { messages: [{ role: 'user', content: message }] },
    // 只要 updates：values 每次都回传全量状态，噪音大且没必要
    stream_mode: ['updates'],
    // 浏览器断开后让后端继续跑完，避免半途中断留下脏状态
    on_disconnect: 'continue',
    /*
     * 任务参数走 configurable，后端在图入口处读取：
     *   workspace   → 工作空间绝对路径；空字符串表示不限定，由后端决定
     *   permissions → 确认档位 manual / normal / auto
     *   model       → 选中的对话模型 id（`供应商名:模型名`）
     *   skills      → 本次对话勾选的 skill 名字列表
     * 后端需要在工具调用入口按 permissions 拦截并挂起等前端确认，
     * 否则这两项只是摆设。
     *
     * model 由后端在**每次模型调用前**换成对应供应商的实例
     * （见后端 graph/model_switch.py），所以切换不需要重启后端。
     *
     * skills 是**任务级**参数：工作空间是运行期参数，项目级 skill 跟着它走，
     * 所以 skill 选择不能建图时定死，只能每次运行带过去
     * （见后端 graph/skills.py）。
     */
    config: {
      configurable: {
        [WORKSPACE_KEY]: options.workspace,
        [PERMISSIONS_KEY]: options.permissions,
        [MODEL_KEY]: options.model,
        [SKILLS_KEY]: options.skills,
      },
    },
  })

  return runStream(threadId, body, handlers)
}

/**
 * 恢复一次挂起的运行（后端在 HITL 上挂起了，等人批准/拒绝）。
 *
 * 走的是同一个端点，只是把 `command.resume` 带上决定：
 *   {"decisions": [{"type": "approve"}]} 或
 *   {"decisions": [{"type": "reject", "message": "..."}]}
 * 平台会把 command 转成 LangGraph 的 Command(resume=...) 作为这次运行的输入，
 * 图从挂起点继续往下跑。
 *
 * **decisions 的个数必须和挂起时的 action_requests 一样多**：框架在
 * `HumanInTheLoopMiddleware.after_model` 里校验数量，对不上直接抛
 * `Number of human decisions (N) does not match number of hanging tool calls (M)`，
 * 整个运行报错。所以这里收数组，不收单个决定。
 *
 * **档位必须原样带回去**：后端的拦截判定在恢复时会再跑一次，档位变了结论就
 * 可能变（批准后变成"这条命令要拦"，就永远批不掉了）。
 *
 * **模型也要原样带回去**：恢复时后端同样按 configurable 里的 model 换模型，
 * 带空了就换成默认模型，跟批准前用的不是同一个模型。
 *
 * **勾选的 skill 也要原样带回去**：skill 是任务级参数，任务参数变了就等于
 * 换了个任务——恢复的那一轮不该跟批准前不是同一组 skill。
 */
export function resumeRun(
  threadId: string,
  decisions: ApprovalDecision[],
  options: RunOptions,
  handlers: RunHandlers,
): () => void {
  if (isMockMode) {
    // mock 模式没有真的图，直接把流收掉
    handlers.onEnd()
    return () => {}
  }

  const body = JSON.stringify({
    assistant_id: ASSISTANT_ID,
    command: {
      resume: {
        decisions,
      },
    },
    stream_mode: ['updates'],
    on_disconnect: 'continue',
    config: {
      configurable: {
        [WORKSPACE_KEY]: options.workspace,
        [PERMISSIONS_KEY]: options.permissions,
        [MODEL_KEY]: options.model,
        [SKILLS_KEY]: options.skills,
      },
    },
  })

  return runStream(threadId, body, handlers)
}

/** 跑一次流式请求并把事件分发给 handlers，返回取消函数。 */
function consumeRunStream(
  threadId: string,
  request: { url: string; init: RequestInit },
  handlers: RunHandlers,
  /** join 已存在的 run 时传进来：HTTP 失败可以交给恢复逻辑轮询 state */
  knownRunId?: string,
): () => void {
  const controller = new AbortController()
  const normalizer = createEventNormalizer()
  let runId = knownRunId
  let settled = false

  const cancel = () => {
    if (settled) return
    settled = true
    controller.abort()
    // 断流之后后端可能仍在跑，拿到 run_id 就通知它真正中止
    if (runId) void cancelRun(threadId, runId).catch(() => {})
    // 必须主动收尾：abort 之后循环和 catch 都会被 settled 短路，
    // 不在这里补一次 onEnd，UI 会一直卡在“生成中”
    handlers.onEnd()
  }

  const finish = () => {
    if (settled) return
    settled = true
    handlers.onEnd()
  }

  void (async () => {
    try {
      const res = await fetch(request.url, {
        ...request.init,
        signal: controller.signal,
      })

      if (!res.ok) {
        const text = await res.text().catch(() => '')
        // join 已有 run：404/409 多半是 run 刚好结束，交给恢复逻辑去读 state，
        // 比直接甩一个 HTTP 错误更有用
        if (knownRunId && handlers.onConnectionLost) {
          handlers.onConnectionLost(runId)
          return
        }
        handlers.onError(`${res.status} ${res.statusText}${text ? ` — ${text}` : ''}`)
        return finish()
      }
      if (!res.body) {
        handlers.onError('响应没有可读的流')
        return finish()
      }

      for await (const evt of readSseStream(res.body)) {
        if (settled) break
        for (const event of normalizer.push(evt)) {
          switch (event.type) {
            case 'metadata':
              if (event.runId) {
                runId = event.runId
                handlers.onRunId?.(event.runId)
              }
              break
            case 'token':
              handlers.onToken(event.text)
              break
            case 'tool_call':
              handlers.onToolCall(event.call)
              break
            case 'tool_result':
              handlers.onToolResult({
                id: event.id,
                output: event.result.output,
                diff: event.result.diff,
                files: event.result.files,
                error: event.error,
              })
              break
            case 'todos':
              handlers.onTodos(event.todos)
              break
            case 'interrupt':
              handlers.onInterrupt?.(event.requests)
              break
            case 'error':
              handlers.onError(event.message)
              break
            case 'end':
              return finish()
          }
        }
      }

      // 用户主动取消会 abort 并 break 上面的循环，这里不能再走恢复
      if (settled) return

      // join 一个已经结束的 run 时平台会直接返回空流（实测 200 + 空 body），
      // 这时没有 end 事件，交给恢复逻辑读 state 收尾；首次运行按正常结束处理
      if (knownRunId && handlers.onConnectionLost) {
        handlers.onConnectionLost(runId)
        return
      }
      finish()
    } catch (err) {
      if (settled) return // 用户主动取消，不当作错误
      if (handlers.onConnectionLost) {
        // 网络断开不等于 run 失败：后端还在跑，交给调用方接回/轮询
        handlers.onConnectionLost(runId)
        return
      }
      handlers.onError(err instanceof Error ? err.message : String(err))
      finish()
    }
  })()

  return cancel
}

function runStream(threadId: string, body: string, handlers: RunHandlers): () => void {
  return consumeRunStream(
    threadId,
    {
      url: `${apiBaseUrl}/threads/${threadId}/runs/stream`,
      init: {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Accept: 'text/event-stream',
          ...authHeaders(),
        },
        body,
      },
    },
    handlers,
  )
}

/**
 * 重新接上一个已经在跑的 run。
 *
 * 平台说明 join_stream 只推「接上之后」产生的事件，断线前已经产出的内容
 * 不会补发——所以调用方应先以 `GET /threads/{id}/state` 为准，
 * 这个流只负责把后续输出接回 UI。
 */
export function joinRunStream(
  threadId: string,
  runId: string,
  handlers: RunHandlers,
): () => void {
  if (isMockMode) {
    handlers.onEnd()
    return () => {}
  }

  return consumeRunStream(
    threadId,
    {
      url: `${apiBaseUrl}/threads/${threadId}/runs/${runId}/stream?stream_mode=updates`,
      init: {
        method: 'GET',
        headers: {
          Accept: 'text/event-stream',
          ...authHeaders(),
        },
      },
    },
    handlers,
    runId,
  )
}

/** 通知后端中止运行 */
export async function cancelRun(threadId: string, runId: string): Promise<void> {
  const res = await fetch(
    `${apiBaseUrl}/threads/${threadId}/runs/${runId}/cancel`,
    { method: 'POST', headers: authHeaders() },
  )
  if (!res.ok) {
    throw new Error(`取消运行失败：${res.status} ${res.statusText}`)
  }
}
