import { beforeEach, describe, expect, it } from 'bun:test';
import crypto from 'crypto';
import { db, initDatabase, LibraryModel, MediaModel, ProgressModel } from '../apps/server/src/db';
import { TitleStore } from '../apps/server/src/db/title-store';
import { DATABASE_MIGRATIONS, runDatabaseMigrations } from '../apps/server/src/db/migrations';
import { showIdFor } from '../apps/server/src/db/logical-media';
import { Database } from 'bun:sqlite';

describe('watch progress follows the work, not the file', () => {
  let libraryId: string;
  let userId: string;
  let uhd: string;
  let hd: string;
  let store: TitleStore;

  function addVersion(id: string, height: number, label: string) {
    const now = new Date().toISOString();
    MediaModel.upsert({
      id,
      library_id: libraryId,
      title: 'Dune',
      original_filename: `${id}.mkv`,
      relative_path: `${id}.mkv`,
      full_path: `/tmp/${libraryId}/${id}.mkv`,
      type: 'movie',
      year: 2021,
      duration: 9000,
      size_bytes: 1000,
      format: 'mkv',
      height,
      resolution_label: label,
      is_hdr: false,
      streams_json: '[]',
      created_at: now,
      updated_at: now
    });
    store.linkMedia(id, { libraryId, type: 'movie', title: 'Dune', year: 2021 });
  }

  beforeEach(() => {
    initDatabase();
    store = new TitleStore(db);
    const suffix = crypto.randomUUID();
    libraryId = `ver-lib-${suffix}`;
    userId = `ver-user-${suffix}`;
    uhd = `ver-uhd-${suffix}`;
    hd = `ver-hd-${suffix}`;

    LibraryModel.create({
      id: libraryId, name: 'Versions', path: `/tmp/${libraryId}`,
      type: 'movie', created_at: new Date().toISOString()
    });
    addVersion(uhd, 2160, '4K');
    addVersion(hd, 1080, '1080p');
  });

  it('groups both files under one title', () => {
    expect(store.titleIdForMedia(uhd)).toBe(store.titleIdForMedia(hd));
  });

  it('resumes the other version where you left off', () => {
    ProgressModel.upsert(userId, uhd, 2400, 9000);

    const other = MediaModel.getById(hd, userId)!;
    expect(other.progress?.position_seconds).toBe(2400);
  });

  it('marks the other version watched once one is finished', () => {
    ProgressModel.upsert(userId, uhd, 8900, 9000);
    expect(MediaModel.getById(hd, userId)!.progress?.completed).toBe(true);
  });

  it('prefers the most recent position when both were played', () => {
    ProgressModel.upsert(userId, uhd, 1200, 9000);
    ProgressModel.upsert(userId, hd, 3600, 9000);

    expect(MediaModel.getById(uhd, userId)!.progress?.position_seconds).toBe(3600);
  });

  it('keeps one viewer position out of another account', () => {
    ProgressModel.upsert(userId, uhd, 2400, 9000);
    expect(MediaModel.getById(hd, `${userId}-other`)!.progress).toBeUndefined();
  });

  it('does not leak progress between unrelated films', () => {
    const unrelated = `ver-other-${crypto.randomUUID()}`;
    const now = new Date().toISOString();
    MediaModel.upsert({
      id: unrelated, library_id: libraryId, title: 'Arrival',
      original_filename: 'a.mkv', relative_path: 'a.mkv', full_path: `/tmp/${libraryId}/a.mkv`,
      type: 'movie', year: 2016, duration: 7000, size_bytes: 1000, format: 'mkv',
      is_hdr: false, streams_json: '[]', created_at: now, updated_at: now
    });
    store.linkMedia(unrelated, { libraryId, type: 'movie', title: 'Arrival', year: 2016 });

    ProgressModel.upsert(userId, uhd, 2400, 9000);
    expect(MediaModel.getById(unrelated, userId)!.progress).toBeUndefined();
  });
});

