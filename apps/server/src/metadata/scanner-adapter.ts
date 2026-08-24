import type { MediaItem } from '../types';
import type { MetadataMatchRequest } from './provider';

export const DEFAULT_AUTOMATIC_MATCH_CONFIDENCE = 0.9;

type ScannerMetadataItem = Pick<
  MediaItem,
  'type' | 'title' | 'series_title' | 'season_number' | 'episode_number' | 'year'
>;

/**
 * Converts scanner-owned local metadata into the provider contract.
 *
 * Keeping this translation in the metadata layer prevents the scanner from
 * depending on TMDB (or any future vendor). Music and home videos are outside
 * the v1 movie/TV provider scope and intentionally return null.
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
      entityType: 'episode',
      title: item.title,
      year: item.year,
      seriesTitle: item.series_title,
      seasonNumber: item.season_number,
      episodeNumber: item.episode_number,
      minimumConfidence
    };
  }

  return null;
}
