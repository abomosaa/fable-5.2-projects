import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';

const api = process.env.WIM_API ?? 'http://127.0.0.1:8787';

export default defineConfig({
  plugins: [react()],
  server: {
    port: 5173,
    proxy: { '/api': api, '/basemap': api, '/glyphs': api },
  },
  build: {
    outDir: 'dist',
    sourcemap: false,
    chunkSizeWarningLimit: 1400,
    rollupOptions: { output: { manualChunks: { maplibre: ['maplibre-gl'], react: ['react', 'react-dom'] } } },
  },
  test: { include: ['src/**/*.test.ts'], environment: 'node' },
});
