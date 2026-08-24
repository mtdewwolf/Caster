import type { Database } from 'bun:sqlite';
import { ADMIN_USER_ID } from '../../auth';

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
