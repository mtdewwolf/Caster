import type { Database } from 'bun:sqlite';
import crypto from 'crypto';

export type DeviceStatus = 'active' | 'revoked';

export interface StoredDevice {
  id: string;
  user_id: string;
  name: string;
  platform: string;
  device_token_hash: string;
  capabilities: string;
  created_at: number;
  last_used_at: number | null;
  last_seen_at: number | null;
  revoked_at: number | null;
  status: DeviceStatus;
}

export interface NewDeviceInput {
  userId: string;
  name: string;
  platform: string;
  tokenHash: string;
  capabilities?: string;
  now?: number;
}

/** Device tokens are stored only as versioned SHA-256 digests, like API tokens. */
export function hashDeviceToken(token: string): string {
  return `sha256$${crypto.createHash('sha256').update(token).digest('hex')}`;
}

function newDeviceId(): string {
  return `dev_${crypto.randomUUID()}`;
}

const LAST_USED_WRITE_INTERVAL_MS = 5 * 60 * 1000;

export class SqliteDeviceStore {
  constructor(readonly database: Database) {}

  createDevice(input: NewDeviceInput): StoredDevice {
    const now = input.now ?? Date.now();
    const device: StoredDevice = {
      id: newDeviceId(),
      user_id: input.userId,
      name: input.name,
      platform: input.platform,
      device_token_hash: input.tokenHash,
      capabilities: input.capabilities ?? '{}',
      created_at: now,
      last_used_at: now,
      last_seen_at: now,
      revoked_at: null,
      status: 'active'
    };
    this.database.run(`
      INSERT INTO devices (
        id, user_id, name, platform, device_token_hash, capabilities,
        created_at, last_used_at, last_seen_at, revoked_at, status
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `, [
      device.id,
      device.user_id,
      device.name,
      device.platform,
      device.device_token_hash,
      device.capabilities,
      device.created_at,
      device.last_used_at,
      device.last_seen_at,
      device.revoked_at,
      device.status
    ]);
    return device;
  }

  findById(deviceId: string): StoredDevice | null {
    const row = this.database.query(`
      SELECT id, user_id, name, platform, device_token_hash, capabilities,
             created_at, last_used_at, last_seen_at, revoked_at, status
      FROM devices WHERE id = ?
    `).get(deviceId) as StoredDevice | null;
    return row;
  }

  listDevicesForUser(userId: string, options: { includeRevoked?: boolean } = {}): StoredDevice[] {
    const clause = options.includeRevoked ? '' : "AND status = 'active'";
    return this.database.query(`
      SELECT id, user_id, name, platform, device_token_hash, capabilities,
             created_at, last_used_at, last_seen_at, revoked_at, status
      FROM devices
      WHERE user_id = ? ${clause}
      ORDER BY created_at DESC, id DESC
    `).all(userId) as StoredDevice[];
  }

  /** Resolves an active device by token digest and throttles last_used_at writes. */
  findByDeviceToken(tokenHash: string, now = Date.now()): StoredDevice | null {
    const device = this.database.query(`
      SELECT id, user_id, name, platform, device_token_hash, capabilities,
             created_at, last_used_at, last_seen_at, revoked_at, status
      FROM devices
      WHERE device_token_hash = ? AND status = 'active' AND revoked_at IS NULL
    `).get(tokenHash) as StoredDevice | null;

    if (!device) return null;

    if (!device.last_used_at || device.last_used_at <= now - LAST_USED_WRITE_INTERVAL_MS) {
      this.database.run('UPDATE devices SET last_used_at = ? WHERE id = ?', [now, device.id]);
      device.last_used_at = now;
    }

    return device;
  }

  touchLastSeen(deviceId: string, now = Date.now()): void {
    this.database.run(`
      UPDATE devices SET last_seen_at = ?
      WHERE id = ? AND status = 'active'
    `, [now, deviceId]);
  }

  renameDevice(deviceId: string, userId: string, name: string): boolean {
    const result = this.database.run(`
      UPDATE devices SET name = ? WHERE id = ? AND user_id = ? AND status = 'active'
    `, [name, deviceId, userId]);
    return result.changes > 0;
  }

  revokeDevice(deviceId: string, userId?: string, now = Date.now()): boolean {
    const scope = userId === undefined ? '' : 'AND user_id = ?';
    const result = this.database.run(`
      UPDATE devices
      SET status = 'revoked', revoked_at = ?
      WHERE id = ? AND status = 'active' ${scope}
    `, userId === undefined ? [now, deviceId] : [now, deviceId, userId]);
    return result.changes > 0;
  }

  deleteDevice(deviceId: string, userId?: string): boolean {
    const scope = userId === undefined ? '' : 'AND user_id = ?';
    const result = this.database.run(
      `DELETE FROM devices WHERE id = ? ${scope}`,
      userId === undefined ? [deviceId] : [deviceId, userId]
    );
    return result.changes > 0;
  }
}
