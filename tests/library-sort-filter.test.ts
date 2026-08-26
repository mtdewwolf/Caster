import { beforeEach, describe, expect, it } from 'bun:test';
import {
  initDatabase,
  isWatchedFilter,
  LibraryModel,
  MEDIA_SORT_OPTIONS,
  MediaModel,
  ProgressModel
} from '../apps/server/src/db';

describe('library sorting and filtering', () => {
  let libraryId: string;
  let userId: string;
  let ids: Record<string, string>;

  const titlesOf = (result: { items: Array<{ id: string }> }) =>
    result.items.map((item) => item.id);

  beforeEach(() => {
    initDatabase();
    const suffix = `${Date.now()}_${crypto.randomUUID()}`;
    libraryId = `sortlib_${suffix}`;
    userId = `sortuser_${suffix}`;
    const now = new Date().toISOString();

    LibraryModel.create({
      id: libraryId,
      name: 'Sort library',
      path: `/tmp/${libraryId}`,
      type: 'movie',
      created_at: now
    });

    ids = {
      alpha: `alpha_${suffix}`,
      bravo: `bravo_${suffix}`,
      charlie: `charlie_${suffix}`
    };

    const insert = (
      id: string,
      title: string,
      year: number,
      duration: number,
      genre: string,
      isHdr: boolean,
      createdAt: string
    ) => MediaModel.upsert({
      id,
      library_id: libraryId,
      title,
      original_filename: `${id}.mkv`,
      relative_path: `${id}.mkv`,
      full_path: `/tmp/${libraryId}/${id}.mkv`,
      type: 'movie',
      year,
      duration,
      size_bytes: duration * 1000,
      format: 'mkv',
      genre,
      is_hdr: isHdr,
      streams_json: '[]',
      created_at: createdAt,
      updated_at: createdAt
    });

    insert(ids.charlie, 'Charlie', 1999, 300, 'Drama, Thriller', false, '2025-01-01T00:00:00.000Z');
    insert(ids.alpha, 'Alpha', 2021, 100, 'Dramedy', true, '2025-01-02T00:00:00.000Z');
    insert(ids.bravo, 'Bravo', 2010, 200, 'Drama', false, '2025-01-03T00:00:00.000Z');
  });

  const scope = () => ({ libraryId, allowedLibraryIds: [libraryId] });

  it('defaults to newest first', () => {
    expect(titlesOf(MediaModel.getAll(userId, scope())))
      .toEqual([ids.bravo, ids.alpha, ids.charlie]);
  });

  it('sorts by title in both directions', () => {
    expect(titlesOf(MediaModel.getAll(userId, { ...scope(), sort: 'title' })))
      .toEqual([ids.alpha, ids.bravo, ids.charlie]);
    expect(titlesOf(MediaModel.getAll(userId, { ...scope(), sort: 'title_desc' })))
      .toEqual([ids.charlie, ids.bravo, ids.alpha]);
  });

  it('sorts by year and duration', () => {
    expect(titlesOf(MediaModel.getAll(userId, { ...scope(), sort: 'year' })))
      .toEqual([ids.alpha, ids.bravo, ids.charlie]);
    expect(titlesOf(MediaModel.getAll(userId, { ...scope(), sort: 'duration_asc' })))
      .toEqual([ids.alpha, ids.bravo, ids.charlie]);
  });

  it('matches a whole genre rather than a substring', () => {
    // "Dramedy" must not be returned when filtering on "Drama".
    expect(titlesOf(MediaModel.getAll(userId, { ...scope(), genre: 'Drama', sort: 'title' })))
      .toEqual([ids.bravo, ids.charlie]);
    expect(titlesOf(MediaModel.getAll(userId, { ...scope(), genre: 'Dramedy' })))
      .toEqual([ids.alpha]);
  });

  it('filters on HDR', () => {
    expect(titlesOf(MediaModel.getAll(userId, { ...scope(), hdr: true })))
      .toEqual([ids.alpha]);
    expect(titlesOf(MediaModel.getAll(userId, { ...scope(), hdr: false, sort: 'title' })))
      .toEqual([ids.bravo, ids.charlie]);
  });

  it('filters on per-user watched state', () => {
    ProgressModel.upsert(userId, ids.alpha, 96, 100);
    ProgressModel.upsert(userId, ids.bravo, 20, 200);

    expect(titlesOf(MediaModel.getAll(userId, { ...scope(), watched: 'watched' })))
      .toEqual([ids.alpha]);
    expect(titlesOf(MediaModel.getAll(userId, { ...scope(), watched: 'in_progress' })))
      .toEqual([ids.bravo]);
    expect(titlesOf(MediaModel.getAll(userId, { ...scope(), watched: 'unwatched' })))
      .toEqual([ids.charlie]);
  });

  it('scopes watched state to the requesting user', () => {
    ProgressModel.upsert(userId, ids.alpha, 96, 100);

    const other = MediaModel.getAll(`${userId}_other`, { ...scope(), watched: 'unwatched', sort: 'title' });
    expect(titlesOf(other)).toEqual([ids.alpha, ids.bravo, ids.charlie]);
  });

  it('reports a total that respects the active filters', () => {
    const filtered = MediaModel.getAll(userId, { ...scope(), genre: 'Drama', limit: 1 });
    expect(filtered.total).toBe(2);
    expect(filtered.items).toHaveLength(1);
  });

  it('paginates deterministically when a sort value repeats', () => {
    const first = MediaModel.getAll(userId, { ...scope(), sort: 'title', limit: 2, offset: 0 });
    const second = MediaModel.getAll(userId, { ...scope(), sort: 'title', limit: 2, offset: 2 });
    expect([...titlesOf(first), ...titlesOf(second)])
      .toEqual([ids.alpha, ids.bravo, ids.charlie]);
  });

  it('lists distinct genres split out of the stored list', () => {
    expect(MediaModel.getGenres({ libraryId, allowedLibraryIds: [libraryId] }))
      .toEqual(['Drama', 'Dramedy', 'Thriller']);
  });

  it('exposes the supported sort keys and watched filters', () => {
    expect(MEDIA_SORT_OPTIONS).toContain('title');
    expect(MEDIA_SORT_OPTIONS).toContain('year_asc');
    expect(isWatchedFilter('in_progress')).toBe(true);
    expect(isWatchedFilter('nonsense')).toBe(false);
  });
});
