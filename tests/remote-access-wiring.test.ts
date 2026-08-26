import { describe, expect, it } from 'bun:test';
import { Database } from 'bun:sqlite';
import { DATABASE_MIGRATIONS, runDatabaseMigrations } from '../apps/server/src/db/migrations';
import server from '../apps/server/src/index';

describe('remote access control plane wiring', () => {
  it('mounts the remote access router without an account gate', async () => {
    const response = await server.fetch(new Request('http://localhost/api/remote-access/status'));
    expect(response.status).toBe(200);
    const body = await response.json() as Record<string, unknown>;
    expect(body).toHaveProperty('enabled');
    expect(body).toHaveProperty('controlPlaneConfigured');
    expect(Array.isArray(body.advertisedEndpoints)).toBe(true);
  });

  it('does not fall through to the generic API 404 handler', async () => {
    const response = await server.fetch(new Request('http://localhost/api/remote-access/status'));
    expect((await response.json() as Record<string, unknown>).error).toBeUndefined();
  });
});

describe('remote access migration', () => {
  it('uses a unique ascending version and creates its tables', () => {
    const versions = DATABASE_MIGRATIONS.map(({ version }) => version);
    expect(new Set(versions).size).toBe(versions.length);
    expect([...versions].sort((left, right) => left - right)).toEqual(versions);
    expect(DATABASE_MIGRATIONS.find(({ name }) => name === 'remote_access_control_plane'))
      .toMatchObject({ version: 16, name: 'remote_access_control_plane' });

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
