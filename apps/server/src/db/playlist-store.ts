import crypto from 'crypto';
import type { Database } from 'bun:sqlite';

export interface PlaylistRecord {
  id: string;
  user_id: string;
  name: string;
  revision: number;
  item_count: number;
  created_at: string;
  updated_at: string;
}

export interface PlaylistItemRecord {
  id: string;
  playlist_id: string;
  media_id: string;
  position: number;
  added_at: string;
}

export class PlaylistConflictError extends Error {}
export class PlaylistNotFoundError extends Error {}

function normalizedName(name: string): string {
  const value = name.trim();
  if (value.length < 1 || value.length > 120) {
    throw new RangeError('Playlist name must be between 1 and 120 characters');
  }
  return value;
}

function inTransaction(database: Database, operation: () => void): void {
  database.run('BEGIN IMMEDIATE');
  try {
    operation();
    database.run('COMMIT');
  } catch (error) {
    try {
      database.run('ROLLBACK');
    } catch {
      // Preserve the original failure.
    }
    throw error;
  }
}

export class PlaylistStore {
  constructor(private readonly database: Database) {}

  list(userId: string): PlaylistRecord[] {
    return this.database.query(`
      SELECT p.*, COUNT(pi.id) AS item_count
      FROM playlists p
      LEFT JOIN playlist_items pi ON pi.playlist_id = p.id
      WHERE p.user_id = ?
      GROUP BY p.id
      ORDER BY p.updated_at DESC, p.name COLLATE NOCASE ASC
    `).all(userId) as PlaylistRecord[];
  }

  get(userId: string, playlistId: string): PlaylistRecord | null {
    return this.database.query(`
      SELECT p.*, COUNT(pi.id) AS item_count
      FROM playlists p
      LEFT JOIN playlist_items pi ON pi.playlist_id = p.id
      WHERE p.user_id = ? AND p.id = ?
      GROUP BY p.id
    `).get(userId, playlistId) as PlaylistRecord | null;
  }

  items(userId: string, playlistId: string): PlaylistItemRecord[] | null {
    if (!this.get(userId, playlistId)) return null;
    return this.database.query(`
      SELECT id, playlist_id, media_id, position, added_at
      FROM playlist_items
      WHERE playlist_id = ?
      ORDER BY position ASC, id ASC
    `).all(playlistId) as PlaylistItemRecord[];
  }

  create(userId: string, name: string): PlaylistRecord {
    const now = new Date().toISOString();
    const id = `playlist_${crypto.randomUUID()}`;
    this.database.run(`
      INSERT INTO playlists (id, user_id, name, revision, created_at, updated_at)
      VALUES (?, ?, ?, 1, ?, ?)
    `, [id, userId, normalizedName(name), now, now]);
    return this.get(userId, id)!;
  }

  rename(userId: string, playlistId: string, name: string, expectedRevision: number): PlaylistRecord {
    const result = this.database.run(`
      UPDATE playlists
      SET name = ?, revision = revision + 1, updated_at = ?
      WHERE id = ? AND user_id = ? AND revision = ?
    `, [normalizedName(name), new Date().toISOString(), playlistId, userId, expectedRevision]);
    if (result.changes === 0) this.throwMissingOrConflict(userId, playlistId);
    return this.get(userId, playlistId)!;
  }

  delete(userId: string, playlistId: string): boolean {
    return this.database.run(
      'DELETE FROM playlists WHERE id = ? AND user_id = ?',
      [playlistId, userId]
    ).changes > 0;
  }

  addItem(
    userId: string,
    playlistId: string,
    mediaId: string,
    requestedPosition?: number
  ): { playlist: PlaylistRecord; item: PlaylistItemRecord } {
    let item!: PlaylistItemRecord;
    inTransaction(this.database, () => {
      const playlist = this.get(userId, playlistId);
      if (!playlist) throw new PlaylistNotFoundError('Playlist not found');
      const count = playlist.item_count;
      const position = requestedPosition === undefined ? count : requestedPosition;
      if (!Number.isSafeInteger(position) || position < 0 || position > count) {
        throw new RangeError('position must be between 0 and the playlist length');
      }
      this.database.run(`
        UPDATE playlist_items SET position = position + 1
        WHERE playlist_id = ? AND position >= ?
      `, [playlistId, position]);
      const now = new Date().toISOString();
      item = {
        id: `playlist_item_${crypto.randomUUID()}`,
        playlist_id: playlistId,
        media_id: mediaId,
        position,
        added_at: now
      };
      this.database.run(`
        INSERT INTO playlist_items (id, playlist_id, media_id, position, added_at)
        VALUES (?, ?, ?, ?, ?)
      `, [item.id, playlistId, mediaId, position, now]);
      this.database.run(`
        UPDATE playlists SET revision = revision + 1, updated_at = ? WHERE id = ?
      `, [now, playlistId]);
    });
    return { playlist: this.get(userId, playlistId)!, item };
  }

  reorder(userId: string, playlistId: string, itemIds: string[], expectedRevision: number): PlaylistRecord {
    inTransaction(this.database, () => {
      const playlist = this.get(userId, playlistId);
      if (!playlist) throw new PlaylistNotFoundError('Playlist not found');
      if (playlist.revision !== expectedRevision) throw new PlaylistConflictError('Playlist changed');
      const currentIds = (this.items(userId, playlistId) || []).map((item) => item.id);
      if (
        currentIds.length !== itemIds.length
        || new Set(itemIds).size !== itemIds.length
        || currentIds.some((id) => !itemIds.includes(id))
      ) {
        throw new RangeError('itemIds must contain every playlist item exactly once');
      }
      const update = this.database.prepare(
        'UPDATE playlist_items SET position = ? WHERE playlist_id = ? AND id = ?'
      );
      itemIds.forEach((id, position) => update.run(position, playlistId, id));
      this.database.run(`
        UPDATE playlists SET revision = revision + 1, updated_at = ? WHERE id = ?
      `, [new Date().toISOString(), playlistId]);
    });
    return this.get(userId, playlistId)!;
  }

  removeItem(userId: string, playlistId: string, itemId: string): PlaylistRecord | null {
    let removed = false;
    inTransaction(this.database, () => {
      if (!this.get(userId, playlistId)) throw new PlaylistNotFoundError('Playlist not found');
      const row = this.database.query(`
        SELECT position FROM playlist_items WHERE playlist_id = ? AND id = ?
      `).get(playlistId, itemId) as { position: number } | null;
      if (!row) return;
      this.database.run('DELETE FROM playlist_items WHERE playlist_id = ? AND id = ?', [playlistId, itemId]);
      this.database.run(`
        UPDATE playlist_items SET position = position - 1
        WHERE playlist_id = ? AND position > ?
      `, [playlistId, row.position]);
      this.database.run(`
        UPDATE playlists SET revision = revision + 1, updated_at = ? WHERE id = ?
      `, [new Date().toISOString(), playlistId]);
      removed = true;
    });
    return removed ? this.get(userId, playlistId) : null;
  }

  private throwMissingOrConflict(userId: string, playlistId: string): never {
    if (!this.get(userId, playlistId)) throw new PlaylistNotFoundError('Playlist not found');
    throw new PlaylistConflictError('Playlist changed');
  }
}
