import {
  METADATA_PROVIDER_API_VERSION,
  type MetadataArtwork,
  type MetadataArtworkType,
  type MetadataCredit,
  type MetadataDetails,
  type MetadataEntityType,
  type MetadataExternalId,
  type MetadataMatchRequest,
  type MetadataMatchResult,
  type MetadataProvider,
  type MetadataProviderContext,
  type MetadataProviderReference,
  type MetadataSearchRequest,
  type MetadataSearchResult
} from './provider';

const DEFAULT_API_BASE_URL = 'https://api.themoviedb.org/3';
const DEFAULT_IMAGE_BASE_URL = 'https://image.tmdb.org/t/p';
const DEFAULT_CACHE_TTL_MS = 6 * 60 * 60 * 1000;
const DEFAULT_MAX_CACHE_ENTRIES = 500;
const DEFAULT_MAX_RATE_LIMIT_RETRIES = 2;

type Fetch = typeof globalThis.fetch;

interface TmdbSearchItem {
  id: number;
  title?: string;
  original_title?: string;
  release_date?: string;
  name?: string;
  original_name?: string;
  first_air_date?: string;
  overview?: string;
  poster_path?: string | null;
}

interface TmdbSearchResponse {
  results?: TmdbSearchItem[];
}

interface TmdbImage {
  file_path: string;
  width?: number;
  height?: number;
  iso_639_1?: string | null;
}

interface TmdbImagesResponse {
  posters?: TmdbImage[];
  backdrops?: TmdbImage[];
  logos?: TmdbImage[];
}

interface TmdbPersonCredit {
  id?: number;
  name?: string;
  job?: string;
  character?: string;
  order?: number;
  profile_path?: string | null;
  roles?: Array<{ character?: string }>;
}

interface TmdbDetailsResponse {
  id: number;
  title?: string;
  original_title?: string;
  release_date?: string;
  name?: string;
  original_name?: string;
  first_air_date?: string;
  overview?: string;
  tagline?: string;
  vote_average?: number;
  genres?: Array<{ name?: string }>;
  production_companies?: Array<{ name?: string }>;
  networks?: Array<{ name?: string }>;
  credits?: { cast?: TmdbPersonCredit[]; crew?: TmdbPersonCredit[] };
  aggregate_credits?: { cast?: TmdbPersonCredit[]; crew?: TmdbPersonCredit[] };
  external_ids?: Record<string, unknown>;
  release_dates?: {
    results?: Array<{
      iso_3166_1?: string;
      release_dates?: Array<{ certification?: string }>;
    }>;
  };
  content_ratings?: {
    results?: Array<{ iso_3166_1?: string; rating?: string }>;
  };
}

interface CacheEntry {
  expiresAt: number;
  value: unknown;
}

export interface TmdbMetadataProviderOptions {
  /** TMDB API Read Access Token. It is only ever sent in the Authorization header. */
  accessToken?: string;
  language?: string;
  region?: string;
  apiBaseUrl?: string;
  imageBaseUrl?: string;
  cacheTtlMs?: number;
  maxCacheEntries?: number;
  maxRateLimitRetries?: number;
  fetch?: Fetch;
  now?: () => number;
  sleep?: (milliseconds: number, signal?: AbortSignal) => Promise<void>;
}

export class TmdbConfigurationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'TmdbConfigurationError';
  }
}

export class TmdbHttpError extends Error {
  readonly status: number;

  constructor(status: number, message: string) {
    super(message);
    this.name = 'TmdbHttpError';
    this.status = status;
  }
}

export class TmdbUnsupportedEntityError extends Error {
  constructor(entityType: MetadataEntityType) {
    super(`TMDB provider does not support ${entityType} metadata yet`);
    this.name = 'TmdbUnsupportedEntityError';
  }
}

export class TmdbMetadataProvider implements MetadataProvider {
  readonly apiVersion = METADATA_PROVIDER_API_VERSION;
  readonly id = 'tmdb';
  readonly displayName = 'The Movie Database (TMDB)';
  readonly capabilities = {
    entityTypes: ['movie', 'show'] as const,
    artworkTypes: ['poster', 'backdrop', 'logo'] as const
  };

