/**
 * fetch 封装：统一前缀、错误处理、鉴权头注入点。
 *
 * 开发态所有请求都走 `/api` 前缀，由 Vite 代理转发到 langgraph-cli；
 * 生产态把 VITE_API_BASE_URL 指向后端真实地址即可，无需改代码。
 */
const BASE_URL = (import.meta.env.VITE_API_BASE_URL as string | undefined) ?? '/api'

export const apiBaseUrl = BASE_URL

export class ApiError extends Error {
  status: number
  body: unknown

  constructor(message: string, status: number, body?: unknown) {
    super(message)
    this.name = 'ApiError'
    this.status = status
    this.body = body
  }
}

/** 预留：生产环境由反向网关注入，这里保持一个集中出口 */
export function authHeaders(): Record<string, string> {
  const key = import.meta.env.VITE_LANGGRAPH_API_KEY as string | undefined
  return key ? { Authorization: `Bearer ${key}` } : {}
}

async function parseBody(res: Response): Promise<unknown> {
  const text = await res.text()
  if (!text) return undefined
  try {
    return JSON.parse(text)
  } catch {
    return text
  }
}

export async function request<T>(path: string, init?: RequestInit): Promise<T> {
  let res: Response
  try {
    res = await fetch(`${BASE_URL}${path}`, {
      ...init,
      headers: {
        'Content-Type': 'application/json',
        ...authHeaders(),
        ...(init?.headers as Record<string, string> | undefined),
      },
    })
  } catch (err) {
    // 网络层失败：后端没起、代理没通、断网
    throw new ApiError(
      `无法连接后端（${BASE_URL}）：${err instanceof Error ? err.message : String(err)}`,
      0,
    )
  }

  if (!res.ok) {
    const body = await parseBody(res)
    throw new ApiError(`${res.status} ${res.statusText} — ${path}`, res.status, body)
  }

  if (res.status === 204) return undefined as T
  return (await res.json()) as T
}

/** 当前是否处于 mock 模式（后端 P0 还没落地时用来演示 UI） */
export const isMockMode = (import.meta.env.VITE_USE_MOCK as string | undefined) === 'true'

/**
 * 把后端给出的可读原因挖出来。
 *
 * request() 抛的 ApiError.message 是 `400 Bad Request — /xxx` 这种请求行信息，
 * 对用户没意义；真正的中文原因在响应体里，但两套后端的字段名不一样：
 *
 *   - 我们自己的 /admin/*：{"error": "供应商已存在…"}
 *   - LangGraph 平台：    {"detail": "Invalid JSON in request body"}
 *
 * 两个都认，都认不到就退回 message。
 */
export function errorMessage(err: unknown): string {
  if (err instanceof ApiError) {
    const body = err.body as { error?: unknown; detail?: unknown } | null | undefined
    if (body) {
      if (typeof body.error === 'string' && body.error) return body.error
      if (typeof body.detail === 'string' && body.detail) return body.detail
    }
    return err.message
  }
  return err instanceof Error ? err.message : String(err)
}
