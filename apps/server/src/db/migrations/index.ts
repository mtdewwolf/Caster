import type { Database } from 'bun:sqlite';
import { ADMIN_USER_ID } from '../../identity';

export interface DatabaseMigration {
  version: number;
  name: string;
  up: (database: Database) => void;
}

interface AppliedMigration {
  version: number;
  name: string;
}

function runInImmediateTransaction(database: Database, operation: () => void): void {
  database.run('BEGIN IMMEDIATE');
  let transactionOpen = true;

  try {
    operation();
    database.run('COMMIT');
    transactionOpen = false;
  } catch (error) {
    if (transactionOpen) {
      try {
        database.run('ROLLBACK');
      } catch {
        // Preserve the migration error if SQLite already ended the transaction.
      }
    }
    throw error;
  }
}

function createInitialSchema(database: Database): void {
  database.run(`
    CREATE TABLE IF NOT EXISTS libraries (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      path TEXT NOT NULL,
      type TEXT NOT NULL,
      last_scanned_at TEXT,
      created_at TEXT NOT NULL
    );
  `);

  database.run(`
    CREATE TABLE IF NOT EXISTS media_items (
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
    );
  `);

  database.run('CREATE INDEX IF NOT EXISTS idx_media_library ON media_items(library_id)');
  database.run('CREATE INDEX IF NOT EXISTS idx_media_type ON media_items(type)');
  database.run('CREATE INDEX IF NOT EXISTS idx_media_title ON media_items(title)');
  database.run(`
    CREATE INDEX IF NOT EXISTS idx_media_series
      ON media_items(series_title, season_number, episode_number)
  `);

  // Version 1 mirrors Caster's original on-disk schema. A later migration
  // intentionally upgrades this table so fresh and historical databases take
  // the same tested path to the current schema.
  database.run(`
    CREATE TABLE IF NOT EXISTS watch_progress (
      id TEXT PRIMARY KEY,
      media_id TEXT UNIQUE NOT NULL REFERENCES media_items(id) ON DELETE CASCADE,
      position_seconds REAL NOT NULL DEFAULT 0,
      duration_seconds REAL NOT NULL DEFAULT 0,
      progress_percent REAL NOT NULL DEFAULT 0,
      completed INTEGER NOT NULL DEFAULT 0,
      last_watched_at TEXT NOT NULL
    );
  `);

  database.run(`
    CREATE INDEX IF NOT EXISTS idx_progress_last_watched
      ON watch_progress(last_watched_at DESC)
  `);

  database.run(`
    CREATE TABLE IF NOT EXISTS settings (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL
    );
  `);
}

function createExternalSubtitlesSchema(database: Database): void {
  database.run(`
    CREATE TABLE IF NOT EXISTS external_subtitles (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      media_id TEXT NOT NULL REFERENCES media_items(id) ON DELETE CASCADE,
      stream_index INTEGER NOT NULL,
      file_path TEXT NOT NULL,
      language TEXT,
      UNIQUE(media_id, stream_index)
    );
  `);

  database.run(`
    CREATE INDEX IF NOT EXISTS idx_external_subtitles_media
      ON external_subtitles(media_id)
  `);
}

