import react from '@vitejs/plugin-react'
import { defineConfig } from 'vite'

// The dev server proxies /api to Express so the browser sees ONE origin.
// Session cookies then behave in development exactly as they do in production,
// where a single process serves both (docs/02-architecture.md section 9).
export default defineConfig({
  plugins: [react()],
  server: {
    port: 5173,
    strictPort: true,
    proxy: {
      '/api': { target: 'http://localhost:3000', changeOrigin: false },
      '/display': { target: 'http://localhost:3000', changeOrigin: false },
      '/healthz': { target: 'http://localhost:3000', changeOrigin: false },
    },
  },
  build: {
    outDir: 'dist',
    sourcemap: true,
    // Enforced in CI so the calendar cannot quietly grow a huge date library
    // (docs/10-testing.md, quality gate 10).
    chunkSizeWarningLimit: 250,
  },
})
