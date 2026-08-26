import { beforeEach, describe, expect, it } from 'bun:test';
import { Database } from 'bun:sqlite';
import { runDatabaseMigrations } from '../apps/server/src/db/migrations';
import { MediaIdentityStore } from '../apps/server/src/db/media-identity-store';

describe('path history and cross-library moves', () => {
  let database: Database;
  let missingPaths: Set<string>;
  let store: MediaIdentityStore;

  const FINGERPRINT = 'sampled-sha256-v1:abc';

  function insertMedia(id: string, libraryId: string, fullPath: string, fingerprint = FINGERPRINT) {
    const now = '2026-01-01T00:00:00.000Z';
    database.run(`
      INSERT INTO media_items (
        id, library_id, title, original_filename, relative_path, full_path,
        type, duration, size_bytes, format, streams_json,
        content_fingerprint, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, 'movie', 100, 100, 'mkv', '[]', ?, ?, ?)
    `, [id, libraryId, id, `${id}.mkv`, `${id}.mkv`, fullPath, fingerprint, now, now]);
  }

  function library(id: string) {
    database.run(
      `INSERT INTO libraries (id, name, path, type, created_at) VALUES (?, ?, ?, 'movie', ?)`,
      [id, id, `/media/${id}`, '2026-01-01T00:00:00.000Z']
    );
  }

  const resolve = (over: Partial<Parameters<MediaIdentityStore['resolve']>[0]> = {}) =>
    store.resolve({
      libraryId: 'lib-a',
      fullPath: '/media/lib-a/moved.mkv',
      relativePath: 'moved.mkv',
      originalFilename: 'moved.mkv',
      contentFingerprint: FINGERPRINT,
      newId: 'brand-new',
      ...over
    });

  const pathOf = (id: string) =>
    (database.query('SELECT full_path, library_id FROM media_items WHERE id = ?').get(id) as any);

  beforeEach(() => {
    database = new Database(':memory:');
    runDatabaseMigrations(database);
    library('lib-a');
    library('lib-b');
    missingPaths = new Set();
    store = new MediaIdentityStore(database, (filePath) => !missingPaths.has(filePath));
  });

  it('records the path of a newly indexed file', () => {
    insertMedia('m1', 'lib-a', '/media/lib-a/moved.mkv');
    const resolved = resolve();

    expect(resolved).toEqual({ id: 'm1', kind: 'existing' });
    expect(store.getPathHistory('m1').map((entry) => entry.fullPath))
      .toEqual(['/media/lib-a/moved.mkv']);
  });

  it('keeps every path a file has lived at', () => {
    insertMedia('m1', 'lib-a', '/media/lib-a/old.mkv');
    missingPaths.add('/media/lib-a/old.mkv');

    resolve({ currentLibraryPaths: new Set(['/media/lib-a/moved.mkv']) });

    expect(store.getPathHistory('m1').map((entry) => entry.fullPath).sort())
      .toEqual(['/media/lib-a/moved.mkv', '/media/lib-a/old.mkv']);
  });

  it('follows a file moved into another library', () => {
    insertMedia('m1', 'lib-b', '/media/lib-b/old.mkv');
    missingPaths.add('/media/lib-b/old.mkv');

    const resolved = resolve({ currentLibraryPaths: new Set(['/media/lib-a/moved.mkv']) });

    expect(resolved).toEqual({ id: 'm1', kind: 'reconciled', via: 'cross-library' });
    expect(pathOf('m1')).toEqual({
      full_path: '/media/lib-a/moved.mkv',
      library_id: 'lib-a'
    });
  });

  it('does not steal a file that still exists in another library', () => {
    insertMedia('m1', 'lib-b', '/media/lib-b/still-there.mkv');

    expect(resolve({ currentLibraryPaths: new Set(['/media/lib-a/moved.mkv']) }))
      .toEqual({ id: 'brand-new', kind: 'new' });
    expect(pathOf('m1').library_id).toBe('lib-b');
  });

  it('refuses to guess between two identical missing files', () => {
    insertMedia('m1', 'lib-a', '/media/lib-a/one.mkv');
    insertMedia('m2', 'lib-a', '/media/lib-a/two.mkv');

    expect(resolve({ currentLibraryPaths: new Set(['/media/lib-a/moved.mkv']) }))
      .toEqual({ id: 'brand-new', kind: 'new' });
  });

  it('breaks a tie using a path the file has occupied before', () => {
    insertMedia('m1', 'lib-a', '/media/lib-a/one.mkv');
    insertMedia('m2', 'lib-a', '/media/lib-a/two.mkv');
    // m2 lived at the incoming path before, so it is the better match.
    store.recordPath('m2', '/media/lib-a/moved.mkv', 'lib-a');

    const resolved = resolve({ currentLibraryPaths: new Set(['/media/lib-a/moved.mkv']) });

    expect(resolved).toEqual({ id: 'm2', kind: 'reconciled', via: 'path-history' });
    expect(pathOf('m2').full_path).toBe('/media/lib-a/moved.mkv');
  });

  it('still refuses when both candidates have lived at the path', () => {
    insertMedia('m1', 'lib-a', '/media/lib-a/one.mkv');
    insertMedia('m2', 'lib-a', '/media/lib-a/two.mkv');
    store.recordPath('m1', '/media/lib-a/moved.mkv', 'lib-a');
    store.recordPath('m2', '/media/lib-a/moved.mkv', 'lib-a');

    expect(resolve({ currentLibraryPaths: new Set(['/media/lib-a/moved.mkv']) }))
      .toEqual({ id: 'brand-new', kind: 'new' });
  });

  it('prefers a same-library match over a cross-library one', () => {
    insertMedia('local', 'lib-a', '/media/lib-a/old.mkv');
    insertMedia('remote', 'lib-b', '/media/lib-b/old.mkv');
    missingPaths.add('/media/lib-a/old.mkv');
    missingPaths.add('/media/lib-b/old.mkv');

    expect(resolve({ currentLibraryPaths: new Set(['/media/lib-a/moved.mkv']) }))
      .toEqual({ id: 'local', kind: 'reconciled', via: 'same-library' });
  });

  it('does not match a file with a different fingerprint', () => {
    insertMedia('m1', 'lib-a', '/media/lib-a/old.mkv', 'sampled-sha256-v1:different');
    missingPaths.add('/media/lib-a/old.mkv');

    expect(resolve({ currentLibraryPaths: new Set(['/media/lib-a/moved.mkv']) }))
      .toEqual({ id: 'brand-new', kind: 'new' });
  });

  it('drops history when the media item is deleted', () => {
    insertMedia('m1', 'lib-a', '/media/lib-a/moved.mkv');
    resolve();
    expect(store.getPathHistory('m1')).toHaveLength(1);

    database.run('PRAGMA foreign_keys = ON');
    database.run('DELETE FROM media_items WHERE id = ?', ['m1']);
    expect(store.getPathHistory('m1')).toEqual([]);
  });
});
