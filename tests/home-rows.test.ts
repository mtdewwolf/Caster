import { beforeAll, beforeEach, describe, expect, it } from 'bun:test';
import { db, initDatabase, LibraryModel, MediaModel, ProgressModel } from '../apps/server/src/db';
import server from '../apps/server/src/index';

describe('home rows', () => {
  let libraryId: string;
  let otherLibraryId: string;
  let userId: string;
  let id: (key: string) => string;

  const idsOf = (items: Array<{ id: string }>) => items.map((item) => item.id);

  beforeEach(() => {
    initDatabase();
    const suffix = `${Date.now()}_${crypto.randomUUID()}`;
    libraryId = `homelib_${suffix}`;
    otherLibraryId = `otherlib_${suffix}`;
    userId = `homeuser_${suffix}`;
    id = (key: string) => `${key}_${suffix}`;
    const now = new Date().toISOString();

    for (const [libId, name] of [[libraryId, 'Home library'], [otherLibraryId, 'Other library']]) {
      LibraryModel.create({ id: libId, name, path: `/tmp/${libId}`, type: 'tv', created_at: now });
    }

    const episode = (
      key: string,
      season: number,
      number: number,
      createdAt: string,
      series = 'Example Show',
      libId = libraryId
    ) => MediaModel.upsert({
      id: id(key),
      library_id: libId,
      title: `${series} S${season}E${number}`,
      original_filename: `${key}.mkv`,
      relative_path: `${key}.mkv`,
      full_path: `/tmp/${libId}/${key}.mkv`,
      type: 'episode',
      series_title: series,
      season_number: season,
      episode_number: number,
      duration: 100,
      size_bytes: 100,
      format: 'mkv',
      is_hdr: false,
      streams_json: '[]',
      created_at: createdAt,
      updated_at: createdAt
    });

    episode('s1e1', 1, 1, '2025-01-01T00:00:00.000Z');
    episode('s1e2', 1, 2, '2025-01-02T00:00:00.000Z');
    episode('s1e10', 1, 10, '2025-01-03T00:00:00.000Z');
    episode('s2e1', 2, 1, '2025-01-04T00:00:00.000Z');
    episode('hidden', 1, 1, '2025-01-09T00:00:00.000Z', 'Hidden Show', otherLibraryId);
  });

  const scope = () => [libraryId] as const;

  it('lists the newest indexed items first', () => {
    expect(idsOf(MediaModel.getRecentlyAdded(userId, 3, scope())))
      .toEqual([id('s2e1'), id('s1e10'), id('s1e2')]);
  });

  it('keeps recently added inside the viewer library scope', () => {
    expect(idsOf(MediaModel.getRecentlyAdded(userId, 10, scope()))).not.toContain(id('hidden'));
  });

  it('offers the next episode after the last one finished', () => {
    ProgressModel.upsert(userId, id('s1e1'), 100, 100);
    expect(idsOf(MediaModel.getNextUp(userId, 10, scope()))).toEqual([id('s1e2')]);
  });

  it('crosses a season boundary rather than stopping at the season finale', () => {
    ProgressModel.upsert(userId, id('s1e10'), 100, 100);
    expect(idsOf(MediaModel.getNextUp(userId, 10, scope()))).toEqual([id('s2e1')]);
  });

  it('returns one entry per series, not every remaining episode', () => {
    ProgressModel.upsert(userId, id('s1e1'), 100, 100);
    expect(MediaModel.getNextUp(userId, 10, scope())).toHaveLength(1);
  });

  it('skips an episode the viewer already finished out of order', () => {
    ProgressModel.upsert(userId, id('s1e1'), 100, 100);
    ProgressModel.upsert(userId, id('s1e2'), 100, 100);
    expect(idsOf(MediaModel.getNextUp(userId, 10, scope()))).toEqual([id('s1e10')]);
  });

  it('offers nothing once a series is fully watched', () => {
    for (const key of ['s1e1', 's1e2', 's1e10', 's2e1']) {
      ProgressModel.upsert(userId, id(key), 100, 100);
    }
    expect(MediaModel.getNextUp(userId, 10, scope())).toEqual([]);
  });

  it('does not suggest a next episode for a series never started', () => {
    expect(MediaModel.getNextUp(userId, 10, scope())).toEqual([]);
  });

  it('scopes next up to the requesting user', () => {
    ProgressModel.upsert(userId, id('s1e1'), 100, 100);
    expect(MediaModel.getNextUp(`${userId}_other`, 10, scope())).toEqual([]);
  });

  it('lists finished items in recently watched, newest first', () => {
    ProgressModel.upsert(userId, id('s1e1'), 100, 100);
    ProgressModel.upsert(userId, id('s1e2'), 30, 100);

    const watched = idsOf(MediaModel.getRecentlyWatched(userId, 10, scope()));
    expect(watched).toContain(id('s1e1'));
    expect(watched).not.toContain(id('s1e2'));
  });
});

describe('home rows route', () => {
  const suffix = crypto.randomUUID();

  const call = (pathname: string) => server.fetch(new Request(`http://localhost${pathname}`));

  beforeAll(() => {
    initDatabase();
  });

  it('serves every row from one request', async () => {
    const response = await call('/api/media/home');
    expect(response.status).toBe(200);

    const body = await response.json() as { rows: Record<string, unknown[]> };
    expect(Object.keys(body.rows).sort())
      .toEqual(['continueWatching', 'nextUp', 'recentlyAdded', 'recentlyWatched']);
  });

  it('is not shadowed by the /media/:id route', async () => {
    // A literal segment registered after /media/:id would resolve as a lookup
    // for an item called "home" and 404 instead.
    const home = await call('/api/media/home');
    const genres = await call('/api/media/genres');

    expect(home.status).toBe(200);
    expect(genres.status).toBe(200);
    expect(await genres.json()).toHaveProperty('genres');
  });

  it('rejects an out-of-range row limit', async () => {
    expect((await call('/api/media/home?limit=999')).status).toBe(400);
  });
});
