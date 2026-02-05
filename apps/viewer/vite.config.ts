import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const proxyTarget = (process.env.VITE_VIEWER_SERVER_PROXY_TARGET ?? 'http://127.0.0.1:8081').trim();

export default defineConfig({
  plugins: [react()],
  optimizeDeps: {
    include: ['@dagrejs/dagre', '@dagrejs/graphlib'],
  },
  resolve: {
    alias: {
      // dagre's "ESM" build wraps require() in a dynamic shim that esbuild
      // can't trace, causing "Dynamic require of @dagrejs/graphlib" at runtime.
      // Force the CJS build so esbuild can follow the static require() calls.
      '@dagrejs/dagre': path.resolve(
        __dirname,
        'node_modules/@dagrejs/dagre/dist/dagre.cjs.js',
      ),
    },
  },
  server: {
    host: true,
    port: 8080,
    strictPort: true,
    proxy: {
      '/api': {
        target: proxyTarget,
        // Preserve Host/Origin from the browser so viewer-server's same-origin checks
        // work even under Docker port mapping (e.g. 8060->8080).
        changeOrigin: false,
        ws: true,
      },
    },
  },
});
