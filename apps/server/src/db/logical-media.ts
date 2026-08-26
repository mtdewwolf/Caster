import crypto from 'crypto';

/**
 * Logical media identity: the work, not the file.
 *
 * `media_items` has always been one row per file, which makes a film that
 * exists as both a 4K remux and a 1080p encode into two unrelated items with
 * separate watch history. A *title* is the thing a person means when they say
 * "that film" or "that episode"; the files underneath it are versions.
 *
 * Identity is derived from what the scanner already parses, so the same file
 * always lands on the same title no matter how many times it is rescanned.
 */

export type TitleKind = 'movie' | 'episode' | 'video';

/** Media types that have a logical title. Music has its own model. */
export function hasLogicalTitle(type: string): type is TitleKind {
  return type === 'movie' || type === 'episode' || type === 'video';
}

/**
 * Folds a name down to the part that identifies the work.
 *
 * Two files for the same film routinely differ in punctuation and case —
 * "Blade Runner 2049" and "Blade.Runner.2049" — so the natural key is built
 * from the folded form rather than the raw title.
 */
export function normalizeName(name: string): string {
  return name
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/['’`]/g, '')
    .replace(/[^a-z0-9]+/g, ' ')
    .trim()
    .replace(/\s+/g, ' ');
}

/**
 * Identifier for a show.
 *
 * Deliberately the same derivation the metadata layer already used for its
 * series subject, so existing series metadata points at these rows without any
 * remapping — the derived identity becomes a real row rather than a
 * coincidence two subsystems happened to agree on.
 */
export function showIdFor(libraryId: string, seriesTitle: string): string {
  return `ser_${crypto.createHash('md5')
    .update(`${libraryId}::${seriesTitle}`)
    .digest('hex')
    .substring(0, 16)}`;
}

export interface TitleIdentityInput {
  libraryId: string;
  type: string;
  title: string;
  seriesTitle?: string | null | undefined;
  seasonNumber?: number | null | undefined;
  episodeNumber?: number | null | undefined;
  year?: number | null | undefined;
}

export interface TitleIdentity {
  id: string;
  naturalKey: string;
  kind: TitleKind;
  libraryId: string;
  showId: string | null;
  seasonNumber: number | null;
  episodeNumber: number | null;
  name: string;
  year: number | null;
}

/**
 * Works out which title a scanned file belongs to.
 *
 * Returns null for anything without a logical identity — music tracks, and
 * episodes with no series or numbering, where guessing would merge unrelated
 * files under one title.
 */
export function titleIdentityFor(input: TitleIdentityInput): TitleIdentity | null {
  if (!hasLogicalTitle(input.type)) return null;

  const name = input.title?.trim();
  if (!name) return null;

  if (input.type === 'episode') {
    const seriesTitle = input.seriesTitle?.trim();
    if (!seriesTitle) return null;
    if (input.seasonNumber === null || input.seasonNumber === undefined) return null;
    if (input.episodeNumber === null || input.episodeNumber === undefined) return null;

    const showId = showIdFor(input.libraryId, seriesTitle);
    const naturalKey = `${showId}|s${input.seasonNumber}|e${input.episodeNumber}`;

    return {
      id: titleIdFor(naturalKey),
      naturalKey,
      kind: 'episode',
      libraryId: input.libraryId,
      showId,
      seasonNumber: input.seasonNumber,
      episodeNumber: input.episodeNumber,
      name,
      year: input.year ?? null
    };
  }

  // A movie is identified by its folded name and year. Without a year, two
  // remakes would collapse together, so the key keeps the distinction explicit.
  const folded = normalizeName(name);
  if (!folded) return null;
  const naturalKey = `${input.libraryId}|${input.type}|${folded}|${input.year ?? ''}`;

  return {
    id: titleIdFor(naturalKey),
    naturalKey,
    kind: input.type,
    libraryId: input.libraryId,
    showId: null,
    seasonNumber: null,
    episodeNumber: null,
    name,
    year: input.year ?? null
  };
}

export function titleIdFor(naturalKey: string): string {
  return `ttl_${crypto.createHash('sha256').update(naturalKey).digest('hex').substring(0, 24)}`;
}

/**
 * How one version differs from the others under the same title.
 *
 * Purely descriptive — a label for a picker, not an identity. Two files with
 * identical labels are still separate versions.
 */
export function versionLabelFor(item: {
  resolution_label?: string | null | undefined;
  video_codec?: string | null | undefined;
  is_hdr?: boolean | number | null | undefined;
  audio_channel_layout?: string | null | undefined;
  format?: string | null | undefined;
}): string {
  const parts = [
    item.resolution_label,
    item.is_hdr ? 'HDR' : null,
    item.video_codec?.toUpperCase(),
    item.audio_channel_layout,
    item.format?.toUpperCase()
  ].filter((part): part is string => Boolean(part && String(part).trim()));

  return parts.length > 0 ? parts.join(' · ') : 'Original';
}
