import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'
import { defineConfig, type ProxyOptions } from 'vite'

// Yahoo Finance doesn't allow browser (CORS) requests, so the Markets page calls
// /api/yahoo/... and this proxy forwards it. Works in `npm run dev` and `npm run preview`.
// On a static host, the backend needs to provide the same /api/yahoo route.
const yahoo: Record<string, ProxyOptions> = {
  '/api/yahoo': {
    target: 'https://query1.finance.yahoo.com',
    changeOrigin: true,
    rewrite: (path) => path.replace(/^\/api\/yahoo/, ''),
    headers: { 'User-Agent': 'Mozilla/5.0' },
  },
}

export default defineConfig({
  plugins: [react(), tailwindcss()],
  server: { proxy: yahoo },
  preview: { proxy: yahoo },
})
