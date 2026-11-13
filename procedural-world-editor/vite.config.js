import { defineConfig } from 'vite';
export default defineConfig({
  root: '.',
  publicDir: 'public',
  build: { outDir: 'dist', target: 'es2022', sourcemap: false, chunkSizeWarningLimit: 4000, copyPublicDir: false },
  worker: { format: 'es' },
  test: { include: ['tests/**/*.test.js'], testTimeout: 180000, hookTimeout: 180000, pool: 'forks', maxWorkers: 1, fileParallelism: false },
});
