import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import {
  initDatabase,
  LibraryModel,
  MediaModel,
  ProgressModel,
  SeriesModel
} from '../apps/server/src/db';

describe('SQL-level library visibility', () => {
  let allowedLibraryId: string;
  let hiddenLibraryId: string;
  let allowedMovieId: string;
  let hiddenMovieId: string;
  let allowedEpisodeId: string;
  let hiddenEpisodeId: string;

  beforeEach(() => {
    initDatabase();
    const suffix = `${Date.now()}_${crypto.randomUUID()}`;
    allowedLibraryId = `allowed_${suffix}`;
    hiddenLibraryId = `hidden_${suffix}`;
    allowedMovieId = `allowed_movie_${suffix}`;
    hiddenMovieId = `hidden_movie_${suffix}`;
    allowedEpisodeId = `allowed_episode_${suffix}`;
    hiddenEpisodeId = `hidden_episode_${suffix}`;
    const now = new Date().toISOString();

    LibraryModel.create({
      id: allowedLibraryId,
      name: 'Allowed library',
      path: `/tmp/${allowedLibraryId}`,
      type: 'tv',
      created_at: now
    });
    LibraryModel.create({
      id: hiddenLibraryId,
      name: 'Hidden library',
      path: `/tmp/${hiddenLibraryId}`,
      type: 'tv',
      created_at: now
    });

    const insertMedia = (
      id: string,
      libraryId: string,
      type: 'movie' | 'episode',
      seriesTitle?: string
    ) => MediaModel.upsert({
      id,
      library_id: libraryId,
      title: id,
      original_filename: `${id}.mkv`,
      relative_path: `${id}.mkv`,
      full_path: `/tmp/${libraryId}/${id}.mkv`,
      type,
      series_title: seriesTitle,
      season_number: type === 'episode' ? 1 : undefined,
      episode_number: type === 'episode' ? 1 : undefined,
      duration: 100,
      size_bytes: 100,
      format: 'mkv',
      is_hdr: false,
      streams_json: '[]',
      created_at: now,
      updated_at: now
    });

    insertMedia(allowedMovieId, allowedLibraryId, 'movie');
    insertMedia(hiddenMovieId, hiddenLibraryId, 'movie');
    insertMedia(allowedEpisodeId, allowedLibraryId, 'episode', 'Allowed Show');
    insertMedia(hiddenEpisodeId, hiddenLibraryId, 'episode', 'Hidden Show');
    MediaModel.updateContentRating(allowedMovieId, 'PG');
    MediaModel.updateContentRating(allowedEpisodeId, 'R');

    for (const mediaId of [allowedMovieId, hiddenMovieId, allowedEpisodeId, hiddenEpisodeId]) {
      ProgressModel.upsert('admin', mediaId, 30, 100);
    }
  });

  afterEach(() => {
    LibraryModel.delete(allowedLibraryId);
    LibraryModel.delete(hiddenLibraryId);
  });

  it('filters before media pagination and total calculation', () => {
    const page = MediaModel.getAll('admin', {
      allowedLibraryIds: [allowedLibraryId],
      limit: 1
    });

    expect(page.total).toBe(2);
    expect(page.items).toHaveLength(1);
    expect(page.items[0].library_id).toBe(allowedLibraryId);
    expect(MediaModel.getAll('admin', { allowedLibraryIds: [] })).toEqual({ items: [], total: 0 });
    expect(MediaModel.getAll('admin').total).toBeGreaterThanOrEqual(4);
  });

  it('filters direct, progress, continue-watching, and episode queries', () => {
    expect(MediaModel.getById(hiddenMovieId, 'admin', [allowedLibraryId])).toBeNull();
    expect(MediaModel.getById(allowedMovieId, 'admin', [allowedLibraryId])?.id).toBe(allowedMovieId);

    const progress = MediaModel.getProgressItems('admin', {
      allowedLibraryIds: [allowedLibraryId]
    });
    expect(progress.filter((item) => [allowedMovieId, hiddenMovieId, allowedEpisodeId, hiddenEpisodeId]
      .includes(item.id)).map((item) => item.library_id)).toEqual([
      allowedLibraryId,
      allowedLibraryId
    ]);

    const continuing = MediaModel.getContinueWatching('admin', 20, [allowedLibraryId]);
    expect(continuing.filter((item) => [allowedMovieId, hiddenMovieId, allowedEpisodeId, hiddenEpisodeId]
      .includes(item.id)).every((item) => item.library_id === allowedLibraryId)).toBe(true);
    expect(MediaModel.getContinueWatching('admin', 20, [])).toEqual([]);

    expect(MediaModel.getBySeries(
      hiddenLibraryId,
      'Hidden Show',
      'admin',
      [allowedLibraryId]
    )).toEqual([]);
    expect(MediaModel.getBySeries(
      allowedLibraryId,
      'Allowed Show',
      'admin',
      [allowedLibraryId]
    ).map((item) => item.id)).toEqual([allowedEpisodeId]);
  });

  it('filters series rollups, lookup, and seasons at query time', () => {
    const unrestricted = SeriesModel.getAll('admin');
    const allowedSeries = unrestricted.find((series) => series.library_id === allowedLibraryId)!;
    const hiddenSeries = unrestricted.find((series) => series.library_id === hiddenLibraryId)!;

    expect(SeriesModel.getAll('admin', { allowedLibraryIds: [allowedLibraryId] })
      .filter((series) => [allowedLibraryId, hiddenLibraryId].includes(series.library_id))
      .map((series) => series.library_id)).toEqual([allowedLibraryId]);
    expect(SeriesModel.getAll('admin', { allowedLibraryIds: [] })).toEqual([]);
    expect(SeriesModel.getById(hiddenSeries.id, 'admin', [allowedLibraryId])).toBeNull();
    expect(SeriesModel.getById(allowedSeries.id, 'admin', [allowedLibraryId])?.id).toBe(allowedSeries.id);
    expect(SeriesModel.getSeasons(hiddenLibraryId, 'Hidden Show', 'admin', [allowedLibraryId]))
      .toEqual([]);
    expect(SeriesModel.getSeasons(allowedLibraryId, 'Allowed Show', 'admin', [allowedLibraryId]))
      .toHaveLength(1);
  });

  it('filters content ratings before counts, pagination, progress, and series rollups', () => {
    const pg13Only = { maxLevel: 3, allowUnrated: false };
    const page = MediaModel.getAll('admin', {
      allowedLibraryIds: [allowedLibraryId],
      contentRatingScope: pg13Only,
      limit: 1
    });
    expect(page.total).toBe(1);
    expect(page.items.map((item) => item.id)).toEqual([allowedMovieId]);
    expect(MediaModel.getById(
      allowedEpisodeId, 'admin', [allowedLibraryId], pg13Only
    )).toBeNull();
    expect(MediaModel.getProgressItems('admin', {
      allowedLibraryIds: [allowedLibraryId], contentRatingScope: pg13Only
    }).map((item) => item.id)).toContain(allowedMovieId);
    expect(MediaModel.getContinueWatching(
      'admin', 20, [allowedLibraryId], pg13Only
    ).map((item) => item.id)).not.toContain(allowedEpisodeId);
    expect(SeriesModel.getAll('admin', {
      allowedLibraryIds: [allowedLibraryId], contentRatingScope: pg13Only
    })).toEqual([]);

    const allowUnrated = MediaModel.getAll('admin', {
      allowedLibraryIds: [hiddenLibraryId],
      contentRatingScope: { maxLevel: 3, allowUnrated: true }
    });
    expect(allowUnrated.total).toBe(2);
  });

  it('keeps rating level zero distinct from unrestricted and can deny only unrated rows', () => {
    MediaModel.updateContentRating(allowedMovieId, 'TV-Y');

    const tvYOnly = MediaModel.getAll('admin', {
      allowedLibraryIds: [allowedLibraryId],
      contentRatingScope: { maxLevel: 0, allowUnrated: false }
    });
    expect(tvYOnly.items.map((item) => item.id)).toEqual([allowedMovieId]);
    expect(tvYOnly.items[0]).toMatchObject({
      content_rating: 'TV-Y',
      content_rating_level: 0
    });

    const ratedWithoutMaximum = MediaModel.getAll('admin', {
      allowedLibraryIds: [hiddenLibraryId],
      contentRatingScope: { maxLevel: null, allowUnrated: false }
    });
    expect(ratedWithoutMaximum).toEqual({ items: [], total: 0 });
  });

  it('applies content restrictions to per-library item counts', () => {
    const scopedLibraries = LibraryModel.getAll({
      contentRatingScope: { maxLevel: 3, allowUnrated: false }
    });
    expect(scopedLibraries.find((library) => library.id === allowedLibraryId)?.item_count).toBe(1);
    expect(scopedLibraries.find((library) => library.id === hiddenLibraryId)?.item_count).toBe(0);

    const unratedAllowed = LibraryModel.getAll({
      contentRatingScope: { maxLevel: 3, allowUnrated: true }
    });
    expect(unratedAllowed.find((library) => library.id === hiddenLibraryId)?.item_count).toBe(2);
  });
});
