import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
import { Database } from 'bun:sqlite';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { Hono } from 'hono';
import {
  authRouter,
  createAuthRouter,
  getCurrentUserId,
  hashSessionToken,
  requireAdminForMutations
} from '../apps/server/src/auth';
import { db, initDatabase } from '../apps/server/src/db';
import { AccessControlStore } from '../apps/server/src/db/access-control';
import { SqliteSessionStore } from '../apps/server/src/db/session-store';
import { SqliteUserStore, verifyPassword } from '../apps/server/src/db/user-store';
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
    initDatabase();
    const users = new SqliteUserStore(db);
    users.setCredential('admin', 'password', password);
    users.setCredential('admin', 'api_token', apiToken);
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
  app.get('/api/progress-owner', (c) => c.json({ userId: getCurrentUserId(c) }));
  app.post('/api/libraries', (c) => c.json({ created: true }));
  app.delete('/api/libraries/:id', (c) => c.json({ deleted: c.req.param('id') }));
  app.route('/api', apiRouter);

  it('keeps read routes public and rejects anonymous mutations', async () => {
    const readResponse = await app.request('/api/libraries');
    const writeResponse = await app.request('/api/libraries', { method: 'POST' });
    const deleteResponse = await app.request('/api/libraries/lib_1', { method: 'DELETE' });
    const ownerResponse = await app.request('/api/progress-owner');

    expect(readResponse.status).toBe(200);
    expect(writeResponse.status).toBe(401);
    expect(await writeResponse.json()).toEqual({ error: 'Authentication required' });
    expect(deleteResponse.status).toBe(401);
    expect(await ownerResponse.json()).toEqual({ userId: 'public' });
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
    const ownerResponse = await app.request('/api/progress-owner', {
      headers: { Cookie: cookie }
    });

    expect(await sessionResponse.json()).toEqual({
      authenticated: true,
      configured: true,
      protectedMode: true,
      user: { id: 'admin', username: 'admin', role: 'admin' }
    });
    expect(writeResponse.status).toBe(200);
    expect(await ownerResponse.json()).toEqual({ userId: 'admin' });
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

  it('rejects malformed login bodies and rate-limits repeated failures', async () => {
    const malformedResponse = await app.request('/api/auth/login', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Real-IP': 'auth-malformed-test' },
      body: '{'
    });
    expect(malformedResponse.status).toBe(400);
    expect(await malformedResponse.json()).toEqual({ error: 'A password or token is required' });

    const headers = {
      'Content-Type': 'application/json',
      'X-Real-IP': 'auth-rate-limit-test'
    };
    for (let attempt = 0; attempt < 5; attempt += 1) {
      const response = await app.request('/api/auth/login', {
        method: 'POST',
        headers,
        body: JSON.stringify({ password: 'wrong-password' })
      });
      expect(response.status).toBe(401);
    }

    const limitedResponse = await app.request('/api/auth/login', {
      method: 'POST',
      headers,
      body: JSON.stringify({ password })
    });
    expect(limitedResponse.status).toBe(429);
    expect(Number(limitedResponse.headers.get('Retry-After'))).toBeGreaterThan(0);
  });

  it('invalidates a browser session on logout', async () => {
    const anonymousLogout = await app.request('/api/auth/logout', { method: 'POST' });
    expect(anonymousLogout.status).toBe(200);

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

  it('persists only a session digest and accepts it after reopening the database', async () => {
    const testDirectory = fs.mkdtempSync(path.join(os.tmpdir(), 'caster-session-test-'));
    const databasePath = path.join(testDirectory, 'sessions.db');
    let firstDatabase: Database | undefined;
    let secondDatabase: Database | undefined;

    try {
      firstDatabase = new Database(databasePath);
      initDatabase(firstDatabase);
      const firstApp = new Hono();
      firstApp.route('/api/auth', createAuthRouter(
        new SqliteSessionStore(firstDatabase),
        new SqliteUserStore(firstDatabase)
      ));

      const loginResponse = await firstApp.request('/api/auth/login', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'X-Real-IP': 'auth-restart-test' },
        body: JSON.stringify({ password })
      });
      const cookie = loginResponse.headers.get('set-cookie')!.split(';')[0];
      const rawToken = cookie.slice(cookie.indexOf('=') + 1);
      const storedSession = firstDatabase.query(`
        SELECT token_hash, user_id FROM auth_sessions
      `).get() as { token_hash: string; user_id: string };

      expect(storedSession).toEqual({
        token_hash: hashSessionToken(rawToken),
        user_id: 'admin'
      });
      expect(storedSession.token_hash).not.toContain(rawToken);

      firstDatabase.close();
      firstDatabase = undefined;

      secondDatabase = new Database(databasePath);
      initDatabase(secondDatabase);
      const restartedApp = new Hono();
      restartedApp.route('/api/auth', createAuthRouter(
        new SqliteSessionStore(secondDatabase),
        new SqliteUserStore(secondDatabase)
      ));

      const sessionResponse = await restartedApp.request('/api/auth/session', {
        headers: { Cookie: cookie }
      });

      expect(await sessionResponse.json()).toEqual({
        authenticated: true,
        configured: true,
        protectedMode: true,
        user: { id: 'admin', username: 'admin', role: 'admin' }
      });
    } finally {
      firstDatabase?.close();
      secondDatabase?.close();
      fs.rmSync(testDirectory, { recursive: true, force: true });
    }
  });

  it('rejects and removes expired sessions and prunes them in bounded batches', async () => {
    const database = new Database(':memory:');
    try {
      initDatabase(database);
      const store = new SqliteSessionStore(database);
      const now = Date.now();
      const expiredToken = 'expired-session-token';
      store.create(hashSessionToken(expiredToken), 'admin', now - 2_000, now - 1_000);

      const testApp = new Hono();
      testApp.route('/api/auth', createAuthRouter(store, new SqliteUserStore(database)));
      const response = await testApp.request('/api/auth/session', {
        headers: { Cookie: `caster_admin_session=${expiredToken}` }
      });

      expect(await response.json()).toEqual({
        authenticated: false,
        configured: true,
        protectedMode: true
      });
      expect(database.query(`
        SELECT COUNT(*) AS count FROM auth_sessions WHERE token_hash = ?
      `).get(hashSessionToken(expiredToken))).toEqual({ count: 0 });

      store.create(hashSessionToken('expired-two'), 'admin', now - 2_000, now - 1_000);
      store.create(hashSessionToken('expired-three'), 'admin', now - 2_000, now - 1_000);
      expect(store.pruneExpired(now, 1)).toBe(1);
      expect(database.query('SELECT COUNT(*) AS count FROM auth_sessions').get()).toEqual({ count: 1 });
    } finally {
      database.close();
    }
  });

  it('bootstraps legacy credentials as hashes and supports independent named users', async () => {
    const database = new Database(':memory:');
    try {
      initDatabase(database);
      const sessionStore = new SqliteSessionStore(database);
      const userStore = new SqliteUserStore(database);
      const testApp = new Hono();
      testApp.route('/api/auth', createAuthRouter(sessionStore, userStore));

      const adminLogin = await testApp.request('/api/auth/login', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'X-Real-IP': 'accounts-admin-login' },
        body: JSON.stringify({ password })
      });
      expect(adminLogin.status).toBe(200);
      const adminCookie = adminLogin.headers.get('set-cookie')!.split(';')[0];

      const storedCredentials = database.query(`
        SELECT type, secret_hash FROM user_credentials
        WHERE user_id = 'admin' ORDER BY type
      `).all() as Array<{ type: string; secret_hash: string }>;
      expect(storedCredentials).toHaveLength(2);
      expect(storedCredentials.every((credential) =>
        credential.secret_hash !== password && credential.secret_hash !== apiToken
      )).toBe(true);
      const passwordHash = storedCredentials.find((credential) => credential.type === 'password')!.secret_hash;
      expect(passwordHash.startsWith('scrypt$')).toBe(true);
      expect(verifyPassword(password, passwordHash)).toBe(true);
      expect(storedCredentials.find((credential) => credential.type === 'api_token')!.secret_hash)
        .toMatch(/^sha256\$[a-f0-9]{64}$/);

      const createViewer = await testApp.request('/api/auth/users', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Cookie: adminCookie },
        body: JSON.stringify({
          username: 'family-viewer',
          password: 'viewer-password',
          role: 'viewer'
        })
      });
      expect(createViewer.status).toBe(201);
      const viewer = (await createViewer.json() as { user: { id: string } }).user;

      const viewerLogin = await testApp.request('/api/auth/login', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'X-Real-IP': 'accounts-viewer-login' },
        body: JSON.stringify({ username: 'FAMILY-VIEWER', password: 'viewer-password' })
      });
      expect(viewerLogin.status).toBe(200);
      expect(await viewerLogin.clone().json()).toMatchObject({
        authenticated: true,
        user: { id: viewer.id, username: 'family-viewer', role: 'viewer' }
      });
      const viewerCookie = viewerLogin.headers.get('set-cookie')!.split(';')[0];
      const viewerSession = await testApp.request('/api/auth/session', {
        headers: { Cookie: viewerCookie }
      });
      expect(await viewerSession.json()).toMatchObject({
        authenticated: true,
        user: { id: viewer.id, role: 'viewer' }
      });
      const viewerAdminRequest = await testApp.request('/api/auth/users', {
        headers: { Cookie: viewerCookie }
      });
      expect(viewerAdminRequest.status).toBe(403);

      const persistedViewerCredential = database.query(`
        SELECT secret_hash FROM user_credentials WHERE user_id = ? AND type = 'password'
      `).get(viewer.id) as { secret_hash: string };
      expect(persistedViewerCredential.secret_hash).not.toContain('viewer-password');
      expect(verifyPassword('viewer-password', persistedViewerCredential.secret_hash)).toBe(true);
    } finally {
      database.close();
    }
  });

  it('uses environment credentials only for bootstrap and honors password and token rotation', async () => {
    const database = new Database(':memory:');
    try {
      initDatabase(database);
      const sessionStore = new SqliteSessionStore(database);
      const userStore = new SqliteUserStore(database);
      const testApp = new Hono();
      testApp.route('/api/auth', createAuthRouter(sessionStore, userStore));

      const initialLogin = await testApp.request('/api/auth/login', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'X-Real-IP': 'rotation-initial-login' },
        body: JSON.stringify({ password })
      });
      expect(initialLogin.status).toBe(200);
      const adminCookie = initialLogin.headers.get('set-cookie')!.split(';')[0];
      const rotatedPassword = 'rotated-admin-password';
      const rotatedToken = 'rotated-admin-api-token-value';

      const rotateResponse = await testApp.request('/api/auth/users/admin', {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json', Cookie: adminCookie },
        body: JSON.stringify({ password: rotatedPassword, apiToken: rotatedToken })
      });
      expect(rotateResponse.status).toBe(200);

      // A fresh store instance exercises restart bootstrap with the original,
      // now-stale environment values still present.
      const restartedApp = new Hono();
      restartedApp.route('/api/auth', createAuthRouter(
        new SqliteSessionStore(database),
        new SqliteUserStore(database)
      ));

      const login = (credential: string, key: string) => restartedApp.request('/api/auth/login', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'X-Real-IP': key },
        body: JSON.stringify({ password: credential })
      });
      expect((await login(password, 'rotation-stale-env-password')).status).toBe(401);
      expect((await login(apiToken, 'rotation-stale-env-token-form')).status).toBe(401);
      expect((await login(rotatedPassword, 'rotation-new-password')).status).toBe(200);

      const oldTokenResponse = await restartedApp.request('/api/auth/users', {
        headers: { Authorization: `Bearer ${apiToken}` }
      });
      const newTokenResponse = await restartedApp.request('/api/auth/users', {
        headers: { Authorization: `Bearer ${rotatedToken}` }
      });
      const oldPasswordBearer = await restartedApp.request('/api/auth/users', {
        headers: { Authorization: `Bearer ${password}` }
      });
      const newPasswordBearer = await restartedApp.request('/api/auth/users', {
        headers: { Authorization: `Bearer ${rotatedPassword}` }
      });
      expect(oldTokenResponse.status).toBe(401);
      expect(newTokenResponse.status).toBe(200);
      expect(oldPasswordBearer.status).toBe(401);
      expect(newPasswordBearer.status).toBe(401);
      expect(await (await restartedApp.request('/api/auth/session', {
        headers: { Cookie: adminCookie }
      })).json()).toMatchObject({ authenticated: false });
    } finally {
      database.close();
    }
  });

  it('persists a named viewer and its session across a database restart', async () => {
    const testDirectory = fs.mkdtempSync(path.join(os.tmpdir(), 'caster-viewer-restart-test-'));
    const databasePath = path.join(testDirectory, 'viewer.db');
    let firstDatabase: Database | undefined;
    let secondDatabase: Database | undefined;

    try {
      firstDatabase = new Database(databasePath);
      initDatabase(firstDatabase);
      const firstUserStore = new SqliteUserStore(firstDatabase);
      const viewer = firstUserStore.create('persistent-viewer', 'Persistent Viewer', 'viewer');
      firstUserStore.setCredential(viewer.id, 'password', 'persistent-viewer-password');
      const firstApp = new Hono();
      firstApp.route('/api/auth', createAuthRouter(
        new SqliteSessionStore(firstDatabase),
        firstUserStore
      ));

      const loginResponse = await firstApp.request('/api/auth/login', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'X-Real-IP': 'viewer-restart-login' },
        body: JSON.stringify({
          username: 'Persistent Viewer',
          password: 'persistent-viewer-password'
        })
      });
      expect(loginResponse.status).toBe(200);
      const viewerCookie = loginResponse.headers.get('set-cookie')!.split(';')[0];

      firstDatabase.close();
      firstDatabase = undefined;
      secondDatabase = new Database(databasePath);
      initDatabase(secondDatabase);
      const restartedApp = new Hono();
      restartedApp.route('/api/auth', createAuthRouter(
        new SqliteSessionStore(secondDatabase),
        new SqliteUserStore(secondDatabase)
      ));

      const sessionResponse = await restartedApp.request('/api/auth/session', {
        headers: { Cookie: viewerCookie }
      });
      expect(await sessionResponse.json()).toMatchObject({
        authenticated: true,
        user: { id: viewer.id, username: viewer.username, role: 'viewer' }
      });
    } finally {
      firstDatabase?.close();
      secondDatabase?.close();
      fs.rmSync(testDirectory, { recursive: true, force: true });
    }
  });

  it('invalidates all sessions when an administrator disables a user or resets a password', async () => {
    const database = new Database(':memory:');
    try {
      initDatabase(database);
      const sessionStore = new SqliteSessionStore(database);
      const userStore = new SqliteUserStore(database);
      const testApp = new Hono();
      testApp.route('/api/auth', createAuthRouter(sessionStore, userStore));

      const adminLogin = await testApp.request('/api/auth/login', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'X-Real-IP': 'disable-admin-login' },
        body: JSON.stringify({ password })
      });
      const adminCookie = adminLogin.headers.get('set-cookie')!.split(';')[0];
      const createdResponse = await testApp.request('/api/auth/users', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Cookie: adminCookie },
        body: JSON.stringify({ username: 'disable-me', password: 'initial-password' })
      });
      const userId = (await createdResponse.json() as { user: { id: string } }).user.id;

      const login = async (credential: string, key: string) => testApp.request('/api/auth/login', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'X-Real-IP': key },
        body: JSON.stringify({ username: 'disable-me', password: credential })
      });
      const firstLogin = await login('initial-password', 'disable-viewer-login-1');
      const firstCookie = firstLogin.headers.get('set-cookie')!.split(';')[0];

      const disableResponse = await testApp.request(`/api/auth/users/${userId}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json', Cookie: adminCookie },
        body: JSON.stringify({ active: false })
      });
      expect(disableResponse.status).toBe(200);
      expect(database.query('SELECT COUNT(*) AS count FROM auth_sessions WHERE user_id = ?').get(userId))
        .toEqual({ count: 0 });
      const disabledSession = await testApp.request('/api/auth/session', {
        headers: { Cookie: firstCookie }
      });
      expect(await disabledSession.json()).toMatchObject({ authenticated: false });
      expect((await login('initial-password', 'disable-viewer-login-2')).status).toBe(401);

      await testApp.request(`/api/auth/users/${userId}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json', Cookie: adminCookie },
        body: JSON.stringify({ active: true })
      });
      const secondLogin = await login('initial-password', 'disable-viewer-login-3');
      const secondCookie = secondLogin.headers.get('set-cookie')!.split(';')[0];
      const resetResponse = await testApp.request(`/api/auth/users/${userId}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json', Cookie: adminCookie },
        body: JSON.stringify({ password: 'replacement-password' })
      });
      expect(resetResponse.status).toBe(200);
      expect((await testApp.request('/api/auth/session', {
        headers: { Cookie: secondCookie }
      })).status).toBe(200);
      expect(await (await testApp.request('/api/auth/session', {
        headers: { Cookie: secondCookie }
      })).json()).toMatchObject({ authenticated: false });
      expect((await login('initial-password', 'disable-viewer-login-4')).status).toBe(401);
      expect((await login('replacement-password', 'disable-viewer-login-5')).status).toBe(200);
    } finally {
      database.close();
    }
  });

  it('switches shared-TV profiles only from a cookie session with the target PIN', async () => {
    const database = new Database(':memory:');
    try {
      initDatabase(database);
      const sessionStore = new SqliteSessionStore(database);
      const userStore = new SqliteUserStore(database);
      const accessControlStore = new AccessControlStore(database);
      const testApp = new Hono();
      testApp.route('/api/auth', createAuthRouter(
        sessionStore,
        userStore,
        accessControlStore
      ));

      const target = userStore.create('tv-kids', 'Kids', 'viewer');
      accessControlStore.setProfilePin(target.id, '0427');
      const bruteForceTarget = userStore.create('tv-brute-force', 'Brute Force', 'viewer');
      accessControlStore.setProfilePin(bruteForceTarget.id, '1357');
      const otherViewer = userStore.create('tv-other', 'Other Viewer', 'viewer');
      accessControlStore.setProfilePin(otherViewer.id, '2468');
      accessControlStore.setProfilePin('admin', '9876');
      const adminLogin = await testApp.request('/api/auth/login', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'X-Real-IP': 'switch-admin-login' },
        body: JSON.stringify({ password })
      });
      const adminCookie = adminLogin.headers.get('set-cookie')!.split(';')[0];

      const bearerSwitch = await testApp.request('/api/auth/profile/switch', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${apiToken}`,
          Cookie: adminCookie
        },
        body: JSON.stringify({ username: 'Kids', pin: '0427' })
      });
      expect(bearerSwitch.status).toBe(403);
      expect(bearerSwitch.headers.get('set-cookie')).toBeNull();

      const wrongPin = await testApp.request('/api/auth/profile/switch', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Cookie: adminCookie },
        body: JSON.stringify({ username: 'Kids', pin: '9999' })
      });
      expect(wrongPin.status).toBe(401);
      expect(wrongPin.headers.get('set-cookie')).toBeNull();
      expect(await (await testApp.request('/api/auth/session', {
        headers: { Cookie: adminCookie }
      })).json()).toMatchObject({ authenticated: true, user: { id: 'admin' } });

      const switched = await testApp.request('/api/auth/profile/switch', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Cookie: adminCookie },
        body: JSON.stringify({ username: 'kids', pin: '0427' })
      });
      expect(switched.status).toBe(200);
      expect(await switched.clone().json()).toEqual({
        authenticated: true,
        user: { id: target.id, username: 'Kids', role: 'viewer' }
      });
      const viewerCookie = switched.headers.get('set-cookie')!.split(';')[0];
      expect(viewerCookie).not.toBe(adminCookie);
      expect(await (await testApp.request('/api/auth/session', {
        headers: { Cookie: adminCookie }
      })).json()).toMatchObject({ authenticated: false });
      expect(await (await testApp.request('/api/auth/session', {
        headers: { Cookie: viewerCookie }
      })).json()).toMatchObject({ authenticated: true, user: { id: target.id } });

      const viewerDeniedByDefault = await testApp.request('/api/auth/profile/switch', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Cookie: viewerCookie },
        body: JSON.stringify({ username: 'Other Viewer', pin: '2468' })
      });
      expect(viewerDeniedByDefault.status).toBe(403);
      expect(await viewerDeniedByDefault.json()).toEqual({
        error: 'Profile switching is not permitted'
      });

      accessControlStore.updatePermissions(target.id, { canManageProfiles: true });

      const upwardSwitch = await testApp.request('/api/auth/profile/switch', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Cookie: viewerCookie },
        body: JSON.stringify({ username: 'admin', pin: '9876' })
      });
      expect(upwardSwitch.status).toBe(401);
      expect(await upwardSwitch.json()).toEqual({ error: 'Invalid profile or PIN' });
      expect(upwardSwitch.headers.get('set-cookie')).toBeNull();

      const viewerAllowedAfterGrant = await testApp.request('/api/auth/profile/switch', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Cookie: viewerCookie },
        body: JSON.stringify({ username: 'Other Viewer', pin: '2468' })
      });
      expect(viewerAllowedAfterGrant.status).toBe(200);
      expect(await viewerAllowedAfterGrant.clone().json()).toMatchObject({
        authenticated: true,
        user: { id: otherViewer.id, role: 'viewer' }
      });
      expect(viewerAllowedAfterGrant.headers.get('set-cookie')).not.toBeNull();

      const randomSessionSwitch = await testApp.request('/api/auth/profile/switch', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Cookie: 'caster_admin_session=random-invalid-session'
        },
        body: JSON.stringify({ username: 'Kids', pin: '0427' })
      });
      expect(randomSessionSwitch.status).toBe(401);
      expect(await randomSessionSwitch.json()).toEqual({ error: 'Authentication required' });

      const secondAdminLogin = await testApp.request('/api/auth/login', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'X-Real-IP': 'switch-admin-login-2' },
        body: JSON.stringify({ password })
      });
      const secondAdminCookie = secondAdminLogin.headers.get('set-cookie')!.split(';')[0];
      userStore.update(target.id, { active: false });
      const inactiveSwitch = await testApp.request('/api/auth/profile/switch', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Cookie: secondAdminCookie },
        body: JSON.stringify({ username: 'Kids', pin: '0427' })
      });
      expect(inactiveSwitch.status).toBe(401);
      expect(inactiveSwitch.headers.get('set-cookie')).toBeNull();
      expect(await (await testApp.request('/api/auth/session', {
        headers: { Cookie: secondAdminCookie }
      })).json()).toMatchObject({ authenticated: true, user: { id: 'admin' } });

      userStore.update(target.id, { active: true });
      for (let attempt = 0; attempt < 5; attempt += 1) {
        const failedSwitch = await testApp.request('/api/auth/profile/switch', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', Cookie: secondAdminCookie },
          body: JSON.stringify({ username: 'Brute Force', pin: '1111' })
        });
        expect(failedSwitch.status).toBe(401);
        expect(await failedSwitch.json()).toEqual({ error: 'Invalid profile or PIN' });
      }
      const limitedSwitch = await testApp.request('/api/auth/profile/switch', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Cookie: secondAdminCookie },
        body: JSON.stringify({ username: 'Brute Force', pin: '1357' })
      });
      expect(limitedSwitch.status).toBe(429);
      expect(Number(limitedSwitch.headers.get('Retry-After'))).toBeGreaterThan(0);
      expect(limitedSwitch.headers.get('set-cookie')).toBeNull();

      const otherTargetSwitch = await testApp.request('/api/auth/profile/switch', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Cookie: secondAdminCookie },
        body: JSON.stringify({ username: 'Kids', pin: '0427' })
      });
      expect(otherTargetSwitch.status).toBe(200);
    } finally {
      database.close();
    }
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
