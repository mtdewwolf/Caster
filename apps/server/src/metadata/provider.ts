/**
 * Version of the provider contract understood by this Caster server.
 *
 * Provider implementations must declare this exact version. A future breaking
 * contract can live alongside v1 instead of silently changing provider
 * behavior.
 */
export const METADATA_PROVIDER_API_VERSION = 1 as const;

export type MetadataEntityType = 'movie' | 'show' | 'season' | 'episode';

export type MetadataArtworkType = 'poster' | 'backdrop' | 'logo' | 'still';

export interface MetadataProviderReference {
  providerId: string;
  externalId: string;
  entityType: MetadataEntityType;
}

export interface MetadataExternalId {
  providerId: string;
  externalId: string;
}

export interface MetadataArtwork {
  providerId: string;
  externalId?: string;
  type: MetadataArtworkType;
  url: string;
  width?: number;
  height?: number;
  language?: string;
}

export interface MetadataCredit {
  externalId?: MetadataExternalId;
  name: string;
  role?: string;
  character?: string;
  order?: number;
  profileUrl?: string;
}

export interface MetadataSearchRequest {
  entityType: MetadataEntityType;
  title: string;
  year?: number;
  seriesTitle?: string;
  seasonNumber?: number;
  episodeNumber?: number;
  limit?: number;
}

export interface MetadataSearchResult extends MetadataProviderReference {
  title: string;
  originalTitle?: string;
  overview?: string;
  releaseDate?: string;
  year?: number;
  poster?: MetadataArtwork;
  /** Provider-native relevance, normalized to the inclusive 0..1 range. */
  score?: number;
}

export interface MetadataMatchRequest extends MetadataSearchRequest {
  /**
   * Inclusive score required for an automatic match. Providers may apply
   * additional conservative rules and return an ambiguous result instead.
   */
  minimumConfidence: number;
}

export type MetadataMatchResult =
  | {
      status: 'matched';
      match: MetadataSearchResult;
      confidence: number;
      candidates: readonly MetadataSearchResult[];
    }
  | {
      status: 'ambiguous';
      candidates: readonly MetadataSearchResult[];
      reason?: string;
    }
  | {
      status: 'not_found';
      candidates: readonly MetadataSearchResult[];
    };

export interface MetadataDetails extends MetadataProviderReference {
  title: string;
  originalTitle?: string;
  overview?: string;
  tagline?: string;
  releaseDate?: string;
  genres?: readonly string[];
  studios?: readonly string[];
  networks?: readonly string[];
  rating?: number;
  contentRating?: string;
  cast?: readonly MetadataCredit[];
  crew?: readonly MetadataCredit[];
  externalIds?: readonly MetadataExternalId[];
}

export interface MetadataProviderContext {
  language?: string;
  region?: string;
  signal?: AbortSignal;
}

export interface MetadataProviderCapabilities {
  entityTypes: readonly MetadataEntityType[];
  artworkTypes: readonly MetadataArtworkType[];
}

/**
 * Vendor-neutral metadata provider contract.
 *
 * The scanner and persistence layers consume this contract through the
 * registry; they never need to import a concrete provider implementation.
 */
export interface MetadataProviderV1 {
  readonly apiVersion: typeof METADATA_PROVIDER_API_VERSION;
  readonly id: string;
  readonly displayName: string;
  readonly capabilities: MetadataProviderCapabilities;

  search(
    request: MetadataSearchRequest,
    context?: MetadataProviderContext
  ): Promise<readonly MetadataSearchResult[]>;

  match(
    request: MetadataMatchRequest,
    context?: MetadataProviderContext
  ): Promise<MetadataMatchResult>;

  getDetails(
    reference: MetadataProviderReference,
    context?: MetadataProviderContext
  ): Promise<MetadataDetails | null>;

  getArtwork(
    reference: MetadataProviderReference,
    context?: MetadataProviderContext
  ): Promise<readonly MetadataArtwork[]>;
}

export type MetadataProvider = MetadataProviderV1;
