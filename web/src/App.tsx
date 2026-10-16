/**
 * 路由表（设计文档 9）。
 *
 *   /                    重定向到最近会话，没有就新建一个
 *   /chat                新会话（不落 thread_id）
 *   /chat/:threadId      指定会话
 *   /settings            设置页
 */
import { BrowserRouter, Route, Routes } from 'react-router-dom'
import { ChatPage } from './pages/ChatPage'
import { RootRedirect } from './pages/RootRedirect'
import { SettingsPage } from './pages/SettingsPage'

export function App() {
  return (
    <BrowserRouter>
      <Routes>
        <Route path="/" element={<RootRedirect />} />
        <Route path="/chat" element={<ChatPage />} />
        <Route path="/chat/:threadId" element={<ChatPage />} />
        <Route path="/settings" element={<SettingsPage />} />
        <Route path="*" element={<RootRedirect />} />
      </Routes>
    </BrowserRouter>
  )
}
