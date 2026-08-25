import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
import { Database } from 'bun:sqlite';
import { Hono } from 'hono';
import {
  DEFAULT_PAIRING_TTL_MS,
  DevicePairingService,
  MAX_PAIRING_ATTEMPTS,
  PAIRING_CODE_CHARSET,
  PAIRING_CODE_LENGTH
} from '../apps/server/src/security/device-pairing';
import { SqliteDeviceStore, hashDeviceToken } from '../apps/server/src/db/device-store';
import { initDatabase } from '../apps/server/src/db';
import { DATABASE_MIGRATIONS } from '../apps/server/src/db/migrations';
import { SqliteSessionStore } from '../apps/server/src/db/session-store';
import { SqliteUserStore } from '../apps/server/src/db/user-store';
import { createDevicesRouter } from '../apps/server/src/routes/devices';
import { resolvePrincipal } from '../apps/server/src/auth';

const FORBIDDEN_CHARACTERS = ['0', 'O', '1', 'I', 'L'];

interface TestContext {
  app: Hono;
  database: Database;
  devices: SqliteDeviceStore;
  pairing: DevicePairingService;
  aliceId: string;
  bobId: string;
}

function createTestContext(aliceToken: string, bobToken: string): TestContext {
  const database = new Database(':memory:');
  initDatabase(database);
  const users = new SqliteUserStore(database);
  const sessions = new SqliteSessionStore(database);
  const devices = new SqliteDeviceStore(database);
  const pairing = new DevicePairingService(database, devices);
  const alice = users.create(crypto.randomUUID(), 'alice', 'admin');
  const bob = users.create(crypto.randomUUID(), 'bob', 'viewer');
  users.setCredential(alice.id, 'api_token', aliceToken);
  users.setCredential(bob.id, 'api_token', bobToken);
  const app = new Hono();
  app.route('/api/auth/devices', createDevicesRouter({
    deviceStore: devices,
    pairing,
    resolvePrincipal: (c) => resolvePrincipal(c, sessions, users, devices)
  }));
  app.get('/whoami', (c) => c.json({
    principal: resolvePrincipal(c, sessions, users, devices)
  }));
  return { app, database, devices, pairing, aliceId: alice.id, bobId: bob.id };
}

function devicePrincipal(context: TestContext, deviceToken: string): Promise<Response> {
  return context.app.request('/whoami', {
    headers: { Authorization: `Bearer ${deviceToken}` }
  });
}

