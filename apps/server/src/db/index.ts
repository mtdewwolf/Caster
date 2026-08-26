import { Database } from 'bun:sqlite';
import path from 'path';
import fs from 'fs';
import crypto from 'crypto';
import type { Library, MediaItem, Series, SeriesSeason, WatchProgress } from '../types';
import type { ContentRatingScope } from '../types';
import { contentRatingLevel, normalizeContentRating } from '../content-ratings';
import {
  migrateLegacyWatchProgressToUsers,
  runDatabaseMigrations
} from './migrations';
import { PUBLIC_USER_ID } from '../identity';

// Ensure data directory exists
const DATA_DIR = process.env.MEDIA_DATA_DIR || path.join(process.cwd(), 'data');
if (!fs.existsSync(DATA_DIR)) {
  fs.mkdirSync(DATA_DIR, { recursive: true });
}

const DB_PATH = path.join(DATA_DIR, 'media.db');
export const db = new Database(DB_PATH);
let mediaFtsEnabled = false;

// Enable WAL mode for high concurrency
db.run('PRAGMA journal_mode = WAL;');
db.run('PRAGMA synchronous = NORMAL;');
db.run('PRAGMA foreign_keys = ON;');

// Initialize and upgrade the schema before models begin serving queries.
export function initDatabase(database: Database = db) {
  database.run('PRAGMA foreign_keys = ON;');
  runDatabaseMigrations(database);

  // FTS5 is bundled with Bun's SQLite build, but keep LIKE search as a fallback
  // for environments that provide SQLite without the extension.
  try {
    const ftsAlreadyExists = !!database.query(`
      SELECT 1 FROM sqlite_master
      WHERE type = 'table' AND name = 'media_items_fts'
    `).get();

    database.run(`
      CREATE VIRTUAL TABLE IF NOT EXISTS media_items_fts USING fts5(
        title,
        series_title,
        content = 'media_items',
        content_rowid = 'rowid',
        tokenize = 'unicode61 remove_diacritics 2'
      );

      CREATE TRIGGER IF NOT EXISTS media_items_fts_insert AFTER INSERT ON media_items BEGIN
        INSERT INTO media_items_fts(rowid, title, series_title)
        VALUES (new.rowid, new.title, new.series_title);
      END;

      CREATE TRIGGER IF NOT EXISTS media_items_fts_delete AFTER DELETE ON media_items BEGIN
        INSERT INTO media_items_fts(media_items_fts, rowid, title, series_title)
        VALUES ('delete', old.rowid, old.title, old.series_title);
      END;

      CREATE TRIGGER IF NOT EXISTS media_items_fts_update AFTER UPDATE ON media_items BEGIN
        INSERT INTO media_items_fts(media_items_fts, rowid, title, series_title)
        VALUES ('delete', old.rowid, old.title, old.series_title);
        INSERT INTO media_items_fts(rowid, title, series_title)
        VALUES (new.rowid, new.title, new.series_title);
      END;
    `);

    if (!ftsAlreadyExists) {
      database.run(`INSERT INTO media_items_fts(media_items_fts) VALUES ('rebuild')`);
    }
    if (database === db) mediaFtsEnabled = true;
  } catch (error) {
    if (database === db) mediaFtsEnabled = false;
    console.warn('SQLite FTS5 unavailable; falling back to LIKE search.', error);
  }
}

export const migrateWatchProgressToUsers = migrateLegacyWatchProgressToUsers;

// ---------------- Helper Queries ---------------- //

export const LibraryModel = {
  getAll: (options: { contentRatingScope?: ContentRatingScope } = {}): Library[] => {
    const params: any[] = [];
    const ratingClause = contentRatingScopeClause('m', options.contentRatingScope, params);
    const rows = db.query(`
      SELECT l.*, COUNT(m.id) as item_count 
      FROM libraries l
      LEFT JOIN media_items m ON l.id = m.library_id AND ${ratingClause}
      GROUP BY l.id
      ORDER BY l.name ASC
    `).all(...params) as (Library & { item_count: number })[];
    return rows;
  },

  getById: (id: string): Library | null => {
    const row = db.query(`
      SELECT l.*, COUNT(m.id) as item_count 
      FROM libraries l
      LEFT JOIN media_items m ON l.id = m.library_id
      WHERE l.id = ?
      GROUP BY l.id
    `).get(id) as (Library & { item_count: number }) | null;
    return row;
  },

  create: (lib: Omit<Library, 'item_count'>) => {
    const stmt = db.prepare(`
      INSERT INTO libraries (id, name, path, type, last_scanned_at, created_at)
      VALUES ($id, $name, $path, $type, $last_scanned_at, $created_at)
    `);
    stmt.run({
      $id: lib.id,
      $name: lib.name,
      $path: lib.path,
      $type: lib.type,
      $last_scanned_at: lib.last_scanned_at || null,
      $created_at: lib.created_at
    });
    return LibraryModel.getById(lib.id);
  },

  updateLastScanned: (id: string) => {
    db.run('UPDATE libraries SET last_scanned_at = ? WHERE id = ?', [new Date().toISOString(), id]);
  },

  delete: (id: string) => {
    db.run('DELETE FROM libraries WHERE id = ?', [id]);
  }
};

