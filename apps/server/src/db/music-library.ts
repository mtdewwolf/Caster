import crypto from 'crypto';
import type { Database } from 'bun:sqlite';

export interface MusicContentRatingScope {
  maxLevel: number | null;
  allowUnrated: boolean;
}

export interface MusicQueryScope {
  allowedLibraryIds?: readonly string[];
  contentRatingScope?: MusicContentRatingScope;
}

export interface MusicListOptions extends MusicQueryScope {
  libraryId?: string;
  search?: string;
}

export interface ArtistSummary {
  id: string;
  name: string;
  library_id: string;
  library_name?: string;
  album_count: number;
  track_count: number;
  total_duration: number;
  poster_path?: string;
}

export interface AlbumSummary {
  id: string;
  title: string;
  album_artist: string;
  library_id: string;
  library_name?: string;
  year?: number;
  track_count: number;
  total_duration: number;
  poster_path?: string;
}

export interface MusicTrack {
  id: string;
  library_id: string;
  library_name?: string;
  full_path?: string;
  title: string;
  artist?: string;
  album_artist?: string;
  album?: string;
  track_number?: number;
  disc_number?: number;
  genre?: string;
  year?: number;
  duration: number;
  poster_path?: string;
  [key: string]: unknown;
}

export interface ArtistDetail {
  artist: ArtistSummary;
  albums: AlbumSummary[];
}

export interface AlbumDetail {
  album: AlbumSummary;
  tracks: MusicTrack[];
}

const ARTIST_EXPRESSION = `COALESCE(
  NULLIF(TRIM(m.album_artist), ''),
  NULLIF(TRIM(m.artist), ''),
  'Unknown Artist'
)`;
const ALBUM_EXPRESSION = `COALESCE(NULLIF(TRIM(m.album), ''), 'Unknown Album')`;

function normalizedIdentityPart(value: string): string {
  return value.normalize('NFKC').trim().replace(/\s+/g, ' ').toLocaleLowerCase('en-US');
}

function digestId(prefix: string, parts: Array<string | number | undefined>): string {
  const source = parts.map((part) => normalizedIdentityPart(String(part ?? ''))).join('\0');
  return `${prefix}_${crypto.createHash('sha256').update(source).digest('hex').slice(0, 24)}`;
}

export function musicArtistId(libraryId: string, artistName: string): string {
  return digestId('art', [libraryId, artistName]);
}

export function musicAlbumId(
  libraryId: string,
  albumArtist: string,
  albumTitle: string,
  year?: number
): string {
  return digestId('alb', [libraryId, albumArtist, albumTitle, year]);
}

function scopeClauses(
  options: MusicQueryScope,
  params: unknown[],
  alias: string = 'm'
): string[] {
  const clauses: string[] = [];
  const allowed = options.allowedLibraryIds;
  if (allowed !== undefined) {
    if (allowed.length === 0) clauses.push('1 = 0');
    else {
      clauses.push(`${alias}.library_id IN (${allowed.map(() => '?').join(', ')})`);
      params.push(...allowed);
    }
  }

  const rating = options.contentRatingScope;
  if (rating) {
    if (rating.maxLevel === null) {
      if (!rating.allowUnrated) clauses.push(`${alias}.content_rating_level IS NOT NULL`);
    } else {
      params.push(rating.maxLevel);
      clauses.push(rating.allowUnrated
        ? `(${alias}.content_rating_level IS NULL OR ${alias}.content_rating_level <= ?)`
        : `(${alias}.content_rating_level IS NOT NULL AND ${alias}.content_rating_level <= ?)`);
    }
  }
  return clauses;
}

function formatArtist(row: Record<string, any>): ArtistSummary {
  return {
    id: musicArtistId(row.library_id, row.name),
    name: row.name,
    library_id: row.library_id,
    library_name: row.library_name || undefined,
    album_count: Number(row.album_count) || 0,
    track_count: Number(row.track_count) || 0,
    total_duration: Number(row.total_duration) || 0,
    poster_path: row.poster_path || undefined
  };
}

