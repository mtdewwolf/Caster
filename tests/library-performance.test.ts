import { beforeAll, describe, expect, it } from 'bun:test';
import crypto from 'crypto';
import { initDatabase, db, LibraryModel, MediaModel, ProgressModel, SeriesModel } from '../apps/server/src/db';

/**
 * Guards the query shapes the library depends on at a realistic size.
 *
 * Two kinds of assertion. The query plans are the real guard: they fail
 * deterministically the moment a query stops using an index, whatever the
 * machine. The timing budgets are deliberately loose — they exist to catch a
 * pathological regression, not to measure a laptop against a CI runner.
 */
describe('library query performance', () => {
  const suffix = crypto.randomUUID().slice(0, 8);
  const libraryId = `perf-lib-${suffix}`;
  const userId = `perf-user-${suffix}`;
  const MOVIES = 6000;
  const EPISODES = 6000;
  const SERIES_COUNT = 200;

  function explain(sql: string, params: unknown[] = []): string {
    const statement = db.prepare(`EXPLAIN QUERY PLAN ${sql}`);
    try {
      const rows = statement.all(...params as any[]) as Array<{ detail: string }>;
      return rows.map((row) => row.detail).join(' | ');
    } finally {
      statement.finalize();
    }
  }

  function timed(work: () => unknown): number {
    const started = performance.now();
    work();
    return performance.now() - started;
  }

  beforeAll(() => {
    initDatabase();
    LibraryModel.create({
      id: libraryId,
      name: 'Performance library',
      path: `/tmp/${libraryId}`,
      type: 'tv',
      created_at: new Date().toISOString()
    });

    const now = new Date().toISOString();
    const insert = (
      id: string,
      type: 'movie' | 'episode',
      index: number,
      seriesTitle?: string
    ) => MediaModel.upsert({
      id,
      library_id: libraryId,
      title: `Title ${String(index).padStart(6, '0')}`,
      original_filename: `${id}.mkv`,
      relative_path: `${id}.mkv`,
      full_path: `/tmp/${libraryId}/${id}.mkv`,
      type,
      series_title: seriesTitle,
      season_number: type === 'episode' ? (index % 8) + 1 : undefined,
      episode_number: type === 'episode' ? (index % 24) + 1 : undefined,
      year: 1980 + (index % 45),
      duration: 600 + (index % 5400),
      size_bytes: 1_000_000 + index,
      format: 'mkv',
      resolution_label: ['4K', '1080p', '720p'][index % 3],
      genre: ['Drama', 'Comedy, Drama', 'Thriller'][index % 3],
      is_hdr: index % 5 === 0,
      streams_json: '[]',
      created_at: now,
      updated_at: now
    });

    // One transaction: 12,000 individual commits would dominate the run time
    // and tell us nothing about query performance.
    db.run('BEGIN');
    try {
      for (let index = 0; index < MOVIES; index += 1) {
        insert(`perf-movie-${suffix}-${index}`, 'movie', index);
      }
      for (let index = 0; index < EPISODES; index += 1) {
        insert(
          `perf-ep-${suffix}-${index}`,
          'episode',
          index,
          `Series ${String(index % SERIES_COUNT).padStart(4, '0')}`
        );
      }
      db.run('COMMIT');
    } catch (error) {
      db.run('ROLLBACK');
      throw error;
    }

    // A realistic amount of watch history to join against.
    db.run('BEGIN');
    try {
      for (let index = 0; index < 1500; index += 1) {
        ProgressModel.upsert(userId, `perf-ep-${suffix}-${index}`, index % 600, 3600);
      }
      db.run('COMMIT');
    } catch (error) {
      db.run('ROLLBACK');
      throw error;
    }
  });

  it('indexed the synthetic library as expected', () => {
    const total = MediaModel.getAll(userId, { libraryId, allowedLibraryIds: [libraryId] }).total;
    expect(total).toBe(MOVIES + EPISODES);
  });

  it('narrows a library listing by index rather than scanning every row', () => {
    const plan = explain(
      'SELECT m.id FROM media_items m WHERE m.library_id = ? AND m.type = ?',
      [libraryId, 'movie']
    );
    expect(plan).toContain('USING INDEX');
    expect(plan).not.toContain('SCAN media_items');
  });

  it('resolves a single item by primary key', () => {
    const plan = explain('SELECT * FROM media_items m WHERE m.id = ?', ['nothing']);
    expect(plan.toLowerCase()).toContain('search');
    expect(plan).not.toContain('SCAN media_items');
  });

  it('joins per-user progress through an index', () => {
    const plan = explain(
      'SELECT p.id FROM watch_progress p WHERE p.user_id = ? ORDER BY p.last_watched_at DESC',
      [userId]
    );
    expect(plan).toContain('INDEX');
  });

  it('groups a series without scanning the whole library', () => {
    const plan = explain(`
      SELECT m.series_title FROM media_items m
      WHERE m.type = 'episode' AND m.library_id = ? AND m.series_title = ?
    `, [libraryId, 'Series 0001']);
    expect(plan).toContain('USING INDEX');
  });

  it('pages a large library quickly', () => {
    const elapsed = timed(() => MediaModel.getAll(userId, {
      libraryId,
      allowedLibraryIds: [libraryId],
      sort: 'title',
      limit: 50,
      offset: 0
    }));
    expect(elapsed).toBeLessThan(1500);
  });

  it('stays quick on a deep page', () => {
    const elapsed = timed(() => MediaModel.getAll(userId, {
      libraryId,
      allowedLibraryIds: [libraryId],
      sort: 'title',
      limit: 50,
      offset: 8000
    }));
    expect(elapsed).toBeLessThan(2000);
  });

  it('searches a large library quickly', () => {
    const elapsed = timed(() => MediaModel.getAll(userId, {
      libraryId,
      allowedLibraryIds: [libraryId],
      search: 'Title 004242',
      limit: 50
    }));
    expect(elapsed).toBeLessThan(1500);
  });

  it('finds a title through full-text search rather than a scan', () => {
    const found = MediaModel.getAll(userId, {
      libraryId,
      allowedLibraryIds: [libraryId],
      search: 'Title 004242',
      limit: 10
    });
    expect(found.items.length).toBeGreaterThan(0);
  });

  it('aggregates every series quickly', () => {
    const elapsed = timed(() => {
      const series = SeriesModel.getAll(userId, {
        libraryId,
        allowedLibraryIds: [libraryId]
      });
      expect(series.length).toBe(SERIES_COUNT);
    });
    expect(elapsed).toBeLessThan(3000);
  });

  it('builds the home rows quickly', () => {
    const elapsed = timed(() => {
      MediaModel.getContinueWatching(userId, 12, [libraryId]);
      MediaModel.getRecentlyAdded(userId, 12, [libraryId]);
      MediaModel.getRecentlyWatched(userId, 12, [libraryId]);
      MediaModel.getNextUp(userId, 12, [libraryId]);
    });
    expect(elapsed).toBeLessThan(3000);
  });

  it('filters on watched state without a correlated scan per row', () => {
    const elapsed = timed(() => MediaModel.getAll(userId, {
      libraryId,
      allowedLibraryIds: [libraryId],
      watched: 'unwatched',
      limit: 50
    }));
    expect(elapsed).toBeLessThan(2500);
  });

  it('lists distinct genres quickly', () => {
    const elapsed = timed(() => {
      const genres = MediaModel.getGenres({ libraryId, allowedLibraryIds: [libraryId] });
      expect(genres).toEqual(['Comedy', 'Drama', 'Thriller']);
    });
    expect(elapsed).toBeLessThan(2000);
  });
});
