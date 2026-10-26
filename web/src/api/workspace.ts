/**
 * 工作空间：弹**系统原生**的文件浏览窗口选一个目录。
 *
 * ## 为什么不是浏览器的目录选择 API
 *
 * File System Access API（`showDirectoryPicker()`）和 `<input webkitdirectory>`
 * 都**故意不暴露绝对路径**——只给目录名 / 相对路径，这是浏览器的安全设计，
 * 绕不过去。而工作空间要的恰恰是绝对路径：agent 得在那个目录里读写文件、
 * 跑命令（虚拟路径 `/` 就是工作空间的根）。
 *
 * 后端跑在用户自己机器上，它既知道真实路径，也能调起系统的目录选择框
 * （macOS 的 `choose folder`、Linux 的 zenity、Windows 的 FolderBrowserDialog）。
 * 弹窗就弹在用户眼前，跟「cd 到项目目录里再跑 claude」是一回事。
 *
 * ## 约定端点
 *
 * `POST /workspaces/pick`
 *   - `{"path": "/abs/path"}` —— 选中了
 *   - `{"path": null, "cancelled": true}` —— 用户点了取消（**不是错误**）
 *   - `{"error": "..."}` + 503 —— 弹不出来（后端在无图形界面的环境里等）
 */
import { request, isMockMode } from './client'
import { mockPickWorkspace } from './mock'

export interface PickWorkspaceResult {
  /** 选中的绝对路径；取消时为 null */
  path: string | null
  /** 用户点了取消（不算错误） */
  cancelled: boolean
}

export async function pickWorkspace(): Promise<PickWorkspaceResult> {
  if (isMockMode) return mockPickWorkspace()

  const res = await request<{ path?: string | null; cancelled?: boolean }>('/workspaces/pick', {
    method: 'POST',
  })

  return {
    path: typeof res.path === 'string' ? res.path : null,
    cancelled: res.cancelled === true,
  }
}
