import { beforeEach, describe, expect, it } from 'bun:test';
import { Database } from 'bun:sqlite';
import { runDatabaseMigrations } from '../apps/server/src/db/migrations';
import { MetadataStore, seriesSubjectId } from '../apps/server/src/db/metadata-store';
import {
  METADATA_PROVIDER_API_VERSION,
  MetadataEnrichmentService,
  MetadataProviderRegistry,
  planMetadataMatch,
  type MetadataMatchResult,
  type MetadataProvider,
  type MetadataSearchResult
} from '../apps/server/src/metadata';

interface FakeProviderOptions {
  id?: string;
  match?: MetadataMatchResult;
  failOn?: 'match' | 'details' | 'artwork';
}

function candidate(id: string, providerId = 'fake', entityType: 'movie' | 'show' = 'movie'): MetadataSearchResult {
  return {
    providerId,
    externalId: id,
    entityType,
    title: `Candidate ${id}`,
    score: 0.97
  };
}

function createFakeProvider(options: FakeProviderOptions = {}) {
  const id = options.id ?? 'fake';
  const calls: string[] = [];
  const first = candidate('one', id);

  const provider: MetadataProvider = {
    apiVersion: METADATA_PROVIDER_API_VERSION,
    id,
    displayName: `Fake ${id}`,
    capabilities: {
      entityTypes: ['movie', 'show'],
      artworkTypes: ['poster', 'backdrop']
    },
    async search(request) {
      calls.push('search');
      return [candidate('one', id, request.entityType as 'movie' | 'show'), candidate('two', id)];
    },
    async match() {
      calls.push('match');
      if (options.failOn === 'match') throw new Error('provider is down');
      return options.match ?? {
        status: 'matched',
        match: first,
        confidence: 0.97,
        candidates: [first]
      };
    },
    async getDetails(reference) {
      calls.push('getDetails');
      if (options.failOn === 'details') throw new Error('provider is down');
      return {
        ...reference,
        title: 'Provider Title',
        overview: 'A description from the provider',
        tagline: 'Tagline',
        releaseDate: '2019-05-01',
        genres: ['Drama', 'Thriller'],
        studios: ['Fake Studio'],
        rating: 8.4,
        contentRating: 'PG-13',
        cast: [{ name: 'Lead Actor', character: 'Someone', order: 0 }],
        crew: [{ name: 'A Director', role: 'Director' }],
        externalIds: [{ providerId: 'imdb', externalId: 'tt1234567' }]
      };
    },
    async getArtwork(reference) {
      calls.push('getArtwork');
      if (options.failOn === 'artwork') throw new Error('artwork unavailable');
      return [
        { providerId: reference.providerId, type: 'poster', url: 'https://example.test/p.jpg', width: 1000, height: 1500 },
        { providerId: reference.providerId, type: 'backdrop', url: 'https://example.test/b.jpg' }
      ];
    }
  };

  return { provider, calls };
}

const movie = {
  id: 'media_movie_1',
  library_id: 'lib_1',
  type: 'movie' as const,
  title: 'Example Movie',
  year: 2019
};

const episode = {
  id: 'media_episode_1',
  library_id: 'lib_1',
  type: 'episode' as const,
  title: 'Pilot',
  series_title: 'Example Show',
  season_number: 1,
  episode_number: 1
};

