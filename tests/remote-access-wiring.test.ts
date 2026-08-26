import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
import crypto from 'crypto';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { Database } from 'bun:sqlite';
import { db, initDatabase } from '../apps/server/src/db';
import { DATABASE_MIGRATIONS, runDatabaseMigrations } from '../apps/server/src/db/migrations';
import { SqliteUserStore } from '../apps/server/src/db/user-store';
import { AccountProvisioningStore } from '../apps/server/src/db/account-provisioning';
import {
  castSecretFilePath,
  createCastAccessToken,
  resetCastSecretCache,
  verifyCastAccessToken
} from '../apps/server/src/security/cast-access';
import server from '../apps/server/src/index';

describe('remote access control plane wiring', () => {
  const suffix = crypto.randomUUID();
  const adminId = `remote-admin-${suffix}`;
  const viewerId = `remote-viewer-${suffix}`;
  const adminToken = `remote-admin-token-${suffix}`;
  const viewerToken = `remote-viewer-token-${suffix}`;

  function request(pathname: string, token?: string) {
    const headers = new Headers();
    if (token) headers.set('Authorization', `Bearer ${token}`);
    return server.fetch(new Request(`http://localhost${pathname}`, { headers }));
  }

  beforeAll(() => {
    initDatabase();
    const users = new SqliteUserStore(db);
    users.create(adminId, `remote-admin-${suffix}`, 'admin');
    users.create(viewerId, `remote-viewer-${suffix}`, 'viewer');
    users.setCredential(adminId, 'api_token', adminToken);
    users.setCredential(viewerId, 'api_token', viewerToken);
    new AccountProvisioningStore(db).claimLegacyOwnerIfConfigured(adminId);
  });

  it('mounts the remote access router so administrators can read status', async () => {
    const response = await request('/api/remote-access/status', adminToken);
    expect(response.status).toBe(200);

    const body = await response.json() as Record<string, unknown>;
    expect(body).toHaveProperty('enabled');
    expect(body).toHaveProperty('controlPlaneConfigured');
    expect(Array.isArray(body.advertisedEndpoints)).toBe(true);
  });

  it('keeps remote access administration behind the admin gate', async () => {
    expect((await request('/api/remote-access/status', viewerToken)).status).toBe(403);
    expect([401, 403]).toContain((await request('/api/remote-access/status')).status);
  });

  it('does not fall through to the generic API 404 handler', async () => {
    const response = await request('/api/remote-access/status', adminToken);
    const body = await response.json() as Record<string, unknown>;
    expect(body.error).toBeUndefined();
  });
});

describe('remote access migration', () => {
  it('uses a unique ascending version', () => {
    const versions = DATABASE_MIGRATIONS.map(({ version }) => version);
    expect(new Set(versions).size).toBe(versions.length);
    expect([...versions].sort((left, right) => left - right)).toEqual(versions);
  });

  it('is registered in the migration ledger', () => {
    expect(DATABASE_MIGRATIONS.find(({ name }) => name === 'remote_access_control_plane'))
      .toMatchObject({ version: 16, name: 'remote_access_control_plane' });
  });

  it('creates the control plane tables on a fresh database', () => {
    const database = new Database(':memory:');
    try {
      runDatabaseMigrations(database);
      const tables = (database.query(`
        SELECT name FROM sqlite_master WHERE type = 'table' AND name LIKE 'remote_%'
      `).all() as Array<{ name: string }>).map(({ name }) => name).sort();

      expect(tables).toEqual(['remote_heartbeat_log', 'remote_registration']);
      expect(database.query('PRAGMA foreign_key_check').all()).toEqual([]);
    } finally {
      database.close();
    }
  });
});

describe('cast access signing key', () => {
  const originalDataDir = process.env.MEDIA_DATA_DIR;
  const originalSecret = process.env.CASTER_CAST_SECRET;
  let dataDir = '';

  beforeAll(() => {
    dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'caster-cast-secret-'));
    delete process.env.CASTER_CAST_SECRET;
    process.env.MEDIA_DATA_DIR = dataDir;
    resetCastSecretCache();
  });

  afterAll(() => {
    if (originalDataDir === undefined) delete process.env.MEDIA_DATA_DIR;
    else process.env.MEDIA_DATA_DIR = originalDataDir;
    if (originalSecret === undefined) delete process.env.CASTER_CAST_SECRET;
    else process.env.CASTER_CAST_SECRET = originalSecret;
    resetCastSecretCache();
    fs.rmSync(dataDir, { recursive: true, force: true });
  });

  it('persists a generated key beside the database', () => {
    createCastAccessToken('user-1', 'media-1');
    const keyFile = castSecretFilePath();

    expect(fs.existsSync(keyFile)).toBe(true);
    expect(Buffer.from(fs.readFileSync(keyFile, 'utf8').trim(), 'base64').length).toBe(32);
  });

  it('verifies grants issued before a restart', () => {
    const grant = createCastAccessToken('user-1', 'media-1');

    // A restart drops every in-process cache but keeps the data directory.
    resetCastSecretCache();

    expect(verifyCastAccessToken(grant.token, '/api/media/media-1/stream'))
      .toMatchObject({ userId: 'user-1', mediaId: 'media-1' });
  });

  it('prefers an explicitly configured secret over the persisted key', () => {
    process.env.CASTER_CAST_SECRET = `configured-${crypto.randomUUID()}`;
    resetCastSecretCache();
    const configured = createCastAccessToken('user-2', 'media-2');

    delete process.env.CASTER_CAST_SECRET;
    resetCastSecretCache();

    expect(verifyCastAccessToken(configured.token, '/api/media/media-2/stream')).toBeNull();
  });
});
