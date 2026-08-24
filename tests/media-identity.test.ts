import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import { Database } from 'bun:sqlite';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { MediaIdentityStore } from '../apps/server/src/db/media-identity-store';
import { runDatabaseMigrations } from '../apps/server/src/db/migrations';
import { contentFingerprint } from '../apps/server/src/scanner/content-fingerprint';

describe('stable media identity', () => {
  let temporaryRoot = '';

  afterEach(() => {
    const expectedPrefix = path.join(os.tmpdir(), 'caster-identity-');
    if (temporaryRoot.startsWith(expectedPrefix)) {
      fs.rmSync(temporaryRoot, { recursive: true, force: true });
    }
  });

  it('computes the same bounded fingerprint after a rename and changes it with sampled content', () => {
    temporaryRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'caster-identity-'));
    const original = path.join(temporaryRoot, 'original.bin');
    const renamed = path.join(temporaryRoot, 'renamed.bin');
    const bytes = Buffer.alloc(256 * 1024, 7);
    fs.writeFileSync(original, bytes);
    const before = contentFingerprint(original);

    fs.renameSync(original, renamed);
    expect(contentFingerprint(renamed)).toBe(before);

    bytes[0] = 8;
    fs.writeFileSync(renamed, bytes);
    expect(contentFingerprint(renamed)).not.toBe(before);
  });
});

describe('media identity reconciliation', () => {
  let database: Database;
  const now = '2026-08-24T00:00:00.000Z';

  beforeEach(() => {
    database = new Database(':memory:');
    database.run('PRAGMA foreign_keys = ON');
    runDatabaseMigrations(database);
    database.run(`
      INSERT INTO libraries (id, name, path, type, created_at)
      VALUES ('tv', 'TV', '/media/tv', 'tv', ?)
    `, [now]);
  });

  afterEach(() => database.close());

  function seedMedia(id: string, fullPath: string, fingerprint: string) {
    database.run(`
      INSERT INTO media_items (
        id, library_id, title, original_filename, relative_path, full_path,
        type, content_fingerprint, created_at, updated_at
      ) VALUES (?, 'tv', 'Episode', ?, ?, ?, 'episode', ?, ?, ?)
    `, [id, path.basename(fullPath), path.basename(fullPath), fullPath, fingerprint, now, now]);
  }

  it('reuses one missing fingerprint match and preserves every dependent record', () => {
    seedMedia('stable-id', '/media/tv/old/S01E01.mkv', 'sampled-sha256-v1:abc');
    database.run(`
      INSERT INTO watch_progress (
        id, user_id, media_id, position_seconds, duration_seconds,
        progress_percent, completed, last_watched_at
      ) VALUES ('progress', 'admin', 'stable-id', 30, 100, 30, 0, ?)
    `, [now]);
    database.run(`
      INSERT INTO media_markers (
        id, media_id, marker_type, start_seconds, end_seconds, state,
        source, created_at, updated_at
      ) VALUES ('marker', 'stable-id', 'intro', 0, 20, 'active', 'manual', ?, ?)
    `, [now, now]);
    database.run(`
      INSERT INTO playlists (id, user_id, name, created_at, updated_at)
      VALUES ('playlist', 'admin', 'TV Theme', ?, ?)
    `, [now, now]);
    database.run(`
      INSERT INTO playlist_items (id, playlist_id, media_id, position, added_at)
      VALUES ('playlist-item', 'playlist', 'stable-id', 0, ?)
    `, [now]);

    const identities = new MediaIdentityStore(database, () => false);
    const resolved = identities.resolve({
      libraryId: 'tv',
      fullPath: '/media/tv/new/Renamed.S01E01.mkv',
      relativePath: 'new/Renamed.S01E01.mkv',
      originalFilename: 'Renamed.S01E01.mkv',
      contentFingerprint: 'sampled-sha256-v1:abc',
      newId: 'new-id'
    });

    expect(resolved).toEqual({ id: 'stable-id', kind: 'reconciled' });
    expect(database.query(`
      SELECT id, full_path, relative_path FROM media_items WHERE id = 'stable-id'
    `).get()).toEqual({
      id: 'stable-id',
      full_path: '/media/tv/new/Renamed.S01E01.mkv',
      relative_path: 'new/Renamed.S01E01.mkv'
    });
    expect(database.query("SELECT media_id FROM watch_progress WHERE id = 'progress'").get())
      .toEqual({ media_id: 'stable-id' });
    expect(database.query("SELECT media_id FROM media_markers WHERE id = 'marker'").get())
      .toEqual({ media_id: 'stable-id' });
    expect(database.query("SELECT media_id FROM playlist_items WHERE id = 'playlist-item'").get())
      .toEqual({ media_id: 'stable-id' });
  });

  it('does not guess when more than one missing row shares the fingerprint', () => {
    seedMedia('duplicate-a', '/media/tv/old/a.mkv', 'sampled-sha256-v1:same');
    seedMedia('duplicate-b', '/media/tv/old/b.mkv', 'sampled-sha256-v1:same');
    const identities = new MediaIdentityStore(database, () => false);

    expect(identities.resolve({
      libraryId: 'tv',
      fullPath: '/media/tv/new.mkv',
      relativePath: 'new.mkv',
      originalFilename: 'new.mkv',
      contentFingerprint: 'sampled-sha256-v1:same',
      newId: 'new-id'
    })).toEqual({ id: 'new-id', kind: 'new' });
    expect(database.query("SELECT COUNT(*) AS count FROM media_items WHERE full_path LIKE '/media/tv/old/%'").get())
      .toEqual({ count: 2 });
  });

  it('prefers the existing full-path identity before fingerprint matching', () => {
    seedMedia('existing-id', '/media/tv/current.mkv', 'sampled-sha256-v1:old');
    const identities = new MediaIdentityStore(database, () => false);
    expect(identities.resolve({
      libraryId: 'tv',
      fullPath: '/media/tv/current.mkv',
      relativePath: 'current.mkv',
      originalFilename: 'current.mkv',
      contentFingerprint: 'sampled-sha256-v1:new',
      newId: 'new-id'
    })).toEqual({ id: 'existing-id', kind: 'existing' });
  });
});
