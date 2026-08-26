/**
 * When a library should be scanned.
 *
 * Two triggers, and both need restraint. A filesystem watcher fires once per
 * file during a large copy, so events are debounced into a single scan after
 * the writes settle. A periodic rescan catches everything a watcher misses —
 * network shares, containers without inotify, changes made while the server was
 * off — but should not run while a scan is already going.
 *
 * All of it is pure so the timing rules can be tested without touching a disk
 * or waiting on a clock.
 */

export const DEFAULT_DEBOUNCE_MS = 15_000;
export const DEFAULT_SCAN_INTERVAL_MINUTES = 360;
/** Longest a scan lock is trusted before it is treated as abandoned. */
export const LOCK_STALE_AFTER_MS = 30 * 60 * 1000;

export interface LibrarySchedule {
  libraryId: string;
  autoScan: boolean;
  watchFilesystem: boolean;
  /** Minutes between periodic rescans. Null uses the default. */
  scanIntervalMinutes: number | null;
  lastScannedAt: string | null;
}

export interface PendingChange {
  libraryId: string;
  /** When the most recent filesystem event for this library arrived. */
  lastEventAt: number;
}

export function intervalMsFor(schedule: LibrarySchedule): number {
  const minutes = schedule.scanIntervalMinutes && schedule.scanIntervalMinutes > 0
    ? schedule.scanIntervalMinutes
    : DEFAULT_SCAN_INTERVAL_MINUTES;
  return minutes * 60 * 1000;
}

/**
 * Whether a periodic rescan is due.
 *
 * A library that has never been scanned is due immediately — that is the case
 * where someone has just added a folder and is waiting to see their media.
 */
export function isPeriodicScanDue(schedule: LibrarySchedule, now: number): boolean {
  if (!schedule.autoScan) return false;
  if (!schedule.lastScannedAt) return true;

  const lastScanned = Date.parse(schedule.lastScannedAt);
  if (!Number.isFinite(lastScanned)) return true;

  return now - lastScanned >= intervalMsFor(schedule);
}

/**
 * Whether filesystem changes have settled enough to act on.
 *
 * Copying a season of television emits hundreds of events over minutes.
 * Scanning on the first one would index half-written files; scanning on each
 * one would rescan the library hundreds of times.
 */
export function changesHaveSettled(
  change: PendingChange,
  now: number,
  debounceMs: number = DEFAULT_DEBOUNCE_MS
): boolean {
  return now - change.lastEventAt >= Math.max(0, debounceMs);
}

export interface ScanDecision {
  libraryId: string;
  reason: 'filesystem-change' | 'periodic';
}

/**
 * The libraries to scan right now.
 *
 * A library already scanning is skipped rather than queued: the run in flight
 * will pick up whatever changed, and stacking scans on a slow library is how a
 * server ends up permanently busy.
 */
export function librariesDueForScan(input: {
  schedules: readonly LibrarySchedule[];
  pendingChanges: readonly PendingChange[];
  scanningLibraryIds: readonly string[];
  now: number;
  debounceMs?: number;
}): ScanDecision[] {
  const scanning = new Set(input.scanningLibraryIds);
  const decisions: ScanDecision[] = [];
  const claimed = new Set<string>();

  const byId = new Map(input.schedules.map((schedule) => [schedule.libraryId, schedule]));

  for (const change of input.pendingChanges) {
    const schedule = byId.get(change.libraryId);
    if (!schedule || !schedule.watchFilesystem) continue;
    if (scanning.has(change.libraryId) || claimed.has(change.libraryId)) continue;
    if (!changesHaveSettled(change, input.now, input.debounceMs)) continue;

    claimed.add(change.libraryId);
    decisions.push({ libraryId: change.libraryId, reason: 'filesystem-change' });
  }

  for (const schedule of input.schedules) {
    if (scanning.has(schedule.libraryId) || claimed.has(schedule.libraryId)) continue;
    if (!isPeriodicScanDue(schedule, input.now)) continue;

    claimed.add(schedule.libraryId);
    decisions.push({ libraryId: schedule.libraryId, reason: 'periodic' });
  }

  return decisions;
}

/** True when a lock is old enough that its owner is presumed gone. */
export function lockIsStale(
  heartbeatAt: string,
  now: number,
  staleAfterMs: number = LOCK_STALE_AFTER_MS
): boolean {
  const beat = Date.parse(heartbeatAt);
  // An unparseable timestamp is not a reason to keep a library locked forever.
  if (!Number.isFinite(beat)) return true;
  return now - beat >= staleAfterMs;
}

/** Filesystem events worth reacting to. */
export function isRelevantChange(fileName: string | null | undefined): boolean {
  if (!fileName) return false;
  const name = fileName.split(/[\\/]/).pop() ?? '';
  // Editors, downloaders and macOS all litter directories with files that are
  // not media and change constantly.
  if (!name || name.startsWith('.')) return false;
  return !/\.(part|crdownload|tmp|temp|!ut|partial)$/i.test(name);
}
