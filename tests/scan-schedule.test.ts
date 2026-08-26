import { beforeEach, describe, expect, it } from 'bun:test';
import { Database } from 'bun:sqlite';
import { runDatabaseMigrations } from '../apps/server/src/db/migrations';
import {
  ScanLockStore,
  readLibrarySchedules,
  updateLibrarySchedule
} from '../apps/server/src/db/scan-lock-store';
import {
  changesHaveSettled,
  DEFAULT_DEBOUNCE_MS,
  isPeriodicScanDue,
  isRelevantChange,
  librariesDueForScan,
  lockIsStale,
  type LibrarySchedule
} from '../apps/server/src/scanner/schedule';

const NOW = Date.parse('2026-03-01T12:00:00.000Z');
const minutesAgo = (minutes: number) => new Date(NOW - minutes * 60_000).toISOString();

const schedule = (over: Partial<LibrarySchedule> = {}): LibrarySchedule => ({
  libraryId: 'lib',
  autoScan: true,
  watchFilesystem: true,
  scanIntervalMinutes: 60,
  lastScannedAt: minutesAgo(10),
  ...over
});

describe('periodic rescans', () => {
  it('does nothing for a library with auto-scan off', () => {
    expect(isPeriodicScanDue(schedule({ autoScan: false, lastScannedAt: null }), NOW)).toBe(false);
  });

  it('scans a library that has never been scanned', () => {
    // Someone has just added a folder and is waiting to see their media.
    expect(isPeriodicScanDue(schedule({ lastScannedAt: null }), NOW)).toBe(true);
  });

  it('waits out the interval', () => {
    expect(isPeriodicScanDue(schedule({ lastScannedAt: minutesAgo(59) }), NOW)).toBe(false);
    expect(isPeriodicScanDue(schedule({ lastScannedAt: minutesAgo(61) }), NOW)).toBe(true);
  });

  it('falls back to a sane interval when none is set', () => {
    expect(isPeriodicScanDue(schedule({ scanIntervalMinutes: null, lastScannedAt: minutesAgo(60) }), NOW)).toBe(false);
    expect(isPeriodicScanDue(schedule({ scanIntervalMinutes: null, lastScannedAt: minutesAgo(400) }), NOW)).toBe(true);
  });

  it('rescans rather than trusting an unreadable timestamp', () => {
    expect(isPeriodicScanDue(schedule({ lastScannedAt: 'not a date' }), NOW)).toBe(true);
  });
});

describe('debouncing filesystem changes', () => {
  it('waits for writes to stop before scanning', () => {
    // Copying a season emits events for minutes; scanning on the first one
    // would index half-written files.
    expect(changesHaveSettled({ libraryId: 'lib', lastEventAt: NOW - 1000 }, NOW)).toBe(false);
    expect(changesHaveSettled({ libraryId: 'lib', lastEventAt: NOW - DEFAULT_DEBOUNCE_MS }, NOW)).toBe(true);
  });

  it('ignores files that are still being written', () => {
    expect(isRelevantChange('Movie.mkv')).toBe(true);
    expect(isRelevantChange('Movie.mkv.part')).toBe(false);
    expect(isRelevantChange('Movie.mkv.crdownload')).toBe(false);
    expect(isRelevantChange('.DS_Store')).toBe(false);
    expect(isRelevantChange('subdir/.hidden')).toBe(false);
    expect(isRelevantChange(null)).toBe(false);
  });
});

describe('choosing what to scan', () => {
  const due = (over: Parameters<typeof librariesDueForScan>[0]) => librariesDueForScan(over);

  it('scans a library whose changes have settled', () => {
    expect(due({
      schedules: [schedule()],
      pendingChanges: [{ libraryId: 'lib', lastEventAt: NOW - 20_000 }],
      scanningLibraryIds: [],
      now: NOW
    })).toEqual([{ libraryId: 'lib', reason: 'filesystem-change' }]);
  });

  it('ignores changes for a library that is not being watched', () => {
    expect(due({
      schedules: [schedule({ watchFilesystem: false, lastScannedAt: minutesAgo(1) })],
      pendingChanges: [{ libraryId: 'lib', lastEventAt: NOW - 20_000 }],
      scanningLibraryIds: [],
      now: NOW
    })).toEqual([]);
  });

  it('never stacks a scan on a library already scanning', () => {
    expect(due({
      schedules: [schedule({ lastScannedAt: null })],
      pendingChanges: [{ libraryId: 'lib', lastEventAt: NOW - 60_000 }],
      scanningLibraryIds: ['lib'],
      now: NOW
    })).toEqual([]);
  });

  it('does not queue a library twice for two reasons', () => {
    const decisions = due({
      schedules: [schedule({ lastScannedAt: null })],
      pendingChanges: [{ libraryId: 'lib', lastEventAt: NOW - 60_000 }],
      scanningLibraryIds: [],
      now: NOW
    });
    expect(decisions).toHaveLength(1);
    // A change is the more specific reason, so it wins over the periodic one.
    expect(decisions[0]!.reason).toBe('filesystem-change');
  });

  it('handles libraries independently', () => {
    const decisions = due({
      schedules: [
        schedule({ libraryId: 'films', lastScannedAt: minutesAgo(120) }),
        schedule({ libraryId: 'music', lastScannedAt: minutesAgo(1) })
      ],
      pendingChanges: [],
      scanningLibraryIds: [],
      now: NOW
    });
    expect(decisions.map((decision) => decision.libraryId)).toEqual(['films']);
  });

  it('ignores changes for a library it knows nothing about', () => {
    expect(due({
      schedules: [],
      pendingChanges: [{ libraryId: 'ghost', lastEventAt: NOW - 60_000 }],
      scanningLibraryIds: [],
      now: NOW
    })).toEqual([]);
  });
});