export interface ExternalSubtitleRow {
  id: number;
  media_id: string;
  stream_index: number;
  file_path: string;
  language?: string;
}

export const ExternalSubtitleModel = {
  replaceAllForMedia: (mediaId: string, tracks: Array<{ streamIndex: number; filePath: string; language?: string }>) => {
    db.run('DELETE FROM external_subtitles WHERE media_id = ?', [mediaId]);
    if (tracks.length === 0) return;
    const stmt = db.prepare(`
      INSERT INTO external_subtitles (media_id, stream_index, file_path, language)
      VALUES ($media_id, $stream_index, $file_path, $language)
    `);
    for (const track of tracks) {
      stmt.run({
        $media_id: mediaId,
        $stream_index: track.streamIndex,
        $file_path: track.filePath,
        $language: track.language || null
      });
    }
  },

  getByMediaAndIndex: (mediaId: string, streamIndex: number): ExternalSubtitleRow | null => {
    return db.query(`
      SELECT * FROM external_subtitles
      WHERE media_id = ? AND stream_index = ?
    `).get(mediaId, streamIndex) as ExternalSubtitleRow | null;
  }
};

export const MediaModel = {
  getById: (
    id: string,
    userId: string,
    allowedLibraryIds?: readonly string[],
    contentRatingScope?: ContentRatingScope
  ): MediaItem | null => {
    const scopeParams: string[] = [];
    const scopeClause = libraryScopeClause('m', allowedLibraryIds, scopeParams);
    const ratingClause = contentRatingScopeClause('m', contentRatingScope, scopeParams);
    const row = db.query(`
      SELECT m.*, l.name as library_name, 
             p.id as progress_id, p.position_seconds, p.duration_seconds as p_duration,
             p.progress_percent, p.completed, p.last_watched_at,
             p.user_id as progress_user_id
      FROM media_items m
      JOIN libraries l ON m.library_id = l.id
      -- Progress belongs to the logical title, so opening the 1080p copy of a
      -- film resumes where the 4K copy left off. The subquery keeps this to the
      -- single-item lookup; list queries stay on the cheap per-file join.
      LEFT JOIN watch_progress p ON p.user_id = ? AND p.id = (
        SELECT wp.id FROM watch_progress wp
        WHERE wp.user_id = ?
          AND (wp.media_id = m.id OR (m.title_id IS NOT NULL AND wp.title_id = m.title_id))
        -- Two versions watched in the same millisecond tie on timestamp, so
        -- the furthest position wins: never resume someone backwards.
        ORDER BY wp.last_watched_at DESC, wp.position_seconds DESC
        LIMIT 1
      )
      WHERE m.id = ? AND ${scopeClause} AND ${ratingClause}
    `).get(userId, userId, id, ...scopeParams) as any;

    if (!row) return null;
    return formatMediaRow(row);
  },

  getAll: (userId: string, options: {
    libraryId?: string;
    type?: string;
    search?: string;
    resolution?: string;
    genre?: string;
    watched?: WatchedFilter;
    hdr?: boolean;
    limit?: number;
    offset?: number;
    sort?: string;
    allowedLibraryIds?: readonly string[];
    contentRatingScope?: ContentRatingScope;
  } = {}): { items: MediaItem[]; total: number } => {
    let whereClauses: string[] = [];
    let params: any[] = [];

    if (options.libraryId) {
      whereClauses.push('m.library_id = ?');
      params.push(options.libraryId);
    }
    whereClauses.push(libraryScopeClause('m', options.allowedLibraryIds, params));
    whereClauses.push(contentRatingScopeClause('m', options.contentRatingScope, params));
    if (options.type) {
      whereClauses.push('m.type = ?');
      params.push(options.type);
    }
    if (options.resolution) {
      whereClauses.push('m.resolution_label LIKE ?');
      params.push(`%${options.resolution}%`);
    }
    if (options.genre) {
      // Genre is a comma-joined list on the row, so match a delimited segment
      // rather than a bare substring ("Drama" must not match "Dramedy").
      whereClauses.push(`(', ' || REPLACE(m.genre, ',', ', ') || ', ') LIKE ?`);
      params.push(`%, ${options.genre}, %`);
    }
    if (options.hdr !== undefined) {
      whereClauses.push(options.hdr ? 'm.is_hdr = 1' : 'COALESCE(m.is_hdr, 0) = 0');
    }
    // Watched state lives in a per-user table. A correlated EXISTS keeps the
    // clause valid in the COUNT query, which does not join watch_progress.
    if (options.watched && options.watched !== 'all') {
      const progressClause = WATCHED_FILTER_CLAUSES[options.watched];
      if (progressClause) {
        whereClauses.push(progressClause);
        params.push(userId);
      }
    }
    const search = options.search?.trim();
    if (search) {
      const ftsQuery = buildFtsQuery(search);
      if (mediaFtsEnabled && ftsQuery) {
        whereClauses.push(`m.rowid IN (
          SELECT rowid FROM media_items_fts WHERE media_items_fts MATCH ?
        )`);
        params.push(ftsQuery);
      } else {
        whereClauses.push('(m.title LIKE ? OR m.series_title LIKE ?)');
        params.push(`%${search}%`, `%${search}%`);
      }
    }

    const whereStr = whereClauses.length > 0 ? `WHERE ${whereClauses.join(' AND ')}` : '';

    // Every ordering ends in a unique column so pagination cannot drop or
    // repeat a row when several share a sort value.
    const orderStr = `ORDER BY ${MEDIA_SORT_CLAUSES[options.sort ?? ''] ?? MEDIA_SORT_CLAUSES.added}`;

    const countRow = db.query(`SELECT COUNT(*) as count FROM media_items m ${whereStr}`).get(...params) as { count: number };
    const total = countRow?.count || 0;

    const limit = options.limit || 50;
    const offset = options.offset || 0;

    const rows = db.query(`
      SELECT m.*, l.name as library_name,
             p.id as progress_id, p.position_seconds, p.duration_seconds as p_duration,
             p.progress_percent, p.completed, p.last_watched_at,
             p.user_id as progress_user_id
      FROM media_items m
      JOIN libraries l ON m.library_id = l.id
      LEFT JOIN watch_progress p ON m.id = p.media_id AND p.user_id = ?
      ${whereStr}
      ${orderStr}
      LIMIT ? OFFSET ?
    `).all(userId, ...params, limit, offset) as any[];

    return {
      items: rows.map(formatMediaRow),
      total
    };
  },

  /** Distinct genre names in scope, for populating the library filter menu. */
  getGenres: (options: {
    libraryId?: string;
    type?: string;
    allowedLibraryIds?: readonly string[];
    contentRatingScope?: ContentRatingScope;
  } = {}): string[] => {
    const whereClauses: string[] = ["m.genre IS NOT NULL", "TRIM(m.genre) != ''"];
    const params: any[] = [];

    if (options.libraryId) {
      whereClauses.push('m.library_id = ?');
      params.push(options.libraryId);
    }
    whereClauses.push(libraryScopeClause('m', options.allowedLibraryIds, params));
    whereClauses.push(contentRatingScopeClause('m', options.contentRatingScope, params));
    if (options.type) {
      whereClauses.push('m.type = ?');
      params.push(options.type);
    }

    const rows = db.query(`
      SELECT DISTINCT m.genre AS genre FROM media_items m
      WHERE ${whereClauses.join(' AND ')}
    `).all(...params) as Array<{ genre: string }>;

    // Rows store genres as a comma-joined list, so split before de-duplicating.
    const genres = new Set<string>();
    for (const row of rows) {
      for (const genre of row.genre.split(',')) {
        const name = genre.trim();
        if (name) genres.add(name);
      }
    }
    return [...genres].sort((left, right) => left.localeCompare(right, 'en'));
  },

  getProgressItems: (userId: string, options: {
    status?: string;
    limit?: number;
    allowedLibraryIds?: readonly string[];
    contentRatingScope?: ContentRatingScope;
  } = {}): MediaItem[] => {
    const whereClauses = ['p.user_id = ?'];
    const params: any[] = [userId];

    whereClauses.push(libraryScopeClause('m', options.allowedLibraryIds, params));
    whereClauses.push(contentRatingScopeClause('m', options.contentRatingScope, params));

    if (options.status === 'in_progress') {
      whereClauses.push('p.completed = 0');
    } else if (options.status === 'completed') {
      whereClauses.push('p.completed = 1');
    }

    const whereStr = whereClauses.length > 0 ? `WHERE ${whereClauses.join(' AND ')}` : '';
    const limit = options.limit || 200;

    const rows = db.query(`
      SELECT m.*, l.name as library_name,
             p.id as progress_id, p.position_seconds, p.duration_seconds as p_duration,
             p.progress_percent, p.completed, p.last_watched_at,
             p.user_id as progress_user_id
      FROM watch_progress p
      JOIN media_items m ON p.media_id = m.id
      JOIN libraries l ON m.library_id = l.id
      ${whereStr}
      ORDER BY p.last_watched_at DESC
      LIMIT ?
    `).all(...params, limit) as any[];

    return rows.map(formatMediaRow);
  },

  getContinueWatching: (
    userId: string,
    limit: number = 10,
    allowedLibraryIds?: readonly string[],
    contentRatingScope?: ContentRatingScope
  ): MediaItem[] => {
    const scopeParams: string[] = [];
    const scopeClause = libraryScopeClause('m', allowedLibraryIds, scopeParams);
    const ratingClause = contentRatingScopeClause('m', contentRatingScope, scopeParams);
    const rows = db.query(`
      SELECT m.*, l.name as library_name,
             p.id as progress_id, p.position_seconds, p.duration_seconds as p_duration,
             p.progress_percent, p.completed, p.last_watched_at,
             p.user_id as progress_user_id
      FROM watch_progress p
      JOIN media_items m ON p.media_id = m.id
      JOIN libraries l ON m.library_id = l.id
      WHERE p.user_id = ?
        AND p.completed = 0 AND p.position_seconds > 10 AND p.progress_percent < 95
        AND ${scopeClause} AND ${ratingClause}
      ORDER BY p.last_watched_at DESC
      LIMIT ?
    `).all(userId, ...scopeParams, limit) as any[];

    return rows.map(formatMediaRow);
  },

  /** Newest indexed items, for the Recently Added home row. */
  getRecentlyAdded: (
    userId: string,
    limit: number = 12,
    allowedLibraryIds?: readonly string[],
    contentRatingScope?: ContentRatingScope
  ): MediaItem[] => {
    const scopeParams: string[] = [];
    const scopeClause = libraryScopeClause('m', allowedLibraryIds, scopeParams);
    const ratingClause = contentRatingScopeClause('m', contentRatingScope, scopeParams);
    const rows = db.query(`
      SELECT m.*, l.name as library_name,
             p.id as progress_id, p.position_seconds, p.duration_seconds as p_duration,
             p.progress_percent, p.completed, p.last_watched_at,
             p.user_id as progress_user_id
      FROM media_items m
      JOIN libraries l ON m.library_id = l.id
      LEFT JOIN watch_progress p ON m.id = p.media_id AND p.user_id = ?
      WHERE ${scopeClause} AND ${ratingClause}
      ORDER BY m.created_at DESC, m.id ASC
      LIMIT ?
    `).all(userId, ...scopeParams, limit) as any[];

    return rows.map(formatMediaRow);
  },

  /** Most recently finished items, for the Recently Watched home row. */
  getRecentlyWatched: (
    userId: string,
    limit: number = 12,
    allowedLibraryIds?: readonly string[],
    contentRatingScope?: ContentRatingScope
  ): MediaItem[] => {
    const scopeParams: string[] = [];
    const scopeClause = libraryScopeClause('m', allowedLibraryIds, scopeParams);
    const ratingClause = contentRatingScopeClause('m', contentRatingScope, scopeParams);
    const rows = db.query(`
      SELECT m.*, l.name as library_name,
             p.id as progress_id, p.position_seconds, p.duration_seconds as p_duration,
             p.progress_percent, p.completed, p.last_watched_at,
             p.user_id as progress_user_id
      FROM watch_progress p
      JOIN media_items m ON p.media_id = m.id
      JOIN libraries l ON m.library_id = l.id
      WHERE p.user_id = ? AND p.completed = 1
        AND ${scopeClause} AND ${ratingClause}
      ORDER BY p.last_watched_at DESC
      LIMIT ?
    `).all(userId, ...scopeParams, limit) as any[];

    return rows.map(formatMediaRow);
  },

  /**
   * The next unwatched episode of each series the viewer has finished an
   * episode of. One row per series, ordered by how recently they watched it.
   *
   * Season and episode numbers are combined into a single ordering key so that
   * "after S01E10" correctly means S02E01 rather than S01E11 only.
   */
  getNextUp: (
    userId: string,
    limit: number = 12,
    allowedLibraryIds?: readonly string[],
    contentRatingScope?: ContentRatingScope
  ): MediaItem[] => {
    const watchedScopeParams: string[] = [];
    const watchedScope = libraryScopeClause('w', allowedLibraryIds, watchedScopeParams);
    const watchedRating = contentRatingScopeClause('w', contentRatingScope, watchedScopeParams);

    const nextScopeParams: string[] = [];
    const nextScope = libraryScopeClause('m', allowedLibraryIds, nextScopeParams);
    const nextRating = contentRatingScopeClause('m', contentRatingScope, nextScopeParams);

    const rows = db.query(`
      WITH watched_series AS (
        SELECT w.library_id AS library_id,
               w.series_title AS series_title,
               MAX(w.season_number * 10000 + w.episode_number) AS last_key,
               MAX(wp.last_watched_at) AS last_watched_at
        FROM media_items w
        JOIN watch_progress wp ON wp.media_id = w.id AND wp.user_id = ?
        WHERE w.type = 'episode'
          AND w.series_title IS NOT NULL
          AND w.season_number IS NOT NULL
          AND w.episode_number IS NOT NULL
          AND wp.completed = 1
          AND ${watchedScope} AND ${watchedRating}
        GROUP BY w.library_id, w.series_title
      )
      SELECT m.*, l.name as library_name,
             p.id as progress_id, p.position_seconds, p.duration_seconds as p_duration,
             p.progress_percent, p.completed, p.last_watched_at,
             p.user_id as progress_user_id,
             MIN(m.season_number * 10000 + m.episode_number) AS next_key,
             s.last_watched_at AS series_last_watched_at
      FROM media_items m
      JOIN watched_series s
        ON s.library_id = m.library_id AND s.series_title = m.series_title
      JOIN libraries l ON m.library_id = l.id
      LEFT JOIN watch_progress p ON m.id = p.media_id AND p.user_id = ?
      WHERE m.type = 'episode'
        AND m.season_number IS NOT NULL
        AND m.episode_number IS NOT NULL
        AND (m.season_number * 10000 + m.episode_number) > s.last_key
        AND COALESCE(p.completed, 0) = 0
        AND ${nextScope} AND ${nextRating}
      GROUP BY m.library_id, m.series_title
      ORDER BY s.last_watched_at DESC
      LIMIT ?
    `).all(
      userId, ...watchedScopeParams,
      userId, ...nextScopeParams,
      limit
    ) as any[];

    return rows.map(formatMediaRow);
  },

  upsert: (item: Omit<MediaItem, 'progress' | 'library_name'>) => {
    const stmt = db.prepare(`
      INSERT INTO media_items (
        id, library_id, title, original_filename, relative_path, full_path,
        type, series_title, season_number, episode_number, year, duration,
        size_bytes, format, video_codec, width, height, resolution_label,
        frame_rate, bit_rate, is_hdr, audio_codec, audio_channels,
        audio_channel_layout, audio_language, streams_json, poster_path,
        content_rating, content_rating_level, artist, album_artist, album,
        track_number, disc_number, genre, content_fingerprint, created_at, updated_at
      ) VALUES (
        $id, $library_id, $title, $original_filename, $relative_path, $full_path,
        $type, $series_title, $season_number, $episode_number, $year, $duration,
        $size_bytes, $format, $video_codec, $width, $height, $resolution_label,
        $frame_rate, $bit_rate, $is_hdr, $audio_codec, $audio_channels,
        $audio_channel_layout, $audio_language, $streams_json, $poster_path,
        $content_rating, $content_rating_level, $artist, $album_artist, $album,
        $track_number, $disc_number, $genre, $content_fingerprint, $created_at, $updated_at
      ) ON CONFLICT(full_path) DO UPDATE SET
        title = excluded.title,
        duration = excluded.duration,
        size_bytes = excluded.size_bytes,
        format = excluded.format,
        video_codec = excluded.video_codec,
        width = excluded.width,
        height = excluded.height,
        resolution_label = excluded.resolution_label,
        frame_rate = excluded.frame_rate,
        bit_rate = excluded.bit_rate,
        is_hdr = excluded.is_hdr,
        audio_codec = excluded.audio_codec,
        audio_channels = excluded.audio_channels,
        audio_channel_layout = excluded.audio_channel_layout,
        audio_language = excluded.audio_language,
        streams_json = excluded.streams_json,
        poster_path = excluded.poster_path,
        content_rating = COALESCE(excluded.content_rating, media_items.content_rating),
        content_rating_level = COALESCE(excluded.content_rating_level, media_items.content_rating_level),
        artist = excluded.artist,
        album_artist = excluded.album_artist,
        album = excluded.album,
        track_number = excluded.track_number,
        disc_number = excluded.disc_number,
        genre = excluded.genre,
        content_fingerprint = excluded.content_fingerprint,
        updated_at = excluded.updated_at
    `);

    stmt.run({
      $id: item.id,
      $library_id: item.library_id,
      $title: item.title,
      $original_filename: item.original_filename,
      $relative_path: item.relative_path,
      $full_path: item.full_path,
      $type: item.type,
      $series_title: item.series_title || null,
      $season_number: item.season_number ?? null,
      $episode_number: item.episode_number ?? null,
      $year: item.year ?? null,
      $duration: item.duration || 0,
      $size_bytes: item.size_bytes || 0,
      $format: item.format || '',
      $video_codec: item.video_codec || null,
      $width: item.width ?? null,
      $height: item.height ?? null,
      $resolution_label: item.resolution_label || null,
      $frame_rate: item.frame_rate ?? null,
      $bit_rate: item.bit_rate ?? null,
      $is_hdr: item.is_hdr ? 1 : 0,
      $audio_codec: item.audio_codec || null,
      $audio_channels: item.audio_channels ?? null,
      $audio_channel_layout: item.audio_channel_layout || null,
      $audio_language: item.audio_language || null,
      $streams_json: item.streams_json || '[]',
      $poster_path: item.poster_path || null,
      $content_rating: normalizeContentRating(item.content_rating),
      $content_rating_level: contentRatingLevel(item.content_rating),
      $artist: item.artist || null,
      $album_artist: item.album_artist || null,
      $album: item.album || null,
      $track_number: item.track_number ?? null,
      $disc_number: item.disc_number ?? null,
      $genre: item.genre || null,
      $content_fingerprint: item.content_fingerprint || null,
      $created_at: item.created_at,
      $updated_at: item.updated_at
    });
  },

  updatePosterPath: (id: string, posterPath: string) => {
    db.run('UPDATE media_items SET poster_path = ? WHERE id = ?', [posterPath, id]);
  },

  updateContentRating: (
    id: string,
    contentRating: string | null,
    userId: string = PUBLIC_USER_ID
  ): MediaItem | null => {
    const normalized = normalizeContentRating(contentRating);
    db.run(`
      UPDATE media_items
      SET content_rating = ?, content_rating_level = ?, updated_at = ?
      WHERE id = ?
    `, [normalized, contentRatingLevel(normalized), new Date().toISOString(), id]);
    return MediaModel.getById(id, userId);
  },

  delete: (id: string): void => {
    db.run('DELETE FROM media_items WHERE id = ?', [id]);
  },

  stageDiscoveredPaths: (
    libraryId: string,
    scanGenerationId: string,
    fullPaths: readonly string[]
  ): void => {
    if (fullPaths.length === 0) return;

    const statement = db.prepare(`
      INSERT OR IGNORE INTO library_scan_discoveries (
        library_id, scan_generation_id, full_path, discovered_at
      ) VALUES (?, ?, ?, ?)
    `);
    const discoveredAt = new Date().toISOString();
    for (const fullPath of fullPaths) {
      statement.run(libraryId, scanGenerationId, fullPath, discoveredAt);
    }
  },

  reconcileLibraryScan: (libraryId: string, scanGenerationId: string): void => {
    // Reconcile against paths discovered during the filesystem traversal. A
    // processing failure cannot remove a path from this generation because
    // staging happens before processMediaFile is called.
    db.run(`
      DELETE FROM media_items
      WHERE library_id = ?
        AND NOT EXISTS (
          SELECT 1
          FROM library_scan_discoveries discovered
          WHERE discovered.library_id = ?
            AND discovered.scan_generation_id = ?
            AND discovered.full_path = media_items.full_path
        )
    `, [libraryId, libraryId, scanGenerationId]);

    // Keep the most recent generation for diagnostics while preventing the
    // discovery table from growing without bound.
    db.run(`
      DELETE FROM library_scan_discoveries
      WHERE library_id = ? AND scan_generation_id != ?
    `, [libraryId, scanGenerationId]);
  },

  deleteNotFoundInPaths: (libraryId: string, currentFullPaths: string[]) => {
    if (currentFullPaths.length === 0) {
      db.run('DELETE FROM media_items WHERE library_id = ?', [libraryId]);
      return;
    }
    const placeholders = currentFullPaths.map(() => '?').join(',');
    db.run(`DELETE FROM media_items WHERE library_id = ? AND full_path NOT IN (${placeholders})`, [libraryId, ...currentFullPaths]);
  },

  getBySeries: (
    libraryId: string,
    seriesTitle: string,
    userId: string,
    allowedLibraryIds?: readonly string[],
    contentRatingScope?: ContentRatingScope
  ): MediaItem[] => {
    const scopeParams: string[] = [];
    const scopeClause = libraryScopeClause('m', allowedLibraryIds, scopeParams);
    const ratingClause = contentRatingScopeClause('m', contentRatingScope, scopeParams);
    const rows = db.query(`
      SELECT m.*, l.name as library_name,
             p.id as progress_id, p.position_seconds, p.duration_seconds as p_duration,
             p.progress_percent, p.completed, p.last_watched_at,
             p.user_id as progress_user_id
      FROM media_items m
      JOIN libraries l ON m.library_id = l.id
      LEFT JOIN watch_progress p ON m.id = p.media_id AND p.user_id = ?
      WHERE m.type = 'episode' AND m.library_id = ? AND m.series_title = ?
        AND ${scopeClause} AND ${ratingClause}
      ORDER BY COALESCE(m.season_number, 0) ASC, COALESCE(m.episode_number, 0) ASC, m.title ASC
    `).all(userId, libraryId, seriesTitle, ...scopeParams) as any[];

    return rows.map(formatMediaRow);
  }
};

