import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig({
  plugins: [react()],
  server: {
    port: 3000,
    strictPort: true,
    host: true,
    proxy: {
      '/api': {
        target: 'http://localhost:3001',
        changeOrigin: true,
        configure: (proxy) => {
          // The browser is same-origin with Vite on :3000, but Caster receives
          // the proxied request on :3001. Normalize only the development
          // proxy's Origin header so backend CSRF checks see their own origin.
          proxy.on('proxyReq', (proxyRequest) => {
            proxyRequest.setHeader('Origin', 'http://localhost:3001');
          });
        },
        ws: true
      }
    }
  }
});