function formatAlbum(row: Record<string, any>): AlbumSummary {
  const year = row.year == null ? undefined : Number(row.year);
  return {
    id: musicAlbumId(row.library_id, row.album_artist, row.title, year),
    title: row.title,
    album_artist: row.album_artist,
    library_id: row.library_id,
    library_name: row.library_name || undefined,
    year,
    track_count: Number(row.track_count) || 0,
    total_duration: Number(row.total_duration) || 0,
    poster_path: row.poster_path || undefined
  };
}

function formatTrack(row: Record<string, any>): MusicTrack {
  const track: MusicTrack = {
    id: String(row.id),
    library_id: String(row.library_id),
    title: String(row.title),
    ...row,
    duration: Number(row.duration) || 0,
    track_number: row.track_number == null ? undefined : Number(row.track_number),
    disc_number: row.disc_number == null ? undefined : Number(row.disc_number),
    year: row.year == null ? undefined : Number(row.year),
    library_name: row.library_name || undefined,
    poster_path: row.poster_path || undefined,
    is_hdr: !!row.is_hdr
  };
  if (row.progress_id) {
    track.progress = {
      id: row.progress_id,
      user_id: row.progress_user_id,
      media_id: row.id,
      position_seconds: row.position_seconds,
      duration_seconds: row.progress_duration,
      progress_percent: row.progress_percent,
      completed: !!row.completed,
      last_watched_at: row.last_watched_at
    };
  }
  delete track.progress_id;
  delete track.progress_user_id;
  delete track.progress_duration;
  return track;
}

export interface MusicLibraryStore {
  getArtists(options?: MusicListOptions): ArtistSummary[];
  getArtist(id: string, options?: MusicListOptions): ArtistDetail | null;
  getAlbums(options?: MusicListOptions & { artistId?: string }): AlbumSummary[];
  getAlbum(id: string, options?: MusicListOptions & { userId?: string }): AlbumDetail | null;
}