async function createPairingCode(context: TestContext, bearerToken: string): Promise<{
  code: string;
  expiresAt: number;
}> {
  const response = await context.app.request('/api/auth/devices', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${bearerToken}`
    },
    body: JSON.stringify({})
  });
  expect(response.status).toBe(201);
  const body = await response.json();
  return { code: body.pairingCode, expiresAt: body.expiresAt };
}

describe('device identity and pairing', () => {
  const originalPassword = process.env.ADMIN_PASSWORD;
  const originalToken = process.env.ADMIN_TOKEN;
  let aliceToken = '';
  let bobToken = '';

  beforeAll(() => {
    delete process.env.ADMIN_PASSWORD;
    delete process.env.ADMIN_TOKEN;
    aliceToken = `alice-token-${crypto.randomUUID()}`;
    bobToken = `bob-token-${crypto.randomUUID()}`;
  });

  afterAll(() => {
    if (originalPassword === undefined) delete process.env.ADMIN_PASSWORD;
    else process.env.ADMIN_PASSWORD = originalPassword;
    if (originalToken === undefined) delete process.env.ADMIN_TOKEN;
    else process.env.ADMIN_TOKEN = originalToken;
  });

  it('applies the v14 device_identity_and_pairing migration cleanly', () => {
    expect(DATABASE_MIGRATIONS.find(({ name }) => name === 'device_identity_and_pairing')).toMatchObject({
      version: 14,
      name: 'device_identity_and_pairing'
    });
    const database = new Database(':memory:');
    try {
      initDatabase(database);
      const applied = database.query(
        'SELECT name FROM schema_migrations WHERE version = 14'
      ).get() as { name: string };
      expect(applied.name).toBe('device_identity_and_pairing');

      const tables = database.query(`
        SELECT name FROM sqlite_master WHERE type = 'table' AND name IN ('devices', 'pairing_codes')
      `).all() as Array<{ name: string }>;
      expect(tables.map((row) => row.name).sort()).toEqual(['devices', 'pairing_codes']);

      const indexes = database.query(`
        SELECT name FROM sqlite_master WHERE type = 'index' AND name LIKE 'idx_%devices%'
          OR type = 'index' AND name LIKE 'idx_pairing_codes%'
      `).all() as Array<{ name: string }>;
      const names = indexes.map((row) => row.name);
      for (const expected of [
        'idx_devices_user_id',
        'idx_devices_token_hash',
        'idx_pairing_codes_code_hash',
        'idx_pairing_codes_expires_at'
      ]) {
        expect(names).toContain(expected);
      }
    } finally {
      database.close();
    }
  });

  it('generates unambiguous codes with the default TTL', () => {
    const context = createTestContext(aliceToken, bobToken);
    try {
      const codePattern = new RegExp(`^[${PAIRING_CODE_CHARSET}]{${PAIRING_CODE_LENGTH}}$`);
      expect(PAIRING_CODE_CHARSET).not.toMatch(/[01ILO]/);
      const seen = new Set<string>();
      for (let index = 0; index < 64; index++) {
        const generated = context.pairing.generatePairingCode(context.aliceId, { now: 1_000_000 });
        expect(generated.code).toMatch(codePattern);
        for (const forbidden of FORBIDDEN_CHARACTERS) {
          expect(generated.code).not.toContain(forbidden);
        }
        seen.add(generated.code);
        expect(generated.expiresAt - 1_000_000).toBe(DEFAULT_PAIRING_TTL_MS);
      }
      expect(seen.size).toBeGreaterThan(1);
    } finally {
      context.database.close();
    }
  });

  it('redeems a valid code into a scoped device credential exactly once', async () => {
    const context = createTestContext(aliceToken, bobToken);
    try {
      const { code, expiresAt } = await createPairingCode(context, aliceToken);
      expect(expiresAt).toBeLessThanOrEqual(Date.now() + DEFAULT_PAIRING_TTL_MS);

      const redeem = await context.app.request('/api/auth/devices/redeem', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'X-Real-IP': 'redeem-happy' },
        body: JSON.stringify({ code: code.toLowerCase(), name: 'Living Room TV', platform: 'android-tv' })
      });
      expect(redeem.status).toBe(200);
      const redeemed = await redeem.json();
      expect(redeemed.userId).toBe(context.aliceId);
      expect(redeemed.deviceId).toStartWith('dev_');
      expect(redeemed.deviceToken).toMatch(/^[A-Za-z0-9_-]{43}$/);

      const stored = context.database.query(`
        SELECT device_token_hash, status, user_id FROM devices WHERE id = ?
      `).get(redeemed.deviceId) as { device_token_hash: string; status: string; user_id: string };
      expect(stored.device_token_hash).toBe(hashDeviceToken(redeemed.deviceToken));
      expect(stored.device_token_hash).toStartWith('sha256$');
      expect(stored.status).toBe('active');
      expect(stored.user_id).toBe(context.aliceId);

      // The raw code and token are never stored in plaintext.
      const allRows = context.database.query(`
        SELECT code_hash FROM pairing_codes
      `).all() as Array<{ code_hash: string }>;
      expect(JSON.stringify(allRows)).not.toContain(code);

      // Replay is rejected.
      const replay = await context.app.request('/api/auth/devices/redeem', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'X-Real-IP': 'redeem-replay' },
        body: JSON.stringify({ code, name: 'Second TV', platform: 'android-tv' })
      });
      expect(replay.status).toBe(409);

      // The device token resolves a scoped principal for the owning user.
      const whoami = await devicePrincipal(context, redeemed.deviceToken);
      expect(await whoami.json()).toMatchObject({
        principal: {
          id: context.aliceId,
          role: 'admin',
          credential: 'device'
        }
      });

      // Resolution updates last_used_at.
      const afterUse = context.devices.findById(redeemed.deviceId)!;
      expect(afterUse.last_used_at).not.toBeNull();
    } finally {
      context.database.close();
    }
  });

  it('rejects expired codes without creating a device', async () => {
    const context = createTestContext(aliceToken, bobToken);
    try {
      const generated = context.pairing.generatePairingCode(context.aliceId, {
        ttlMs: 60_000,
        now: Date.now() - 120_000
      });
      const response = await context.app.request('/api/auth/devices/redeem', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'X-Real-IP': 'redeem-expired' },
        body: JSON.stringify({ code: generated.code, name: 'Old TV', platform: 'fire-tv' })
      });
      expect(response.status).toBe(400);
      expect(await response.json()).toEqual({ error: 'This pairing code has expired' });
      expect(context.devices.listDevicesForUser(context.aliceId)).toHaveLength(0);
    } finally {
      context.database.close();
    }
  });

  it('invalidates codes after five failed verifications', async () => {
    const context = createTestContext(aliceToken, bobToken);
    try {
      const { code } = await createPairingCode(context, aliceToken);
      const attemptsRow = () => context.database.query(
        'SELECT attempts, consumed_at FROM pairing_codes'
      ).get() as { attempts: number; consumed_at: number | null };

      for (let attempt = 1; attempt <= MAX_PAIRING_ATTEMPTS; attempt++) {
        const wrong = attempt === MAX_PAIRING_ATTEMPTS ? 'ZZZZZZZZ' : '22222222';
        const response = await context.app.request('/api/auth/devices/redeem', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', 'X-Real-IP': 'redeem-attempts' },
          body: JSON.stringify({ code: wrong, name: 'Mystery TV', platform: 'web' })
        });
        expect(response.status).toBe(400);
        expect(attemptsRow().attempts).toBe(attempt);
      }
      expect(attemptsRow().consumed_at).not.toBeNull();

      // Even the real code no longer redeems once invalidated.
      const correct = await context.app.request('/api/auth/devices/redeem', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'X-Real-IP': 'redeem-attempts' },
        body: JSON.stringify({ code, name: 'Living Room TV', platform: 'android-tv' })
      });
      expect(correct.status).toBe(400);
      expect(await correct.json()).toEqual({
        error: 'This pairing code was deactivated after too many failed attempts'
      });
      expect(context.devices.listDevicesForUser(context.aliceId)).toHaveLength(0);
    } finally {
      context.database.close();
    }
  });

  it('revoking a device invalidates its token immediately', async () => {
    const context = createTestContext(aliceToken, bobToken);
    try {
      const { code } = await createPairingCode(context, aliceToken);
      const redeem = await context.app.request('/api/auth/devices/redeem', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'X-Real-IP': 'revoke-flow' },
        body: JSON.stringify({ code, name: 'Bedroom TV', platform: 'ios' })
      });
      const { deviceId, deviceToken } = await redeem.json();

      const before = await devicePrincipal(context, deviceToken);
      expect((await before.json()).principal).not.toBeNull();

      const revoked = await context.app.request(`/api/auth/devices/${deviceId}`, {
        method: 'DELETE',
        headers: { Authorization: `Bearer ${aliceToken}` }
      });
      expect(revoked.status).toBe(200);
      expect(await revoked.json()).toEqual({ revoked: true });

      const after = await devicePrincipal(context, deviceToken);
      expect((await after.json()).principal).toBeNull();

      const list = await context.app.request('/api/auth/devices', {
        headers: { Authorization: `Bearer ${aliceToken}` }
      });
      const devices = (await list.json()).devices as Array<{ id: string }>;
      expect(devices.find((device) => device.id === deviceId)).toBeUndefined();
    } finally {
      context.database.close();
    }
  });

  it('supports rename, scoped listing, and ownership boundaries', async () => {
    const context = createTestContext(aliceToken, bobToken);
    try {
      const alicePairing = await createPairingCode(context, aliceToken);
      const bobPairing = await createPairingCode(context, bobToken);
      const redeem = async (code: string, ip: string) => await context.app.request(
        '/api/auth/devices/redeem',
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', 'X-Real-IP': ip },
          body: JSON.stringify({ code, name: 'TV', platform: 'android' })
        }
      );
      const aliceRedeem = await redeem(alicePairing.code, 'scope-alice');
      const bobRedeem = await redeem(bobPairing.code, 'scope-bob');
      const aliceDeviceId = (await aliceRedeem.json()).deviceId as string;

      // Rename own device.
      const renamed = await context.app.request(`/api/auth/devices/${aliceDeviceId}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${aliceToken}` },
        body: JSON.stringify({ name: 'Den Projector' })
      });
      expect(renamed.status).toBe(200);
      expect((await renamed.json()).device).toMatchObject({
        id: aliceDeviceId,
        name: 'Den Projector'
      });

      // Users see only their own devices by default.
      const aliceList = await (await context.app.request('/api/auth/devices', {
        headers: { Authorization: `Bearer ${aliceToken}` }
      })).json();
      const bobList = await (await context.app.request('/api/auth/devices', {
        headers: { Authorization: `Bearer ${bobToken}` }
      })).json();
      expect(aliceList.devices).toHaveLength(1);
      expect(aliceList.devices[0].name).toBe('Den Projector');
      expect(bobList.devices).toHaveLength(1);

      // Viewers cannot enumerate another user's devices, admins can.
      const forbidden = await context.app.request(
        `/api/auth/devices?userId=${context.aliceId}`,
        { headers: { Authorization: `Bearer ${bobToken}` } }
      );
      expect(forbidden.status).toBe(403);
      const adminScoped = await context.app.request(
        `/api/auth/devices?userId=${context.bobId}`,
        { headers: { Authorization: `Bearer ${aliceToken}` } }
      );
      expect(adminScoped.status).toBe(200);
      expect((await adminScoped.json()).devices).toHaveLength(1);

      // Viewers cannot rename or revoke someone else's device.
      const foreignRename = await context.app.request(`/api/auth/devices/${aliceDeviceId}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${bobToken}` },
        body: JSON.stringify({ name: 'Hacked' })
      });
      expect(foreignRename.status).toBe(404);
      const foreignRevoke = await context.app.request(`/api/auth/devices/${aliceDeviceId}`, {
        method: 'DELETE',
        headers: { Authorization: `Bearer ${bobToken}` }
      });
      expect(foreignRevoke.status).toBe(404);
      expect(context.devices.findById(aliceDeviceId)!.status).toBe('active');

      // Deleting (revoking) removes the device from active service.
      const deleted = await context.app.request(`/api/auth/devices/${aliceDeviceId}`, {
        method: 'DELETE',
        headers: { Authorization: `Bearer ${aliceToken}` }
      });
      expect(deleted.status).toBe(200);
      const afterDelete = context.devices.findById(aliceDeviceId)!;
      expect(afterDelete.status).toBe('revoked');
      expect(afterDelete.revoked_at).not.toBeNull();
      expect(context.devices.listDevicesForUser(context.aliceId)).toHaveLength(0);
      expect(context.devices.listDevicesForUser(context.aliceId, { includeRevoked: true })).toHaveLength(1);
    } finally {
      context.database.close();
    }
  });

  it('rate-limits public redemption per client IP', async () => {
    const context = createTestContext(aliceToken, bobToken);
    try {
      let lastStatus = 0;
      for (let attempt = 0; attempt < 12; attempt++) {
        const response = await context.app.request('/api/auth/devices/redeem', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', 'X-Real-IP': 'rate-limit-ip' },
          body: JSON.stringify({ code: '22222222', name: 'TV', platform: 'web' })
        });
        lastStatus = response.status;
        if (response.status === 429) {
          expect(response.headers.get('Retry-After')).toBeTruthy();
          break;
        }
      }
      expect(lastStatus).toBe(429);
    } finally {
      context.database.close();
    }
  });
});
