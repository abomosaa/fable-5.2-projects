import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vite';

const serverPort = Number(process.env.PORT ?? 8089);
const serverTarget = `http://127.0.0.1:${serverPort}`;

export default defineConfig({
  root: fileURLToPath(new URL('.', import.meta.url)),
  publicDir: 'public',
  build: {
    outDir: '../dist/client',
    emptyOutDir: true,
    target: 'es2022',
    sourcemap: false,
    chunkSizeWarningLimit: 900,
  },
  server: {
    host: process.env.CLIENT_HOST ?? '127.0.0.1',
    port: Number(process.env.CLIENT_PORT ?? 5173),
    strictPort: true,
    // In development the browser talks to Vite, which forwards game traffic
    // to the game server. In production the game server serves everything.
    proxy: {
      '/ws': { target: serverTarget, ws: true, changeOrigin: false },
      '/config.json': serverTarget,
      '/healthz': serverTarget,
      '/readyz': serverTarget,
      '/api': serverTarget,
    },
  },
});
