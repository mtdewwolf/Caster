import { Database } from 'bun:sqlite';
import crypto from 'crypto';

export const MEDIA_MARKER_TYPES = ['intro', 'credits'] as const;

export type MediaMarkerType = (typeof MEDIA_MARKER_TYPES)[number];
export type MediaMarkerState = 'active' | 'disabled';

export interface MediaMarker {
  id: string;
  mediaId: string;
  type: MediaMarkerType;
  startSeconds: number | null;
  endSeconds: number | null;
  state: MediaMarkerState;
  source: string;
  confidence: number | null;
  analyzerVersion: string | null;
  revision: number;
  createdAt: string;
  updatedAt: string;
}

export interface MarkerRangeInput {
  mediaId: string;
  type: MediaMarkerType;
  startSeconds: number;
  endSeconds: number;
}

export interface DetectedMarkerInput extends MarkerRangeInput {
  source: string;
  confidence?: number | null;
  analyzerVersion?: string | null;
}

interface MediaMarkerRow {
  id: string;
  media_id: string;
  marker_type: MediaMarkerType;
  start_seconds: number | null;
  end_seconds: number | null;
  state: MediaMarkerState;
  source: string;
  confidence: number | null;
  analyzer_version: string | null;
  revision: number;
  created_at: string;
  updated_at: string;
}

export function isMediaMarkerType(value: string): value is MediaMarkerType {
  return (MEDIA_MARKER_TYPES as readonly string[]).includes(value);
}

function assertMarkerRange(startSeconds: number, endSeconds: number): void {
  if (!Number.isFinite(startSeconds) || startSeconds < 0) {
    throw new TypeError('startSeconds must be a non-negative finite number');
  }
  if (!Number.isFinite(endSeconds) || endSeconds <= startSeconds) {
    throw new TypeError('endSeconds must be a finite number greater than startSeconds');
  }
}

function mapMarker(row: MediaMarkerRow): MediaMarker {
  return {
    id: row.id,
    mediaId: row.media_id,
    type: row.marker_type,
    startSeconds: row.start_seconds,
    endSeconds: row.end_seconds,
    state: row.state,
    source: row.source,
    confidence: row.confidence,
    analyzerVersion: row.analyzer_version,
    revision: row.revision,
    createdAt: row.created_at,
    updatedAt: row.updated_at
  };
}

/**
 * Persistence and precedence rules for episode playback markers.
 *
 * Manual ranges always replace detector output. A manual disable is stored as
 * a tombstone so a later detector run cannot silently recreate that marker.
 */
export class MediaMarkerStore {
  constructor(
    private readonly database: Database,
    private readonly now: () => string = () => new Date().toISOString()
  ) {}

  get(mediaId: string, type: MediaMarkerType): MediaMarker | null {
    const row = this.database.query(`
      SELECT * FROM media_markers
      WHERE media_id = ? AND marker_type = ?
    `).get(mediaId, type) as MediaMarkerRow | null;
    return row ? mapMarker(row) : null;
  }

  getAll(mediaId: string): MediaMarker[] {
    const rows = this.database.query(`
      SELECT * FROM media_markers
      WHERE media_id = ?
      ORDER BY CASE marker_type WHEN 'intro' THEN 0 ELSE 1 END, start_seconds
    `).all(mediaId) as MediaMarkerRow[];
    return rows.map(mapMarker);
  }

  getActive(mediaId: string): MediaMarker[] {
    const rows = this.database.query(`
      SELECT * FROM media_markers
      WHERE media_id = ? AND state = 'active'
      ORDER BY start_seconds, CASE marker_type WHEN 'intro' THEN 0 ELSE 1 END
    `).all(mediaId) as MediaMarkerRow[];
    return rows.map(mapMarker);
  }

  upsertManual(input: MarkerRangeInput): MediaMarker {
    assertMarkerRange(input.startSeconds, input.endSeconds);
    const timestamp = this.now();
    this.database.run(`
      INSERT INTO media_markers (
        id, media_id, marker_type, start_seconds, end_seconds, state, source,
        confidence, analyzer_version, revision, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, 'active', 'manual', NULL, NULL, 1, ?, ?)
      ON CONFLICT(media_id, marker_type) DO UPDATE SET
        start_seconds = excluded.start_seconds,
        end_seconds = excluded.end_seconds,
        state = 'active',
        source = 'manual',
        confidence = NULL,
        analyzer_version = NULL,
        revision = media_markers.revision + 1,
        updated_at = excluded.updated_at
    `, [
      `marker_${crypto.randomUUID()}`,
      input.mediaId,
      input.type,
      input.startSeconds,
      input.endSeconds,
      timestamp,
      timestamp
    ]);
    return this.require(input.mediaId, input.type);
  }

  disableManual(mediaId: string, type: MediaMarkerType): MediaMarker {
    const timestamp = this.now();
    this.database.run(`
      INSERT INTO media_markers (
        id, media_id, marker_type, start_seconds, end_seconds, state, source,
        confidence, analyzer_version, revision, created_at, updated_at
      ) VALUES (?, ?, ?, NULL, NULL, 'disabled', 'manual', NULL, NULL, 1, ?, ?)
      ON CONFLICT(media_id, marker_type) DO UPDATE SET
        start_seconds = NULL,
        end_seconds = NULL,
        state = 'disabled',
        source = 'manual',
        confidence = NULL,
        analyzer_version = NULL,
        revision = media_markers.revision + 1,
        updated_at = excluded.updated_at
    `, [`marker_${crypto.randomUUID()}`, mediaId, type, timestamp, timestamp]);
    return this.require(mediaId, type);
  }

  /**
   * Saves detector output unless an administrator has already corrected or
   * disabled the marker. The returned value is the effective stored marker.
   */
  upsertDetected(input: DetectedMarkerInput): MediaMarker {
    assertMarkerRange(input.startSeconds, input.endSeconds);
    const source = input.source.trim();
    if (!source || source === 'manual') {
      throw new TypeError('Detected marker source must identify a non-manual detector');
    }
    if (
      input.confidence !== undefined && input.confidence !== null &&
      (!Number.isFinite(input.confidence) || input.confidence < 0 || input.confidence > 1)
    ) {
      throw new TypeError('confidence must be between 0 and 1');
    }

    const timestamp = this.now();
    this.database.run(`
      INSERT INTO media_markers (
        id, media_id, marker_type, start_seconds, end_seconds, state, source,
        confidence, analyzer_version, revision, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, 'active', ?, ?, ?, 1, ?, ?)
      ON CONFLICT(media_id, marker_type) DO UPDATE SET
        start_seconds = excluded.start_seconds,
        end_seconds = excluded.end_seconds,
        state = 'active',
        source = excluded.source,
        confidence = excluded.confidence,
        analyzer_version = excluded.analyzer_version,
        revision = media_markers.revision + 1,
        updated_at = excluded.updated_at
      WHERE media_markers.source != 'manual' AND media_markers.state != 'disabled'
    `, [
      `marker_${crypto.randomUUID()}`,
      input.mediaId,
      input.type,
      input.startSeconds,
      input.endSeconds,
      source,
      input.confidence ?? null,
      input.analyzerVersion ?? null,
      timestamp,
      timestamp
    ]);
    return this.require(input.mediaId, input.type);
  }

  private require(mediaId: string, type: MediaMarkerType): MediaMarker {
    const marker = this.get(mediaId, type);
    if (!marker) throw new Error(`Marker ${mediaId}/${type} was not persisted`);
    return marker;
  }
}