export function upgradeWatchProgressToUsersSchema(database: Database): void {
  const columns = database.query('PRAGMA table_info(watch_progress)').all() as Array<{ name: string }>;
  if (columns.length === 0) {
    throw new Error('Cannot migrate watch_progress because the table does not exist');
  }

  if (!columns.some((column) => column.name === 'user_id')) {
    database.run(`
      CREATE TABLE watch_progress_with_users (
        id TEXT PRIMARY KEY,
        user_id TEXT NOT NULL,
        media_id TEXT NOT NULL REFERENCES media_items(id) ON DELETE CASCADE,
        position_seconds REAL NOT NULL DEFAULT 0,
        duration_seconds REAL NOT NULL DEFAULT 0,
        progress_percent REAL NOT NULL DEFAULT 0,
        completed INTEGER NOT NULL DEFAULT 0,
        last_watched_at TEXT NOT NULL,
        UNIQUE(user_id, media_id)
      );
    `);
    database.run(`
      INSERT INTO watch_progress_with_users (
        id, user_id, media_id, position_seconds, duration_seconds,
        progress_percent, completed, last_watched_at
      )
      SELECT id, ?, media_id, position_seconds, duration_seconds,
             progress_percent, completed, last_watched_at
      FROM watch_progress
    `, [ADMIN_USER_ID]);
    database.run('DROP TABLE watch_progress');
    database.run('ALTER TABLE watch_progress_with_users RENAME TO watch_progress');
  }

  database.run('DROP INDEX IF EXISTS idx_progress_last_watched');
  database.run(`
    CREATE INDEX IF NOT EXISTS idx_progress_user_last_watched
      ON watch_progress(user_id, last_watched_at DESC)
  `);
}

function createAuthSessionsSchema(database: Database): void {
  database.run(`
    CREATE TABLE IF NOT EXISTS auth_sessions (
      token_hash TEXT PRIMARY KEY CHECK(length(token_hash) = 64),
      user_id TEXT NOT NULL,
      created_at INTEGER NOT NULL,
      expires_at INTEGER NOT NULL,
      last_used_at INTEGER NOT NULL
    )
  `);
  database.run(`
    CREATE INDEX IF NOT EXISTS idx_auth_sessions_expires_at
      ON auth_sessions(expires_at)
  `);
}

function createUsersSchema(database: Database): void {
  database.run(`
    CREATE TABLE users (
      id TEXT PRIMARY KEY,
      username TEXT NOT NULL COLLATE NOCASE UNIQUE
        CHECK(length(trim(username)) BETWEEN 1 AND 64),
      role TEXT NOT NULL CHECK(role IN ('admin', 'viewer')),
      active INTEGER NOT NULL DEFAULT 1 CHECK(active IN (0, 1)),
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    )
  `);

  const now = new Date().toISOString();
  database.run(`
    INSERT INTO users (id, username, role, active, created_at, updated_at)
    VALUES (?, 'admin', 'admin', 1, ?, ?)
  `, [ADMIN_USER_ID, now, now]);

  database.run(`
    CREATE TABLE user_credentials (
      user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      type TEXT NOT NULL CHECK(type IN ('password', 'api_token')),
      secret_hash TEXT NOT NULL CHECK(length(secret_hash) > 32),
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      PRIMARY KEY(user_id, type)
    )
  `);

  // Migration 4 predates users. Rebuild its table so all future sessions are
  // tied to an account and are removed with it, while preserving valid legacy
  // admin sessions during the upgrade.
  database.run('ALTER TABLE auth_sessions RENAME TO auth_sessions_without_users');
  database.run(`
    CREATE TABLE auth_sessions (
      token_hash TEXT PRIMARY KEY CHECK(length(token_hash) = 64),
      user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      created_at INTEGER NOT NULL,
      expires_at INTEGER NOT NULL,
      last_used_at INTEGER NOT NULL
    )
  `);
  database.run(`
    INSERT INTO auth_sessions (token_hash, user_id, created_at, expires_at, last_used_at)
    SELECT token_hash, user_id, created_at, expires_at, last_used_at
    FROM auth_sessions_without_users
    WHERE user_id = ?
  `, [ADMIN_USER_ID]);
  database.run('DROP TABLE auth_sessions_without_users');
  database.run(`
    CREATE INDEX idx_auth_sessions_expires_at ON auth_sessions(expires_at)
  `);
  database.run(`
    CREATE INDEX idx_auth_sessions_user_id ON auth_sessions(user_id)
  `);
}

