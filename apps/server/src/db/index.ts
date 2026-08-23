import { Database } from 'bun:sqlite';
import path from 'path';
import fs from 'fs';
import type { Library, MediaItem, WatchProgress } from '../types';

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

// Initialize schema
export function initDatabase() {
  db.run(`
    CREATE TABLE IF NOT EXISTS libraries (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      path TEXT NOT NULL,
      type TEXT NOT NULL,
      last_scanned_at TEXT,
      created_at TEXT NOT NULL
    );
  `);

  db.run(`
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

  db.run(`
    CREATE INDEX IF NOT EXISTS idx_media_library ON media_items(library_id);
    CREATE INDEX IF NOT EXISTS idx_media_type ON media_items(type);
    CREATE INDEX IF NOT EXISTS idx_media_title ON media_items(title);
    CREATE INDEX IF NOT EXISTS idx_media_series ON media_items(series_title, season_number, episode_number);
  `);

  // FTS5 is bundled with Bun's SQLite build, but keep LIKE search as a fallback
  // for environments that provide SQLite without the extension.
  try {
    const ftsAlreadyExists = !!db.query(`
      SELECT 1 FROM sqlite_master
      WHERE type = 'table' AND name = 'media_items_fts'
    `).get();

    db.run(`
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
      db.run(`INSERT INTO media_items_fts(media_items_fts) VALUES ('rebuild')`);
    }
    mediaFtsEnabled = true;
  } catch (error) {
    mediaFtsEnabled = false;
    console.warn('SQLite FTS5 unavailable; falling back to LIKE search.', error);
  }

  db.run(`
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

  db.run(`
    CREATE INDEX IF NOT EXISTS idx_progress_last_watched ON watch_progress(last_watched_at DESC);
  `);

  db.run(`
    CREATE TABLE IF NOT EXISTS settings (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL
    );
  `);
}

// ---------------- Helper Queries ---------------- //

export const LibraryModel = {
  getAll: (): Library[] => {
    const rows = db.query(`
      SELECT l.*, COUNT(m.id) as item_count 
      FROM libraries l
      LEFT JOIN media_items m ON l.id = m.library_id
      GROUP BY l.id
      ORDER BY l.name ASC
    `).all() as (Library & { item_count: number })[];
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

export const MediaModel = {
  getById: (id: string): MediaItem | null => {
    const row = db.query(`
      SELECT m.*, l.name as library_name, 
             p.id as progress_id, p.position_seconds, p.duration_seconds as p_duration,
             p.progress_percent, p.completed, p.last_watched_at
      FROM media_items m
      JOIN libraries l ON m.library_id = l.id
      LEFT JOIN watch_progress p ON m.id = p.media_id
      WHERE m.id = ?
    `).get(id) as any;

    if (!row) return null;
    return formatMediaRow(row);
  },

  getAll: (options: {
    libraryId?: string;
    type?: string;
    search?: string;
    resolution?: string;
    limit?: number;
    offset?: number;
    sort?: string;
  } = {}): { items: MediaItem[]; total: number } => {
    let whereClauses: string[] = [];
    let params: any[] = [];

    if (options.libraryId) {
      whereClauses.push('m.library_id = ?');
      params.push(options.libraryId);
    }
    if (options.type) {
      whereClauses.push('m.type = ?');
      params.push(options.type);
    }
    if (options.resolution) {
      whereClauses.push('m.resolution_label LIKE ?');
      params.push(`%${options.resolution}%`);
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

    let orderStr = 'ORDER BY m.created_at DESC';
    if (options.sort === 'title') orderStr = 'ORDER BY m.title ASC';
    else if (options.sort === 'year') orderStr = 'ORDER BY m.year DESC, m.title ASC';
    else if (options.sort === 'duration') orderStr = 'ORDER BY m.duration DESC';

    const countRow = db.query(`SELECT COUNT(*) as count FROM media_items m ${whereStr}`).get(...params) as { count: number };
    const total = countRow?.count || 0;

    const limit = options.limit || 50;
    const offset = options.offset || 0;

    const rows = db.query(`
      SELECT m.*, l.name as library_name,
             p.id as progress_id, p.position_seconds, p.duration_seconds as p_duration,
             p.progress_percent, p.completed, p.last_watched_at
      FROM media_items m
      JOIN libraries l ON m.library_id = l.id
      LEFT JOIN watch_progress p ON m.id = p.media_id
      ${whereStr}
      ${orderStr}
      LIMIT ? OFFSET ?
    `).all(...params, limit, offset) as any[];

    return {
      items: rows.map(formatMediaRow),
      total
    };
  },

  getContinueWatching: (limit: number = 10): MediaItem[] => {
    const rows = db.query(`
      SELECT m.*, l.name as library_name,
             p.id as progress_id, p.position_seconds, p.duration_seconds as p_duration,
             p.progress_percent, p.completed, p.last_watched_at
      FROM watch_progress p
      JOIN media_items m ON p.media_id = m.id
      JOIN libraries l ON m.library_id = l.id
      WHERE p.completed = 0 AND p.position_seconds > 10 AND p.progress_percent < 95
      ORDER BY p.last_watched_at DESC
      LIMIT ?
    `).all(limit) as any[];

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
        created_at, updated_at
      ) VALUES (
        $id, $library_id, $title, $original_filename, $relative_path, $full_path,
        $type, $series_title, $season_number, $episode_number, $year, $duration,
        $size_bytes, $format, $video_codec, $width, $height, $resolution_label,
        $frame_rate, $bit_rate, $is_hdr, $audio_codec, $audio_channels,
        $audio_channel_layout, $audio_language, $streams_json, $poster_path,
        $created_at, $updated_at
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
      $created_at: item.created_at,
      $updated_at: item.updated_at
    });
  },

  deleteNotFoundInPaths: (libraryId: string, currentFullPaths: string[]) => {
    if (currentFullPaths.length === 0) {
      db.run('DELETE FROM media_items WHERE library_id = ?', [libraryId]);
      return;
    }
    const placeholders = currentFullPaths.map(() => '?').join(',');
    db.run(`DELETE FROM media_items WHERE library_id = ? AND full_path NOT IN (${placeholders})`, [libraryId, ...currentFullPaths]);
  }
};

function buildFtsQuery(search: string): string {
  const tokens = search.match(/[\p{L}\p{N}_]+/gu) || [];
  return tokens.map((token) => `"${token.replaceAll('"', '""')}"*`).join(' AND ');
}