describe('scan locks', () => {
  let database: Database;
  let store: ScanLockStore;

  beforeEach(() => {
    database = new Database(':memory:');
    runDatabaseMigrations(database);
    for (const id of ['films', 'music']) {
      database.run(
        `INSERT INTO libraries (id, name, path, type, created_at) VALUES (?, ?, ?, 'movie', ?)`,
        [id, id, `/media/${id}`, new Date(NOW).toISOString()]
      );
    }
    store = new ScanLockStore(database, 'owner-a');
  });

  it('lets one scanner in at a time', () => {
    expect(store.acquire('films', NOW)).toBe(true);
    expect(new ScanLockStore(database, 'owner-b').acquire('films', NOW)).toBe(false);
  });

  it('scans two libraries at once', () => {
    // The old single boolean made scanning films block scanning music.
    expect(store.acquire('films', NOW)).toBe(true);
    expect(store.acquire('music', NOW)).toBe(true);
    expect(store.activeLibraryIds(NOW).sort()).toEqual(['films', 'music']);
  });

  it('reclaims a lock whose owner stopped responding', () => {
    store.acquire('films', NOW);
    const muchLater = NOW + 60 * 60 * 1000;

    // A crash mid-scan used to leave a library unscannable until restart.
    expect(new ScanLockStore(database, 'owner-b').acquire('films', muchLater)).toBe(true);
  });

  it('keeps a lock alive while the scan reports in', () => {
    store.acquire('films', NOW);
    const later = NOW + 25 * 60 * 1000;
    store.heartbeat('films', later);

    expect(new ScanLockStore(database, 'owner-b').acquire('films', later + 60_000)).toBe(false);
  });

  it('does not release another owner lock', () => {
    store.acquire('films', NOW);
    expect(new ScanLockStore(database, 'owner-b').release('films')).toBe(false);
    expect(store.release('films')).toBe(true);
  });

  it('clears abandoned locks at startup', () => {
    store.acquire('films', NOW);
    store.acquire('music', NOW);
    store.heartbeat('music', NOW + 60 * 60 * 1000);

    expect(store.releaseStale(NOW + 61 * 60 * 1000)).toBe(1);
    expect(store.activeLibraryIds(NOW + 61 * 60 * 1000)).toEqual(['music']);
  });

  it('treats an unreadable heartbeat as abandoned', () => {
    // Better to allow a duplicate scan than to lock a library out forever.
    expect(lockIsStale('nonsense', NOW)).toBe(true);
  });
});

describe('per-library scanning settings', () => {
  let database: Database;

  beforeEach(() => {
    database = new Database(':memory:');
    runDatabaseMigrations(database);
    database.run(
      `INSERT INTO libraries (id, name, path, type, created_at) VALUES ('films', 'Films', '/media', 'movie', ?)`,
      [new Date(NOW).toISOString()]
    );
  });

  it('defaults to off so nothing starts watching uninvited', () => {
    const [found] = readLibrarySchedules(database);
    expect(found).toMatchObject({ autoScan: false, watchFilesystem: false, scanIntervalMinutes: null });
  });

  it('stores what an administrator turns on', () => {
    expect(updateLibrarySchedule(database, 'films', {
      autoScan: true, watchFilesystem: true, scanIntervalMinutes: 30
    })).toBe(true);

    expect(readLibrarySchedules(database)[0]).toMatchObject({
      autoScan: true, watchFilesystem: true, scanIntervalMinutes: 30
    });
  });

  it('changes only what was asked for', () => {
    updateLibrarySchedule(database, 'films', { autoScan: true, scanIntervalMinutes: 30 });
    updateLibrarySchedule(database, 'films', { watchFilesystem: true });

    expect(readLibrarySchedules(database)[0]).toMatchObject({
      autoScan: true, watchFilesystem: true, scanIntervalMinutes: 30
    });
  });

  it('reports an unknown library rather than silently doing nothing', () => {
    expect(updateLibrarySchedule(database, 'ghost', { autoScan: true })).toBe(false);
    expect(updateLibrarySchedule(database, 'films', {})).toBe(false);
  });
});