function createUserLibraryPermissionsSchema(database: Database): void {
  database.run(`
    CREATE TABLE user_library_access (
      user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      library_id TEXT NOT NULL REFERENCES libraries(id) ON DELETE CASCADE,
      created_at TEXT NOT NULL,
      PRIMARY KEY(user_id, library_id)
    )
  `);
  database.run(`
    CREATE INDEX idx_user_library_access_library
      ON user_library_access(library_id, user_id)
  `);
  database.run(`
    CREATE TABLE user_permissions (
      user_id TEXT PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
      max_content_rating TEXT,
      allow_unrated INTEGER NOT NULL DEFAULT 1 CHECK(allow_unrated IN (0, 1)),
      can_download INTEGER NOT NULL DEFAULT 0 CHECK(can_download IN (0, 1)),
      can_stream_remote INTEGER NOT NULL DEFAULT 1 CHECK(can_stream_remote IN (0, 1)),
      can_delete_media INTEGER NOT NULL DEFAULT 0 CHECK(can_delete_media IN (0, 1)),
      can_manage_profiles INTEGER NOT NULL DEFAULT 0 CHECK(can_manage_profiles IN (0, 1)),
      profile_pin_hash TEXT,
      updated_at TEXT NOT NULL
    )
  `);
}

function addMediaContentRatings(database: Database): void {
  database.run('ALTER TABLE media_items ADD COLUMN content_rating TEXT');
  database.run('ALTER TABLE media_items ADD COLUMN content_rating_level INTEGER');
  database.run(`
    CREATE INDEX idx_media_content_rating_level
      ON media_items(content_rating_level)
  `);
}

function createAccountProvisioningSchema(database: Database): void {
  database.run(`
    CREATE TABLE server_setup (
      singleton INTEGER PRIMARY KEY CHECK(singleton = 1),
      owner_user_id TEXT REFERENCES users(id) ON DELETE SET NULL,
      completed_at TEXT
    )
  `);
  database.run(`
    INSERT INTO server_setup (singleton, owner_user_id, completed_at)
    SELECT 1, users.id, ?
    FROM users
    WHERE users.role = 'admin'
      AND EXISTS (
        SELECT 1 FROM user_credentials WHERE user_credentials.user_id = users.id
      )
    ORDER BY CASE WHEN users.id = ? THEN 0 ELSE 1 END, users.created_at
    LIMIT 1
  `, [new Date().toISOString(), ADMIN_USER_ID]);
  database.run(`
    INSERT OR IGNORE INTO server_setup (singleton, owner_user_id, completed_at)
    VALUES (1, NULL, NULL)
  `);

  database.run(`
    CREATE TABLE account_invites (
      id TEXT PRIMARY KEY,
      token_hash TEXT NOT NULL UNIQUE CHECK(length(token_hash) = 64),
      role TEXT NOT NULL CHECK(role IN ('admin', 'viewer')),
      created_by TEXT NOT NULL REFERENCES users(id),
      created_at INTEGER NOT NULL,
      expires_at INTEGER NOT NULL,
      accepted_at INTEGER,
      accepted_user_id TEXT REFERENCES users(id),
      revoked_at INTEGER,
      CHECK(expires_at > created_at),
      CHECK(accepted_at IS NULL OR revoked_at IS NULL)
    )
  `);
  database.run(`
    CREATE INDEX idx_account_invites_expires_at
      ON account_invites(expires_at)
  `);
  database.run(`
    CREATE INDEX idx_account_invites_created_by
      ON account_invites(created_by, created_at DESC)
  `);
}

function allowProvisioningOwnerCleanup(database: Database): void {
  database.run('ALTER TABLE server_setup RENAME TO server_setup_without_delete_action');
  database.run(`
    CREATE TABLE server_setup (
      singleton INTEGER PRIMARY KEY CHECK(singleton = 1),
      owner_user_id TEXT REFERENCES users(id) ON DELETE SET NULL,
      completed_at TEXT
    )
  `);
  database.run(`
    INSERT INTO server_setup (singleton, owner_user_id, completed_at)
    SELECT singleton, owner_user_id, completed_at
    FROM server_setup_without_delete_action
  `);
  database.run('DROP TABLE server_setup_without_delete_action');
}

