import { describe, expect, it } from 'bun:test';
import { Database } from 'bun:sqlite';
import { initDatabase } from '../apps/server/src/db';
import {
  DATABASE_MIGRATIONS,
  runDatabaseMigrations,
  type DatabaseMigration
} from '../apps/server/src/db/migrations';

function createOriginalCasterSchema(database: Database): void {
  database.run(`
    CREATE TABLE libraries (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      path TEXT NOT NULL,
      type TEXT NOT NULL,
      last_scanned_at TEXT,
      created_at TEXT NOT NULL
    )
  `);
  database.run(`
    CREATE TABLE media_items (
      id TEXT PRIMARY KEY,
      library_id TEXT NOT NULL REFERENCES libraries(id) ON DELETE CASCADE,
      title TEXT NOT NULL,
      original_filename TEXT NOT NULL,
      relative_path TEXT NOT NULL,
      full_path TEXT NOT NULL UNIQUE,
      type TEXT NOT NULL,
      series_title TEXT,
      season_number INTEGER,
      episode_number INTEGER,
      year INTEGER,
      duration REAL DEFAULT 0,
      size_bytes INTEGER DEFAULT 0,
      format TEXT,
      video_codec TEXT,
      width INTEGER,
      height INTEGER,
      resolution_label TEXT,
      frame_rate REAL,
      bit_rate INTEGER,
      is_hdr INTEGER DEFAULT 0,
      audio_codec TEXT,
      audio_channels INTEGER,
      audio_channel_layout TEXT,
      audio_language TEXT,
      streams_json TEXT,
      poster_path TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    )
  `);
  database.run(`
    CREATE TABLE watch_progress (
      id TEXT PRIMARY KEY,
      media_id TEXT UNIQUE NOT NULL REFERENCES media_items(id) ON DELETE CASCADE,
      position_seconds REAL NOT NULL DEFAULT 0,
      duration_seconds REAL NOT NULL DEFAULT 0,
      progress_percent REAL NOT NULL DEFAULT 0,
      completed INTEGER NOT NULL DEFAULT 0,
      last_watched_at TEXT NOT NULL
    )
  `);
  database.run(`
    CREATE INDEX idx_progress_last_watched
      ON watch_progress(last_watched_at DESC)
  `);
  database.run(`
    CREATE TABLE settings (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL
    )
  `);
}

function seedLibraryAndMedia(database: Database): void {
  database.run(`
    INSERT INTO libraries (id, name, path, type, created_at)
    VALUES ('library-1', 'Movies', '/media/movies', 'movies', '2025-01-01T00:00:00.000Z')
  `);
  database.run(`
    INSERT INTO media_items (
      id, library_id, title, original_filename, relative_path, full_path,
      type, created_at, updated_at
    ) VALUES (
      'media-1', 'library-1', 'Migration Test', 'migration-test.mkv',
      'migration-test.mkv', '/media/movies/migration-test.mkv', 'movie',
      '2025-01-01T00:00:00.000Z', '2025-01-01T00:00:00.000Z'
    )
  `);
}

