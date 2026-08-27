import { beforeEach, describe, expect, it } from 'bun:test';
import { Database } from 'bun:sqlite';
import { runDatabaseMigrations } from '../apps/server/src/db/migrations';
import { AutoScanRuntime } from '../apps/server/src/scanner/auto-scan';
import { ScanLockStore, updateLibrarySchedule } from '../apps/server/src/db/scan-lock-store';
import { addLibraryRoot } from '../apps/server/src/db/library-roots';

describe('automatic scanning', () => {
  let database: Database;
  let clock: number;
  let scanned: string[];
  let failing: Set<string>;

  const START = Date.parse('2026-03-01T12:00:00.000Z');

  function runtime(over: Partial<ConstructorParameters<typeof AutoScanRuntime>[0]> = {}) {
    return new AutoScanRuntime({
      database,
      now: () => clock,
      log: () => {},
      warn: () => {},
      scanLibrary: async (libraryId) => {
        if (failing.has(libraryId)) throw new Error('scan blew up');
        scanned.push(libraryId);
        // A real scan stamps the library as scanned; mirror that.
        database.run('UPDATE libraries SET last_scanned_at = ? WHERE id = ?',
          [new Date(clock).toISOString(), libraryId]);
      },
      ...over
    });
  }

  function addLibrary(id: string, lastScannedAt: string | null = null) {
    database.run(
      `INSERT INTO libraries (id, name, path, type, last_scanned_at, created_at)
       VALUES (?, ?, ?, 'movie', ?, ?)`,
      [id, id, `/media/${id}`, lastScannedAt, new Date(START).toISOString()]
    );
  }

  beforeEach(() => {
    database = new Database(':memory:');
    runDatabaseMigrations(database);
    clock = START;
    scanned = [];
    failing = new Set();
  });

  it('does nothing for libraries that never opted in', async () => {
    addLibrary('films');
    expect(await runtime().tick()).toEqual([]);
  });

  it('scans a newly enabled library that has never been scanned', async () => {
    addLibrary('films');
    updateLibrarySchedule(database, 'films', { autoScan: true });

    expect(await runtime().tick()).toEqual(['films']);
  });

  it('waits out the interval before scanning again', async () => {
    addLibrary('films');
    updateLibrarySchedule(database, 'films', { autoScan: true, scanIntervalMinutes: 60 });
    const auto = runtime();

    await auto.tick();
    clock += 30 * 60_000;
    expect(await auto.tick()).toEqual([]);

    clock += 31 * 60_000;
    expect(await auto.tick()).toEqual(['films']);
  });

  it('never runs two ticks over each other', async () => {
    addLibrary('films');
    updateLibrarySchedule(database, 'films', { autoScan: true });

    let release: (() => void) | null = null;
    const auto = runtime({
      scanLibrary: () => new Promise<void>((resolve) => { release = resolve; })
    });

    const first = auto.tick();
    const second = await auto.tick();
    // The second tick finds one already running and does nothing.
    expect(second).toEqual([]);

    release!();
    await first;
  });

  it('keeps scanning other libraries when one fails', async () => {
    addLibrary('films');
    addLibrary('music');
    updateLibrarySchedule(database, 'films', { autoScan: true });
    updateLibrarySchedule(database, 'music', { autoScan: true });
    failing.add('films');

    // A broken library must not take the runtime down with it.
    expect(await runtime().tick()).toEqual(['music']);
  });

  it('skips a library something else is already scanning', async () => {
    addLibrary('films');
    updateLibrarySchedule(database, 'films', { autoScan: true });
    new ScanLockStore(database, 'someone-else').acquire('films', clock);

    expect(await runtime().tick()).toEqual([]);
  });

  it('reacts to a filesystem change once writes settle', async () => {
    addLibrary('films', new Date(START).toISOString());
    updateLibrarySchedule(database, 'films', {
      autoScan: true, watchFilesystem: true, scanIntervalMinutes: 600
    });

    const events: Array<(event: string, name: string) => void> = [];
    const auto = runtime({
      watch: ((_path: string, _options: unknown, listener: any) => {
        events.push(listener);
        return { close: () => {}, on: () => {} } as any;
      }) as any
    });
    auto.syncWatchers();

    events[0]!('rename', 'New Film.mkv');
    expect(auto.pendingLibraryIds).toEqual(['films']);

    // Too soon: the copy may still be in progress.
    expect(await auto.tick()).toEqual([]);

    clock += 20_000;
    expect(await auto.tick()).toEqual(['films']);
  });

  it('ignores events for files still being written', async () => {
    addLibrary('films', new Date(START).toISOString());
    updateLibrarySchedule(database, 'films', { watchFilesystem: true });

    const events: Array<(event: string, name: string) => void> = [];
    const auto = runtime({
      watch: ((_path: string, _options: unknown, listener: any) => {
        events.push(listener);
        return { close: () => {}, on: () => {} } as any;
      }) as any
    });
    auto.syncWatchers();

    events[0]!('change', 'Film.mkv.part');
    events[0]!('change', '.DS_Store');
    expect(auto.pendingLibraryIds).toEqual([]);
  });

  it('carries on without a watcher when the platform cannot provide one', () => {
    addLibrary('films');
    updateLibrarySchedule(database, 'films', { watchFilesystem: true });

    // Network shares and some containers deliver no events at all.
    const auto = runtime({
      watch: (() => { throw new Error('inotify unavailable'); }) as any
    });

    expect(() => auto.syncWatchers()).not.toThrow();
    expect(auto.watchedLibraryIds).toEqual([]);
  });

  it('watches every folder of a library that spans several', () => {
    addLibrary('films', new Date(START).toISOString());
    const archive = addLibraryRoot(database, 'films', '/media/films-archive');
    updateLibrarySchedule(database, 'films', {
      autoScan: true, watchFilesystem: true, scanIntervalMinutes: 600
    });

    const events: Array<(event: string, name: string) => void> = [];
    const auto = runtime({
      watch: ((_path: string, _options: unknown, listener: any) => {
        events.push(listener);
        return { close: () => {}, on: () => {} } as any;
      }) as any
    });
    auto.syncWatchers();

    // One watcher per folder, but still one library.
    expect(auto.watchedPaths).toEqual(archive.paths);
    expect(auto.watchedLibraryIds).toEqual(['films']);

    // A change anywhere in the library is a change to the library.
    events[1]!('rename', 'New Film.mkv');
    expect(auto.pendingLibraryIds).toEqual(['films']);
  });

  it('stops watching a library that was turned off', () => {
    addLibrary('films');
    updateLibrarySchedule(database, 'films', { watchFilesystem: true });

    let closed = 0;
    const auto = runtime({
      watch: (() => ({ close: () => { closed += 1; }, on: () => {} })) as any
    });

    auto.syncWatchers();
    expect(auto.watchedLibraryIds).toEqual(['films']);

    updateLibrarySchedule(database, 'films', { watchFilesystem: false });
    auto.syncWatchers();

    expect(auto.watchedLibraryIds).toEqual([]);
    expect(closed).toBe(1);
  });

  it('clears abandoned locks when it starts', () => {
    addLibrary('films');
    new ScanLockStore(database, 'a-dead-process').acquire('films', clock);
    clock += 60 * 60_000;

    const auto = runtime({ watch: (() => ({ close: () => {}, on: () => {} })) as any });
    auto.start();
    try {
      expect(new ScanLockStore(database).activeLibraryIds(clock)).toEqual([]);
    } finally {
      auto.stop();
    }
  });
});