const SERIES_GROUP_SELECT = `
  SELECT m.library_id, l.name as library_name, m.series_title as title,
         MIN(m.year) as year,
         COUNT(m.id) as episode_count,
         COUNT(DISTINCT m.season_number) as season_count,
         COALESCE(SUM(m.duration), 0) as total_duration,
         MAX(m.poster_path) as poster_path,
         SUM(CASE WHEN p.completed = 1 THEN 1 ELSE 0 END) as watched_count
  FROM media_items m
  JOIN libraries l ON m.library_id = l.id
  LEFT JOIN watch_progress p ON p.media_id = m.id AND p.user_id = ?
  WHERE m.type = 'episode' AND m.series_title IS NOT NULL AND m.series_title != ''
`;

function seriesIdFor(libraryId: string, seriesTitle: string): string {
  return `ser_${crypto.createHash('md5').update(`${libraryId}::${seriesTitle}`).digest('hex').substring(0, 16)}`;
}

function formatSeriesRow(row: any): Series {
  return {
    id: seriesIdFor(row.library_id, row.title),
    title: row.title,
    library_id: row.library_id,
    library_name: row.library_name,
    year: row.year ?? undefined,
    episode_count: row.episode_count || 0,
    season_count: row.season_count || 0,
    total_duration: row.total_duration || 0,
    watched_count: row.watched_count || 0,
    poster_path: row.poster_path || undefined
  };
}