export const ProgressModel = {
  upsert: (mediaId: string, position: number, duration: number) => {
    const percent = duration > 0 ? Math.min(100, Math.round((position / duration) * 100)) : 0;
    const completed = percent >= 92 ? 1 : 0;
    const id = `prog_${mediaId}`;
    const now = new Date().toISOString();

    const stmt = db.prepare(`
      INSERT INTO watch_progress (id, media_id, position_seconds, duration_seconds, progress_percent, completed, last_watched_at)
      VALUES ($id, $media_id, $position, $duration, $percent, $completed, $now)
      ON CONFLICT(media_id) DO UPDATE SET
        position_seconds = excluded.position_seconds,
        duration_seconds = excluded.duration_seconds,
        progress_percent = excluded.progress_percent,
        completed = excluded.completed,
        last_watched_at = excluded.last_watched_at
    `);

    stmt.run({
      $id: id,
      $media_id: mediaId,
      $position: position,
      $duration: duration,
      $percent: percent,
      $completed: completed,
      $now: now
    });

    return {
      id,
      media_id: mediaId,
      position_seconds: position,
      duration_seconds: duration,
      progress_percent: percent,
      completed: !!completed,
      last_watched_at: now
    };
  }
};

function formatMediaRow(row: any): MediaItem {
  let progress: WatchProgress | undefined = undefined;
  if (row.progress_id) {
    progress = {
      id: row.progress_id,
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
    streams_json: row.streams_json,
    poster_path: row.poster_path,
    created_at: row.created_at,
    updated_at: row.updated_at,
    library_name: row.library_name,
    progress
  };
}
