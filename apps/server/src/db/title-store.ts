import type { Database } from 'bun:sqlite';
import {
  titleIdentityFor,
  versionLabelFor,
  type TitleIdentity,
  type TitleIdentityInput
} from './logical-media';

export interface Title {
  id: string;
  libraryId: string;
  kind: string;
  showId: string | null;
  seasonNumber: number | null;
  episodeNumber: number | null;
  name: string;
  year: number | null;
  versionCount: number;
}

export interface MediaVersion {
  mediaId: string;
  label: string;
  resolutionLabel: string | null;
  videoCodec: string | null;
  audioCodec: string | null;
  audioChannelLayout: string | null;
  isHdr: boolean;
  format: string;
  durationSeconds: number;
  sizeBytes: number;
  /** True for the version the server would pick by default. */
  isPreferred: boolean;
}

export interface MediaStreamRecord {
  streamIndex: number;
  codecType: string;
  codecName: string | null;
  language: string | null;
  title: string | null;
  channels: number | null;
  channelLayout: string | null;
  width: number | null;
  height: number | null;
  isDefault: boolean;
  isForced: boolean;
  isExternal: boolean;
}

/**
 * Logical titles and the files that realise them.
 *
 * The scanner still indexes files; this is what groups them. One film held as
 * both a 4K remux and a 1080p encode is one title with two versions, which is
 * what lets a person switch quality without losing their place.
 */
export class TitleStore {
  constructor(private readonly database: Database) {}

  /**
   * Finds or creates the title a scanned file belongs to, and links the file
   * to it. Returns null for media with no logical identity.
   */
  linkMedia(mediaId: string, input: TitleIdentityInput): TitleIdentity | null {
    const identity = titleIdentityFor(input);
    if (!identity) {
      this.database.run('UPDATE media_items SET title_id = NULL WHERE id = ?', [mediaId]);
      return null;
    }

    const now = new Date().toISOString();

    if (identity.showId) {
      this.database.run(`
        INSERT INTO shows (id, library_id, name, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?)
        ON CONFLICT(id) DO UPDATE SET name = excluded.name, updated_at = excluded.updated_at
      `, [identity.showId, identity.libraryId, input.seriesTitle!.trim(), now, now]);
    }

    this.database.run(`
      INSERT INTO titles (
        id, library_id, kind, show_id, season_number, episode_number,
        name, year, natural_key, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET
        name = excluded.name,
        year = excluded.year,
        library_id = excluded.library_id,
        updated_at = excluded.updated_at
    `, [
      identity.id, identity.libraryId, identity.kind, identity.showId,
      identity.seasonNumber, identity.episodeNumber,
      identity.name, identity.year, identity.naturalKey, now, now
    ]);

    this.database.run('UPDATE media_items SET title_id = ? WHERE id = ?', [identity.id, mediaId]);
    return identity;
  }

  getTitle(titleId: string): Title | null {
    const row = this.database.query(`
      SELECT t.*, (SELECT COUNT(*) FROM media_items m WHERE m.title_id = t.id) AS version_count
      FROM titles t WHERE t.id = ?
    `).get(titleId) as Record<string, any> | null;
    return row ? formatTitle(row) : null;
  }

  titleIdForMedia(mediaId: string): string | null {
    const row = this.database.query(
      'SELECT title_id FROM media_items WHERE id = ?'
    ).get(mediaId) as { title_id: string | null } | null;
    return row?.title_id ?? null;
  }

  /**
   * Every playable file under a title, best first.
   *
   * "Best" is resolution then bitrate: the highest-fidelity copy is the one a
   * person means by default, and anything else is an explicit downgrade.
   */
  getVersions(titleId: string): MediaVersion[] {
    const rows = this.database.query(`
      SELECT id, resolution_label, video_codec, audio_codec, audio_channel_layout,
             is_hdr, format, duration, size_bytes, width, height, bit_rate
      FROM media_items
      WHERE title_id = ?
      ORDER BY COALESCE(height, 0) DESC, COALESCE(bit_rate, 0) DESC, id ASC
    `).all(titleId) as Array<Record<string, any>>;

    return rows.map((row, index) => ({
      mediaId: row.id,
      label: versionLabelFor(row),
      resolutionLabel: row.resolution_label ?? null,
      videoCodec: row.video_codec ?? null,
      audioCodec: row.audio_codec ?? null,
      audioChannelLayout: row.audio_channel_layout ?? null,
      isHdr: Boolean(row.is_hdr),
      format: row.format,
      durationSeconds: row.duration ?? 0,
      sizeBytes: row.size_bytes ?? 0,
      isPreferred: index === 0
    }));
  }

  /** Versions of the title this file belongs to, including the file itself. */
  getVersionsForMedia(mediaId: string): MediaVersion[] {
    const titleId = this.titleIdForMedia(mediaId);
    return titleId ? this.getVersions(titleId) : [];
  }

  replaceStreams(mediaId: string, streams: readonly Record<string, any>[]): void {
    this.database.run('DELETE FROM media_streams WHERE media_id = ?', [mediaId]);

    for (const stream of streams) {
      if (!Number.isSafeInteger(stream?.index) || typeof stream?.codec_type !== 'string') continue;
      this.database.run(`
        INSERT OR REPLACE INTO media_streams (
          media_id, stream_index, codec_type, codec_name, language, title,
          channels, channel_layout, width, height, is_default, is_forced, is_external
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `, [
        mediaId, stream.index, stream.codec_type, stream.codec_name ?? null,
        stream.language ?? null, stream.title ?? null,
        stream.channels ?? null, stream.channel_layout ?? null,
        stream.width ?? null, stream.height ?? null,
        stream.is_default ? 1 : 0, stream.is_forced ? 1 : 0, stream.is_external ? 1 : 0
      ]);
    }
  }

  getStreams(mediaId: string): MediaStreamRecord[] {
    const rows = this.database.query(`
      SELECT stream_index, codec_type, codec_name, language, title,
             channels, channel_layout, width, height, is_default, is_forced, is_external
      FROM media_streams WHERE media_id = ? ORDER BY stream_index ASC
    `).all(mediaId) as Array<Record<string, any>>;

    return rows.map((row) => ({
      streamIndex: row.stream_index,
      codecType: row.codec_type,
      codecName: row.codec_name ?? null,
      language: row.language ?? null,
      title: row.title ?? null,
      channels: row.channels ?? null,
      channelLayout: row.channel_layout ?? null,
      width: row.width ?? null,
      height: row.height ?? null,
      isDefault: row.is_default === 1,
      isForced: row.is_forced === 1,
      isExternal: row.is_external === 1
    }));
  }

  /** Removes titles and shows nothing points at any more. */
  pruneEmpty(): { titles: number; shows: number } {
    const titles = this.database.run(`
      DELETE FROM titles
      WHERE id NOT IN (SELECT title_id FROM media_items WHERE title_id IS NOT NULL)
    `);
    const shows = this.database.run(`
      DELETE FROM shows
      WHERE id NOT IN (SELECT show_id FROM titles WHERE show_id IS NOT NULL)
    `);
    return { titles: titles.changes, shows: shows.changes };
  }
}

function formatTitle(row: Record<string, any>): Title {
  return {
    id: row.id,
    libraryId: row.library_id,
    kind: row.kind,
    showId: row.show_id ?? null,
    seasonNumber: row.season_number ?? null,
    episodeNumber: row.episode_number ?? null,
    name: row.name,
    year: row.year ?? null,
    versionCount: row.version_count ?? 0
  };
}
