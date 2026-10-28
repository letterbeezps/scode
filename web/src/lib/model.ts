/**
 * 运行期选择的对话模型。
 *
 * 模型 id 是 `供应商名:模型名`，与 conf/config.toml 里 [models] 的写法一致，
 * 也和后端 `GET /admin/models` 返回的 `id` 一样（见 api/types.ts 的 AdminModel）。
 *
 * **选中即生效，不用重启后端**：选中值存在 localStorage 里，每次发消息时
 * 随运行配置（`context.model`）一起发给后端；后端在每次模型调用前按这个 id
 * 把模型换掉（见后端 `stupid_code/graph/model_switch.py`）。
 *
 * 发空字符串表示「不指定」——后端就用它启动时带的默认模型
 * （conf/config.toml 的 [models].default）。
 */
export const MODEL_KEY = 'model'