describe('metadata enrichment', () => {
  let database: Database;
  let store: MetadataStore;

  const serviceWith = (options: FakeProviderOptions = {}) => {
    const { provider, calls } = createFakeProvider(options);
    const registry = new MetadataProviderRegistry([provider]);
    const service = new MetadataEnrichmentService({ registry, store, warn: () => {} });
    return { service, calls, registry };
  };

  beforeEach(() => {
    database = new Database(':memory:');
    runDatabaseMigrations(database);
    store = new MetadataStore(database);
  });

  it('enriches a movie with details and artwork', async () => {
    const { service } = serviceWith();
    const result = await service.enrich(movie);

    expect(result.status).toBe('matched');

    const stored = store.get({ type: 'media', id: movie.id })!;
    expect(stored.title).toBe('Provider Title');
    expect(stored.overview).toBe('A description from the provider');
    expect(stored.genres).toEqual(['Drama', 'Thriller']);
    expect(stored.cast[0]).toMatchObject({ name: 'Lead Actor' });
    expect(stored.externalIds).toEqual([{ providerId: 'imdb', externalId: 'tt1234567' }]);
    expect(stored.artwork.map((art) => art.kind).sort()).toEqual(['backdrop', 'poster']);
  });

  it('stores episode metadata against the series, not each episode', async () => {
    const { service } = serviceWith();
    await service.enrich(episode);

    const subject = { type: 'series' as const, id: seriesSubjectId('lib_1', 'Example Show') };
    expect(store.get(subject)).not.toBeNull();
    expect(store.get({ type: 'media', id: episode.id })).toBeNull();
  });

  it('asks the provider for a show rather than an unsupported episode lookup', async () => {
    const plan = planMetadataMatch(episode)!;
    expect(plan.request.entityType).toBe('show');
    expect(plan.request.title).toBe('Example Show');
  });

  it('never silently applies an ambiguous match', async () => {
    const { service } = serviceWith({
      match: {
        status: 'ambiguous',
        candidates: [candidate('one'), candidate('two')],
        reason: 'Two candidates scored alike'
      }
    });

    const result = await service.enrich(movie);

    expect(result.status).toBe('ambiguous');
    expect(result.candidates).toHaveLength(2);
    expect(store.get({ type: 'media', id: movie.id })).toBeNull();
  });

  it('records a miss without writing metadata', async () => {
    const { service } = serviceWith({ match: { status: 'not_found', candidates: [] } });

    expect((await service.enrich(movie)).status).toBe('not_found');
    expect(store.get({ type: 'media', id: movie.id })).toBeNull();
    expect(store.getFetchLog({ type: 'media', id: movie.id })?.outcome).toBe('not_found');
  });

  it('survives a provider outage without throwing', async () => {
    const { service } = serviceWith({ failOn: 'match' });

    const result = await service.enrich(movie);
    expect(result.status).toBe('error');
    expect(result.message).toContain('provider is down');
    expect(store.get({ type: 'media', id: movie.id })).toBeNull();
  });

  it('retries after an error but not after a match', async () => {
    const failing = serviceWith({ failOn: 'match' });
    await failing.service.enrich(movie);
    // An error is always worth retrying.
    await failing.service.enrich(movie);
    expect(failing.calls.filter((call) => call === 'match')).toHaveLength(2);

    const working = serviceWith();
    await working.service.enrich(movie);
    await working.service.enrich(movie);
    expect(working.calls.filter((call) => call === 'match')).toHaveLength(1);
  });

  it('does not re-request on an unchanged rescan', async () => {
    const { service, calls } = serviceWith();
    await service.enrich(movie);
    const afterFirst = calls.length;

    const second = await service.enrich(movie);
    expect(second.status).toBe('skipped');
    expect(calls.length).toBe(afterFirst);
  });

  it('re-requests when the search terms change', async () => {
    const { service, calls } = serviceWith();
    await service.enrich(movie);
    const afterFirst = calls.filter((call) => call === 'match').length;

    await service.enrich({ ...movie, title: 'Example Movie Remastered' });
    expect(calls.filter((call) => call === 'match').length).toBe(afterFirst + 1);
  });

  it('keeps stored metadata across a restart', async () => {
    const { service } = serviceWith();
    await service.enrich(movie);

    // A fresh store over the same database is what a restart looks like.
    const reopened = new MetadataStore(database);
    expect(reopened.get({ type: 'media', id: movie.id })?.title).toBe('Provider Title');
  });

  it('lets an administrator correct a bad match, and keeps the correction', async () => {
    const { service } = serviceWith();
    await service.enrich(movie);

    const plan = planMetadataMatch(movie)!;
    const corrected = await service.applyMatch(plan, candidate('corrected'), { source: 'manual' });
    expect(corrected.status).toBe('matched');

    const stored = store.get(plan.subject)!;
    expect(stored.externalId).toBe('corrected');
    expect(stored.matchSource).toBe('manual');
    expect(stored.locked).toBe(true);

    // An automatic pass must not undo the correction.
    const afterAutomatic = await service.enrich(movie);
    expect(afterAutomatic.status).toBe('locked');
    expect(store.get(plan.subject)?.externalId).toBe('corrected');
  });

  it('lets a forced refresh override a manual lock', async () => {
    const { service } = serviceWith();
    const plan = planMetadataMatch(movie)!;
    await service.applyMatch(plan, candidate('corrected'), { source: 'manual' });

    const refreshed = await service.enrich(movie, { force: true });
    expect(refreshed.status).toBe('matched');
    expect(store.get(plan.subject)?.externalId).toBe('one');
  });

  it('unmatches back to scanner-derived details', async () => {
    const { service } = serviceWith();
    await service.enrich(movie);
    const subject = { type: 'media' as const, id: movie.id };

    expect(store.clear(subject)).toBe(true);
    expect(store.get(subject)).toBeNull();
    expect(store.getArtwork(subject)).toEqual([]);
    expect(store.getFetchLog(subject)).toBeNull();
  });

  it('still stores details when artwork alone fails', async () => {
    const { service } = serviceWith({ failOn: 'artwork' });
    expect((await service.enrich(movie)).status).toBe('matched');

    const stored = store.get({ type: 'media', id: movie.id })!;
    expect(stored.title).toBe('Provider Title');
    expect(stored.artwork).toEqual([]);
  });

  it('reports disabled rather than failing when no provider is registered', async () => {
    const service = new MetadataEnrichmentService({
      registry: new MetadataProviderRegistry(),
      store,
      warn: () => {}
    });

    expect(service.enabled).toBe(false);
    expect((await service.enrich(movie)).status).toBe('disabled');
    // Queueing must be a no-op rather than an error on an unconfigured server.
    expect(() => service.enqueue(movie)).not.toThrow();
    expect(service.pending).toBe(0);
  });

  it('leaves music and home video alone', async () => {
    const { service, calls } = serviceWith();

    expect((await service.enrich({ ...movie, type: 'track' as any })).status).toBe('unsupported');
    expect((await service.enrich({ ...movie, type: 'video' as any })).status).toBe('unsupported');
    expect(calls).toHaveLength(0);
  });

  it('accepts a second provider without any scanner change', async () => {
    const primary = createFakeProvider({ id: 'primary' });
    const secondary = createFakeProvider({ id: 'secondary' });
    const registry = new MetadataProviderRegistry([primary.provider, secondary.provider]);

    const service = new MetadataEnrichmentService({
      registry,
      store,
      providerId: 'secondary',
      warn: () => {}
    });
    await service.enrich(movie);

    expect(primary.calls).toHaveLength(0);
    expect(store.get({ type: 'media', id: movie.id })?.providerId).toBe('secondary');
  });

  it('prunes metadata for media that no longer exists', async () => {
    const { service } = serviceWith();
    await service.enrich(movie);

    expect(store.pruneOrphanedMedia()).toBe(1);
    expect(store.get({ type: 'media', id: movie.id })).toBeNull();
  });

  it('keeps series metadata when pruning orphaned media rows', async () => {
    const { service } = serviceWith();
    await service.enrich(episode);

    store.pruneOrphanedMedia();
    expect(store.get({ type: 'series', id: seriesSubjectId('lib_1', 'Example Show') })).not.toBeNull();
  });
});
