import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'bun:test';
import { Database } from 'bun:sqlite';
import crypto from 'crypto';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { DATABASE_MIGRATIONS, runDatabaseMigrations } from '../apps/server/src/db/migrations';
import {
  addLibraryRoot,
  listLibraryRoots,
  removeLibraryRoot,
  rootForPath
} from '../apps/server/src/db/library-roots';
import { db, initDatabase, LibraryModel } from '../apps/server/src/db';
import { scanLibrary } from '../apps/server/src/scanner/indexer';

const FIRST = path.resolve('/media/movies');
const SECOND = path.resolve('/mnt/archive/movies');
const NESTED = path.resolve('/media/movies/4k');

describe('library roots', () => {
  let database: Database;

  function addLibrary(id: string, rootPath: string, createdAt = '2026-01-01T00:00:00.000Z'): void {
    database.run(
      `INSERT INTO libraries (id, name, path, type, created_at) VALUES (?, ?, ?, 'movies', ?)`,
      [id, id, rootPath, createdAt]
    );
  }

  function addMedia(id: string, libraryId: string, fullPath: string): void {
    database.run(`
      INSERT INTO media_items (
        id, library_id, title, original_filename, relative_path, full_path,
        type, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, 'movie', '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z')
    `, [id, libraryId, id, path.basename(fullPath), path.basename(fullPath), fullPath]);
  }

  function libraryPathColumn(libraryId: string): string {
    return (database.query('SELECT path FROM libraries WHERE id = ?').get(libraryId) as { path: string }).path;
  }

  beforeEach(() => {
    database = new Database(':memory:');
    database.run('PRAGMA foreign_keys = ON');
    runDatabaseMigrations(database);
  });

  it('adopts an existing library folder as that library first root', () => {
    const upgrading = new Database(':memory:');
    try {
      upgrading.run('PRAGMA foreign_keys = ON');
      // Everything up to, but not including, the migration under test.
      runDatabaseMigrations(upgrading, DATABASE_MIGRATIONS.slice(0, 21));
      upgrading.run(
        `INSERT INTO libraries (id, name, path, type, created_at) VALUES ('films', 'Films', ?, 'movies', ?)`,
        [FIRST, '2026-01-01T00:00:00.000Z']
      );

      runDatabaseMigrations(upgrading);

      expect(listLibraryRoots(upgrading, 'films')).toEqual([FIRST]);
    } finally {
      upgrading.close();
    }
  });

  it('reads a library written without roots from its legacy column', () => {
    // Rows written directly by a tool or a test never went through addLibraryRoot.
    addLibrary('films', FIRST);
    expect(listLibraryRoots(database, 'films')).toEqual([FIRST]);
  });

  it('adds a second folder and keeps the first one as the library path', () => {
    addLibrary('films', FIRST);

    const result = addLibraryRoot(database, 'films', SECOND);

    expect(result).toEqual({ ok: true, paths: [FIRST, SECOND] });
    expect(listLibraryRoots(database, 'films')).toEqual([FIRST, SECOND]);
    // Anything still reading the old column must see a folder that is really
    // part of the library.
    expect(libraryPathColumn('films')).toBe(FIRST);
  });

  it('refuses a folder the library already covers', () => {
    addLibrary('films', FIRST);
    addLibraryRoot(database, 'films', SECOND);

    expect(addLibraryRoot(database, 'films', SECOND)).toMatchObject({ ok: false, reason: 'duplicate' });
    expect(listLibraryRoots(database, 'films')).toEqual([FIRST, SECOND]);
  });

  it('refuses folders nested in one another, in either direction', () => {
    addLibrary('films', FIRST);

    // Scanning a folder and its parent into one library would index every file
    // beneath it twice.
    expect(addLibraryRoot(database, 'films', NESTED)).toMatchObject({
      ok: false,
      reason: 'overlaps',
      conflictingPath: FIRST
    });

    addLibrary('shows', NESTED);
    expect(addLibraryRoot(database, 'shows', FIRST)).toMatchObject({
      ok: false,
      reason: 'overlaps',
      conflictingPath: NESTED
    });
  });

  it('refuses to remove a library only folder', () => {
    addLibrary('films', FIRST);

    expect(removeLibraryRoot(database, 'films', FIRST)).toMatchObject({ ok: false, reason: 'last-root' });
    expect(listLibraryRoots(database, 'films')).toEqual([FIRST]);
  });

  it('refuses to remove a folder the library never had', () => {
    addLibrary('films', FIRST);
    addLibraryRoot(database, 'films', SECOND);

    expect(removeLibraryRoot(database, 'films', NESTED)).toMatchObject({ ok: false, reason: 'not-a-root' });
  });

  it('forgets what a removed folder contributed and leaves the rest alone', () => {
    addLibrary('films', FIRST);
    addLibraryRoot(database, 'films', SECOND);
    addMedia('kept', 'films', path.join(FIRST, 'Kept.mkv'));
    addMedia('dropped', 'films', path.join(SECOND, 'Nested', 'Dropped.mkv'));

    expect(removeLibraryRoot(database, 'films', SECOND)).toEqual({ ok: true, paths: [FIRST] });
    expect(database.query('SELECT id FROM media_items WHERE library_id = ?').all('films'))
      .toEqual([{ id: 'kept' }]);
  });

  it('promotes the next folder when the first one is removed', () => {
    addLibrary('films', FIRST);
    addLibraryRoot(database, 'films', SECOND);

    expect(removeLibraryRoot(database, 'films', FIRST)).toEqual({ ok: true, paths: [SECOND] });
    expect(libraryPathColumn('films')).toBe(SECOND);
  });

  it('reports a library it has never heard of', () => {
    expect(addLibraryRoot(database, 'missing', FIRST)).toMatchObject({
      ok: false,
      reason: 'library-not-found'
    });
  });

  it('attributes a file to the deepest folder that contains it', () => {
    expect(rootForPath([FIRST, SECOND], path.join(SECOND, 'Film.mkv'))).toBe(SECOND);
    // A nested root describes its own files rather than deferring to its parent.
    expect(rootForPath([FIRST, NESTED], path.join(NESTED, 'Film.mkv'))).toBe(NESTED);
    expect(rootForPath([FIRST, SECOND], path.resolve('/elsewhere/Film.mkv'))).toBeNull();
  });
});

