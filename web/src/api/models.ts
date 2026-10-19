/**
 * 模型管理：增删改查 conf/config.toml 里的模型配置。
 *
 * 契约见 stupid_code/API.md「模型管理」一节，后端由 admin_app.py 挂在
 * langgraph dev 的 /admin 前缀下（与内置路由并行，不冲突）。
 *
 * 三个必须记住的点：
 *
 * 1. **写入的是配置，不是运行时。** config.toml 是 `agent.py` 导入时读的，
 *    改完必须重启 scode，运行中的 graph 还拿着旧的模型实例。所有写操作的
 *    响应都带 `restart_required: true`，UI 要把它显式告诉用户。
 * 2. **api_key 默认脱敏。** 列表和详情返回 `***末4位`，带 `?reveal=true`
 *    才给明文。UI 上的「显示」开关要走这个参数，不要在前端缓存明文。
 * 3. **连接字段是供应商级的。** toml 按 provider 分组，protocol / base_url /
 *    api_key / display_name 实际属于整段，所以改一个模型会影响同供应商下所有
 *    模型——响应里的 co_affected 就是这个意思，别在 UI 上写成「只改了这一个」。
 */
import { isMockMode, request } from './client'
import { mockAdminModels } from './mock'
import type {
  AdminModel,
  ModelCreateInput,
  ModelCreateResult,
  ModelDeleteResult,
  ModelListResponse,
  ModelUpdateInput,
  ModelUpdateResult,
} from './types'

/**
 * 模型 id 是 `供应商名:模型名`，冒号在 URL path 里合法。
 * 仍然交给 encodeURIComponent：它会把冒号编成 %3A，Starlette 取 path_params
 * 时会解码回来，两种写法都能到后端，但统一编码省掉「这个 id 要不要转义」的
 * 判断成本。
 */
function encodeId(id: string): string {
  return encodeURIComponent(id)
}

/**
 * 列出全部模型（扁平数组，每项自带全部连接字段）。
 *
 * reveal=true 时 api_key 返回明文。默认脱敏。
 */
export async function listModels(reveal = false): Promise<ModelListResponse> {
  if (isMockMode) return mockAdminModels.list(reveal)
  const query = reveal ? '?reveal=true' : ''
  return request<ModelListResponse>(`/admin/models${query}`)
}

export async function getModel(id: string, reveal = false): Promise<AdminModel> {
  if (isMockMode) return mockAdminModels.get(id, reveal)
  const query = reveal ? '?reveal=true' : ''
  return request<AdminModel>(`/admin/models/${encodeId(id)}${query}`)
}

export async function createModel(input: ModelCreateInput): Promise<ModelCreateResult> {
  if (isMockMode) return mockAdminModels.create(input)
  return request<ModelCreateResult>('/admin/models', {
    method: 'POST',
    body: JSON.stringify(input),
  })
}

export async function updateModel(
  id: string,
  input: ModelUpdateInput,
): Promise<ModelUpdateResult> {
  if (isMockMode) return mockAdminModels.update(id, input)
  return request<ModelUpdateResult>(`/admin/models/${encodeId(id)}`, {
    method: 'PUT',
    body: JSON.stringify(input),
  })
}

export async function deleteModel(id: string): Promise<ModelDeleteResult> {
  if (isMockMode) return mockAdminModels.delete(id)
  return request<ModelDeleteResult>(`/admin/models/${encodeId(id)}`, {
    method: 'DELETE',
  })
}

/**
 * 把 ModelUpdateInput 收拾成真正要发出去的 body。
 *
 * 空字符串不能发：后端 update_model 是「字段出现即写入」，
 * api_key 发空串会直接 400「api_key 不能为空」，display_name / base_url
 * 发空串则会把配置清成空值（有时确实想这么干，但默认按「没填=不改」处理）。
 */
export function pruneUpdateInput(input: ModelUpdateInput): ModelUpdateInput {
  const body: ModelUpdateInput = {}
  if (input.protocol) body.protocol = input.protocol
  if (input.display_name) body.display_name = input.display_name
  // base_url 允许显式清空：用 undefined 表示「不动」，空串表示「清掉」
  if (input.base_url !== undefined) body.base_url = input.base_url
  if (input.api_key) body.api_key = input.api_key
  return body
}
