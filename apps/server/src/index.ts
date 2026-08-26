import { Hono } from 'hono';
import { serveStatic, websocket } from 'hono/bun';
import fs from 'fs';
import path from 'path';
import { initDatabase } from './db';
import { apiRouter } from './routes/api';
import { transcoder } from './transcoder/engine';
import { createRemoteAccessRouter } from './routes/remote-access';
import { createConnectionRouter } from './routes/connection';
import { collectEndpointCandidates } from './remote/endpoints';
import { RemoteAccessStore } from './db/remote-store';
import { autoScanRuntime } from './scanner/runtime';
import { db } from './db';
import { apiRequestSecurity } from './security/request-security';

// Initialize SQLite database
initDatabase();

const app = new Hono();

// Caster is intentionally account-free. The API middleware only handles
// trusted-origin reflection and CORS preflight responses.
app.use('/api/*', apiRequestSecurity);

// Remote access is mounted ahead of the generic /api router so its routes are
// not shadowed by the catch-all API handler.
app.route('/api/remote-access', createRemoteAccessRouter({
  store: new RemoteAccessStore(db)
}));

// How clients discover the ways they can reach this server.
app.route('/api/connection', createConnectionRouter({
  collectEndpoints: () => collectEndpointCandidates()
}));

// Mount API router
app.route('/api', apiRouter);

// Health check endpoint
app.get('/health', (c) => c.json({
  status: 'ok',
  service: 'Caster Media Server',
  time: new Date().toISOString()
}));

// Keep unknown API calls machine-readable instead of falling through to the
// web app's SPA index page.
app.all('/api/*', (c) => c.json({ error: 'API route not found' }, 404));

// Serve static web app assets if built (for Docker / production deployment)
const WEB_DIST = path.join(__dirname, '../../web/dist');
if (fs.existsSync(WEB_DIST)) {
  app.use('/*', serveStatic({ root: WEB_DIST }));
  app.get('*', serveStatic({ path: path.join(WEB_DIST, 'index.html') }));
} else {
  app.get('/', (c) => c.html(`
    <!DOCTYPE html>
    <html>
      <head><title>Caster Media Server</title></head>
      <body style="font-family: sans-serif; background: #0f172a; color: #f8fafc; padding: 40px; text-align: center;">
        <h1>🎬 Caster Media Server API is Running</h1>
        <p>API Base: <code>/api</code> | Port: <code>${process.env.PORT || 3001}</code></p>
        <p>Run the frontend with <code>bun run --filter '@caster/web' dev</code> or build it for full web player integration.</p>
      </body>
    </html>
  `));
}

const PORT = parseInt(process.env.PORT || '3001', 10);
const HOST = process.env.HOST || '0.0.0.0';

if (import.meta.main) {
  // Only libraries an operator has explicitly enabled are touched; with none
  // enabled this starts a timer that finds nothing to do.
  autoScanRuntime.start();
  console.log(`\n======================================================`);
  console.log(`🚀 Caster Media Server starting on http://${HOST}:${PORT}`);
  console.log(`🌐 Tailscale & Local Network Ready`);
  const hw = transcoder.getHardwareStatus();
  console.log(`⚡ Hardware Acceleration: [${hw.accelType.toUpperCase()}]`);
  console.log(`   - Intel QSV: ${hw.qsvSupported ? '✓ Available' : '✗'}`);
  console.log(`   - NVIDIA NVENC: ${hw.nvencSupported ? '✓ Available' : '✗'}`);
  console.log(`   - VAAPI: ${hw.vaapiSupported ? '✓ Available' : '✗'}`);
  console.log(`======================================================\n`);

  console.warn('SECURITY NOTICE: Caster is running account-free; every API route is public.');
}

export default {
  port: PORT,
  hostname: HOST,
  fetch: app.fetch,
  websocket
};
