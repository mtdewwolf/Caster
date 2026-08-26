import crypto from 'crypto';
import type { Database } from 'bun:sqlite';
import type {
  MetadataArtwork,
  MetadataCredit,
  MetadataDetails,
  MetadataExternalId
} from '../metadata/provider';

export type MetadataSubjectType = 'media' | 'series';
export type MetadataMatchSource = 'provider' | 'manual';
export type MetadataFetchOutcome =
  | 'matched' | 'ambiguous' | 'not_found' | 'error' | 'skipped';

export interface MetadataSubject {
  type: MetadataSubjectType;
  id: string;
}

export interface StoredMetadata {
  subject: MetadataSubject;
  providerId: string | null;
  externalId: string | null;
  entityType: string | null;
  title: string | null;
  originalTitle: string | null;
  overview: string | null;
  tagline: string | null;
  releaseDate: string | null;
  genres: string[];
  studios: string[];
  networks: string[];
  rating: number | null;
  contentRating: string | null;
  cast: MetadataCredit[];
  crew: MetadataCredit[];
  externalIds: MetadataExternalId[];
  matchConfidence: number | null;
  matchSource: MetadataMatchSource;
  /** A manual correction is never overwritten by an automatic refresh. */
  locked: boolean;
  refreshedAt: string;
  artwork: StoredArtwork[];
}

export interface StoredArtwork {
  providerId: string;
  kind: string;
  /** What clients should load: the local copy when cached, else the provider. */
  url: string;
  /** The provider's original URL, kept so a dropped copy can be re-fetched. */
  remoteUrl: string;
  /** True when this image is served from disk rather than the provider. */
  cached: boolean;
  width: number | null;
  height: number | null;
  language: string | null;
}

export interface SaveMetadataInput {
  subject: MetadataSubject;
  details: MetadataDetails;
  artwork?: readonly MetadataArtwork[];
  matchConfidence?: number;
  matchSource?: MetadataMatchSource;
  locked?: boolean;
  now?: string;
}

export interface FetchLogEntry {
  fingerprint: string;
  outcome: MetadataFetchOutcome;
  attemptedAt: string;
}

/**
 * Stable key for the series a set of episodes belongs to.
 *
 * This is `shows.id`. Series metadata therefore hangs off a real row rather
 * than a derived string two subsystems independently agree on.
 */
export { showIdFor as seriesSubjectId } from './logical-media';

function parseJsonArray<T>(value: unknown): T[] {
  if (typeof value !== 'string' || !value) return [];
  try {
    const parsed = JSON.parse(value);
    return Array.isArray(parsed) ? parsed as T[] : [];
  } catch {
    return [];
  }
}

/**
 * Persists provider-sourced descriptive metadata.
 *
 * Nothing here is on the playback path: a missing row simply means the item
 * shows its scanner-derived title, so a provider outage can never make local
 * media unplayable.
 */
export class MetadataStore {
  constructor(private readonly database: Database) {}

  get(subject: MetadataSubject): StoredMetadata | null {
    const row = this.database.query(`
      SELECT * FROM media_metadata WHERE subject_type = ? AND subject_id = ?
    `).get(subject.type, subject.id) as Record<string, any> | null;
    if (!row) return null;

    return {
      subject,
      providerId: row.provider_id ?? null,
      externalId: row.external_id ?? null,
      entityType: row.entity_type ?? null,
      title: row.title ?? null,
      originalTitle: row.original_title ?? null,
      overview: row.overview ?? null,
      tagline: row.tagline ?? null,
      releaseDate: row.release_date ?? null,
      genres: parseJsonArray<string>(row.genres_json),
      studios: parseJsonArray<string>(row.studios_json),
      networks: parseJsonArray<string>(row.networks_json),
      rating: row.rating ?? null,
      contentRating: row.content_rating ?? null,
      cast: parseJsonArray<MetadataCredit>(row.cast_json),
      crew: parseJsonArray<MetadataCredit>(row.crew_json),
      externalIds: parseJsonArray<MetadataExternalId>(row.external_ids_json),
      matchConfidence: row.match_confidence ?? null,
      matchSource: row.match_source === 'manual' ? 'manual' : 'provider',
      locked: row.locked === 1,
      refreshedAt: row.refreshed_at,
      artwork: this.getArtwork(subject)
    };
  }

