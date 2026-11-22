import { defineConfig } from 'vite';
import vue from '@vitejs/plugin-vue';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const root = path.dirname(fileURLToPath(import.meta.url));

/**
 * The dev server and the API listen on loopback only. The proxy keeps the
 * browser same-origin, so no CORS relaxation is needed and a page opened from
 * another host cannot talk to the API through this process.
 */
export default defineConfig({
  root,
  plugins: [vue()],
  server: {
    host: '127.0.0.1',
    port: 5173,
    strictPort: true,
    proxy: {
      '/api': {
        target: 'http://127.0.0.1:3000',
        changeOrigin: false,
      },
    },
  },
  build: {
    outDir: path.resolve(root, 'dist'),
    emptyOutDir: true,
  },
});
