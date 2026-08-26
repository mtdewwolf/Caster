import crypto from 'crypto';
import type { MediaItem } from '../types';
import type { MetadataMatchRequest } from './provider';
// Series metadata is keyed by the same identifier the shows table uses, so the
// subject of a series metadata row is a real row rather than a parallel scheme.
import { showIdFor as seriesSubjectId } from '../db/logical-media';

export const DEFAULT_AUTOMATIC_MATCH_CONFIDENCE = 0.9;

type ScannerMetadataItem = Pick<
  MediaItem,
  'type' | 'title' | 'series_title' | 'season_number' | 'episode_number' | 'year'
> & { id?: string; library_id?: string };

export interface MetadataMatchSubject {
  type: 'media' | 'series';
  id: string;
}

export interface MetadataMatchPlan {
  /** What the resulting metadata is stored against. */
  subject: MetadataMatchSubject;
  request: MetadataMatchRequest;
  /**
   * Digest of the search terms. An unchanged rescan produces the same value,
   * which is how a repeated provider request is avoided.
   */
  fingerprint: string;
}

function fingerprintFor(request: MetadataMatchRequest): string {
  return crypto.createHash('sha256')
    .update(JSON.stringify([
      request.entityType,
      request.title.trim().toLowerCase(),
      request.year ?? null,
      request.seriesTitle?.trim().toLowerCase() ?? null
    ]))
    .digest('hex')
    .substring(0, 32);
}

/**
 * Converts scanner-owned local metadata into the provider contract.
 *
 * Episodes are matched as their **show**, not as individual episodes: the
 * descriptive metadata a person wants on a TV item (overview, cast, artwork)
 * belongs to the series, and no v1 provider implements episode-level lookup.
 * Music and home videos are outside the movie/TV provider scope and return
 * null rather than being sent to a provider that would reject them.
 */
export function createMetadataMatchRequest(
  item: ScannerMetadataItem,
  minimumConfidence = DEFAULT_AUTOMATIC_MATCH_CONFIDENCE
): MetadataMatchRequest | null {
  if (item.type === 'movie') {
    return {
      entityType: 'movie',
      title: item.title,
      year: item.year,
      minimumConfidence
    };
  }

  if (item.type === 'episode' && item.series_title) {
    return {
      entityType: 'show',
      title: item.series_title,
      seriesTitle: item.series_title,
      year: item.year,
      minimumConfidence
    };
  }

  return null;
}

/**
 * Full enrichment plan for one scanned item: what to ask a provider, what to
 * store the answer against, and how to tell a repeat request from a new one.
 */
export function planMetadataMatch(
  item: ScannerMetadataItem,
  minimumConfidence = DEFAULT_AUTOMATIC_MATCH_CONFIDENCE
): MetadataMatchPlan | null {
  const request = createMetadataMatchRequest(item, minimumConfidence);
  if (!request) return null;

  if (request.entityType === 'show') {
    if (!item.library_id || !item.series_title) return null;
    return {
      subject: { type: 'series', id: seriesSubjectId(item.library_id, item.series_title) },
      request,
      fingerprint: fingerprintFor(request)
    };
  }

  if (!item.id) return null;
  return {
    subject: { type: 'media', id: item.id },
    request,
    fingerprint: fingerprintFor(request)
  };
}
