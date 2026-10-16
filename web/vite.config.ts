import tailwindcss from '@tailwindcss/vite'
import react from '@vitejs/plugin-react'
import { defineConfig, loadEnv } from 'vite'

/**
 * 开发态把 `/api/*` 反向代理到 langgraph-cli（`langgraph dev`，默认 2024 端口），
 * 避免跨域；生产构建产物是纯静态文件，部署时由网关做同样的转发。
 */
export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, process.cwd(), '')
  const target = env.VITE_LANGGRAPH_URL || 'http://localhost:2024'

  return {
    plugins: [react(), tailwindcss()],
    server: {
      port: 5173,
      proxy: {
        '/api': {
          target,
          changeOrigin: true,
          rewrite: (path) => path.replace(/^\/api/, ''),
        },
      },
    },
  }
})
