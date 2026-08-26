import type { Database } from 'bun:sqlite';

/**
 * Persistence for the remote-access control plane.
 *
 * The tables these methods use were declared with the control-plane code but
 * never registered as a migration, so nothing could read or write them. They
 * exist now, and this is what puts them to work: a server keeps one identity
 * across restarts, and its heartbeat attempts leave a trail an operator can
 * inspect when remote access is not behaving.
 */

export interface RemoteRegistration {
  serverId: string;
  controlPlaneUrl: string | null;
  enrolledAt: string | null;
  disabledAt: string | null;
  joinName: string | null;
  updatedAt: string;
}

export interface HeartbeatAttempt {
  seq: number;
  attemptedAt: string;
  ok: boolean;
  statusCode: number | null;
  error: string | null;
}

export class RemoteAccessStore {
  constructor(private readonly database: Database) {}

  getRegistration(): RemoteRegistration | null {
    const row = this.database.query(`
      SELECT server_id, control_plane_url, enrolled_at, disabled_at, join_name, updated_at
      FROM remote_registration WHERE singleton = 1
    `).get() as Record<string, any> | null;
    if (!row) return null;

    return {
      serverId: row.server_id,
      controlPlaneUrl: row.control_plane_url ?? null,
      enrolledAt: row.enrolled_at ?? null,
      disabledAt: row.disabled_at ?? null,
      joinName: row.join_name ?? null,
      updatedAt: row.updated_at
    };
  }

  /** Records this server's identity, keeping any fields not being changed. */
  saveRegistration(input: {
    serverId: string;
    controlPlaneUrl?: string | null;
    enrolledAt?: string | null;
    disabledAt?: string | null;
    joinName?: string | null;
    now?: string;
  }): RemoteRegistration {
    const existing = this.getRegistration();
    const now = input.now ?? new Date().toISOString();

    this.database.run(`
      INSERT INTO remote_registration (
        singleton, server_id, control_plane_url, enrolled_at, disabled_at, join_name, updated_at
      ) VALUES (1, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(singleton) DO UPDATE SET
        server_id = excluded.server_id,
        control_plane_url = excluded.control_plane_url,
        enrolled_at = excluded.enrolled_at,
        disabled_at = excluded.disabled_at,
        join_name = excluded.join_name,
        updated_at = excluded.updated_at
    `, [
      input.serverId,
      input.controlPlaneUrl !== undefined ? input.controlPlaneUrl : existing?.controlPlaneUrl ?? null,
      input.enrolledAt !== undefined ? input.enrolledAt : existing?.enrolledAt ?? null,
      input.disabledAt !== undefined ? input.disabledAt : existing?.disabledAt ?? null,
      input.joinName !== undefined ? input.joinName : existing?.joinName ?? null,
      now
    ]);

    return this.getRegistration()!;
  }

  /** Forgets the enrolment, keeping the server's identity. */
  revokeRegistration(now: string = new Date().toISOString()): boolean {
    const existing = this.getRegistration();
    if (!existing) return false;

    this.saveRegistration({
      serverId: existing.serverId,
      controlPlaneUrl: existing.controlPlaneUrl,
      enrolledAt: null,
      disabledAt: now,
      joinName: null,
      now
    });
    return true;
  }

  recordHeartbeat(attempt: HeartbeatAttempt): void {
    this.database.run(`
      INSERT INTO remote_heartbeat_log (seq, attempted_at, ok, status_code, error)
      VALUES (?, ?, ?, ?, ?)
    `, [
      attempt.seq,
      attempt.attemptedAt,
      attempt.ok ? 1 : 0,
      attempt.statusCode ?? null,
      attempt.error ?? null
    ]);
  }

  recentHeartbeats(limit = 20): HeartbeatAttempt[] {
    const rows = this.database.query(`
      SELECT seq, attempted_at, ok, status_code, error
      FROM remote_heartbeat_log
      ORDER BY attempted_at DESC, id DESC
      LIMIT ?
    `).all(limit) as Array<Record<string, any>>;

    return rows.map((row) => ({
      seq: row.seq,
      attemptedAt: row.attempted_at,
      ok: row.ok === 1,
      statusCode: row.status_code ?? null,
      error: row.error ?? null
    }));
  }

  /**
   * Trims the log to the most recent entries.
   *
   * A heartbeat every minute is half a million rows a year, and nobody is
   * looking further back than the last few hundred.
   */
  pruneHeartbeats(keep = 500): number {
    const result = this.database.run(`
      DELETE FROM remote_heartbeat_log
      WHERE id NOT IN (
        SELECT id FROM remote_heartbeat_log ORDER BY id DESC LIMIT ?
      )
    `, [keep]);
    return result.changes;
  }
}
