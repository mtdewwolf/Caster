const CONTENT_RATING_LEVELS = new Map<string, number>([
  ['TV-Y', 0],
  ['TV-Y7', 1],
  ['G', 1],
  ['TV-G', 1],
  ['PG', 2],
  ['TV-PG', 2],
  ['PG-13', 3],
  ['TV-14', 3],
  ['R', 4],
  ['TV-MA', 4],
  ['NC-17', 5]
]);

export function normalizeContentRating(value: string | null | undefined): string | null {
  if (!value) return null;
  const normalized = value.trim().toUpperCase().replace(/_/g, '-');
  return CONTENT_RATING_LEVELS.has(normalized) ? normalized : null;
}

export function contentRatingLevel(value: string | null | undefined): number | null {
  const normalized = normalizeContentRating(value);
  return normalized === null ? null : CONTENT_RATING_LEVELS.get(normalized)!;
}