export const SeriesModel = {
  getAll: (userId: string, options: {
    libraryId?: string;
    search?: string;
    allowedLibraryIds?: readonly string[];
    contentRatingScope?: ContentRatingScope;
  } = {}): Series[] => {
    const clauses: string[] = [];
    const params: any[] = [];

    if (options.libraryId) {
      clauses.push('m.library_id = ?');
      params.push(options.libraryId);
    }
    clauses.push(libraryScopeClause('m', options.allowedLibraryIds, params));
    clauses.push(contentRatingScopeClause('m', options.contentRatingScope, params));
    if (options.search) {
      clauses.push('m.series_title LIKE ?');
      params.push(`%${options.search}%`);
    }

    const whereStr = clauses.length > 0 ? `AND ${clauses.join(' AND ')}` : '';
    const rows = db.query(`
      ${SERIES_GROUP_SELECT}
      ${whereStr}
      GROUP BY m.library_id, m.series_title
      ORDER BY m.series_title COLLATE NOCASE ASC
    `).all(userId, ...params) as any[];

    return rows.map(formatSeriesRow);
  },

  getById: (
    id: string,
    userId: string,
    allowedLibraryIds?: readonly string[],
    contentRatingScope?: ContentRatingScope
  ): Series | null => {
    const scopeParams: string[] = [];
    const scopeClause = libraryScopeClause('m', allowedLibraryIds, scopeParams);
    const ratingClause = contentRatingScopeClause('m', contentRatingScope, scopeParams);
    const rows = db.query(`
      ${SERIES_GROUP_SELECT}
      AND ${scopeClause} AND ${ratingClause}
      GROUP BY m.library_id, m.series_title
    `).all(userId, ...scopeParams) as any[];
    return rows.map(formatSeriesRow).find((s) => s.id === id) || null;
  },

  getSeasons: (
    libraryId: string,
    seriesTitle: string,
    userId: string,
    allowedLibraryIds?: readonly string[],
    contentRatingScope?: ContentRatingScope
  ): SeriesSeason[] => {
    const scopeParams: string[] = [];
    const scopeClause = libraryScopeClause('m', allowedLibraryIds, scopeParams);
    const ratingClause = contentRatingScopeClause('m', contentRatingScope, scopeParams);
    const rows = db.query(`
      SELECT COALESCE(m.season_number, 0) as season_number,
             COUNT(*) as episode_count,
             COALESCE(SUM(m.duration), 0) as total_duration,
             SUM(CASE WHEN p.completed = 1 THEN 1 ELSE 0 END) as watched_count
      FROM media_items m
      LEFT JOIN watch_progress p ON p.media_id = m.id AND p.user_id = ?
      WHERE m.type = 'episode' AND m.library_id = ? AND m.series_title = ?
        AND ${scopeClause} AND ${ratingClause}
      GROUP BY COALESCE(m.season_number, 0)
      ORDER BY season_number ASC
    `).all(userId, libraryId, seriesTitle, ...scopeParams) as any[];

    return rows.map((row) => ({
      season_number: row.season_number,
      episode_count: row.episode_count,
      total_duration: row.total_duration || 0,
      watched_count: row.watched_count || 0
    }));
  }
};

