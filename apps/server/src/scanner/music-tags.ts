import path from 'path';

export interface NormalizedMusicTags {
  title: string;
  artist: string;
  albumArtist: string;
  album: string;
  trackNumber?: number;
  discNumber?: number;
  genre?: string;
  year?: number;
}

export interface MusicTagFallbacks {
  filePath: string;
  libraryPath?: string;
  fallbackTitle?: string;
}

const UNKNOWN_ARTIST = 'Unknown Artist';
const UNKNOWN_ALBUM = 'Unknown Album';

function normalizedKey(key: string): string {
  return key.normalize('NFKC').toLowerCase().replace(/[\s_-]+/g, '');
}

function stringValue(value: unknown): string | undefined {
  const candidate = Array.isArray(value) ? value[0] : value;
  if (typeof candidate !== 'string' && typeof candidate !== 'number') return undefined;
  const normalized = String(candidate).normalize('NFKC').trim().replace(/\s+/g, ' ');
  return normalized || undefined;
}

function positiveInteger(value: string | undefined): number | undefined {
  if (!value) return undefined;
  const match = value.match(/^\s*(\d+)/);
  if (!match) return undefined;
  const parsed = Number.parseInt(match[1], 10);
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : undefined;
}

function tagYear(value: string | undefined): number | undefined {
  if (!value) return undefined;
  const match = value.match(/(?:^|\D)((?:1[0-9]{3}|2[0-9]{3}))(?:\D|$)/);
  if (!match) return undefined;
  const parsed = Number.parseInt(match[1], 10);
  return Number.isSafeInteger(parsed) ? parsed : undefined;
}

function filenameTitle(filePath: string): string {
  return path.parse(filePath).name
    .replace(/^\s*\d{1,3}(?:\s*[-._]\s*|\s+)/, '')
    .replace(/[._]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim() || path.parse(filePath).name;
}

function pathFallbacks(filePath: string, libraryPath?: string): {
  artist?: string;
  album?: string;
  discNumber?: number;
} {
  const absoluteFile = path.resolve(filePath);
  const relative = libraryPath ? path.relative(path.resolve(libraryPath), absoluteFile) : path.basename(absoluteFile);
  const safelyInsideLibrary = !libraryPath || (
    relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative)
  );
  if (!safelyInsideLibrary) return {};

  const directories = relative.split(path.sep).slice(0, -1).filter(Boolean);
  if (directories.length === 0) return {};

  const immediateParent = directories.at(-1)!;
  const discMatch = immediateParent.match(/^(?:cd|disc|disk)\s*[-_.]?\s*(\d{1,2})$/i);
  if (discMatch && directories.length >= 2) {
    return {
      album: directories.at(-2),
      artist: directories.length >= 3 ? directories.at(-3) : undefined,
      discNumber: positiveInteger(discMatch[1])
    };
  }

  if (directories.length === 1) {
    return { artist: immediateParent };
  }

  return {
    album: immediateParent,
    artist: directories.at(-2)
  };
}

/**
 * Normalizes ffprobe format tags while retaining deterministic filesystem
 * fallbacks for untagged local music. The function is pure and does no I/O.
 */
export function normalizeMusicTags(
  rawTags: Readonly<Record<string, unknown>> | null | undefined,
  fallbacks: MusicTagFallbacks
): NormalizedMusicTags {
  const tags = new Map<string, string>();
  for (const [key, rawValue] of Object.entries(rawTags || {})) {
    const value = stringValue(rawValue);
    if (value) tags.set(normalizedKey(key), value);
  }

  const fromTag = (...keys: string[]): string | undefined => {
    for (const key of keys) {
      const value = tags.get(normalizedKey(key));
      if (value) return value;
    }
    return undefined;
  };

  const pathValues = pathFallbacks(fallbacks.filePath, fallbacks.libraryPath);
  const taggedArtist = fromTag('artist', 'trackartist');
  const taggedAlbumArtist = fromTag('albumartist', 'album artist');
  const artist = taggedArtist || taggedAlbumArtist || pathValues.artist || UNKNOWN_ARTIST;
  const albumArtist = taggedAlbumArtist || taggedArtist || pathValues.artist || UNKNOWN_ARTIST;

  return {
    title: fromTag('title') || stringValue(fallbacks.fallbackTitle) || filenameTitle(fallbacks.filePath),
    artist,
    albumArtist,
    album: fromTag('album') || pathValues.album || UNKNOWN_ALBUM,
    trackNumber: positiveInteger(fromTag('track', 'tracknumber'))
      || positiveInteger(path.basename(fallbacks.filePath)),
    discNumber: positiveInteger(fromTag('disc', 'discnumber')) || pathValues.discNumber,
    genre: fromTag('genre'),
    year: tagYear(fromTag('date', 'year', 'releasedate'))
  };
}

