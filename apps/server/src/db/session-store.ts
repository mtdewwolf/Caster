import type { Database } from 'bun:sqlite';

export interface StoredSession {
  token_hash: string;
  user_id: string;
  created_at: number;
  expires_at: number;
  last_used_at: number;
}

export interface SessionStore {
  create(tokenHash: string, userId: string, createdAt: number, expiresAt: number): void;
  findValid(tokenHash: string, now: number): StoredSession | null;
  invalidate(tokenHash: string): void;
  invalidateUser(userId: string): number;
  pruneExpired(now: number, limit: number): number;
}

const LAST_USED_WRITE_INTERVAL_MS = 5 * 60 * 1000;

export class SqliteSessionStore implements SessionStore {
  constructor(private readonly database: Database) {}

  create(tokenHash: string, userId: string, createdAt: number, expiresAt: number): void {
    this.database.run(`
      INSERT INTO auth_sessions (
        token_hash, user_id, created_at, expires_at, last_used_at
      ) VALUES (?, ?, ?, ?, ?)
    `, [tokenHash, userId, createdAt, expiresAt, createdAt]);
  }

  findValid(tokenHash: string, now: number): StoredSession | null {
    const session = this.database.query(`
      SELECT token_hash, user_id, created_at, expires_at, last_used_at
      FROM auth_sessions
      WHERE token_hash = ?
    `).get(tokenHash) as StoredSession | null;

    if (!session) return null;
    if (session.expires_at <= now) {
      this.invalidate(tokenHash);
      return null;
    }

    if (session.last_used_at <= now - LAST_USED_WRITE_INTERVAL_MS) {
      this.database.run(`
        UPDATE auth_sessions SET last_used_at = ? WHERE token_hash = ?
      `, [now, tokenHash]);
      session.last_used_at = now;
    }

    return session;
  }

  invalidate(tokenHash: string): void {
    this.database.run('DELETE FROM auth_sessions WHERE token_hash = ?', [tokenHash]);
  }

  invalidateUser(userId: string): number {
    return this.database.run('DELETE FROM auth_sessions WHERE user_id = ?', [userId]).changes;
  }

  pruneExpired(now: number, limit: number): number {
    if (!Number.isInteger(limit) || limit <= 0) return 0;

    const result = this.database.run(`
      DELETE FROM auth_sessions
      WHERE token_hash IN (
        SELECT token_hash
        FROM auth_sessions
        WHERE expires_at <= ?
        ORDER BY expires_at ASC
        LIMIT ?
      )
    `, [now, limit]);

    return result.changes;
  }
}