function libraryScopeClause(
  tableAlias: string,
  allowedLibraryIds: readonly string[] | undefined,
  params: any[]
): string {
  if (allowedLibraryIds === undefined) return '1 = 1';
  if (allowedLibraryIds.length === 0) return '1 = 0';
  params.push(...allowedLibraryIds);
  return `${tableAlias}.library_id IN (${allowedLibraryIds.map(() => '?').join(', ')})`;
}

function contentRatingScopeClause(
  tableAlias: string,
  scope: ContentRatingScope | undefined,
  params: any[]
): string {
  if (!scope) return '1 = 1';
  if (scope.maxLevel === null) {
    return scope.allowUnrated ? '1 = 1' : `${tableAlias}.content_rating_level IS NOT NULL`;
  }
  params.push(scope.maxLevel);
  return scope.allowUnrated
    ? `(${tableAlias}.content_rating_level IS NULL OR ${tableAlias}.content_rating_level <= ?)`
    : `(${tableAlias}.content_rating_level IS NOT NULL AND ${tableAlias}.content_rating_level <= ?)`;
}

export type WatchedFilter = 'all' | 'unwatched' | 'in_progress' | 'watched';

export const WATCHED_FILTERS: readonly WatchedFilter[] =
  ['all', 'unwatched', 'in_progress', 'watched'];