function addMusicTrackMetadata(database: Database): void {
  database.run('ALTER TABLE media_items ADD COLUMN artist TEXT');
  database.run('ALTER TABLE media_items ADD COLUMN album_artist TEXT');
  database.run('ALTER TABLE media_items ADD COLUMN album TEXT');
  database.run('ALTER TABLE media_items ADD COLUMN track_number INTEGER');
  database.run('ALTER TABLE media_items ADD COLUMN disc_number INTEGER');
  database.run('ALTER TABLE media_items ADD COLUMN genre TEXT');
  database.run(`
    CREATE INDEX idx_media_music_album
      ON media_items(library_id, album_artist COLLATE NOCASE, album COLLATE NOCASE, year)
  `);
  database.run(`
    CREATE INDEX idx_media_music_order
      ON media_items(
        library_id,
        album_artist COLLATE NOCASE,
        album COLLATE NOCASE,
        disc_number,
        track_number
      )
  `);
}

function createUserPlaylists(database: Database): void {
  database.run(`
    CREATE TABLE playlists (
      id TEXT PRIMARY KEY,
      user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      name TEXT NOT NULL COLLATE NOCASE
        CHECK(length(trim(name)) BETWEEN 1 AND 120),
      revision INTEGER NOT NULL DEFAULT 1,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      UNIQUE(user_id, name)
    )
  `);
  database.run(`
    CREATE TABLE playlist_items (
      id TEXT PRIMARY KEY,
      playlist_id TEXT NOT NULL REFERENCES playlists(id) ON DELETE CASCADE,
      media_id TEXT NOT NULL REFERENCES media_items(id) ON DELETE CASCADE,
      position INTEGER NOT NULL CHECK(position >= 0),
      added_at TEXT NOT NULL
    )
  `);
  database.run(`
    CREATE INDEX idx_playlists_user
      ON playlists(user_id, updated_at DESC)
  `);
  database.run(`
    CREATE INDEX idx_playlist_items_order
      ON playlist_items(playlist_id, position, id)
  `);
}

function createMediaMarkers(database: Database): void {
  database.run(`
    CREATE TABLE media_markers (
      id TEXT PRIMARY KEY,
      media_id TEXT NOT NULL REFERENCES media_items(id) ON DELETE CASCADE,
      marker_type TEXT NOT NULL CHECK(marker_type IN ('intro', 'credits')),
      start_seconds REAL,
      end_seconds REAL,
      state TEXT NOT NULL DEFAULT 'active' CHECK(state IN ('active', 'disabled')),
      source TEXT NOT NULL,
      confidence REAL CHECK(confidence IS NULL OR confidence BETWEEN 0 AND 1),
      analyzer_version TEXT,
      revision INTEGER NOT NULL DEFAULT 1,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      CHECK(
        state = 'disabled'
        OR (
          start_seconds IS NOT NULL AND start_seconds >= 0
          AND end_seconds IS NOT NULL AND end_seconds > start_seconds
        )
      ),
      UNIQUE(media_id, marker_type)
    )
  `);
  database.run(`
    CREATE INDEX idx_media_markers_active_range
      ON media_markers(media_id, state, start_seconds)
  `);
}

function addStableMediaFingerprints(database: Database): void {
  database.run('ALTER TABLE media_items ADD COLUMN content_fingerprint TEXT');
  database.run(`
    CREATE INDEX idx_media_content_fingerprint
      ON media_items(library_id, content_fingerprint)
      WHERE content_fingerprint IS NOT NULL
  `);
}