describe('upgrading an existing install', () => {
  function legacyDatabase(): Database {
    const database = new Database(':memory:');
    // Everything before the logical schema, so this is a real upgrade rather
    // than a fresh install that happens to end in the same place.
    const upTo19 = DATABASE_MIGRATIONS.filter((migration) => migration.version <= 19);
    runDatabaseMigrations(database, upTo19);
    return database;
  }

  function seedLegacy(database: Database) {
    const now = '2026-01-01T00:00:00.000Z';
    database.run(
      `INSERT INTO libraries (id, name, path, type, created_at) VALUES ('lib', 'Lib', '/media', 'tv', ?)`,
      [now]
    );
    database.run(
      `INSERT INTO users (id, username, role, active, created_at, updated_at)
       VALUES ('u1', 'u1', 'viewer', 1, ?, ?)`,
      [now, now]
    );

    const media = (id: string, over: Record<string, any>) => {
      const row = {
        title: 'Dune', type: 'movie', year: 2021, series_title: null,
        season_number: null, episode_number: null, streams_json: '[]', ...over
      };
      database.run(`
        INSERT INTO media_items (
          id, library_id, title, original_filename, relative_path, full_path, type,
          series_title, season_number, episode_number, year,
          duration, size_bytes, format, streams_json, created_at, updated_at
        ) VALUES (?, 'lib', ?, ?, ?, ?, ?, ?, ?, ?, ?, 100, 100, 'mkv', ?, ?, ?)
      `, [
        id, row.title, `${id}.mkv`, `${id}.mkv`, `/media/${id}.mkv`, row.type,
        row.series_title, row.season_number, row.episode_number, row.year,
        row.streams_json, now, now
      ]);
    };

    media('uhd', { streams_json: JSON.stringify([
      { index: 0, codec_type: 'video', codec_name: 'hevc' },
      { index: 1, codec_type: 'audio', codec_name: 'truehd', channels: 8 }
    ]) });
    media('hd', {});
    media('ep', { type: 'episode', title: 'Pilot', series_title: 'Example Show', season_number: 1, episode_number: 1 });
    media('song', { type: 'track', title: 'Song' });

    database.run(`
      INSERT INTO watch_progress (
        id, user_id, media_id, position_seconds, duration_seconds, progress_percent, completed, last_watched_at
      ) VALUES ('p1', 'u1', 'uhd', 2400, 9000, 27, 0, ?)
    `, [now]);
  }

  function upgrade(database: Database) {
    runDatabaseMigrations(database, DATABASE_MIGRATIONS);
  }

  it('groups existing files into titles without losing any of them', () => {
    const database = legacyDatabase();
    try {
      seedLegacy(database);
      upgrade(database);

      const rows = database.query('SELECT id, title_id FROM media_items ORDER BY id').all() as any[];
      expect(rows).toHaveLength(4);

      const byId = Object.fromEntries(rows.map((row) => [row.id, row.title_id]));
      expect(byId.uhd).toBe(byId.hd);
      expect(byId.ep).toBeTruthy();
      // Music has no logical title, and inventing one would merge unrelated files.
      expect(byId.song).toBeNull();
    } finally {
      database.close();
    }
  });

  it('creates the show behind existing episodes', () => {
    const database = legacyDatabase();
    try {
      seedLegacy(database);
      upgrade(database);

      const show = database.query('SELECT id, name FROM shows').get() as any;
      expect(show.name).toBe('Example Show');
      expect(show.id).toBe(showIdFor('lib', 'Example Show'));
    } finally {
      database.close();
    }
  });

  it('carries existing watch history onto the new title', () => {
    const database = legacyDatabase();
    try {
      seedLegacy(database);
      upgrade(database);

      const progress = database.query(
        'SELECT position_seconds, title_id FROM watch_progress WHERE id = ?'
      ).get('p1') as any;

      expect(progress.position_seconds).toBe(2400);
      expect(progress.title_id).toBe(
        (database.query('SELECT title_id FROM media_items WHERE id = ?').get('uhd') as any).title_id
      );
    } finally {
      database.close();
    }
  });

  it('normalises the stream blobs it already had', () => {
    const database = legacyDatabase();
    try {
      seedLegacy(database);
      upgrade(database);

      const streams = database.query(
        'SELECT codec_type, codec_name, channels FROM media_streams WHERE media_id = ? ORDER BY stream_index'
      ).all('uhd') as any[];

      expect(streams).toEqual([
        { codec_type: 'video', codec_name: 'hevc', channels: null },
        { codec_type: 'audio', codec_name: 'truehd', channels: 8 }
      ]);
    } finally {
      database.close();
    }
  });

  it('leaves the database referentially sound', () => {
    const database = legacyDatabase();
    try {
      seedLegacy(database);
      upgrade(database);
      expect(database.query('PRAGMA foreign_key_check').all()).toEqual([]);
    } finally {
      database.close();
    }
  });
});