const WATCHED_FILTER_CLAUSES: Record<Exclude<WatchedFilter, 'all'>, string> = {
  unwatched: `NOT EXISTS (
    SELECT 1 FROM watch_progress wp
    WHERE wp.media_id = m.id AND wp.user_id = ? AND wp.position_seconds > 0
  )`,
  in_progress: `EXISTS (
    SELECT 1 FROM watch_progress wp
    WHERE wp.media_id = m.id AND wp.user_id = ?
      AND wp.completed = 0 AND wp.position_seconds > 0
  )`,
  watched: `EXISTS (
    SELECT 1 FROM watch_progress wp
    WHERE wp.media_id = m.id AND wp.user_id = ? AND wp.completed = 1
  )`
};

const MEDIA_SORT_CLAUSES: Record<string, string> = {
  added: 'm.created_at DESC, m.id ASC',
  oldest: 'm.created_at ASC, m.id ASC',
  title: 'm.title COLLATE NOCASE ASC, m.id ASC',
  title_desc: 'm.title COLLATE NOCASE DESC, m.id ASC',
  year: 'm.year IS NULL, m.year DESC, m.title COLLATE NOCASE ASC, m.id ASC',
  year_asc: 'm.year IS NULL, m.year ASC, m.title COLLATE NOCASE ASC, m.id ASC',
  duration: 'm.duration DESC, m.id ASC',
  duration_asc: 'm.duration ASC, m.id ASC',
  size: 'm.size_bytes DESC, m.id ASC'
};