export function createMusicLibraryStore(database: Database): MusicLibraryStore {
  const getArtists = (options: MusicListOptions = {}): ArtistSummary[] => {
    const params: unknown[] = [];
    const clauses = [`m.type = 'track'`, ...scopeClauses(options, params)];
    if (options.libraryId) {
      clauses.push('m.library_id = ?');
      params.push(options.libraryId);
    }
    if (options.search?.trim()) {
      clauses.push(`${ARTIST_EXPRESSION} LIKE ?`);
      params.push(`%${options.search.trim()}%`);
    }

    const rows = database.query(`
      SELECT m.library_id, l.name AS library_name,
             MIN(${ARTIST_EXPRESSION}) AS name,
             COUNT(DISTINCT LOWER(${ALBUM_EXPRESSION}) || CHAR(0) || COALESCE(CAST(m.year AS TEXT), '')) AS album_count,
             COUNT(m.id) AS track_count,
             COALESCE(SUM(m.duration), 0) AS total_duration,
             MAX(m.poster_path) AS poster_path
      FROM media_items m
      JOIN libraries l ON l.id = m.library_id
      WHERE ${clauses.join(' AND ')}
      GROUP BY m.library_id, LOWER(${ARTIST_EXPRESSION})
      ORDER BY name COLLATE NOCASE ASC, m.library_id ASC
    `).all(...params as any[]) as Array<Record<string, any>>;
    return rows.map(formatArtist);
  };

  const getAlbumsForArtist = (
    artist: ArtistSummary | undefined,
    options: MusicListOptions = {}
  ): AlbumSummary[] => {
    const params: unknown[] = [];
    const clauses = [`m.type = 'track'`, ...scopeClauses(options, params)];
    if (options.libraryId) {
      clauses.push('m.library_id = ?');
      params.push(options.libraryId);
    }
    if (artist) {
      clauses.push(`m.library_id = ? AND LOWER(${ARTIST_EXPRESSION}) = LOWER(?)`);
      params.push(artist.library_id, artist.name);
    }
    if (options.search?.trim()) {
      clauses.push(`(${ALBUM_EXPRESSION} LIKE ? OR ${ARTIST_EXPRESSION} LIKE ?)`);
      const pattern = `%${options.search.trim()}%`;
      params.push(pattern, pattern);
    }

    const rows = database.query(`
      SELECT m.library_id, l.name AS library_name,
             MIN(${ALBUM_EXPRESSION}) AS title,
             MIN(${ARTIST_EXPRESSION}) AS album_artist,
             m.year,
             COUNT(m.id) AS track_count,
             COALESCE(SUM(m.duration), 0) AS total_duration,
             MAX(m.poster_path) AS poster_path
      FROM media_items m
      JOIN libraries l ON l.id = m.library_id
      WHERE ${clauses.join(' AND ')}
      GROUP BY m.library_id, LOWER(${ARTIST_EXPRESSION}), LOWER(${ALBUM_EXPRESSION}), m.year
      ORDER BY album_artist COLLATE NOCASE ASC, title COLLATE NOCASE ASC, m.year ASC, m.library_id ASC
    `).all(...params as any[]) as Array<Record<string, any>>;
    return rows.map(formatAlbum);
  };

  const getArtist = (id: string, options: MusicListOptions = {}): ArtistDetail | null => {
    const { search: _search, ...identityOptions } = options;
    const artist = getArtists(identityOptions).find((candidate) => candidate.id === id);
    if (!artist) return null;
    return { artist, albums: getAlbumsForArtist(artist, identityOptions) };
  };

  const getAlbums = (
    options: MusicListOptions & { artistId?: string } = {}
  ): AlbumSummary[] => {
    if (!options.artistId) return getAlbumsForArtist(undefined, options);
    const { search: _search, artistId: _artistId, ...identityOptions } = options;
    const artist = getArtists(identityOptions).find((candidate) => candidate.id === options.artistId);
    return artist ? getAlbumsForArtist(artist, options) : [];
  };

  const getAlbum = (
    id: string,
    options: MusicListOptions & { userId?: string } = {}
  ): AlbumDetail | null => {
    const { search: _search, ...identityOptions } = options;
    const album = getAlbumsForArtist(undefined, identityOptions).find((candidate) => candidate.id === id);
    if (!album) return null;

    const params: unknown[] = [options.userId ?? null, album.library_id, album.album_artist, album.title];
    const clauses = [
      `m.type = 'track'`,
      'm.library_id = ?',
      `LOWER(${ARTIST_EXPRESSION}) = LOWER(?)`,
      `LOWER(${ALBUM_EXPRESSION}) = LOWER(?)`,
      album.year === undefined ? 'm.year IS NULL' : 'm.year = ?',
      ...scopeClauses(options, params)
    ];
    if (album.year !== undefined) params.splice(4, 0, album.year);

    const rows = database.query(`
      SELECT m.*, l.name AS library_name,
             p.id AS progress_id, p.user_id AS progress_user_id,
             p.position_seconds, p.duration_seconds AS progress_duration,
             p.progress_percent, p.completed, p.last_watched_at
      FROM media_items m
      JOIN libraries l ON l.id = m.library_id
      LEFT JOIN watch_progress p ON p.media_id = m.id AND p.user_id = ?
      WHERE ${clauses.join(' AND ')}
      ORDER BY
        CASE WHEN m.disc_number IS NULL THEN 1 ELSE 0 END,
        m.disc_number ASC,
        CASE WHEN m.track_number IS NULL THEN 1 ELSE 0 END,
        m.track_number ASC,
        m.relative_path COLLATE NOCASE ASC,
        m.id ASC
    `).all(...params as any[]) as Array<Record<string, any>>;

    return { album, tracks: rows.map(formatTrack) };
  };

  return { getArtists, getArtist, getAlbums, getAlbum };
}