describe('database migrations', () => {
  it('creates a current schema on a clean install and remains idempotent', () => {
    const database = new Database(':memory:');
    try {
      initDatabase(database);
      seedLibraryAndMedia(database);
      database.run(`
        INSERT INTO watch_progress (
          id, user_id, media_id, position_seconds, duration_seconds,
          progress_percent, completed, last_watched_at
        ) VALUES (
          'progress-1', 'viewer-1', 'media-1', 30, 120, 25, 0,
          '2025-01-01T00:00:00.000Z'
        )
      `);

      initDatabase(database);

      const migrations = database.query(`
        SELECT version, name FROM schema_migrations ORDER BY version
      `).all();
      const progress = database.query(`
        SELECT user_id, media_id, position_seconds FROM watch_progress
      `).get();
      const mediaColumns = database.query('PRAGMA table_info(media_items)').all() as Array<{ name: string }>;
      const fingerprintIndex = database.query(`
        SELECT name FROM sqlite_master
        WHERE type = 'index' AND name = 'idx_media_content_fingerprint'
      `).get();
      const requiredTables = database.query(`
        SELECT name FROM sqlite_master
        WHERE type = 'table'
          AND name IN (
            'libraries', 'media_items', 'external_subtitles',
            'watch_progress', 'settings', 'schema_migrations', 'auth_sessions',
            'users', 'user_credentials', 'user_library_access', 'user_permissions',
            'server_setup', 'account_invites', 'playlists', 'playlist_items',
            'media_markers', 'library_scan_discoveries', 'devices', 'pairing_codes'
          )
        ORDER BY name
      `).all() as Array<{ name: string }>;

      expect(migrations).toEqual([
        { version: 1, name: 'initial_schema' },
        { version: 2, name: 'external_subtitles' },
        { version: 3, name: 'watch_progress_users' },
        { version: 4, name: 'persistent_auth_sessions' },
        { version: 5, name: 'multi_user_accounts' },
        { version: 6, name: 'user_library_permissions' },
        { version: 7, name: 'media_content_ratings' },
        { version: 8, name: 'music_track_metadata' },
        { version: 9, name: 'user_playlists' },
        { version: 10, name: 'media_markers' },
        { version: 11, name: 'stable_media_fingerprints' },
        { version: 12, name: 'account_provisioning' },
        { version: 13, name: 'provisioning_owner_delete_action' },
        { version: 14, name: 'device_identity_and_pairing' },
        { version: 15, name: 'scan_discovery_generations' }
      ]);
      expect(requiredTables.map((row) => row.name)).toEqual([
        'account_invites',
        'auth_sessions',
        'devices',
        'external_subtitles',
        'libraries',
        'library_scan_discoveries',
        'media_items',
        'media_markers',
        'pairing_codes',
        'playlist_items',
        'playlists',
        'schema_migrations',
        'server_setup',
        'settings',
        'user_credentials',
        'user_library_access',
        'user_permissions',
        'users',
        'watch_progress'
      ]);
      expect(progress).toEqual({
        user_id: 'viewer-1',
        media_id: 'media-1',
        position_seconds: 30
      });
      expect(mediaColumns.map((column) => column.name)).toContain('content_fingerprint');
      expect(fingerprintIndex).toEqual({ name: 'idx_media_content_fingerprint' });
      expect(database.query('PRAGMA foreign_keys').get()).toEqual({ foreign_keys: 1 });
      expect(database.query('PRAGMA foreign_key_check').all()).toEqual([]);
    } finally {
      database.close();
    }
  });

  it('adopts an unversioned legacy schema and preserves progress for the admin user', () => {
    const database = new Database(':memory:');
    try {
      database.run('PRAGMA foreign_keys = ON');
      createOriginalCasterSchema(database);
      seedLibraryAndMedia(database);
      database.run(`
        INSERT INTO watch_progress (
          id, media_id, position_seconds, duration_seconds,
          progress_percent, completed, last_watched_at
        ) VALUES (
          'legacy-progress', 'media-1', 45, 180, 25, 0,
          '2025-01-01T00:00:00.000Z'
        )
      `);

      initDatabase(database);
      initDatabase(database);

      const columns = database.query('PRAGMA table_info(watch_progress)').all() as Array<{ name: string }>;
      const migrated = database.query(`
        SELECT id, user_id, media_id, position_seconds FROM watch_progress
      `).get();
      const oldIndex = database.query(`
        SELECT name FROM sqlite_master
        WHERE type = 'index' AND name = 'idx_progress_last_watched'
      `).get();
      const newIndex = database.query(`
        SELECT name FROM sqlite_master
        WHERE type = 'index' AND name = 'idx_progress_user_last_watched'
      `).get();

      database.run(`
        INSERT INTO watch_progress (
          id, user_id, media_id, position_seconds, duration_seconds,
          progress_percent, completed, last_watched_at
        ) VALUES (
          'second-progress', 'viewer-2', 'media-1', 90, 180, 50, 0,
          '2025-01-02T00:00:00.000Z'
        )
      `);

      expect(columns.map((column) => column.name)).toContain('user_id');
      expect(migrated).toEqual({
        id: 'legacy-progress',
        user_id: 'admin',
        media_id: 'media-1',
        position_seconds: 45
      });
      expect(oldIndex).toBeNull();
      expect(newIndex).toEqual({ name: 'idx_progress_user_last_watched' });
      expect(database.query('SELECT COUNT(*) AS count FROM watch_progress').get()).toEqual({ count: 2 });
      expect(database.query('SELECT COUNT(*) AS count FROM schema_migrations').get()).toEqual({ count: 15 });
      expect(database.query(`
        SELECT id, username, role, active FROM users WHERE id = 'admin'
      `).get()).toEqual({ id: 'admin', username: 'admin', role: 'admin', active: 1 });
      expect(database.query('PRAGMA foreign_key_check').all()).toEqual([]);
    } finally {
      database.close();
    }
  });

  it('preserves legacy admin sessions while adding account foreign keys', () => {
    const database = new Database(':memory:');
    try {
      database.run('PRAGMA foreign_keys = ON');
      runDatabaseMigrations(database, DATABASE_MIGRATIONS.slice(0, 4));
      database.run(`
        INSERT INTO auth_sessions (
          token_hash, user_id, created_at, expires_at, last_used_at
        ) VALUES (?, 'admin', 1000, 9999999999999, 1000)
      `, ['a'.repeat(64)]);

      runDatabaseMigrations(database);

      expect(database.query(`
        SELECT token_hash, user_id FROM auth_sessions
      `).get()).toEqual({ token_hash: 'a'.repeat(64), user_id: 'admin' });
      const foreignKeys = database.query('PRAGMA foreign_key_list(auth_sessions)').all() as Array<{
        table: string;
        from: string;
        to: string;
        on_delete: string;
      }>;
      expect(foreignKeys).toContainEqual(expect.objectContaining({
        table: 'users',
        from: 'user_id',
        to: 'id',
        on_delete: 'CASCADE'
      }));
      expect(database.query('PRAGMA foreign_key_check').all()).toEqual([]);
    } finally {
      database.close();
    }
  });

  it('rolls back data and schema changes when a migration fails', () => {
    const database = new Database(':memory:');
    const migrations: readonly DatabaseMigration[] = [
      {
        version: 1,
        name: 'seed_critical_data',
        up: (migrationDatabase) => {
          migrationDatabase.run('CREATE TABLE critical_records (id INTEGER PRIMARY KEY, value TEXT NOT NULL)');
          migrationDatabase.run("INSERT INTO critical_records (id, value) VALUES (1, 'original')");
        }
      },
      {
        version: 2,
        name: 'intentional_failure',
        up: (migrationDatabase) => {
          migrationDatabase.run("UPDATE critical_records SET value = 'changed' WHERE id = 1");
          migrationDatabase.run('CREATE TABLE partial_state (id INTEGER PRIMARY KEY)');
          migrationDatabase.run('DROP TABLE critical_records');
          throw new Error('intentional migration failure');
        }
      }
    ];

    try {
      expect(() => runDatabaseMigrations(database, migrations)).toThrow('intentional migration failure');
      expect(database.query('SELECT * FROM critical_records').get()).toEqual({ id: 1, value: 'original' });
      expect(database.query(`
        SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'partial_state'
      `).get()).toBeNull();
      expect(database.query('SELECT version, name FROM schema_migrations').all()).toEqual([
        { version: 1, name: 'seed_critical_data' }
      ]);

      expect(() => runDatabaseMigrations(database, migrations)).toThrow('intentional migration failure');
      expect(database.query('SELECT * FROM critical_records').get()).toEqual({ id: 1, value: 'original' });
    } finally {
      database.close();
    }
  });
});