  /** Batch lookup so a library page does not issue one query per row. */
  getMany(subjects: readonly MetadataSubject[]): Map<string, StoredMetadata> {
    const found = new Map<string, StoredMetadata>();
    for (const subject of subjects) {
      const metadata = this.get(subject);
      if (metadata) found.set(`${subject.type}:${subject.id}`, metadata);
    }
    return found;
  }

  getArtwork(subject: MetadataSubject): StoredArtwork[] {
    const rows = this.database.query(`
      SELECT provider_id, kind, url, local_file, width, height, language
      FROM metadata_artwork
      WHERE subject_type = ? AND subject_id = ?
      ORDER BY kind ASC, sort_order ASC, id ASC
    `).all(subject.type, subject.id) as Record<string, any>[];

    return rows.map((row) => ({
      providerId: row.provider_id,
      kind: row.kind,
      // Prefer the local copy so the library keeps its artwork when the
      // provider is unreachable, and fall back to the provider otherwise.
      url: row.local_file ? `/api/artwork/${row.local_file}` : row.url,
      remoteUrl: row.url,
      cached: Boolean(row.local_file),
      width: row.width ?? null,
      height: row.height ?? null,
      language: row.language ?? null
    }));
  }

  save(input: SaveMetadataInput): StoredMetadata {
    const now = input.now ?? new Date().toISOString();
    const { subject, details } = input;

    this.database.run(`
      INSERT INTO media_metadata (
        subject_type, subject_id, provider_id, external_id, entity_type,
        title, original_title, overview, tagline, release_date,
        genres_json, studios_json, networks_json, rating, content_rating,
        cast_json, crew_json, external_ids_json,
        match_confidence, match_source, locked, refreshed_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(subject_type, subject_id) DO UPDATE SET
        provider_id = excluded.provider_id,
        external_id = excluded.external_id,
        entity_type = excluded.entity_type,
        title = excluded.title,
        original_title = excluded.original_title,
        overview = excluded.overview,
        tagline = excluded.tagline,
        release_date = excluded.release_date,
        genres_json = excluded.genres_json,
        studios_json = excluded.studios_json,
        networks_json = excluded.networks_json,
        rating = excluded.rating,
        content_rating = excluded.content_rating,
        cast_json = excluded.cast_json,
        crew_json = excluded.crew_json,
        external_ids_json = excluded.external_ids_json,
        match_confidence = excluded.match_confidence,
        match_source = excluded.match_source,
        locked = excluded.locked,
        refreshed_at = excluded.refreshed_at,
        updated_at = excluded.updated_at
    `, [
      subject.type, subject.id,
      details.providerId, details.externalId, details.entityType,
      details.title ?? null,
      details.originalTitle ?? null,
      details.overview ?? null,
      details.tagline ?? null,
      details.releaseDate ?? null,
      JSON.stringify(details.genres ?? []),
      JSON.stringify(details.studios ?? []),
      JSON.stringify(details.networks ?? []),
      details.rating ?? null,
      details.contentRating ?? null,
      JSON.stringify(details.cast ?? []),
      JSON.stringify(details.crew ?? []),
      JSON.stringify(details.externalIds ?? []),
      input.matchConfidence ?? null,
      input.matchSource ?? 'provider',
      input.locked ? 1 : 0,
      now, now
    ]);

    if (input.artwork) this.replaceArtwork(subject, input.artwork);
    return this.get(subject)!;
  }

