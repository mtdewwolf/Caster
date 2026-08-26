import crypto from 'crypto';
import type { Database } from 'bun:sqlite';
import { lockIsStale, LOCK_STALE_AFTER_MS, type LibrarySchedule } from '../scanner/schedule';

/**
 * Which libraries are being scanned, and by whom.
 *
 * The old guard was a single boolean in memory. That made every library share
 * one lock — scanning films blocked scanning music — and a crash mid-scan left
 * nothing to release, so a restart was needed before anything could scan again.
 *
 * A row per library fixes the first problem. A heartbeat fixes the second: a
 * lock whose owner has stopped updating it is reclaimed automatically.
 */

/** Identifies this server process, so it can tell its own locks from others. */
export const SCAN_OWNER_ID = `scan_${crypto.randomUUID()}`;

export interface ScanLock {
  libraryId: string;
  owner: string;
  acquiredAt: string;
  heartbeatAt: string;
}

export class ScanLockStore {
  constructor(
    private readonly database: Database,
    private readonly owner: string = SCAN_OWNER_ID
  ) {}

  /**
   * Claims the right to scan a library.
   *
   * Returns false when someone else holds a live lock. A stale lock is taken
   * over, because the alternative is a library nothing can ever scan again.
   */
  acquire(libraryId: string, now: number = Date.now()): boolean {
    const existing = this.get(libraryId);
    if (existing && !lockIsStale(existing.heartbeatAt, now)) return false;

    const timestamp = new Date(now).toISOString();
    this.database.run(`
      INSERT INTO library_scan_locks (library_id, owner, acquired_at, heartbeat_at)
      VALUES (?, ?, ?, ?)
      ON CONFLICT(library_id) DO UPDATE SET
        owner = excluded.owner,
        acquired_at = excluded.acquired_at,
        heartbeat_at = excluded.heartbeat_at
    `, [libraryId, this.owner, timestamp, timestamp]);
    return true;
  }

  /** Signals that this scan is still alive, so the lock is not reclaimed. */
  heartbeat(libraryId: string, now: number = Date.now()): void {
    this.database.run(
      'UPDATE library_scan_locks SET heartbeat_at = ? WHERE library_id = ? AND owner = ?',
      [new Date(now).toISOString(), libraryId, this.owner]
    );
  }

  /** Releases a lock this process holds. Another owner's lock is left alone. */
  release(libraryId: string): boolean {
    const result = this.database.run(
      'DELETE FROM library_scan_locks WHERE library_id = ? AND owner = ?',
      [libraryId, this.owner]
    );
    return result.changes > 0;
  }

  get(libraryId: string): ScanLock | null {
    const row = this.database.query(
      'SELECT library_id, owner, acquired_at, heartbeat_at FROM library_scan_locks WHERE library_id = ?'
    ).get(libraryId) as Record<string, any> | null;
    if (!row) return null;

    return {
      libraryId: row.library_id,
      owner: row.owner,
      acquiredAt: row.acquired_at,
      heartbeatAt: row.heartbeat_at
    };
  }

  /** Library IDs currently held by a live lock. */
  activeLibraryIds(now: number = Date.now()): string[] {
    const rows = this.database.query(
      'SELECT library_id, heartbeat_at FROM library_scan_locks'
    ).all() as Array<{ library_id: string; heartbeat_at: string }>;

    return rows
      .filter((row) => !lockIsStale(row.heartbeat_at, now))
      .map((row) => row.library_id);
  }

  /**
   * Clears locks nobody is maintaining.
   *
   * Run at startup: a lock this process's previous life left behind would
   * otherwise block scanning until it aged out on its own.
   */
  releaseStale(now: number = Date.now(), staleAfterMs: number = LOCK_STALE_AFTER_MS): number {
    const rows = this.database.query(
      'SELECT library_id, heartbeat_at FROM library_scan_locks'
    ).all() as Array<{ library_id: string; heartbeat_at: string }>;

    let released = 0;
    for (const row of rows) {
      if (!lockIsStale(row.heartbeat_at, now, staleAfterMs)) continue;
      this.database.run('DELETE FROM library_scan_locks WHERE library_id = ?', [row.library_id]);
      released += 1;
    }
    return released;
  }
}

/** Reads every library's scanning policy. */
export function readLibrarySchedules(database: Database): LibrarySchedule[] {
  const rows = database.query(`
    SELECT id, auto_scan, watch_filesystem, scan_interval_minutes, last_scanned_at
    FROM libraries
  `).all() as Array<Record<string, any>>;

  return rows.map((row) => ({
    libraryId: row.id,
    autoScan: row.auto_scan === 1,
    watchFilesystem: row.watch_filesystem === 1,
    scanIntervalMinutes: row.scan_interval_minutes ?? null,
    lastScannedAt: row.last_scanned_at ?? null
  }));
}

export function updateLibrarySchedule(
  database: Database,
  libraryId: string,
  settings: {
    autoScan?: boolean;
    watchFilesystem?: boolean;
    scanIntervalMinutes?: number | null;
  }
): boolean {
  const assignments: string[] = [];
  const params: unknown[] = [];

  if (settings.autoScan !== undefined) {
    assignments.push('auto_scan = ?');
    params.push(settings.autoScan ? 1 : 0);
  }
  if (settings.watchFilesystem !== undefined) {
    assignments.push('watch_filesystem = ?');
    params.push(settings.watchFilesystem ? 1 : 0);
  }
  if (settings.scanIntervalMinutes !== undefined) {
    assignments.push('scan_interval_minutes = ?');
    params.push(settings.scanIntervalMinutes);
  }
  if (assignments.length === 0) return false;

  params.push(libraryId);
  const result = database.run(
    `UPDATE libraries SET ${assignments.join(', ')} WHERE id = ?`,
    params as any[]
  );
  return result.changes > 0;
}