  readonly #accessToken: string;
  readonly #language: string;
  readonly #region?: string;
  readonly #apiBaseUrl: string;
  readonly #imageBaseUrl: string;
  readonly #cacheTtlMs: number;
  readonly #maxCacheEntries: number;
  readonly #maxRateLimitRetries: number;
  readonly #fetch: Fetch;
  readonly #now: () => number;
  readonly #sleep: (milliseconds: number, signal?: AbortSignal) => Promise<void>;
  readonly #cache = new Map<string, CacheEntry>();
  readonly #inFlight = new Map<string, Promise<unknown>>();

  constructor(options: TmdbMetadataProviderOptions = {}) {
    const accessToken = options.accessToken ?? process.env.TMDB_ACCESS_TOKEN;
    if (!accessToken?.trim()) {
      throw new TmdbConfigurationError(
        'TMDB_ACCESS_TOKEN is required to enable the TMDB metadata provider'
      );
    }

    this.#accessToken = accessToken.trim();
    this.#language = options.language ?? process.env.TMDB_LANGUAGE ?? 'en-US';
    this.#region = options.region ?? process.env.TMDB_REGION;
    this.#apiBaseUrl = stripTrailingSlash(options.apiBaseUrl ?? DEFAULT_API_BASE_URL);
    this.#imageBaseUrl = stripTrailingSlash(options.imageBaseUrl ?? DEFAULT_IMAGE_BASE_URL);
    this.#cacheTtlMs = nonNegativeInteger(options.cacheTtlMs, DEFAULT_CACHE_TTL_MS, 'cacheTtlMs');
    this.#maxCacheEntries = positiveInteger(
      options.maxCacheEntries,
      DEFAULT_MAX_CACHE_ENTRIES,
      'maxCacheEntries'
    );
    this.#maxRateLimitRetries = nonNegativeInteger(
      options.maxRateLimitRetries,
      DEFAULT_MAX_RATE_LIMIT_RETRIES,
      'maxRateLimitRetries'
    );
    this.#fetch = options.fetch ?? globalThis.fetch;
    this.#now = options.now ?? Date.now;
    this.#sleep = options.sleep ?? abortableSleep;
  }

  async search(
    request: MetadataSearchRequest,
    context: MetadataProviderContext = {}
  ): Promise<readonly MetadataSearchResult[]> {
    this.#assertSupported(request.entityType);
    const isMovie = request.entityType === 'movie';
    const params = new URLSearchParams({
      query: request.title,
      include_adult: 'false',
      language: context.language ?? this.#language,
      page: '1'
    });
    const region = context.region ?? this.#region;
    if (region && isMovie) params.set('region', region);
    if (request.year) {
      params.set(isMovie ? 'primary_release_year' : 'first_air_date_year', String(request.year));
    }

    const response = await this.#requestJson<TmdbSearchResponse>(
      `/search/${isMovie ? 'movie' : 'tv'}`,
      params,
      context.signal
    );
    const limit = Math.min(Math.max(request.limit ?? 10, 1), 20);

    return (response.results ?? [])
      .slice(0, limit)
      .map((item) => this.#toSearchResult(item, request))
      .sort((left, right) => (right.score ?? 0) - (left.score ?? 0));
  }

  async match(
    request: MetadataMatchRequest,
    context: MetadataProviderContext = {}
  ): Promise<MetadataMatchResult> {
    if (!Number.isFinite(request.minimumConfidence) ||
        request.minimumConfidence < 0 || request.minimumConfidence > 1) {
      throw new RangeError('minimumConfidence must be between 0 and 1');
    }

    const candidates = await this.search(request, context);
    if (candidates.length === 0) {
      return { status: 'not_found', candidates };
    }

    const best = candidates[0];
    const bestConfidence = best.score ?? 0;
    const runnerUpConfidence = candidates[1]?.score ?? 0;
    if (bestConfidence < request.minimumConfidence) {
      return {
        status: 'ambiguous',
        candidates,
        reason: 'No candidate met the automatic match confidence threshold'
      };
    }
    if (runnerUpConfidence >= request.minimumConfidence &&
        bestConfidence - runnerUpConfidence < 0.08) {
      return {
        status: 'ambiguous',
        candidates,
        reason: 'The leading candidates are too close to choose safely'
      };
    }

    return {
      status: 'matched',
      match: best,
      confidence: bestConfidence,
      candidates
    };
  }

  async getDetails(
    reference: MetadataProviderReference,
    context: MetadataProviderContext = {}
  ): Promise<MetadataDetails | null> {
    this.#assertReference(reference);
    const isMovie = reference.entityType === 'movie';
    const params = this.#localizedParams(context);
    params.set(
      'append_to_response',
      isMovie
        ? 'credits,external_ids,release_dates'
        : 'aggregate_credits,external_ids,content_ratings'
    );

    try {
      const data = await this.#requestJson<TmdbDetailsResponse>(
        `/${isMovie ? 'movie' : 'tv'}/${encodeURIComponent(reference.externalId)}`,
        params,
        context.signal
      );
      const credits = isMovie ? data.credits : data.aggregate_credits;

      return {
        ...reference,
        title: (isMovie ? data.title : data.name) ?? '',
        originalTitle: (isMovie ? data.original_title : data.original_name) || undefined,
        overview: data.overview || undefined,
        tagline: data.tagline || undefined,
        releaseDate: (isMovie ? data.release_date : data.first_air_date) || undefined,
        genres: names(data.genres),
        studios: names(data.production_companies),
        networks: names(data.networks),
        rating: finiteNumber(data.vote_average),
        contentRating: selectContentRating(data, context.region ?? this.#region),
        cast: mapCredits(credits?.cast, this.#imageBaseUrl),
        crew: mapCredits(credits?.crew, this.#imageBaseUrl),
        externalIds: mapExternalIds(reference, data.external_ids)
      };
    } catch (error) {
      if (error instanceof TmdbHttpError && error.status === 404) return null;
      throw error;
    }
  }

  async getArtwork(
    reference: MetadataProviderReference,
    context: MetadataProviderContext = {}
  ): Promise<readonly MetadataArtwork[]> {
    this.#assertReference(reference);
    const isMovie = reference.entityType === 'movie';
    const params = this.#localizedParams(context);
    const language = (context.language ?? this.#language).split('-')[0];
    params.set('include_image_language', `${language},null`);
    const data = await this.#requestJson<TmdbImagesResponse>(
      `/${isMovie ? 'movie' : 'tv'}/${encodeURIComponent(reference.externalId)}/images`,
      params,
      context.signal
    );

    return [
      ...this.#mapArtwork(data.posters, 'poster'),
      ...this.#mapArtwork(data.backdrops, 'backdrop'),
      ...this.#mapArtwork(data.logos, 'logo')
    ];
  }

  clearCache(): void {
    this.#cache.clear();
  }

  #toSearchResult(item: TmdbSearchItem, request: MetadataSearchRequest): MetadataSearchResult {
    const isMovie = request.entityType === 'movie';
    const title = (isMovie ? item.title : item.name) ?? '';
    const originalTitle = (isMovie ? item.original_title : item.original_name) || undefined;
    const releaseDate = (isMovie ? item.release_date : item.first_air_date) || undefined;
    const year = parseYear(releaseDate);
    const externalId = String(item.id);

    return {
      providerId: this.id,
      externalId,
      entityType: request.entityType,
      title,
      originalTitle,
      overview: item.overview || undefined,
      releaseDate,
      year,
      poster: item.poster_path
        ? {
            providerId: this.id,
            externalId: item.poster_path,
            type: 'poster',
            url: `${this.#imageBaseUrl}/w500${item.poster_path}`
          }
        : undefined,
      score: calculateMatchConfidence(request.title, request.year, title, originalTitle, year)
    };
  }

  #mapArtwork(images: TmdbImage[] | undefined, type: MetadataArtworkType): MetadataArtwork[] {
    return (images ?? []).map((image) => ({
      providerId: this.id,
      externalId: image.file_path,
      type,
      url: `${this.#imageBaseUrl}/original${image.file_path}`,
      width: image.width,
      height: image.height,
      language: image.iso_639_1 || undefined
    }));
  }

  #localizedParams(context: MetadataProviderContext): URLSearchParams {
    return new URLSearchParams({ language: context.language ?? this.#language });
  }

  #assertReference(reference: MetadataProviderReference): void {
    if (reference.providerId !== this.id) {
      throw new TmdbConfigurationError(
        `TMDB cannot resolve a reference owned by provider "${reference.providerId}"`
      );
    }
    this.#assertSupported(reference.entityType);
    if (!/^[1-9]\d*$/.test(reference.externalId)) {
      throw new TmdbConfigurationError('TMDB external IDs must be positive integers');
    }
  }

  #assertSupported(entityType: MetadataEntityType): void {
    if (entityType !== 'movie' && entityType !== 'show') {
      throw new TmdbUnsupportedEntityError(entityType);
    }
  }

  async #requestJson<T>(
    path: string,
    params: URLSearchParams,
    signal?: AbortSignal
  ): Promise<T> {
    const url = `${this.#apiBaseUrl}${path}?${params.toString()}`;
    const cached = this.#cache.get(url);
    if (cached && cached.expiresAt > this.#now()) {
      // Refresh insertion order so frequently-used entries remain in the cache.
      this.#cache.delete(url);
      this.#cache.set(url, cached);
      return cached.value as T;
    }
    if (cached) this.#cache.delete(url);

    const existingRequest = this.#inFlight.get(url);
    if (existingRequest) return existingRequest as Promise<T>;

    const request = this.#fetchWithRateLimitRetry<T>(url, signal)
      .then((value) => {
        if (this.#cacheTtlMs > 0) {
          this.#cache.set(url, {
            expiresAt: this.#now() + this.#cacheTtlMs,
            value
          });
          while (this.#cache.size > this.#maxCacheEntries) {
            const oldestKey = this.#cache.keys().next().value as string | undefined;
            if (!oldestKey) break;
            this.#cache.delete(oldestKey);
          }
        }
        return value;
      })
      .finally(() => this.#inFlight.delete(url));

    this.#inFlight.set(url, request);
    return request;
  }

  async #fetchWithRateLimitRetry<T>(url: string, signal?: AbortSignal): Promise<T> {
    for (let attempt = 0; ; attempt++) {
      const response = await this.#fetch(url, {
        headers: {
          accept: 'application/json',
          authorization: `Bearer ${this.#accessToken}`
        },
        signal
      });

      if (response.status === 429 && attempt < this.#maxRateLimitRetries) {
        await this.#sleep(retryAfterMilliseconds(response.headers.get('retry-after')), signal);
        continue;
      }
      if (!response.ok) {
        throw new TmdbHttpError(response.status, `TMDB request failed with status ${response.status}`);
      }
      return await response.json() as T;
    }
  }
}

