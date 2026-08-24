import { Database } from 'bun:sqlite';
import crypto from 'crypto';

export type UserRole = 'admin' | 'viewer';
export type CredentialType = 'password' | 'api_token';

export interface UserRecord {
  id: string;
  username: string;
  role: UserRole;
  active: boolean;
  createdAt: string;
  updatedAt: string;
}

interface StoredUser {
  id: string;
  username: string;
  role: UserRole;
  active: number;
  created_at: string;
  updated_at: string;
}

interface StoredCredential {
  user_id: string;
  secret_hash: string;
}

const SCRYPT_COST = 16_384;
const SCRYPT_BLOCK_SIZE = 8;
const SCRYPT_PARALLELIZATION = 1;
const SCRYPT_KEY_LENGTH = 32;

function mapUser(user: StoredUser): UserRecord {
  return {
    id: user.id,
    username: user.username,
    role: user.role,
    active: user.active === 1,
    createdAt: user.created_at,
    updatedAt: user.updated_at
  };
}

export function hashPassword(password: string): string {
  const salt = crypto.randomBytes(16);
  const derived = crypto.scryptSync(password, salt, SCRYPT_KEY_LENGTH, {
    N: SCRYPT_COST,
    r: SCRYPT_BLOCK_SIZE,
    p: SCRYPT_PARALLELIZATION,
    maxmem: 64 * 1024 * 1024
  });
  return [
    'scrypt',
    SCRYPT_COST,
    SCRYPT_BLOCK_SIZE,
    SCRYPT_PARALLELIZATION,
    salt.toString('base64url'),
    derived.toString('base64url')
  ].join('$');
}

export function verifyPassword(password: string, encoded: string): boolean {
  const [algorithm, costText, blockSizeText, parallelizationText, saltText, hashText] =
    encoded.split('$');
  if (algorithm !== 'scrypt' || !saltText || !hashText) return false;

  const cost = Number(costText);
  const blockSize = Number(blockSizeText);
  const parallelization = Number(parallelizationText);
  if (
    cost !== SCRYPT_COST ||
    blockSize !== SCRYPT_BLOCK_SIZE ||
    parallelization !== SCRYPT_PARALLELIZATION
  ) return false;

  try {
    const expected = Buffer.from(hashText, 'base64url');
    const actual = crypto.scryptSync(password, Buffer.from(saltText, 'base64url'), expected.length, {
      N: cost,
      r: blockSize,
      p: parallelization,
      maxmem: 64 * 1024 * 1024
    });
    return expected.length === actual.length && crypto.timingSafeEqual(expected, actual);
  } catch {
    return false;
  }
}

export function hashApiToken(token: string): string {
  return `sha256$${crypto.createHash('sha256').update(token).digest('hex')}`;
}

export class SqliteUserStore {
  constructor(readonly database: Database) {}

  list(): UserRecord[] {
    const users = this.database.query(`
      SELECT id, username, role, active, created_at, updated_at
      FROM users
      ORDER BY username COLLATE NOCASE, id
    `).all() as StoredUser[];
    return users.map(mapUser);
  }

  findById(id: string): UserRecord | null {
    const user = this.database.query(`
      SELECT id, username, role, active, created_at, updated_at
      FROM users WHERE id = ?
    `).get(id) as StoredUser | null;
    return user ? mapUser(user) : null;
  }

  findByUsername(username: string): UserRecord | null {
    const user = this.database.query(`
      SELECT id, username, role, active, created_at, updated_at
      FROM users WHERE username = ? COLLATE NOCASE
    `).get(username) as StoredUser | null;
    return user ? mapUser(user) : null;
  }

  create(id: string, username: string, role: UserRole, active = true): UserRecord {
    const now = new Date().toISOString();
    this.database.run(`
      INSERT INTO users (id, username, role, active, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?)
    `, [id, username, role, active ? 1 : 0, now, now]);
    return this.findById(id)!;
  }

  update(
    id: string,
    updates: { username?: string; role?: UserRole; active?: boolean }
  ): UserRecord | null {
    const existing = this.findById(id);
    if (!existing) return null;
    this.database.run(`
      UPDATE users
      SET username = ?, role = ?, active = ?, updated_at = ?
      WHERE id = ?
    `, [
      updates.username ?? existing.username,
      updates.role ?? existing.role,
      (updates.active ?? existing.active) ? 1 : 0,
      new Date().toISOString(),
      id
    ]);
    return this.findById(id);
  }

  countActiveAdmins(): number {
    const row = this.database.query(`
      SELECT COUNT(*) AS count FROM users WHERE role = 'admin' AND active = 1
    `).get() as { count: number };
    return row.count;
  }

  hasAnyCredential(): boolean {
    const row = this.database.query(`
      SELECT 1 AS present
      FROM user_credentials credentials
      JOIN users ON users.id = credentials.user_id
      WHERE users.active = 1
      LIMIT 1
    `).get() as { present: number } | null;
    return row !== null;
  }

  setCredential(userId: string, type: CredentialType, secret: string): void {
    const secretHash = type === 'password' ? hashPassword(secret) : hashApiToken(secret);
    const now = new Date().toISOString();
    this.database.run(`
      INSERT INTO user_credentials (user_id, type, secret_hash, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?)
      ON CONFLICT(user_id, type) DO UPDATE SET
        secret_hash = excluded.secret_hash,
        updated_at = excluded.updated_at
    `, [userId, type, secretHash, now, now]);
  }

  credentialMatches(userId: string, type: CredentialType, secret: string): boolean {
    const row = this.database.query(`
      SELECT secret_hash FROM user_credentials WHERE user_id = ? AND type = ?
    `).get(userId, type) as { secret_hash: string } | null;
    if (!row) return false;
    if (type === 'password') return verifyPassword(secret, row.secret_hash);
    const actual = Buffer.from(hashApiToken(secret));
    const expected = Buffer.from(row.secret_hash);
    return actual.length === expected.length && crypto.timingSafeEqual(actual, expected);
  }

  findActiveByApiToken(token: string): UserRecord | null {
    const hash = hashApiToken(token);
    const row = this.database.query(`
      SELECT users.id, users.username, users.role, users.active,
             users.created_at, users.updated_at
      FROM user_credentials credentials
      JOIN users ON users.id = credentials.user_id
      WHERE credentials.type = 'api_token'
        AND credentials.secret_hash = ?
        AND users.active = 1
      LIMIT 1
    `).get(hash) as StoredUser | null;
    return row ? mapUser(row) : null;
  }

  getCredentialHash(userId: string, type: CredentialType): string | null {
    const row = this.database.query(`
      SELECT secret_hash FROM user_credentials WHERE user_id = ? AND type = ?
    `).get(userId, type) as { secret_hash: string } | null;
    return row?.secret_hash ?? null;
  }
}