export const DATABASE_MIGRATIONS: readonly DatabaseMigration[] = [
  {
    version: 1,
    name: 'initial_schema',
    up: createInitialSchema
  },
  {
    version: 2,
    name: 'external_subtitles',
    up: createExternalSubtitlesSchema
  },
  {
    version: 3,
    name: 'watch_progress_users',
    up: upgradeWatchProgressToUsersSchema
  },
  {
    version: 4,
    name: 'persistent_auth_sessions',
    up: createAuthSessionsSchema
  },
  {
    version: 5,
    name: 'multi_user_accounts',
    up: createUsersSchema
  },
  {
    version: 6,
    name: 'user_library_permissions',
    up: createUserLibraryPermissionsSchema
  },
  {
    version: 7,
    name: 'media_content_ratings',
    up: addMediaContentRatings
  },
  {
    version: 8,
    name: 'music_track_metadata',
    up: addMusicTrackMetadata
  },
  {
    version: 9,
    name: 'user_playlists',
    up: createUserPlaylists
  },
  {
    version: 10,
    name: 'media_markers',
    up: createMediaMarkers
  },
  {
    version: 11,
    name: 'stable_media_fingerprints',
    up: addStableMediaFingerprints
  },
  {
    version: 12,
    name: 'account_provisioning',
    up: createAccountProvisioningSchema
  },
  {
    version: 13,
    name: 'provisioning_owner_delete_action',
    up: allowProvisioningOwnerCleanup
  }
];

function validateMigrations(migrations: readonly DatabaseMigration[]): void {
  let previousVersion = 0;
  for (const migration of migrations) {
    if (!Number.isInteger(migration.version) || migration.version <= previousVersion) {
      throw new Error('Database migrations must have unique, positive, ascending versions');
    }
    if (!migration.name.trim()) {
      throw new Error(`Database migration ${migration.version} must have a name`);
    }
    previousVersion = migration.version;
  }
}

export function runDatabaseMigrations(
  database: Database,
  migrations: readonly DatabaseMigration[] = DATABASE_MIGRATIONS
): void {
  validateMigrations(migrations);
  database.run(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      version INTEGER PRIMARY KEY,
      name TEXT NOT NULL,
      applied_at TEXT NOT NULL
    )
  `);

  const appliedRows = database.query(`
    SELECT version, name FROM schema_migrations ORDER BY version
  `).all() as AppliedMigration[];
  const appliedByVersion = new Map(appliedRows.map((migration) => [migration.version, migration.name]));

  for (const migration of migrations) {
    const appliedName = appliedByVersion.get(migration.version);
    if (appliedName !== undefined) {
      if (appliedName !== migration.name) {
        throw new Error(
          `Database migration ${migration.version} is recorded as "${appliedName}", expected "${migration.name}"`
        );
      }
      continue;
    }

    runInImmediateTransaction(database, () => {
      // Another server process may have completed this migration while this
      // process waited for SQLite's write lock. Re-check under the lock so
      // concurrent startup stays idempotent.
      const concurrentlyApplied = database.query(`
        SELECT name FROM schema_migrations WHERE version = ?
      `).get(migration.version) as { name: string } | null;
      if (concurrentlyApplied) {
        if (concurrentlyApplied.name !== migration.name) {
          throw new Error(
            `Database migration ${migration.version} is recorded as "${concurrentlyApplied.name}", expected "${migration.name}"`
          );
        }
        return;
      }

      migration.up(database);
      database.run(`
        INSERT INTO schema_migrations (version, name, applied_at)
        VALUES (?, ?, ?)
      `, [migration.version, migration.name, new Date().toISOString()]);
    });
    appliedByVersion.set(migration.version, migration.name);
  }
}

export function migrateLegacyWatchProgressToUsers(database: Database): void {
  const columns = database.query('PRAGMA table_info(watch_progress)').all() as Array<{ name: string }>;
  if (columns.length === 0 || columns.some((column) => column.name === 'user_id')) return;

  runInImmediateTransaction(database, () => {
    upgradeWatchProgressToUsersSchema(database);
  });
}
