import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
import { Database } from 'bun:sqlite';
import { Hono } from 'hono';
import { createAuthRouter } from '../apps/server/src/auth';
import { initDatabase } from '../apps/server/src/db';
import { AccessControlStore } from '../apps/server/src/db/access-control';
import { AccountProvisioningStore } from '../apps/server/src/db/account-provisioning';
import { SqliteSessionStore } from '../apps/server/src/db/session-store';
import { SqliteUserStore } from '../apps/server/src/db/user-store';

describe('account provisioning', () => {
  const originalPassword = process.env.ADMIN_PASSWORD;
  const originalToken = process.env.ADMIN_TOKEN;

  beforeAll(() => {
    delete process.env.ADMIN_PASSWORD;
    delete process.env.ADMIN_TOKEN;
  });

  afterAll(() => {
    if (originalPassword === undefined) delete process.env.ADMIN_PASSWORD;
    else process.env.ADMIN_PASSWORD = originalPassword;
    if (originalToken === undefined) delete process.env.ADMIN_TOKEN;
    else process.env.ADMIN_TOKEN = originalToken;
  });

  function createTestServer(setupAllowed = true) {
    const database = new Database(':memory:');
    initDatabase(database);
    const users = new SqliteUserStore(database);
    const sessions = new SqliteSessionStore(database);
    const provisioning = new AccountProvisioningStore(database);
    const app = new Hono();
    app.route('/api/auth', createAuthRouter(
      sessions,
      users,
      new AccessControlStore(database),
      provisioning,
      { ownerSetupAllowed: () => setupAllowed }
    ));
    return { app, database, users, provisioning };
  }

  it('allows exactly one local owner claim and immediately creates a session', async () => {
    const { app, database, users } = createTestServer();
    try {
      expect(await (await app.request('/api/auth/session')).json()).toEqual({
        authenticated: false,
        configured: false,
        protectedMode: false,
        setupRequired: true
      });

      const setup = await app.request('/api/auth/setup', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ username: 'server-owner', password: 'owner-password' })
      });
      expect(setup.status).toBe(201);
      expect(await setup.clone().json()).toMatchObject({
        authenticated: true,
        user: { id: 'admin', username: 'server-owner', role: 'admin' }
      });
      expect(setup.headers.get('set-cookie')).toContain('HttpOnly');
      expect(users.credentialMatches('admin', 'password', 'owner-password')).toBe(true);

      const repeated = await app.request('/api/auth/setup', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ username: 'attacker', password: 'attacker-password' })
      });
      expect(repeated.status).toBe(409);
      expect(users.findById('admin')?.username).toBe('server-owner');
    } finally {
      database.close();
    }
  });

  it('refuses the first owner claim outside the host setup network', async () => {
    const { app, database } = createTestServer(false);
    try {
      const response = await app.request('/api/auth/setup', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ username: 'owner', password: 'owner-password' })
      });
      expect(response.status).toBe(403);
      expect(await (await app.request('/api/auth/session')).json()).toMatchObject({
        setupRequired: true,
        configured: false
      });
    } finally {
      database.close();
    }
  });

  it('stores only an invite digest and consumes the invite exactly once', async () => {
    const { app, database } = createTestServer();
    try {
      const setup = await app.request('/api/auth/setup', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ username: 'owner', password: 'owner-password' })
      });
      const ownerCookie = setup.headers.get('set-cookie')!.split(';')[0];
      const created = await app.request('/api/auth/invites', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Cookie: ownerCookie },
        body: JSON.stringify({ role: 'viewer', expiresInHours: 24 })
      });
      expect(created.status).toBe(201);
      const invite = (await created.json()).invite as { id: string; token: string; role: string };
      expect(invite.token.length).toBeGreaterThan(32);
      expect(invite.role).toBe('viewer');

      const stored = database.query(`
        SELECT token_hash FROM account_invites WHERE id = ?
      `).get(invite.id) as { token_hash: string };
      expect(stored.token_hash).toHaveLength(64);
      expect(stored.token_hash).not.toContain(invite.token);

      const inspected = await app.request('/api/auth/invites/inspect', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ token: invite.token })
      });
      expect(await inspected.json()).toMatchObject({ invite: { role: 'viewer' } });

      const signup = await app.request('/api/auth/signup', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          token: invite.token,
          username: 'invited-viewer',
          password: 'viewer-password'
        })
      });
      expect(signup.status).toBe(201);
      expect(await signup.clone().json()).toMatchObject({
        authenticated: true,
        user: { username: 'invited-viewer', role: 'viewer' }
      });
      expect(signup.headers.get('set-cookie')).toContain('HttpOnly');

      const replay = await app.request('/api/auth/signup', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          token: invite.token,
          username: 'second-viewer',
          password: 'second-password'
        })
      });
      expect(replay.status).toBe(404);
      expect(database.query(`SELECT COUNT(*) AS count FROM users`).get()).toEqual({ count: 2 });
    } finally {
      database.close();
    }
  });

  it('lets an owner revoke a pending invite', async () => {
    const { app, database } = createTestServer();
    try {
      const setup = await app.request('/api/auth/setup', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ username: 'owner', password: 'owner-password' })
      });
      const cookie = setup.headers.get('set-cookie')!.split(';')[0];
      const created = await app.request('/api/auth/invites', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Cookie: cookie },
        body: JSON.stringify({ role: 'admin', expiresInHours: 1 })
      });
      const invite = (await created.json()).invite as { id: string; token: string };

      expect((await app.request(`/api/auth/invites/${invite.id}`, {
        method: 'DELETE',
        headers: { Cookie: cookie }
      })).status).toBe(200);
      expect((await app.request('/api/auth/invites/inspect', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ token: invite.token })
      })).status).toBe(404);
    } finally {
      database.close();
    }
  });
});
