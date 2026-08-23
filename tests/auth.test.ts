import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
import { Hono } from 'hono';
import { authRouter, requireAdminForMutations } from '../apps/server/src/auth';
import { apiRouter } from '../apps/server/src/routes/api';

describe('Admin authentication', () => {
  const originalPassword = process.env.ADMIN_PASSWORD;
  const originalToken = process.env.ADMIN_TOKEN;
  const password = 'test-admin-password';
  const apiToken = 'test-api-token';
  const app = new Hono();

  beforeAll(() => {
    process.env.ADMIN_PASSWORD = password;
    process.env.ADMIN_TOKEN = apiToken;
  });

  afterAll(() => {
    if (originalPassword === undefined) delete process.env.ADMIN_PASSWORD;
    else process.env.ADMIN_PASSWORD = originalPassword;
    if (originalToken === undefined) delete process.env.ADMIN_TOKEN;
    else process.env.ADMIN_TOKEN = originalToken;
  });

  app.use('/api/*', requireAdminForMutations);
  app.route('/api/auth', authRouter);
  app.get('/api/libraries', (c) => c.json({ libraries: [] }));
  app.post('/api/libraries', (c) => c.json({ created: true }));
  app.delete('/api/libraries/:id', (c) => c.json({ deleted: c.req.param('id') }));
  app.route('/api', apiRouter);

  it('keeps read routes public and rejects anonymous mutations', async () => {
    const readResponse = await app.request('/api/libraries');
    const writeResponse = await app.request('/api/libraries', { method: 'POST' });
    const deleteResponse = await app.request('/api/libraries/lib_1', { method: 'DELETE' });

    expect(readResponse.status).toBe(200);
    expect(writeResponse.status).toBe(401);
    expect(await writeResponse.json()).toEqual({ error: 'Admin authentication required' });
    expect(deleteResponse.status).toBe(401);
  });

  it('creates an HttpOnly session and authorizes mutations after login', async () => {
    const loginResponse = await app.request('/api/auth/login', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Real-IP': 'auth-success-test' },
      body: JSON.stringify({ password })
    });
    const setCookie = loginResponse.headers.get('set-cookie');

    expect(loginResponse.status).toBe(200);
    expect(setCookie).toContain('caster_admin_session=');
    expect(setCookie).toContain('HttpOnly');
    expect(setCookie).toContain('SameSite=Strict');

    const cookie = setCookie!.split(';')[0];
    const sessionResponse = await app.request('/api/auth/session', {
      headers: { Cookie: cookie }
    });
    const writeResponse = await app.request('/api/libraries', {
      method: 'POST',
      headers: { Cookie: cookie }
    });

    expect(await sessionResponse.json()).toEqual({ authenticated: true, configured: true });
    expect(writeResponse.status).toBe(200);
  });

  it('rejects bad credentials and accepts the configured Bearer token', async () => {
    const loginResponse = await app.request('/api/auth/login', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Real-IP': 'auth-failure-test' },
      body: JSON.stringify({ password: 'wrong-password' })
    });
    const tokenResponse = await app.request('/api/libraries/lib_2', {
      method: 'DELETE',
      headers: { Authorization: `Bearer ${apiToken}` }
    });

    expect(loginResponse.status).toBe(401);
    expect(tokenResponse.status).toBe(200);
  });

  it('invalidates a browser session on logout', async () => {
    const loginResponse = await app.request('/api/auth/login', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Real-IP': 'auth-logout-test' },
      body: JSON.stringify({ password })
    });
    const cookie = loginResponse.headers.get('set-cookie')!.split(';')[0];

    const logoutResponse = await app.request('/api/auth/logout', {
      method: 'POST',
      headers: { Cookie: cookie }
    });
    const writeResponse = await app.request('/api/libraries', {
      method: 'POST',
      headers: { Cookie: cookie }
    });

    expect(logoutResponse.status).toBe(200);
    expect(writeResponse.status).toBe(401);
  });

  it('protects the transcode kill switch as an admin mutation', async () => {
    const anonymousResponse = await app.request('/api/system/transcodes/kill', {
      method: 'POST'
    });
    const adminResponse = await app.request('/api/system/transcodes/kill', {
      method: 'POST',
      headers: { Authorization: `Bearer ${apiToken}` }
    });

    expect(anonymousResponse.status).toBe(401);
    expect(adminResponse.status).toBe(200);
    expect(await adminResponse.json()).toMatchObject({ success: true, killed: 0 });
  });
});
