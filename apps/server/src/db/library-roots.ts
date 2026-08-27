import path from 'path';
import type { Database } from 'bun:sqlite';

/**
 * The directories a library is made of.
 *
 * One library used to mean one directory. Real collections outgrow that: a pool
 * fills up and the next season lands on a different dataset, so the operator
 * either splits the library in two — and with it the sidebar, the scans, and
 * any series spanning both — or gives up and reorganises their disks around
 * Caster. A library therefore owns a set of root directories, and every root is
 * scanned into the same library.
 *
 * `libraries.path` survives as the first root. It is what every older query,
 * export, and backup still reads, so it is kept pointing at a directory that
 * actually belongs to the library rather than being left to rot.
 */

export interface LibraryRoot {
  libraryId: string;
  path: string;
  createdAt: string;
}

/** Why a root could not be added or removed, in terms the API can report. */
export type LibraryRootFailure =
  | 'library-not-found'
  | 'duplicate'
  | 'overlaps'
  | 'last-root'
  | 'not-a-root';

export type LibraryRootResult =
  | { ok: true; paths: string[] }
  | { ok: false; reason: LibraryRootFailure; conflictingPath?: string; paths: string[] };

/** Windows treats paths case-insensitively; everywhere else is byte-exact. */
function comparable(value: string): string {
  return process.platform === 'win32' ? value.toLowerCase() : value;
}

export function samePath(left: string, right: string): boolean {
  return comparable(path.resolve(left)) === comparable(path.resolve(right));
}

/** True when `child` is `parent` or sits somewhere beneath it. */
export function containsPath(parent: string, child: string): boolean {
  if (samePath(parent, child)) return true;
  const relative = path.relative(comparable(path.resolve(parent)), comparable(path.resolve(child)));
  if (relative === '' || path.isAbsolute(relative)) return false;
  return relative !== '..' && !relative.startsWith(`..${path.sep}`);
}

/**
 * The root a file was found under, or null when it belongs to none of them.
 *
 * The longest match wins so that a nested root, if one ever exists, describes
 * its own files rather than deferring to an ancestor.
 */
export function rootForPath(roots: readonly string[], filePath: string): string | null {
  let best: string | null = null;
  for (const root of roots) {
    if (!containsPath(root, filePath)) continue;
    if (best === null || root.length > best.length) best = root;
  }
  return best;
}

/**
 * Every root of a library, oldest first.
 *
 * A library with no rows at all falls back to its `libraries.path` column: a
 * row written directly by a tool or a test never went through
 * {@link addLibraryRoot}, and it still describes one real directory.
 */
export function listLibraryRoots(database: Database, libraryId: string): string[] {
  const rows = database.query(`
    SELECT path FROM library_roots
    WHERE library_id = ?
    ORDER BY created_at ASC, path ASC
  `).all(libraryId) as Array<{ path: string }>;
  if (rows.length > 0) return rows.map((row) => row.path);

  const legacy = database.query(
    'SELECT path FROM libraries WHERE id = ?'
  ).get(libraryId) as { path: string | null } | null;
  return legacy?.path?.trim() ? [legacy.path] : [];
}

/** Every root of every library, for callers that would otherwise query per library. */
export function listAllLibraryRoots(database: Database): LibraryRoot[] {
  const rows = database.query(`
    SELECT l.id AS library_id,
           COALESCE(r.path, l.path) AS path,
           COALESCE(r.created_at, l.created_at) AS created_at
    FROM libraries l
    LEFT JOIN library_roots r ON r.library_id = l.id
    ORDER BY l.id ASC, COALESCE(r.created_at, l.created_at) ASC, COALESCE(r.path, l.path) ASC
  `).all() as Array<{ library_id: string; path: string | null; created_at: string }>;

  return rows
    .filter((row) => !!row.path?.trim())
    .map((row) => ({ libraryId: row.library_id, path: row.path as string, createdAt: row.created_at }));
}

/**
 * Points `libraries.path` at the library's first root.
 *
 * Called after every change, because the column is a cache of the root list and
 * a stale one would send legacy readers to a directory the library no longer
 * covers.
 */
function syncPrimaryPath(database: Database, libraryId: string): string[] {
  const paths = listLibraryRoots(database, libraryId);
  if (paths.length > 0) {
    database.run('UPDATE libraries SET path = ? WHERE id = ?', [paths[0], libraryId]);
  }
  return paths;
}

/**
 * Writes a pre-multi-root library's `libraries.path` into the roots table.
 *
 * Does nothing once the library has roots of its own. The library's creation
 * time is used rather than now, so the original directory keeps its place at
 * the front of the list.
 */
