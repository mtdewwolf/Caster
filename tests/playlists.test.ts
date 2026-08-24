import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import { Database } from 'bun:sqlite';
import {
  PlaylistConflictError,
  PlaylistStore
} from '../apps/server/src/db/playlist-store';
import { runDatabaseMigrations } from '../apps/server/src/db/migrations';

describe('user playlists', () => {
  let database: Database;
  let playlists: PlaylistStore;

  beforeEach(() => {
    database = new Database(':memory:');
    database.run('PRAGMA foreign_keys = ON');
    runDatabaseMigrations(database);
    const now = new Date().toISOString();
    database.run(`
      INSERT INTO users (id, username, role, active, created_at, updated_at)
      VALUES ('alice', 'alice', 'viewer', 1, ?, ?),
             ('bob', 'bob', 'viewer', 1, ?, ?)
    `, [now, now, now, now]);
    database.run(`
      INSERT INTO libraries (id, name, path, type, created_at)
      VALUES ('music', 'Music', '/music', 'music', ?)
    `, [now]);
    database.run(`
      INSERT INTO media_items (
        id, library_id, title, original_filename, relative_path, full_path,
        type, created_at, updated_at
      ) VALUES
        ('track-1', 'music', 'One', 'one.flac', 'one.flac', '/music/one.flac', 'track', ?, ?),
        ('track-2', 'music', 'Two', 'two.flac', 'two.flac', '/music/two.flac', 'track', ?, ?)
    `, [now, now, now, now]);
    playlists = new PlaylistStore(database);
  });

  afterEach(() => database.close());

  it('isolates ownership and supports duplicate tracks with dense ordering', () => {
    const playlist = playlists.create('alice', 'Favorites');
    const first = playlists.addItem('alice', playlist.id, 'track-1');
    const second = playlists.addItem('alice', playlist.id, 'track-1');
    const inserted = playlists.addItem('alice', playlist.id, 'track-2', 1);

    expect(playlists.get('bob', playlist.id)).toBeNull();
    expect(playlists.items('alice', playlist.id)?.map((item) => [item.media_id, item.position]))
      .toEqual([['track-1', 0], ['track-2', 1], ['track-1', 2]]);

    playlists.removeItem('alice', playlist.id, inserted.item.id);
    expect(playlists.items('alice', playlist.id)?.map((item) => [item.id, item.position]))
      .toEqual([[first.item.id, 0], [second.item.id, 1]]);
  });

  it('reorders atomically and rejects stale revisions', () => {
    const playlist = playlists.create('alice', 'Road Trip');
    const first = playlists.addItem('alice', playlist.id, 'track-1');
    const second = playlists.addItem('alice', playlist.id, 'track-2');
    const current = playlists.get('alice', playlist.id)!;

    const reordered = playlists.reorder(
      'alice',
      playlist.id,
      [second.item.id, first.item.id],
      current.revision
    );
    expect(reordered.revision).toBe(current.revision + 1);
    expect(playlists.items('alice', playlist.id)?.map((item) => item.media_id))
      .toEqual(['track-2', 'track-1']);
    expect(() => playlists.reorder(
      'alice', playlist.id, [first.item.id, second.item.id], current.revision
    )).toThrow(PlaylistConflictError);
  });

  it('cascades playlist ownership and media item deletion', () => {
    const playlist = playlists.create('alice', 'Disposable');
    playlists.addItem('alice', playlist.id, 'track-1');
    playlists.addItem('alice', playlist.id, 'track-2');

    database.run("DELETE FROM media_items WHERE id = 'track-1'");
    expect(playlists.items('alice', playlist.id)?.map((item) => item.media_id)).toEqual(['track-2']);

    database.run("DELETE FROM users WHERE id = 'alice'");
    expect(database.query('SELECT COUNT(*) AS count FROM playlists').get()).toEqual({ count: 0 });
    expect(database.query('SELECT COUNT(*) AS count FROM playlist_items').get()).toEqual({ count: 0 });
  });
});