describe('scanning a library that spans several folders', () => {
  const suffix = crypto.randomUUID();
  const libraryId = `multi-root-${suffix}`;
  const temporaryPrefix = path.join(os.tmpdir(), 'caster-multi-root-');
  let firstRoot = '';
  let secondRoot = '';

  beforeAll(() => {
    initDatabase();
    // "a" and "b" keep the two folders in a predictable order once sorted.
    firstRoot = fs.mkdtempSync(`${temporaryPrefix}a-`);
    secondRoot = fs.mkdtempSync(`${temporaryPrefix}b-`);
    LibraryModel.create({
      id: libraryId,
      name: 'Split Movies',
      path: firstRoot,
      paths: [firstRoot, secondRoot],
      type: 'movies',
      created_at: new Date().toISOString()
    });
  });

  afterAll(() => {
    LibraryModel.delete(libraryId);
    for (const root of [firstRoot, secondRoot]) {
      if (root.startsWith(temporaryPrefix)) fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it('indexes every folder into the one library', async () => {
    fs.writeFileSync(path.join(firstRoot, 'Alpha (2019).mkv'), Buffer.alloc(2048, 7));
    fs.mkdirSync(path.join(secondRoot, 'Beta'), { recursive: true });
    fs.writeFileSync(path.join(secondRoot, 'Beta', 'Beta (2021).mkv'), Buffer.alloc(2048, 9));

    await scanLibrary(libraryId);

    expect(db.query(`
      SELECT full_path, relative_path FROM media_items
      WHERE library_id = ? ORDER BY full_path
    `).all(libraryId)).toEqual([
      {
        full_path: path.join(firstRoot, 'Alpha (2019).mkv'),
        relative_path: 'Alpha (2019).mkv'
      },
      {
        // Relative to the folder it was found under, not to the library's first.
        full_path: path.join(secondRoot, 'Beta', 'Beta (2021).mkv'),
        relative_path: path.join('Beta', 'Beta (2021).mkv')
      }
    ]);
  });

  it('keeps the other folders media when one folder is removed', () => {
    // Continues from the scan above.
    expect(LibraryModel.removePath(libraryId, secondRoot)).toEqual({ ok: true, paths: [firstRoot] });

    expect(db.query(`
      SELECT full_path FROM media_items WHERE library_id = ?
    `).all(libraryId)).toEqual([{ full_path: path.join(firstRoot, 'Alpha (2019).mkv') }]);
    expect(LibraryModel.getById(libraryId)?.paths).toEqual([firstRoot]);
  });
});
