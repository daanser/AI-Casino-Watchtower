import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { resolve } from 'node:path';

/**
 * 开发时：Vite dev server 跑在 5174，把 /api 与 /ws 代理到主服务 5173。
 * 构建时：直接产出到 apps/server/public/app/，由 Fastify 静态托管，
 *         这样 `npm start` 一个进程就能把「接口 + 观察台」一起端出来。
 */
export default defineConfig({
  plugins: [react()],
  base: '/app/',
  build: {
    outDir: resolve(import.meta.dirname, '../server/public/app'),
    emptyOutDir: true,
    sourcemap: false,
  },
  server: {
    port: 5174,
    strictPort: false,
    proxy: {
      '/api': { target: 'http://127.0.0.1:5173', changeOrigin: true },
      '/ws': { target: 'ws://127.0.0.1:5173', ws: true },
    },
  },
});
