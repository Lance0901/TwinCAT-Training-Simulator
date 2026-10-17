import { defineConfig } from 'vite';

const BACKEND = 'http://localhost:3300';

export default defineConfig({
  root: 'web',
  build: {
    outDir: 'dist',
    emptyOutDir: true,
  },
  server: {
    port: 5173,
    // 開發時前端由 Vite 提供,API 與 WebSocket 都轉給模擬器後端
    proxy: {
      '/api': { target: BACKEND, changeOrigin: true },
      '/ws': { target: BACKEND, ws: true },
    },
  },
});
