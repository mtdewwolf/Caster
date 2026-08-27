import fs from 'fs';
import type { Database } from 'bun:sqlite';
import { ScanLockStore, readLibrarySchedules } from '../db/scan-lock-store';
import { listAllLibraryRoots } from '../db/library-roots';
import {
  DEFAULT_DEBOUNCE_MS,
  isRelevantChange,
  librariesDueForScan,
  type PendingChange
} from './schedule';

/**
 * Keeps libraries up to date without anyone pressing Scan.
 *
 * Two mechanisms, because neither is sufficient alone. A filesystem watcher
 * reacts in seconds but does not exist on every mount — network shares and some
 * container setups deliver no events at all. A periodic rescan is slow but
 * always works, and also catches everything that changed while the server was
 * off. Both feed the same debounced decision, so a library never scans twice
 * for the same change.
 */

export interface AutoScanRuntimeOptions {
  database: Database;
  scanLibrary: (libraryId: string) => Promise<unknown>;
  /** How often to re-evaluate what is due. */
  tickIntervalMs?: number;
  debounceMs?: number;
  now?: () => number;
  watch?: typeof fs.watch;
  log?: (...args: unknown[]) => void;
  warn?: (...args: unknown[]) => void;
}

interface WatchedLibrary {
  libraryId: string;
  path: string;
  watcher: fs.FSWatcher;
}

/**
 * A library spanning several directories needs one watcher per directory, so
 * watchers are keyed by both. A NUL separator cannot occur in either part.
 */
function watchKey(libraryId: string, rootPath: string): string {
  return `${libraryId}\u0000${rootPath}`;
}

export class AutoScanRuntime {
  readonly #database: Database;
  readonly #scanLibrary: (libraryId: string) => Promise<unknown>;
  readonly #tickIntervalMs: number;
  readonly #debounceMs: number;
  readonly #now: () => number;
  readonly #watch: typeof fs.watch;
  readonly #log: (...args: unknown[]) => void;
  readonly #warn: (...args: unknown[]) => void;

  readonly #pending = new Map<string, PendingChange>();
  readonly #watchers = new Map<string, WatchedLibrary>();
  readonly #locks: ScanLockStore;
  #timer: ReturnType<typeof setInterval> | null = null;
  #ticking = false;

  constructor(options: AutoScanRuntimeOptions) {
    this.#database = options.database;
    this.#scanLibrary = options.scanLibrary;
    this.#tickIntervalMs = Math.max(1000, options.tickIntervalMs ?? 30_000);
    this.#debounceMs = options.debounceMs ?? DEFAULT_DEBOUNCE_MS;
    this.#now = options.now ?? (() => Date.now());
    this.#watch = options.watch ?? fs.watch;
    this.#log = options.log ?? ((...args) => console.log(...args));
    this.#warn = options.warn ?? ((...args) => console.warn(...args));
    this.#locks = new ScanLockStore(this.#database);
  }

  /** Libraries with at least one directory being watched. */
  get watchedLibraryIds(): string[] {
    return [...new Set([...this.#watchers.values()].map((watched) => watched.libraryId))];
  }

  /** Every directory currently being watched. */
  get watchedPaths(): string[] {
    return [...this.#watchers.values()].map((watched) => watched.path);
  }

  get pendingLibraryIds(): string[] {
    return [...this.#pending.keys()];
  }

  start(): void {
    if (this.#timer) return;

    // A lock left by a previous life of this process would otherwise keep a
    // library unscannable until it aged out on its own.
    const released = this.#locks.releaseStale(this.#now());
    if (released > 0) this.#log(`Released ${released} abandoned library scan lock(s).`);

    this.syncWatchers();
    this.#timer = setInterval(() => { void this.tick(); }, this.#tickIntervalMs);
  }

  stop(): void {
    if (this.#timer) {
      clearInterval(this.#timer);
      this.#timer = null;
    }
    for (const watched of this.#watchers.values()) {
      try {
        watched.watcher.close();
      } catch {
        // A watcher whose directory vanished may already be closed.
      }
    }
    this.#watchers.clear();
    this.#pending.clear();
  }

  /**
   * Starts and stops watchers to match the current library settings.
   *
   * One watcher per directory, not per library: a library assembled from three
   * mounts is only watched if all three are.
   */
  syncWatchers(): void {
    const watchedLibraries = new Set(
      (this.#database.query(
        'SELECT id FROM libraries WHERE watch_filesystem = 1'
      ).all() as Array<{ id: string }>).map((row) => row.id)
    );

    const wanted = new Map<string, { libraryId: string; path: string }>();
    for (const root of listAllLibraryRoots(this.#database)) {
      if (!watchedLibraries.has(root.libraryId)) continue;
      wanted.set(watchKey(root.libraryId, root.path), { libraryId: root.libraryId, path: root.path });
    }

    for (const [key, watched] of this.#watchers) {
      if (wanted.has(key)) continue;
      try {
        watched.watcher.close();
      } catch {
        // Already gone.
      }
      this.#watchers.delete(key);
    }

    for (const [key, target] of wanted) {
      if (this.#watchers.has(key)) continue;
      this.#startWatching(key, target.libraryId, target.path);
    }
  }

  #startWatching(key: string, libraryId: string, libraryPath: string): void {
    try {
      const watcher = this.#watch(libraryPath, { recursive: true }, (_event, fileName) => {
        if (!isRelevantChange(typeof fileName === 'string' ? fileName : null)) return;
        // Any root changing means the library is due; the scan covers them all.
        this.#pending.set(libraryId, { libraryId, lastEventAt: this.#now() });
      });

      watcher.on('error', (error) => {
        this.#warn(`Stopped watching ${libraryPath}:`, error);
        this.#watchers.delete(key);
      });

      this.#watchers.set(key, { libraryId, path: libraryPath, watcher });
      this.#log(`Watching ${libraryPath} for changes.`);
    } catch (error) {
      // Recursive watching is unavailable on some platforms and most network
      // mounts. The periodic rescan still covers those libraries.
      this.#warn(
        `Could not watch ${libraryPath}; falling back to periodic scans only.`,
        error
      );
    }
  }

  /** Evaluates what is due and scans it. Never throws. */
  async tick(): Promise<string[]> {
    if (this.#ticking) return [];
    this.#ticking = true;

    try {
      const now = this.#now();
      const decisions = librariesDueForScan({
        schedules: readLibrarySchedules(this.#database),
        pendingChanges: [...this.#pending.values()],
        scanningLibraryIds: this.#locks.activeLibraryIds(now),
        now,
        debounceMs: this.#debounceMs
      });

      const scanned: string[] = [];
      for (const decision of decisions) {
        // Clear the pending mark before scanning: a change arriving during the
        // scan should queue another one rather than being swallowed.
        this.#pending.delete(decision.libraryId);
        try {
          this.#log(`Auto-scanning library ${decision.libraryId} (${decision.reason}).`);
          await this.#scanLibrary(decision.libraryId);
          scanned.push(decision.libraryId);
        } catch (error) {
          // A library that fails to scan must not stop the others, and must not
          // take the whole runtime down.
          this.#warn(`Automatic scan of ${decision.libraryId} failed:`, error);
        }
      }
      return scanned;
    } finally {
      this.#ticking = false;
    }
  }
}
