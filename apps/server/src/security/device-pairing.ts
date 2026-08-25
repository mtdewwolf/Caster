import crypto from 'crypto';
import type { Database } from 'bun:sqlite';
import { hashDeviceToken, type SqliteDeviceStore } from '../db/device-store';

export const PAIRING_CODE_LENGTH = 8;

/** Unambiguous uppercase charset: no 0/O or 1/I/L. */
export const PAIRING_CODE_CHARSET = '23456789ABCDEFGHJKMNPQRSTUVWXYZ';
export const DEFAULT_PAIRING_TTL_MS = 10 * 60 * 1000;
export const MAX_PAIRING_ATTEMPTS = 5;

export type PairingFailureReason =
  | 'PAIRING_CODE_INVALID'
  | 'PAIRING_CODE_EXPIRED'
  | 'PAIRING_CODE_CONSUMED'
  | 'PAIRING_CODE_LOCKED';

export class PairingError extends Error {
  constructor(readonly reason: PairingFailureReason, message: string) {
    super(message);
    this.name = 'PairingError';
  }
}

interface StoredPairingCode {
  id: string;
  code_hash: string;
  user_id: string;
  proposed_device_name: string | null;
  proposed_platform: string | null;
  expires_at: number;
  consumed_at: number | null;
  consumed_device_id: string | null;
  attempts: number;
  created_at: number;
}

function pairingCodeHash(code: string): string {
  return `sha256$${crypto.createHash('sha256').update(code).digest('hex')}`;
}

/** Uppercases and strips separator characters, then validates the charset. */
export function normalizePairingCode(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const code = value.toUpperCase().replace(/[\s-]/g, '');
  if (code.length !== PAIRING_CODE_LENGTH) return null;
  for (const char of code) {
    if (!PAIRING_CODE_CHARSET.includes(char)) return null;
  }
  return code;
}

function randomPairingCode(): string {
  const bytes = crypto.randomBytes(PAIRING_CODE_LENGTH);
  let code = '';
  for (let index = 0; index < PAIRING_CODE_LENGTH; index++) {
    code += PAIRING_CODE_CHARSET[bytes[index] % PAIRING_CODE_CHARSET.length];
  }
  return code;
}

function runImmediate<T>(database: Database, operation: () => T): T {
  database.run('BEGIN IMMEDIATE');
  try {
    const result = operation();
    database.run('COMMIT');
    return result;
  } catch (error) {
    try {
      database.run('ROLLBACK');
    } catch {
      // Preserve the original pairing error.
    }
    throw error;
  }
}

export interface GeneratedPairingCode {
  id: string;
  code: string;
  expiresAt: number;
}

export interface RedeemedDevice {
  deviceId: string;
  deviceToken: string;
  userId: string;
  name: string;
  platform: string;
}

export interface GeneratePairingOptions {
  deviceName?: string;
  platform?: string;
  ttlMs?: number;
  now?: number;
}

/**
 * Issues and redeems one-time pairing codes. Raw codes are returned exactly
 * once; only their SHA-256 digest is persisted. Redemption is atomic so a
 * code can never create two devices.
 */
export class DevicePairingService {
  constructor(
    private readonly database: Database,
    private readonly devices: SqliteDeviceStore
  ) {}

  generatePairingCode(userId: string, options: GeneratePairingOptions = {}): GeneratedPairingCode {
    const now = options.now ?? Date.now();
    const ttlMs = options.ttlMs && options.ttlMs > 0 ? options.ttlMs : DEFAULT_PAIRING_TTL_MS;
    const expiresAt = now + ttlMs;
    const record: GeneratedPairingCode = {
      id: `pair_${crypto.randomUUID()}`,
      code: randomPairingCode(),
      expiresAt
    };
    this.database.run(`
      INSERT INTO pairing_codes (
        id, code_hash, user_id, proposed_device_name, proposed_platform,
        expires_at, consumed_at, consumed_device_id, attempts, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, NULL, NULL, 0, ?)
    `, [
      record.id,
      pairingCodeHash(record.code),
      userId,
      options.deviceName ?? null,
      options.platform ?? null,
      expiresAt,
      now
    ]);
    return record;
  }

  redeemCode(rawCode: unknown, device: { name: string; platform: string }, now = Date.now()): RedeemedDevice {
    const code = normalizePairingCode(rawCode);
    if (!code) throw new PairingError('PAIRING_CODE_INVALID', 'This pairing code is invalid');

    // Failures are recorded inside the transaction and only thrown after it
    // commits, so attempt bookkeeping survives the rejection.
    const outcome = runImmediate(this.database, (): { redeemed?: RedeemedDevice; failure?: PairingError } => {
      const row = this.database.query(`
        SELECT id, code_hash, user_id, proposed_device_name, proposed_platform,
               expires_at, consumed_at, consumed_device_id, attempts, created_at
        FROM pairing_codes WHERE code_hash = ?
      `).get(pairingCodeHash(code)) as StoredPairingCode | null;

      if (row) {
        if (row.consumed_at !== null) {
          const exhausted = row.attempts >= MAX_PAIRING_ATTEMPTS;
          return {
            failure: new PairingError(
              exhausted ? 'PAIRING_CODE_LOCKED' : 'PAIRING_CODE_CONSUMED',
              exhausted
                ? 'This pairing code was deactivated after too many failed attempts'
                : 'This pairing code has already been used'
            )
          };
        }
        if (row.expires_at <= now) {
          return { failure: new PairingError('PAIRING_CODE_EXPIRED', 'This pairing code has expired') };
        }
        if (row.attempts >= MAX_PAIRING_ATTEMPTS) {
          this.database.run(
            'UPDATE pairing_codes SET consumed_at = ? WHERE id = ?',
            [now, row.id]
          );
          return { failure: new PairingError('PAIRING_CODE_LOCKED', 'This pairing code was deactivated after too many failed attempts') };
        }

        const deviceToken = crypto.randomBytes(32).toString('base64url');
        const created = this.devices.createDevice({
          userId: row.user_id,
          name: device.name,
          platform: device.platform,
          tokenHash: hashDeviceToken(deviceToken),
          now
        });
        this.database.run(`
          UPDATE pairing_codes SET consumed_at = ?, consumed_device_id = ? WHERE id = ?
        `, [now, created.id, row.id]);
        return {
          redeemed: {
            deviceId: created.id,
            deviceToken,
            userId: row.user_id,
            name: device.name,
            platform: device.platform
          }
        };
      }

      // An unmatched guess cannot be attributed to one row by its digest, so
      // every outstanding code counts the failed verification. Codes that hit
      // the attempt ceiling are invalidated even for holders of the real code.
      this.database.run(`
        UPDATE pairing_codes SET attempts = attempts + 1
        WHERE consumed_at IS NULL AND expires_at > ?
      `, [now]);
      this.database.run(`
        UPDATE pairing_codes SET consumed_at = ?
        WHERE consumed_at IS NULL AND attempts >= ?
      `, [now, MAX_PAIRING_ATTEMPTS]);
      return { failure: new PairingError('PAIRING_CODE_INVALID', 'This pairing code is invalid') };
    });

    if (outcome.failure) throw outcome.failure;
    return outcome.redeemed!;
  }
}