function stripTrailingSlash(value: string): string {
  return value.replace(/\/+$/, '');
}

function positiveInteger(value: number | undefined, fallback: number, name: string): number {
  const resolved = value ?? fallback;
  if (!Number.isInteger(resolved) || resolved <= 0) {
    throw new TmdbConfigurationError(`${name} must be a positive integer`);
  }
  return resolved;
}

function nonNegativeInteger(value: number | undefined, fallback: number, name: string): number {
  const resolved = value ?? fallback;
  if (!Number.isInteger(resolved) || resolved < 0) {
    throw new TmdbConfigurationError(`${name} must be a non-negative integer`);
  }
  return resolved;
}

function parseYear(date: string | undefined): number | undefined {
  if (!date) return undefined;
  const year = Number.parseInt(date.slice(0, 4), 10);
  return Number.isInteger(year) ? year : undefined;
}

function normalizeTitle(value: string): string {
  return value
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLocaleLowerCase('en-US')
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();
}

function tokenSimilarity(left: string, right: string): number {
  const leftTokens = new Set(normalizeTitle(left).split(' ').filter(Boolean));
  const rightTokens = new Set(normalizeTitle(right).split(' ').filter(Boolean));
  if (leftTokens.size === 0 || rightTokens.size === 0) return 0;
  let intersection = 0;
  for (const token of leftTokens) {
    if (rightTokens.has(token)) intersection++;
  }
  return (2 * intersection) / (leftTokens.size + rightTokens.size);
}