export const MEDIA_SORT_OPTIONS: readonly string[] = Object.keys(MEDIA_SORT_CLAUSES);

export function isWatchedFilter(value: unknown): value is WatchedFilter {
  return typeof value === 'string' && (WATCHED_FILTERS as readonly string[]).includes(value);
}

function buildFtsQuery(search: string): string {
  const tokens = search.match(/[\p{L}\p{N}_]+/gu) || [];
  return tokens.map((token) => `"${token.replaceAll('"', '""')}"*`).join(' AND ');
}

export const ProgressModel = {
  upsert: (userId: string, mediaId: string, position: number, duration: number): WatchProgress => {
    const percent = duration > 0 ? Math.min(100, Math.round((position / duration) * 100)) : 0;
    const completed = percent >= 92 ? 1 : 0;
    const id = `prog_${crypto.createHash('sha256').update(`${userId}\0${mediaId}`).digest('hex').substring(0, 24)}`;
    const now = new Date().toISOString();

    const stmt = db.prepare(`
      INSERT INTO watch_progress (id, user_id, media_id, position_seconds, duration_seconds, progress_percent, completed, last_watched_at)
      VALUES ($id, $user_id, $media_id, $position, $duration, $percent, $completed, $now)
      ON CONFLICT(user_id, media_id) DO UPDATE SET
        id = excluded.id,
        position_seconds = excluded.position_seconds,
        duration_seconds = excluded.duration_seconds,
        progress_percent = excluded.progress_percent,
        completed = excluded.completed,
        last_watched_at = excluded.last_watched_at
    `);

    stmt.run({
      $id: id,
      $user_id: userId,
      $media_id: mediaId,
      $position: position,
      $duration: duration,
      $percent: percent,
      $completed: completed,
      $now: now
    });

    // Stamp the logical title so this position is findable from any other
    // version of the same work.
    db.run(`
      UPDATE watch_progress
      SET title_id = (SELECT m.title_id FROM media_items m WHERE m.id = ?)
      WHERE user_id = ? AND media_id = ?
    `, [mediaId, userId, mediaId]);

    return {
      id,
      user_id: userId,
      media_id: mediaId,
      position_seconds: position,
      duration_seconds: duration,
      progress_percent: percent,
      completed: !!completed,
      last_watched_at: now
    };
  },

  markWatched: (userId: string, mediaId: string): WatchProgress => {
    const existing = db.query(`
      SELECT duration_seconds FROM watch_progress
      WHERE user_id = ? AND media_id = ?
    `).get(userId, mediaId) as any;
    const mediaRow = db.query('SELECT duration FROM media_items WHERE id = ?').get(mediaId) as any;

    const duration = existing?.duration_seconds > 0
      ? existing.duration_seconds
      : (mediaRow?.duration || 0);

    return ProgressModel.upsert(userId, mediaId, duration, duration);
  },

  remove: (userId: string, mediaId: string) => {
    db.run('DELETE FROM watch_progress WHERE user_id = ? AND media_id = ?', [userId, mediaId]);
  }
};

