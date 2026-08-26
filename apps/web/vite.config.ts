import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig({
  plugins: [react()],
  server: {
    port: 3000,
    host: true,
    proxy: {
      '/api': {
        // Keep the API target distinct from Vite's fallback ports. Using
        // `localhost` can resolve to another Vite instance on ::1 when a
        // duplicate dev process has already claimed the expected port.
        target: 'http://127.0.0.1:3001',
        changeOrigin: true,
        configure: (proxy) => {
          // The browser is same-origin with Vite on :3000, but Caster receives
          // the proxied request on :3001. Normalize the development proxy's
          // Origin header for the backend's origin policy.
          proxy.on('proxyReq', (proxyRequest) => {
            proxyRequest.setHeader('Origin', 'http://127.0.0.1:3001');
          });
        },
        ws: true
      }
    }
  }
});
