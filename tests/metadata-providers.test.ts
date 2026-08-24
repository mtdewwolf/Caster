import { describe, expect, it } from 'bun:test';
import {
  METADATA_PROVIDER_API_VERSION,
  DEFAULT_AUTOMATIC_MATCH_CONFIDENCE,
  MetadataProviderNotFoundError,
  MetadataProviderRegistrationError,
  MetadataProviderRegistry,
  createMetadataMatchRequest,
  type MetadataProvider,
  type MetadataProviderContext,
  type MetadataProviderReference,
  type MetadataSearchRequest
} from '../apps/server/src/metadata';

function createProvider(id = 'fixture'): MetadataProvider & {
  calls: Array<{ method: string; value: unknown; context?: MetadataProviderContext }>;
} {
  const calls: Array<{ method: string; value: unknown; context?: MetadataProviderContext }> = [];
  const result = {
    providerId: id,
    externalId: 'movie-1',
    entityType: 'movie' as const,
    title: 'Fixture Movie',
    year: 2024,
    score: 0.97
  };

  return {
    apiVersion: METADATA_PROVIDER_API_VERSION,
    id,
    displayName: 'Fixture Provider',
    capabilities: {
      entityTypes: ['movie', 'show', 'season', 'episode'],
      artworkTypes: ['poster', 'backdrop', 'logo', 'still']
    },
    calls,
    async search(request, context) {
      calls.push({ method: 'search', value: request, context });
      return [result];
    },
    async match(request, context) {
      calls.push({ method: 'match', value: request, context });
      return {
        status: 'matched',
        match: result,
        confidence: result.score,
        candidates: [result]
      };
    },
    async getDetails(reference, context) {
      calls.push({ method: 'getDetails', value: reference, context });
      return {
        ...reference,
        title: result.title,
        overview: 'Provider-owned descriptive metadata'
      };
    },
    async getArtwork(reference, context) {
      calls.push({ method: 'getArtwork', value: reference, context });
      return [{
        providerId: id,
        externalId: 'poster-1',
        type: 'poster',
        url: 'https://example.test/poster.jpg',
        width: 1000,
        height: 1500
      }];
    }
  };
}

describe('MetadataProviderRegistry', () => {
  it('registers providers and routes all v1 operations without vendor coupling', async () => {
    const provider = createProvider();
    const registry = new MetadataProviderRegistry([provider]);
    const request: MetadataSearchRequest = {
      entityType: 'movie',
      title: 'Fixture Movie',
      year: 2024
    };
    const context = { language: 'en-US', region: 'US' };
    const reference: MetadataProviderReference = {
      providerId: provider.id,
      externalId: 'movie-1',
      entityType: 'movie'
    };

    expect((await registry.search(provider.id, request, context))[0].externalId).toBe('movie-1');
    expect((await registry.match(provider.id, {
      ...request,
      minimumConfidence: 0.9
    }, context)).status).toBe('matched');
    expect((await registry.getDetails(reference, context))?.title).toBe('Fixture Movie');
    expect((await registry.getArtwork(reference, context))[0].type).toBe('poster');
    expect(provider.calls.map((call) => call.method)).toEqual([
      'search',
      'match',
      'getDetails',
      'getArtwork'
    ]);
    expect(provider.calls.every((call) => call.context === context)).toBe(true);
  });

  it('rejects incompatible versions, invalid IDs, and duplicate registrations', () => {
    const registry = new MetadataProviderRegistry();
    const provider = createProvider();
    const incompatible = {
      ...createProvider('future'),
      apiVersion: 2
    } as unknown as MetadataProvider;

    expect(() => registry.register(incompatible)).toThrow(MetadataProviderRegistrationError);
    expect(() => registry.register(createProvider('Invalid ID'))).toThrow(MetadataProviderRegistrationError);

    registry.register(provider);
    expect(() => registry.register(createProvider())).toThrow(MetadataProviderRegistrationError);
  });

  it('fails explicitly when a request references an unavailable provider', async () => {
    const registry = new MetadataProviderRegistry();

    expect(() => registry.search('missing', {
      entityType: 'movie',
      title: 'Missing Movie'
    })).toThrow(MetadataProviderNotFoundError);
    expect(() => registry.getArtwork({
      providerId: 'missing',
      externalId: 'movie-1',
      entityType: 'movie'
    })).toThrow('Metadata provider "missing" is not registered');
  });

  it('can unregister a provider cleanly', () => {
    const registry = new MetadataProviderRegistry([createProvider()]);

    expect(registry.list().map((provider) => provider.id)).toEqual(['fixture']);
    expect(registry.unregister('fixture')).toBe(true);
    expect(registry.unregister('fixture')).toBe(false);
    expect(registry.get('fixture')).toBeUndefined();
  });
});

describe('scanner metadata adapter', () => {
  it('builds vendor-neutral movie and episode match requests', () => {
    expect(createMetadataMatchRequest({
      type: 'movie',
      title: 'Arrival',
      year: 2016
    })).toEqual({
      entityType: 'movie',
      title: 'Arrival',
      year: 2016,
      minimumConfidence: DEFAULT_AUTOMATIC_MATCH_CONFIDENCE
    });

    expect(createMetadataMatchRequest({
      type: 'episode',
      title: 'Pilot',
      series_title: 'Example Show',
      season_number: 1,
      episode_number: 1
    }, 0.95)).toEqual({
      entityType: 'episode',
      title: 'Pilot',
      seriesTitle: 'Example Show',
      seasonNumber: 1,
      episodeNumber: 1,
      minimumConfidence: 0.95
    });
  });

  it('does not send unsupported local media types to movie/TV providers', () => {
    expect(createMetadataMatchRequest({ type: 'track', title: 'Track' })).toBeNull();
    expect(createMetadataMatchRequest({ type: 'video', title: 'Home Video' })).toBeNull();
    expect(createMetadataMatchRequest({ type: 'episode', title: 'Unknown Episode' })).toBeNull();
  });
});