export function calculateMatchConfidence(
  requestedTitle: string,
  requestedYear: number | undefined,
  candidateTitle: string,
  candidateOriginalTitle: string | undefined,
  candidateYear: number | undefined
): number {
  const requested = normalizeTitle(requestedTitle);
  const titleExact = requested !== '' && requested === normalizeTitle(candidateTitle);
  const originalTitleExact = requested !== '' && requested === normalizeTitle(candidateOriginalTitle ?? '');
  let confidence = titleExact ? 0.84 : originalTitleExact ? 0.82 : 0.65 * Math.max(
    tokenSimilarity(requestedTitle, candidateTitle),
    tokenSimilarity(requestedTitle, candidateOriginalTitle ?? '')
  );

  if (requestedYear !== undefined && candidateYear !== undefined) {
    if (requestedYear === candidateYear) confidence += 0.14;
    else if (Math.abs(requestedYear - candidateYear) === 1) confidence += 0.04;
    else confidence -= 0.12;
  } else if (titleExact || originalTitleExact) {
    confidence += 0.04;
  }

  return Math.round(Math.min(Math.max(confidence, 0), 1) * 1000) / 1000;
}

function names(values: Array<{ name?: string }> | undefined): string[] | undefined {
  const result = (values ?? []).flatMap((value) => value.name?.trim() ? [value.name.trim()] : []);
  return result.length > 0 ? result : undefined;
}

