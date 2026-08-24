import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import { Database } from 'bun:sqlite';
import {
  createMusicLibraryStore,
  musicAlbumId,
  musicArtistId
} from '../apps/server/src/db/music-library';

let database: Database;

function insertTrack(values: {
  id: string;
  libraryId?: string;
  title: string;
  artist?: string;
  albumArtist?: string;
  album?: string;
  year?: number;
  disc?: number;
  track?: number;
  relativePath?: string;
  rating?: number;
}) {
  database.run(`
    INSERT INTO media_items (
      id, library_id, title, relative_path, type, artist, album_artist, album,
      year, disc_number, track_number, duration, poster_path,
      content_rating_level, is_hdr
    ) VALUES (?, ?, ?, ?, 'track', ?, ?, ?, ?, ?, ?, 180, NULL, ?, 0)
  `, [
    values.id,
    values.libraryId || 'library-1',
    values.title,
    values.relativePath || `${values.id}.flac`,
    values.artist || null,
    values.albumArtist || null,
    values.album || null,
    values.year || null,
    values.disc || null,
    values.track || null,
    values.rating ?? null
  ]);
}

beforeEach(() => {
  database = new Database(':memory:');
  database.run('PRAGMA foreign_keys = ON');
  database.run(`
    CREATE TABLE libraries (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL
    );
    CREATE TABLE media_items (
      id TEXT PRIMARY KEY,
      library_id TEXT NOT NULL REFERENCES libraries(id),
      title TEXT NOT NULL,
      relative_path TEXT NOT NULL,
      type TEXT NOT NULL,
      artist TEXT,
      album_artist TEXT,
      album TEXT,
      year INTEGER,
      disc_number INTEGER,
      track_number INTEGER,
      genre TEXT,
      duration REAL NOT NULL DEFAULT 0,
      poster_path TEXT,
      content_rating_level INTEGER,
      is_hdr INTEGER NOT NULL DEFAULT 0
    );
    CREATE TABLE watch_progress (
      id TEXT PRIMARY KEY,
      user_id TEXT NOT NULL,
      media_id TEXT NOT NULL REFERENCES media_items(id),
      position_seconds REAL NOT NULL,
      duration_seconds REAL NOT NULL,
      progress_percent REAL NOT NULL,
      completed INTEGER NOT NULL,
      last_watched_at TEXT NOT NULL,
      UNIQUE(user_id, media_id)
    );
  `);
  database.run("INSERT INTO libraries VALUES ('library-1', 'Music'), ('library-2', 'Other Music')");
});

afterEach(() => database.close());

describe('music library rollups', () => {
  it('groups artists and albums with stable case-insensitive identities', () => {
    insertTrack({ id: 'a1', title: 'One', artist: 'Aurora', albumArtist: 'Aurora', album: 'Dawn', year: 2020 });
    insertTrack({ id: 'a2', title: 'Two', artist: 'AURORA', albumArtist: 'AURORA', album: 'DAWN', year: 2020 });
    insertTrack({ id: 'a3', title: 'Elsewhere', artist: 'Aurora', albumArtist: 'Aurora', album: 'Dusk', year: 2021 });

    const store = createMusicLibraryStore(database);
    const artists = store.getArtists();
    const albums = store.getAlbums();

    expect(artists).toHaveLength(1);
    expect(artists[0]).toMatchObject({ album_count: 2, track_count: 3 });
    expect(artists[0].id).toBe(musicArtistId('library-1', 'aurora'));
    expect(albums).toHaveLength(2);
    expect(albums.find((album) => album.year === 2020)?.id)
      .toBe(musicAlbumId('library-1', 'aurora', 'dawn', 2020));
  });

  it('orders album tracks by disc, track, relative path, and id', () => {
    insertTrack({ id: 'unknown-z', title: 'Unknown Z', artist: 'Artist', album: 'Album', relativePath: 'Album/z.flac' });
    insertTrack({ id: 'disc-2', title: 'Disc Two', artist: 'Artist', album: 'Album', disc: 2, track: 1 });
    insertTrack({ id: 'track-2', title: 'Second', artist: 'Artist', album: 'Album', disc: 1, track: 2 });
    insertTrack({ id: 'track-1', title: 'First', artist: 'Artist', album: 'Album', disc: 1, track: 1 });
    insertTrack({ id: 'unknown-a', title: 'Unknown A', artist: 'Artist', album: 'Album', relativePath: 'Album/a.flac' });

    database.run(`
      INSERT INTO watch_progress VALUES (
        'progress-1', 'viewer-1', 'track-1', 25, 180, 14, 0, '2026-01-01T00:00:00.000Z'
      )
    `);

    const store = createMusicLibraryStore(database);
    const album = store.getAlbums()[0];
    const detail = store.getAlbum(album.id, { userId: 'viewer-1' });

    expect(detail?.tracks.map((track) => track.id)).toEqual([
      'track-1', 'track-2', 'disc-2', 'unknown-a', 'unknown-z'
    ]);
    expect(detail?.tracks[0].progress).toMatchObject({
      user_id: 'viewer-1',
      position_seconds: 25
    });
  });

  it('applies library and rating scope before rollup counts and lookup', () => {
    insertTrack({ id: 'visible', title: 'Visible', artist: 'Artist', album: 'Open', rating: 1 });
    insertTrack({ id: 'restricted', title: 'Restricted', artist: 'Artist', album: 'Restricted', rating: 4 });
    insertTrack({ id: 'unrated', title: 'Unrated', artist: 'Artist', album: 'Open' });
    insertTrack({ id: 'other-library', libraryId: 'library-2', title: 'Other', artist: 'Artist', album: 'Other' });

    const store = createMusicLibraryStore(database);
    const options = {
      allowedLibraryIds: ['library-1'],
      contentRatingScope: { maxLevel: 2, allowUnrated: true }
    } as const;
    const artists = store.getArtists(options);
    const albums = store.getAlbums(options);

    expect(artists).toHaveLength(1);
    expect(artists[0]).toMatchObject({ track_count: 2, album_count: 1 });
    expect(albums.map((album) => album.title)).toEqual(['Open']);

    const unrestrictedRestrictedAlbum = store.getAlbums().find((album) => album.title === 'Restricted')!;
    expect(store.getAlbum(unrestrictedRestrictedAlbum.id, options)).toBeNull();
    expect(store.getArtists({ allowedLibraryIds: [] })).toEqual([]);
  });
});

