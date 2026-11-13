import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig({
  plugins: [react()],
  base: './',
  build: { target: 'es2022', chunkSizeWarningLimit: 4000 },
  optimizeDeps: { exclude: ['manifold-3d'] },
  server: { port: 5173, strictPort: false },
  test: { environment: 'node', include: ['tests/**/*.test.ts'], testTimeout: 60000 },
} as any);
