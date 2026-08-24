import { Hono } from 'hono';
import { serveStatic, websocket } from 'hono/bun';
import fs from 'fs';
import path from 'path';
import { initDatabase } from './db';
import { apiRouter } from './routes/api';
import { transcoder } from './transcoder/engine';
import {
  authRouter,
  isAuthConfigured,
  startSessionPruner
} from './auth';
import {
  apiRequestSecurity,
  openModeIsExplicitlyEnabled
} from './security/request-security';

// Initialize SQLite database
initDatabase();

const app = new Hono();

// Protected deployments require a principal for reads and streams, restrict
// administration to admins, and enforce trusted-origin/CSRF checks. Explicit
// local/open mode preserves account-free media browsing.
app.use('/api/*', apiRequestSecurity);
app.route('/api/auth', authRouter);

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
  startSessionPruner();
  console.log(`\n======================================================`);
  console.log(`🚀 Caster Media Server starting on http://${HOST}:${PORT}`);
  console.log(`🌐 Tailscale & Local Network Ready`);
  const hw = transcoder.getHardwareStatus();
  console.log(`⚡ Hardware Acceleration: [${hw.accelType.toUpperCase()}]`);
  console.log(`   - Intel QSV: ${hw.qsvSupported ? '✓ Available' : '✗'}`);
  console.log(`   - NVIDIA NVENC: ${hw.nvencSupported ? '✓ Available' : '✗'}`);
  console.log(`   - VAAPI: ${hw.vaapiSupported ? '✓ Available' : '✗'}`);
  console.log(`======================================================\n`);

  if (!isAuthConfigured()) {
    if (openModeIsExplicitlyEnabled()) {
      console.warn('SECURITY WARNING: CASTER_OPEN_MODE=true enables unauthenticated catalog and playback access.');
      console.warn(`Anonymous clients are limited to CASTER_OPEN_NETWORKS=${process.env.CASTER_OPEN_NETWORKS ?? '127.0.0.0/8,::1/128'}.`);
      console.warn('Administrative routes remain locked until the one-time owner setup is complete.');
    } else {
      console.warn('SECURITY NOTICE: This server has not been claimed. Complete owner setup in a browser from a local network.');
      console.warn('Use CASTER_SETUP_NETWORKS only when the setup client is outside the built-in private-network ranges.');
    }
  }

  if (process.env.CASTER_OPEN_MODE && !openModeIsExplicitlyEnabled()) {
    console.warn(`SECURITY NOTICE: Ignoring CASTER_OPEN_MODE=${JSON.stringify(process.env.CASTER_OPEN_MODE)}; only the value "true" (case-insensitive) enables it.`);
  }
}

export default {
  port: PORT,
  hostname: HOST,
  fetch: app.fetch,
  websocket
};