function finiteNumber(value: number | undefined): number | undefined {
  return Number.isFinite(value) ? value : undefined;
}

function mapCredits(
  credits: TmdbPersonCredit[] | undefined,
  imageBaseUrl: string
): MetadataCredit[] | undefined {
  const result = (credits ?? []).flatMap((credit) => credit.name?.trim() ? [{
    externalId: credit.id
      ? { providerId: 'tmdb', externalId: String(credit.id) }
      : undefined,
    name: credit.name.trim(),
    role: credit.job || undefined,
    character: credit.character || credit.roles?.[0]?.character || undefined,
    order: credit.order,
    profileUrl: credit.profile_path
      ? `${imageBaseUrl}/w185${credit.profile_path}`
      : undefined
  }] : []);
  return result.length > 0 ? result : undefined;
}

function mapExternalIds(
  reference: MetadataProviderReference,
  values: Record<string, unknown> | undefined
): MetadataExternalId[] {
  const result: MetadataExternalId[] = [{
    providerId: reference.providerId,
    externalId: reference.externalId
  }];
  const mappings: Array<[string, string]> = [
    ['imdb_id', 'imdb'],
    ['tvdb_id', 'tvdb'],
    ['wikidata_id', 'wikidata']
  ];
  for (const [key, providerId] of mappings) {
    const externalId = values?.[key];
    if (typeof externalId === 'string' && externalId.trim()) {
      result.push({ providerId, externalId: externalId.trim() });
    } else if (typeof externalId === 'number' && Number.isFinite(externalId)) {
      result.push({ providerId, externalId: String(externalId) });
    }
  }
  return result;
}

function selectContentRating(
  data: TmdbDetailsResponse,
  preferredRegion: string | undefined
): string | undefined {
  const movieRatings = data.release_dates?.results?.flatMap((region) =>
    (region.release_dates ?? []).flatMap((release) => release.certification?.trim()
      ? [{ region: region.iso_3166_1, rating: release.certification.trim() }]
      : [])
  ) ?? [];
  const showRatings = data.content_ratings?.results?.flatMap((rating) => rating.rating?.trim()
    ? [{ region: rating.iso_3166_1, rating: rating.rating.trim() }]
    : []) ?? [];
  const ratings = [...movieRatings, ...showRatings];
  return ratings.find((rating) => preferredRegion && rating.region === preferredRegion)?.rating ??
    ratings.find((rating) => rating.region === 'US')?.rating ??
    ratings[0]?.rating;
}

function retryAfterMilliseconds(value: string | null): number {
  if (!value) return 1000;
  const seconds = Number(value);
  if (Number.isFinite(seconds) && seconds >= 0) return Math.min(seconds * 1000, 30_000);
  const date = Date.parse(value);
  if (Number.isFinite(date)) return Math.min(Math.max(date - Date.now(), 0), 30_000);
  return 1000;
}

function abortableSleep(milliseconds: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(signal.reason ?? new DOMException('Aborted', 'AbortError'));
      return;
    }
    const handleAbort = () => {
      clearTimeout(timeout);
      reject(signal?.reason ?? new DOMException('Aborted', 'AbortError'));
    };
    const timeout = setTimeout(() => {
      signal?.removeEventListener('abort', handleAbort);
      resolve();
    }, milliseconds);
    signal?.addEventListener('abort', handleAbort, { once: true });
  });
}
