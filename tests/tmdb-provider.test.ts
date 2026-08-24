import { describe, expect, it } from 'bun:test';
import {
  TmdbConfigurationError,
  TmdbMetadataProvider,
  TmdbUnsupportedEntityError,
  calculateMatchConfidence
} from '../apps/server/src/metadata';

function jsonResponse(value: unknown, init: ResponseInit = {}): Response {
  return new Response(JSON.stringify(value), {
    status: 200,
    headers: { 'content-type': 'application/json' },
    ...init
  });
}

describe('TmdbMetadataProvider', () => {
  it('requires a server-side API read access token', () => {
    expect(() => new TmdbMetadataProvider({ accessToken: ' ' }))
      .toThrow(TmdbConfigurationError);
  });

  it('searches movies with locale settings, bearer auth, scoring, and response caching', async () => {
    const requests: Array<{ url: string; authorization: string | null }> = [];
    const fetchMock = (async (input: string | URL | Request, init?: RequestInit) => {
      const headers = new Headers(init?.headers);
      requests.push({
        url: String(input),
        authorization: headers.get('authorization')
      });
      return jsonResponse({
        results: [{
          id: 329865,
          title: 'Arrival',
          original_title: 'Arrival',
          release_date: '2016-11-10',
          overview: 'A linguist works with the military.',
          poster_path: '/arrival.jpg'
        }]
      });
    }) as typeof fetch;
    const provider = new TmdbMetadataProvider({
      accessToken: 'secret-token',
      language: 'de-DE',
      region: 'DE',
      fetch: fetchMock
    });

    const request = { entityType: 'movie' as const, title: 'Arrival', year: 2016 };
    const first = await provider.search(request);
    const second = await provider.search(request);
    const url = new URL(requests[0].url);

    expect(requests).toHaveLength(1);
    expect(requests[0].authorization).toBe('Bearer secret-token');
    expect(url.pathname).toBe('/3/search/movie');
    expect(url.searchParams.get('query')).toBe('Arrival');
    expect(url.searchParams.get('language')).toBe('de-DE');
    expect(url.searchParams.get('region')).toBe('DE');
    expect(url.searchParams.get('primary_release_year')).toBe('2016');
    expect(first).toEqual(second);
    expect(first[0]).toMatchObject({
      providerId: 'tmdb',
      externalId: '329865',
      entityType: 'movie',
      title: 'Arrival',
      year: 2016,
      score: 0.98,
      poster: { url: 'https://image.tmdb.org/t/p/w500/arrival.jpg' }
    });
  });

  it('only auto-matches a clear candidate above the requested confidence', async () => {
    const responses = [
      { id: 2, title: 'Thing', release_date: '2015-01-01' },
      { id: 1, title: 'The Thing', release_date: '1982-06-25' }
    ];
    const provider = new TmdbMetadataProvider({
      accessToken: 'token',
      fetch: (async () => jsonResponse({ results: responses })) as typeof fetch
    });

    const result = await provider.match({
      entityType: 'movie',
      title: 'The Thing',
      year: 1982,
      minimumConfidence: 0.9
    });

    expect(result.status).toBe('matched');
    if (result.status === 'matched') {
      expect(result.match.externalId).toBe('1');
      expect(result.confidence).toBe(0.98);
    }
  });

  it('leaves equally strong candidates ambiguous', async () => {
    const provider = new TmdbMetadataProvider({
      accessToken: 'token',
      fetch: (async () => jsonResponse({
        results: [
          { id: 1, name: 'Example Show', first_air_date: '2020-01-01' },
          { id: 2, name: 'Example Show', first_air_date: '2020-02-01' }
        ]
      })) as typeof fetch
    });

    const result = await provider.match({
      entityType: 'show',
      title: 'Example Show',
      year: 2020,
      minimumConfidence: 0.9
    });

    expect(result.status).toBe('ambiguous');
    expect(result.candidates).toHaveLength(2);
  });

  it('maps movie details, provenance, credits, ratings, and artwork', async () => {
    const fetchMock = (async (input: string | URL | Request) => {
      const url = new URL(String(input));
      if (url.pathname.endsWith('/images')) {
        return jsonResponse({
          posters: [{ file_path: '/poster.jpg', width: 1000, height: 1500, iso_639_1: 'en' }],
          backdrops: [{ file_path: '/backdrop.jpg', width: 1920, height: 1080, iso_639_1: null }],
          logos: []
        });
      }
      return jsonResponse({
        id: 329865,
        title: 'Arrival',
        original_title: 'Arrival',
        overview: 'Overview',
        tagline: 'Why are they here?',
        release_date: '2016-11-10',
        vote_average: 7.6,
        genres: [{ name: 'Drama' }, { name: 'Science Fiction' }],
        production_companies: [{ name: 'FilmNation Entertainment' }],
        credits: {
          cast: [{ id: 9273, name: 'Amy Adams', character: 'Louise Banks', order: 0 }],
          crew: [{ id: 137427, name: 'Denis Villeneuve', job: 'Director' }]
        },
        external_ids: { imdb_id: 'tt2543164', wikidata_id: 'Q18933009' },
        release_dates: {
          results: [{
            iso_3166_1: 'US',
            release_dates: [{ certification: 'PG-13' }]
          }]
        }
      });
    }) as typeof fetch;
    const provider = new TmdbMetadataProvider({ accessToken: 'token', fetch: fetchMock });
    const reference = { providerId: 'tmdb', externalId: '329865', entityType: 'movie' as const };

    const details = await provider.getDetails(reference, { region: 'US' });
    const artwork = await provider.getArtwork(reference, { language: 'en-US' });

    expect(details).toMatchObject({
      ...reference,
      title: 'Arrival',
      contentRating: 'PG-13',
      genres: ['Drama', 'Science Fiction'],
      studios: ['FilmNation Entertainment'],
      cast: [{ name: 'Amy Adams', character: 'Louise Banks' }],
      crew: [{ name: 'Denis Villeneuve', role: 'Director' }],
      externalIds: [
        { providerId: 'tmdb', externalId: '329865' },
        { providerId: 'imdb', externalId: 'tt2543164' },
        { providerId: 'wikidata', externalId: 'Q18933009' }
      ]
    });
    expect(artwork).toEqual([
      {
        providerId: 'tmdb',
        externalId: '/poster.jpg',
        type: 'poster',
        url: 'https://image.tmdb.org/t/p/original/poster.jpg',
        width: 1000,
        height: 1500,
        language: 'en'
      },
      {
        providerId: 'tmdb',
        externalId: '/backdrop.jpg',
        type: 'backdrop',
        url: 'https://image.tmdb.org/t/p/original/backdrop.jpg',
        width: 1920,
        height: 1080,
        language: undefined
      }
    ]);
  });

  it('retries a bounded 429 response using Retry-After', async () => {
    let attempts = 0;
    const waits: number[] = [];
    const provider = new TmdbMetadataProvider({
      accessToken: 'token',
      maxRateLimitRetries: 1,
      sleep: async (milliseconds) => { waits.push(milliseconds); },
      fetch: (async () => {
        attempts++;
        if (attempts === 1) {
          return jsonResponse({}, { status: 429, headers: { 'retry-after': '2' } });
        }
        return jsonResponse({ results: [] });
      }) as typeof fetch
    });

    await provider.search({ entityType: 'movie', title: 'Arrival' });

    expect(attempts).toBe(2);
    expect(waits).toEqual([2000]);
  });

  it('rejects unsupported season and episode requests explicitly', async () => {
    const provider = new TmdbMetadataProvider({
      accessToken: 'token',
      fetch: (async () => jsonResponse({})) as typeof fetch
    });

    expect(provider.search({ entityType: 'episode', title: 'Pilot' }))
      .rejects.toBeInstanceOf(TmdbUnsupportedEntityError);
  });
});

describe('calculateMatchConfidence', () => {
  it('strongly prefers exact title and year while keeping fuzzy titles below auto-match', () => {
    expect(calculateMatchConfidence('Amélie', 2001, 'Amelie', 'Le Fabuleux Destin d’Amélie Poulain', 2001))
      .toBe(0.98);
    expect(calculateMatchConfidence('The Office', 2005, 'Office Christmas Party', undefined, 2016))
      .toBeLessThan(0.9);
  });
});
