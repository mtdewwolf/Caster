import { Database } from 'bun:sqlite';
import crypto from 'crypto';
import { ADMIN_USER_ID } from '../identity';
import { hashPassword, type UserRecord, type UserRole } from './user-store';

export interface AccountInvite {
  id: string;
  role: UserRole;
  createdAt: number;
  expiresAt: number;
  acceptedAt: number | null;
  revokedAt: number | null;
  acceptedUsername: string | null;
}

interface StoredInvite {
  id: string;
  role: UserRole;
  created_at: number;
  expires_at: number;
  accepted_at: number | null;
  revoked_at: number | null;
  accepted_username: string | null;
}

interface StoredUser {
  id: string;
  username: string;
  role: UserRole;
  active: number;
  created_at: string;
  updated_at: string;
}

function tokenHash(token: string): string {
  return crypto.createHash('sha256').update(token).digest('hex');
}

function publicUser(user: StoredUser): UserRecord {
  return {
    id: user.id,
    username: user.username,
    role: user.role,
    active: user.active === 1,
    createdAt: user.created_at,
    updatedAt: user.updated_at
  };
}

function publicInvite(invite: StoredInvite): AccountInvite {
  return {
    id: invite.id,
    role: invite.role,
    createdAt: invite.created_at,
    expiresAt: invite.expires_at,
    acceptedAt: invite.accepted_at,
    revokedAt: invite.revoked_at,
    acceptedUsername: invite.accepted_username
  };
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
      // Preserve the original provisioning error.
    }
    throw error;
  }
}

export class AccountProvisioningStore {
  constructor(readonly database: Database) {}

  isSetupRequired(): boolean {
    const row = this.database.query(`
      SELECT completed_at FROM server_setup WHERE singleton = 1
    `).get() as { completed_at: string | null } | null;
    return !row?.completed_at;
  }

  claimLegacyOwnerIfConfigured(userId = ADMIN_USER_ID): void {
    if (!this.isSetupRequired()) return;
    runImmediate(this.database, () => {
      const owner = this.database.query(`
        SELECT users.id
        FROM users
        JOIN user_credentials ON user_credentials.user_id = users.id
        WHERE users.id = ? AND users.role = 'admin' AND users.active = 1
        LIMIT 1
      `).get(userId) as { id: string } | null;
      if (!owner) return;
      this.database.run(`
        UPDATE server_setup
        SET owner_user_id = ?, completed_at = ?
        WHERE singleton = 1 AND completed_at IS NULL
      `, [owner.id, new Date().toISOString()]);
    });
  }

  completeOwnerSetup(username: string, password: string): UserRecord {
    const passwordHash = hashPassword(password);
    return runImmediate(this.database, () => {
      const state = this.database.query(`
        SELECT completed_at FROM server_setup WHERE singleton = 1
      `).get() as { completed_at: string | null };
      if (state.completed_at) throw new Error('SETUP_ALREADY_COMPLETED');

      const now = new Date().toISOString();
      this.database.run(`
        UPDATE users
        SET username = ?, role = 'admin', active = 1, updated_at = ?
        WHERE id = ?
      `, [username, now, ADMIN_USER_ID]);
      this.database.run(`
        INSERT INTO user_credentials (user_id, type, secret_hash, created_at, updated_at)
        VALUES (?, 'password', ?, ?, ?)
        ON CONFLICT(user_id, type) DO UPDATE SET
          secret_hash = excluded.secret_hash,
          updated_at = excluded.updated_at
      `, [ADMIN_USER_ID, passwordHash, now, now]);
      this.database.run(`
        UPDATE server_setup
        SET owner_user_id = ?, completed_at = ?
        WHERE singleton = 1 AND completed_at IS NULL
      `, [ADMIN_USER_ID, now]);
      const user = this.database.query(`
        SELECT id, username, role, active, created_at, updated_at
        FROM users WHERE id = ?
      `).get(ADMIN_USER_ID) as StoredUser;
      return publicUser(user);
    });
  }

  createInvite(createdBy: string, role: UserRole, expiresAt: number): AccountInvite & { token: string } {
    const token = crypto.randomBytes(32).toString('base64url');
    const now = Date.now();
    const invite: AccountInvite & { token: string } = {
      id: crypto.randomUUID(),
      token,
      role,
      createdAt: now,
      expiresAt,
      acceptedAt: null,
      revokedAt: null,
      acceptedUsername: null
    };
    this.database.run(`
      INSERT INTO account_invites (
        id, token_hash, role, created_by, created_at, expires_at
      ) VALUES (?, ?, ?, ?, ?, ?)
    `, [invite.id, tokenHash(token), role, createdBy, now, expiresAt]);
    return invite;
  }

  listInvites(): AccountInvite[] {
    const rows = this.database.query(`
      SELECT invites.id, invites.role, invites.created_at, invites.expires_at,
             invites.accepted_at, invites.revoked_at,
             users.username AS accepted_username
      FROM account_invites invites
      LEFT JOIN users ON users.id = invites.accepted_user_id
      ORDER BY invites.created_at DESC
    `).all() as StoredInvite[];
    return rows.map(publicInvite);
  }

  inspectInvite(token: string, now = Date.now()): Pick<AccountInvite, 'role' | 'expiresAt'> | null {
    const row = this.database.query(`
      SELECT role, expires_at
      FROM account_invites
      WHERE token_hash = ? AND accepted_at IS NULL AND revoked_at IS NULL AND expires_at > ?
    `).get(tokenHash(token), now) as { role: UserRole; expires_at: number } | null;
    return row ? { role: row.role, expiresAt: row.expires_at } : null;
  }

  acceptInvite(token: string, username: string, password: string, now = Date.now()): UserRecord {
    // Reject random public traffic before paying the scrypt cost. The invite is
    // checked again under the write lock after hashing to preserve one-time use.
    if (!this.inspectInvite(token, now)) throw new Error('INVITE_INVALID');
    const passwordHash = hashPassword(password);
    return runImmediate(this.database, () => {
      const invite = this.database.query(`
        SELECT id, role FROM account_invites
        WHERE token_hash = ? AND accepted_at IS NULL AND revoked_at IS NULL AND expires_at > ?
      `).get(tokenHash(token), now) as { id: string; role: UserRole } | null;
      if (!invite) throw new Error('INVITE_INVALID');

      const userId = crypto.randomUUID();
      const timestamp = new Date(now).toISOString();
      this.database.run(`
        INSERT INTO users (id, username, role, active, created_at, updated_at)
        VALUES (?, ?, ?, 1, ?, ?)
      `, [userId, username, invite.role, timestamp, timestamp]);
      this.database.run(`
        INSERT INTO user_credentials (user_id, type, secret_hash, created_at, updated_at)
        VALUES (?, 'password', ?, ?, ?)
      `, [userId, passwordHash, timestamp, timestamp]);
      this.database.run(`
        UPDATE account_invites
        SET accepted_at = ?, accepted_user_id = ?
        WHERE id = ? AND accepted_at IS NULL AND revoked_at IS NULL
      `, [now, userId, invite.id]);

      const user = this.database.query(`
        SELECT id, username, role, active, created_at, updated_at
        FROM users WHERE id = ?
      `).get(userId) as StoredUser;
      return publicUser(user);
    });
  }

  revokeInvite(id: string, now = Date.now()): boolean {
    const result = this.database.run(`
      UPDATE account_invites
      SET revoked_at = ?
      WHERE id = ? AND accepted_at IS NULL AND revoked_at IS NULL
    `, [now, id]);
    return result.changes > 0;
  }
}
