import { Hono } from 'hono';
import { cors } from 'hono/cors';
import { serveStatic } from 'hono/bun';
import fs from 'fs';
import path from 'path';
import { initDatabase } from './db';
import { apiRouter } from './routes/api';
import { transcoder } from './transcoder/engine';

// Initialize SQLite database
initDatabase();

const app = new Hono();

// Enable permissive CORS for Tailscale mesh networks and local IPs
app.use('*', cors({
  origin: '*',
  allowMethods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS'],
  allowHeaders: ['Content-Type', 'Authorization', 'Range'],
  exposeHeaders: ['Content-Range', 'Accept-Ranges', 'Content-Length', 'Content-Type']
}));

// Mount API router
app.route('/api', apiRouter);

// Health check endpoint
app.get('/health', (c) => c.json({
  status: 'ok',
  service: 'NovaStream Media Server',
  time: new Date().toISOString()
}));

// Serve static web app assets if built (for Docker / production deployment)
const WEB_DIST = path.join(__dirname, '../../web/dist');
if (fs.existsSync(WEB_DIST)) {
  app.use('/*', serveStatic({ root: WEB_DIST }));
  app.get('*', serveStatic({ path: path.join(WEB_DIST, 'index.html') }));
} else {
  app.get('/', (c) => c.html(`
    <!DOCTYPE html>
    <html>
      <head><title>NovaStream Media Server</title></head>
      <body style="font-family: sans-serif; background: #0f172a; color: #f8fafc; padding: 40px; text-align: center;">
        <h1>🎬 NovaStream Media Server API is Running</h1>
        <p>API Base: <code>/api</code> | Port: <code>${process.env.PORT || 3001}</code></p>
        <p>Run the frontend with <code>bun run --filter '@media/web' dev</code> or build it for full web player integration.</p>
      </body>
    </html>
  `));
}

const PORT = parseInt(process.env.PORT || '3001', 10);
const HOST = process.env.HOST || '0.0.0.0';

console.log(`\n======================================================`);
console.log(`🚀 NovaStream Media Server starting on http://${HOST}:${PORT}`);
console.log(`🌐 Tailscale & Local Network Ready`);
const hw = transcoder.getHardwareStatus();
console.log(`⚡ Hardware Acceleration: [${hw.accelType.toUpperCase()}]`);
console.log(`   - Intel QSV: ${hw.qsvSupported ? '✓ Available' : '✗'}`);
console.log(`   - NVIDIA NVENC: ${hw.nvencSupported ? '✓ Available' : '✗'}`);
console.log(`   - VAAPI: ${hw.vaapiSupported ? '✓ Available' : '✗'}`);
console.log(`======================================================\n`);

export default {
  port: PORT,
  hostname: HOST,
  fetch: app.fetch
};