function materializeLegacyRoot(database: Database, libraryId: string): void {
  const hasRoots = database.query(
    'SELECT 1 FROM library_roots WHERE library_id = ? LIMIT 1'
  ).get(libraryId);
  if (hasRoots) return;

  const library = database.query(
    'SELECT path, created_at FROM libraries WHERE id = ?'
  ).get(libraryId) as { path: string | null; created_at: string } | null;
  if (!library?.path?.trim()) return;

  database.run(`
    INSERT OR IGNORE INTO library_roots (library_id, path, created_at)
    VALUES (?, ?, ?)
  `, [libraryId, library.path, library.created_at]);
}

function libraryExists(database: Database, libraryId: string): boolean {
  return !!database.query('SELECT 1 FROM libraries WHERE id = ?').get(libraryId);
}

/**
 * Adds a directory to a library.
 *
 * Overlapping roots are refused rather than merged. Nesting one root inside
 * another would discover the same files twice, and the duplicate would be
 * indistinguishable from two genuine copies of the same title.
 */
export function addLibraryRoot(
  database: Database,
  libraryId: string,
  rootPath: string,
  now: string = new Date().toISOString()
): LibraryRootResult {
  if (!libraryExists(database, libraryId)) {
    return { ok: false, reason: 'library-not-found', paths: [] };
  }

  const resolved = path.resolve(rootPath);
  const existing = listLibraryRoots(database, libraryId);

  for (const current of existing) {
    if (samePath(current, resolved)) {
      return { ok: false, reason: 'duplicate', conflictingPath: current, paths: existing };
    }
    if (containsPath(current, resolved) || containsPath(resolved, current)) {
      return { ok: false, reason: 'overlaps', conflictingPath: current, paths: existing };
    }
  }

  // A library that only ever had `libraries.path` has no rows yet. Materialise
  // that directory first, stamped with the library's own creation time, so it
  // stays the first root instead of being reordered behind the new one.
  materializeLegacyRoot(database, libraryId);

  database.run(`
    INSERT OR IGNORE INTO library_roots (library_id, path, created_at)
    VALUES (?, ?, ?)
  `, [libraryId, resolved, now]);

  return { ok: true, paths: syncPrimaryPath(database, libraryId) };
}

/**
 * Removes a directory from a library.
 *
 * The last root is refused: a library with no directories cannot be scanned,
 * cannot be repaired through this endpoint, and is only ever a mistake. Deleting
 * the library is the way to say that.
 */
export function removeLibraryRoot(
  database: Database,
  libraryId: string,
  rootPath: string
): LibraryRootResult {
  if (!libraryExists(database, libraryId)) {
    return { ok: false, reason: 'library-not-found', paths: [] };
  }

  const existing = listLibraryRoots(database, libraryId);
  const match = existing.find((current) => samePath(current, rootPath));
  if (!match) {
    return { ok: false, reason: 'not-a-root', paths: existing };
  }
  if (existing.length === 1) {
    return { ok: false, reason: 'last-root', paths: existing };
  }

  database.run('DELETE FROM library_roots WHERE library_id = ? AND path = ?', [libraryId, match]);
  // The catalog would otherwise keep serving titles from a directory the
  // library no longer covers until someone happened to rescan it.
  deleteMediaUnderRoot(database, libraryId, match);

  return { ok: true, paths: syncPrimaryPath(database, libraryId) };
}

/**
 * Forgets everything indexed beneath a directory.
 *
 * Membership is decided by {@link containsPath} rather than a SQL prefix match,
 * so removal uses the same notion of "under this root" the scanner used to put
 * the rows there — including how it treats case.
 */
function deleteMediaUnderRoot(database: Database, libraryId: string, rootPath: string): number {
  const rows = database.query(
    'SELECT id, full_path FROM media_items WHERE library_id = ?'
  ).all(libraryId) as Array<{ id: string; full_path: string }>;

  const statement = database.prepare('DELETE FROM media_items WHERE id = ?');
  let removed = 0;
  for (const row of rows) {
    if (!containsPath(rootPath, row.full_path)) continue;
    statement.run(row.id);
    removed += 1;
  }
  return removed;
}

/** Replaces a library's roots wholesale, used when the library is created. */
export function setLibraryRoots(
  database: Database,
  libraryId: string,
  rootPaths: readonly string[],
  now: string = new Date().toISOString()
): string[] {
  database.run('DELETE FROM library_roots WHERE library_id = ?', [libraryId]);
  // Roots are ordered by when they were added, and the first one becomes
  // `libraries.path`. Stamps are spread a millisecond apart so a list added in
  // one request keeps the order it was written in rather than sorting by name.
  const base = Date.parse(now);
  rootPaths.forEach((rootPath, index) => {
    const createdAt = Number.isNaN(base) ? now : new Date(base + index).toISOString();
    database.run(`
      INSERT OR IGNORE INTO library_roots (library_id, path, created_at)
      VALUES (?, ?, ?)
    `, [libraryId, path.resolve(rootPath), createdAt]);
  });
  return syncPrimaryPath(database, libraryId);
}
