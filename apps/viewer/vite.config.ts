import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

const proxyTarget = (process.env.VITE_VIEWER_SERVER_PROXY_TARGET ?? 'http://127.0.0.1:8081').trim();

export default defineConfig({
  plugins: [react()],
  optimizeDeps: {
    include: ['@dagrejs/dagre'],
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
