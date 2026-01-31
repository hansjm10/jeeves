import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig({
  plugins: [react()],
  server: {
    host: true,
    port: 8080,
    strictPort: true,
    proxy: {
      '/api': {
        target: 'http://127.0.0.1:8081',
        // Preserve Host/Origin from the browser so viewer-server's same-origin checks
        // work even under Docker port mapping (e.g. 8060->8080).
        changeOrigin: false,
        ws: true,
      },
    },
  },
});