function formatMediaRow(row: any): MediaItem {
  let progress: WatchProgress | undefined = undefined;
  if (row.progress_id) {
    progress = {
      id: row.progress_id,
      user_id: row.progress_user_id,
      media_id: row.id,
      position_seconds: row.position_seconds,
      duration_seconds: row.p_duration,
      progress_percent: row.progress_percent,
      completed: !!row.completed,
      last_watched_at: row.last_watched_at
    };
  }

  return {
    id: row.id,
    library_id: row.library_id,
    title: row.title,
    original_filename: row.original_filename,
    relative_path: row.relative_path,
    full_path: row.full_path,
    type: row.type,
    series_title: row.series_title,
    season_number: row.season_number,
    episode_number: row.episode_number,
    year: row.year,
    duration: row.duration,
    size_bytes: row.size_bytes,
    format: row.format,
    video_codec: row.video_codec,
    width: row.width,
    height: row.height,
    resolution_label: row.resolution_label,
    frame_rate: row.frame_rate,
    bit_rate: row.bit_rate,
    is_hdr: !!row.is_hdr,
    audio_codec: row.audio_codec,
    audio_channels: row.audio_channels,
    audio_channel_layout: row.audio_channel_layout,
    audio_language: row.audio_language,
    artist: row.artist ?? undefined,
    album_artist: row.album_artist ?? undefined,
    album: row.album ?? undefined,
    track_number: row.track_number ?? undefined,
    disc_number: row.disc_number ?? undefined,
    genre: row.genre ?? undefined,
    streams_json: row.streams_json,
    poster_path: row.poster_path,
    content_rating: row.content_rating ?? undefined,
    content_rating_level: row.content_rating_level ?? undefined,
    created_at: row.created_at,
    updated_at: row.updated_at,
    library_name: row.library_name,
    progress
  };
}