  replaceArtwork(subject: MetadataSubject, artwork: readonly MetadataArtwork[]): void {
    this.database.run(
      'DELETE FROM metadata_artwork WHERE subject_type = ? AND subject_id = ?',
      [subject.type, subject.id]
    );

    let order = 0;
    for (const image of artwork) {
      this.database.run(`
        INSERT INTO metadata_artwork (
          subject_type, subject_id, provider_id, kind, url, width, height, language, sort_order
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
      `, [
        subject.type, subject.id,
        image.providerId, image.type, image.url,
        image.width ?? null, image.height ?? null, image.language ?? null,
        order++
      ]);
    }
  }

  /** Removes a match so the item falls back to scanner-derived details. */
  clear(subject: MetadataSubject): boolean {
    this.database.run(
      'DELETE FROM metadata_artwork WHERE subject_type = ? AND subject_id = ?',
      [subject.type, subject.id]
    );
    this.database.run(
      'DELETE FROM metadata_fetch_log WHERE subject_type = ? AND subject_id = ?',
      [subject.type, subject.id]
    );
    const result = this.database.run(
      'DELETE FROM media_metadata WHERE subject_type = ? AND subject_id = ?',
      [subject.type, subject.id]
    );
    return result.changes > 0;
  }

  getFetchLog(subject: MetadataSubject): FetchLogEntry | null {
    const row = this.database.query(`
      SELECT fingerprint, outcome, attempted_at FROM metadata_fetch_log
      WHERE subject_type = ? AND subject_id = ?
    `).get(subject.type, subject.id) as Record<string, any> | null;
    if (!row) return null;
    return {
      fingerprint: row.fingerprint,
      outcome: row.outcome,
      attemptedAt: row.attempted_at
    };
  }

  recordFetch(
    subject: MetadataSubject,
    fingerprint: string,
    outcome: MetadataFetchOutcome,
    now: string = new Date().toISOString()
  ): void {
    this.database.run(`
      INSERT INTO metadata_fetch_log (subject_type, subject_id, fingerprint, outcome, attempted_at)
      VALUES (?, ?, ?, ?, ?)
      ON CONFLICT(subject_type, subject_id) DO UPDATE SET
        fingerprint = excluded.fingerprint,
        outcome = excluded.outcome,
        attempted_at = excluded.attempted_at
    `, [subject.type, subject.id, fingerprint, outcome, now]);
  }

  /**
   * True when this subject has already been asked about with these exact
   * search terms and the answer is not worth asking for again.
   *
   * A previous error is always retried; a previous miss is retried only after
   * the caller's cooldown, so a rescan does not hammer the provider.
   */
  shouldSkipFetch(
    subject: MetadataSubject,
    fingerprint: string,
    options: { retryMissAfterMs?: number; now?: number } = {}
  ): boolean {
    const entry = this.getFetchLog(subject);
    if (!entry || entry.fingerprint !== fingerprint) return false;
    if (entry.outcome === 'error') return false;
    if (entry.outcome === 'matched' || entry.outcome === 'skipped') return true;

    const retryAfter = options.retryMissAfterMs ?? 7 * 24 * 60 * 60 * 1000;
    const attemptedAt = Date.parse(entry.attemptedAt);
    if (!Number.isFinite(attemptedAt)) return false;
    return (options.now ?? Date.now()) - attemptedAt < retryAfter;
  }

  /** Drops rows whose media item no longer exists after a scan reconcile. */
  pruneOrphanedMedia(): number {
    const result = this.database.run(`
      DELETE FROM media_metadata
      WHERE subject_type = 'media'
        AND subject_id NOT IN (SELECT id FROM media_items)
    `);
    this.database.run(`
      DELETE FROM metadata_artwork
      WHERE subject_type = 'media'
        AND subject_id NOT IN (SELECT id FROM media_items)
    `);
    this.database.run(`
      DELETE FROM metadata_fetch_log
      WHERE subject_type = 'media'
        AND subject_id NOT IN (SELECT id FROM media_items)
    `);
    return result.changes;
  }
}
