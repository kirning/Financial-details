import { defineConfig, type Plugin } from 'vite'
import react from '@vitejs/plugin-react'
import http from 'node:http'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { Readable } from 'node:stream'

const BACKEND = { host: '127.0.0.1', port: 7300 }
/** 版本号单一来源：项目根 VERSION（由 scripts/bump-version.mjs 维护） */
const APP_VERSION = readFileSync(
  join(dirname(fileURLToPath(import.meta.url)), '..', 'VERSION'), 'utf8',
).trim()

/** 需要转发给 Koa 后端的路径前缀（含中文「凭证」） */
const PROXY_RE = /^\/(api|凭证|assets)(\/|$)/

/**
 * 开发代理：把 /api、/凭证、/assets 转发到 Koa 后端。
 *
 * 为什么不用 server.proxy：
 *   Vite 5 的 proxy key 只按**字符串前缀**匹配，写 '/凭证' 不生效，
 *   凭证图片请求会被当成 SPA 路由返回 index.html，表现为图片 0×0 加载不出来。
 *   这里用 Node 原生 http 转发，正则匹配 + 先decodeURIComponent，行为明确，
 *   也不需要额外的 http-proxy 依赖。
 */
function backendProxy(): Plugin {
  return {
    name: 'backend-proxy',
    configureServer(server) {
      server.middlewares.use((req, res, next) => {
        const raw = (req.url ?? '').split('?')[0]
        let path = raw
        try { path = decodeURIComponent(raw) } catch { /* 保持原样 */ }
        if (!PROXY_RE.test(path)) return next()

        const proxyReq = http.request(
          {
            ...BACKEND,
            path: req.url,
            method: req.method,
            headers: { ...req.headers, host: `${BACKEND.host}:${BACKEND.port}` },
          },
          proxyRes => {
            res.writeHead(proxyRes.statusCode ?? 502, proxyRes.headers)
            proxyRes.pipe(res)
          },
        )
        proxyReq.on('error', err => {
          res.writeHead(502, { 'Content-Type': 'text/plain; charset=utf-8' })
          res.end('代理到后端失败：' + err.message + '\n请确认后端已启动：cd ../server && npm start')
        })
        Readable.from(req).pipe(proxyReq)
      })
    },
  }
}

export default defineConfig({
  plugins: [react(), backendProxy()],
  // 构建时注入，页头显示版本号，便于判断远端部署是否落后
  define: { __APP_VERSION__: JSON.stringify(APP_VERSION) },
  // 产物挂在 /app/ 下，避免与根目录的 assets/（Tailwind 兜底副本）冲突
  base: '/app/',
  server: { port: 7301, strictPort: true },
  build: {
    outDir: 'dist',
    emptyOutDir: true,
    chunkSizeWarningLimit: 900,
    // 按依赖拆 vendor：后续新增统计图表只改主包，echarts / antd 可长期缓存
    rollupOptions: {
      output: {
        manualChunks(id) {
          const p = id.replace(/\\/g, '/')
          if (!p.includes('/node_modules/')) return
          if (p.includes('/echarts/') || p.includes('/zrender/')) return 'vendor-echarts'
          if (p.includes('/antd/') || p.includes('/@ant-design/') ||
              p.includes('/@rc-component/') || p.includes('/rc-')) return 'vendor-antd'
          if (p.includes('/react/') || p.includes('/react-dom/') ||
              p.includes('/scheduler/')) return 'vendor-react'
        },
      },
    },
  },
})