import { describe, it, expect, beforeEach } from 'bun:test';
import fs from 'fs';
import path from 'path';
import { Database } from 'bun:sqlite';
import { parseFilename } from '../apps/server/src/scanner/metadata';
import { transcoder, TRANSCODE_CACHE_DIR } from '../apps/server/src/transcoder/engine';
import { initDatabase, LibraryModel, MediaModel, migrateWatchProgressToUsers, ProgressModel, SeriesModel } from '../apps/server/src/db';

describe('Media Server Tests', () => {
  beforeEach(() => {
    initDatabase();
  });

  describe('Filename Parser', () => {
    it('should parse movie filenames correctly', () => {
      const parsed = parseFilename('Inception.2010.1080p.BluRay.x264.mkv', 'movies');
      expect(parsed.title).toBe('Inception');
      expect(parsed.year).toBe(2010);
      expect(parsed.type).toBe('movie');
    });

    it('should parse TV series episode filenames correctly', () => {
      const parsed = parseFilename('Breaking.Bad.S01E03.720p.mkv', 'tv');
      expect(parsed.seriesTitle).toBe('Breaking Bad');
      expect(parsed.seasonNumber).toBe(1);
      expect(parsed.episodeNumber).toBe(3);
      expect(parsed.type).toBe('episode');
    });

    it('should parse music tracks correctly', () => {
      const parsed = parseFilename('01 - Bohemian Rhapsody.flac', 'music');
      expect(parsed.title).toContain('Bohemian Rhapsody');
      expect(parsed.type).toBe('track');
    });
  });

  describe('Database Models', () => {
    it('should migrate legacy progress to the admin user and allow per-user rows', () => {
      const legacyDb = new Database(':memory:');
      legacyDb.run('CREATE TABLE media_items (id TEXT PRIMARY KEY)');
      legacyDb.run(`
        CREATE TABLE watch_progress (
          id TEXT PRIMARY KEY,
          media_id TEXT UNIQUE NOT NULL REFERENCES media_items(id) ON DELETE CASCADE,
          position_seconds REAL NOT NULL DEFAULT 0,
          duration_seconds REAL NOT NULL DEFAULT 0,
          progress_percent REAL NOT NULL DEFAULT 0,
          completed INTEGER NOT NULL DEFAULT 0,
          last_watched_at TEXT NOT NULL
        )
      `);
      legacyDb.run('INSERT INTO media_items (id) VALUES (?)', ['legacy-media']);
      legacyDb.run(`
        INSERT INTO watch_progress VALUES (?, ?, ?, ?, ?, ?, ?)
      `, ['prog_legacy', 'legacy-media', 120, 600, 20, 0, new Date().toISOString()]);

      migrateWatchProgressToUsers(legacyDb);

      const columns = legacyDb.query('PRAGMA table_info(watch_progress)').all() as Array<{ name: string }>;
      const migrated = legacyDb.query(`
        SELECT user_id, media_id, position_seconds FROM watch_progress
      `).get() as { user_id: string; media_id: string; position_seconds: number };
      legacyDb.run(`
        INSERT INTO watch_progress VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      `, ['prog_second', 'second-user', 'legacy-media', 240, 600, 40, 0, new Date().toISOString()]);
      const rowCount = legacyDb.query(`
        SELECT COUNT(*) as count FROM watch_progress WHERE media_id = ?
      `).get('legacy-media') as { count: number };

      expect(columns.map((column) => column.name)).toContain('user_id');
      expect(migrated).toMatchObject({
        user_id: 'admin',
        media_id: 'legacy-media',
        position_seconds: 120
      });
      expect(rowCount.count).toBe(2);
      legacyDb.close();
    });

    it('should create and retrieve libraries', () => {
      const id = `test_lib_${Date.now()}`;
      LibraryModel.create({
        id,
        name: 'Test Movies',
        path: '/tmp/test_movies',
        type: 'movies',
        created_at: new Date().toISOString()
      });

      const retrieved = LibraryModel.getById(id);
      expect(retrieved).not.toBeNull();
      expect(retrieved?.name).toBe('Test Movies');
    });

    it('should track watch progress and update resume state', () => {
      const libId = `test_lib_progress_${Date.now()}`;
      LibraryModel.create({
        id: libId,
        name: 'Test Movies Progress',
        path: '/tmp/test_movies_progress',
        type: 'movies',
        created_at: new Date().toISOString()
      });

      const mediaId = `media_item_${Date.now()}`;
      MediaModel.upsert({
        id: mediaId,
        library_id: libId,
        title: 'Test Movie',
        original_filename: 'Test.Movie.2023.mkv',
        relative_path: 'Test.Movie.2023.mkv',
        full_path: `/tmp/test_movies_progress/Test.Movie.${Date.now()}.mkv`,
        type: 'movie',
        duration: 600,
        size_bytes: 1024000,
        format: 'mkv',
        is_hdr: false,
        streams_json: '[]',
        created_at: new Date().toISOString(),
        updated_at: new Date().toISOString()
      });

      const progress = ProgressModel.upsert('test-user', mediaId, 120, 600); // 20%
      expect(progress.user_id).toBe('test-user');
      expect(progress.position_seconds).toBe(120);
      expect(progress.progress_percent).toBe(20);
      expect(progress.completed).toBe(false);

      const completedProgress = ProgressModel.upsert('test-user', mediaId, 580, 600); // >92%
      expect(completedProgress.completed).toBe(true);
    });

    it('should isolate progress and continue-watching items by user', () => {
      const suffix = `${Date.now()}_${Math.random().toString(16).slice(2)}`;
      const libId = `test_lib_users_${suffix}`;
      const mediaId = `media_users_${suffix}`;

      LibraryModel.create({
        id: libId,
        name: 'Multi-user Progress',
        path: `/tmp/test_users_${suffix}`,
        type: 'movies',
        created_at: new Date().toISOString()
      });
      MediaModel.upsert({
        id: mediaId,
        library_id: libId,
        title: 'Shared Movie',
        original_filename: 'Shared.Movie.mkv',
        relative_path: 'Shared.Movie.mkv',
        full_path: `/tmp/test_users_${suffix}/Shared.Movie.mkv`,
        type: 'movie',
        duration: 600,
        size_bytes: 1024000,
        format: 'mkv',
        is_hdr: false,
        streams_json: '[]',
        created_at: new Date().toISOString(),
        updated_at: new Date().toISOString()
      });

      const aliceProgress = ProgressModel.upsert('alice', mediaId, 120, 600);
      const bobProgress = ProgressModel.upsert('bob', mediaId, 300, 600);

      expect(aliceProgress.id).not.toBe(bobProgress.id);
      expect(MediaModel.getById(mediaId, 'alice')?.progress?.position_seconds).toBe(120);
      expect(MediaModel.getById(mediaId, 'bob')?.progress?.position_seconds).toBe(300);
      expect(MediaModel.getContinueWatching('alice').find((item) => item.id === mediaId)?.progress?.user_id).toBe('alice');
      expect(MediaModel.getContinueWatching('bob').find((item) => item.id === mediaId)?.progress?.user_id).toBe('bob');

      ProgressModel.remove('alice', mediaId);
      expect(MediaModel.getById(mediaId, 'alice')?.progress).toBeUndefined();
      expect(MediaModel.getById(mediaId, 'bob')?.progress?.position_seconds).toBe(300);
    });

    it('should keep full-text title search in sync with media changes', () => {
      const suffix = Date.now().toString();
      const libId = `test_lib_search_${suffix}`;
      const mediaId = `media_search_${suffix}`;
      const fullPath = `/tmp/test_search_${suffix}/Interstellar.mkv`;

      LibraryModel.create({
        id: libId,
        name: 'Search Test',
        path: `/tmp/test_search_${suffix}`,
        type: 'movies',
        created_at: new Date().toISOString()
      });

      const mediaItem = {
        id: mediaId,
        library_id: libId,
        title: 'Interstellar',
        original_filename: 'Interstellar.mkv',
        relative_path: 'Interstellar.mkv',
        full_path: fullPath,
        type: 'movie',
        duration: 600,
        size_bytes: 1024000,
        format: 'mkv',
        is_hdr: false,
        streams_json: '[]',
        created_at: new Date().toISOString(),
        updated_at: new Date().toISOString()
      };

      MediaModel.upsert(mediaItem);
      expect(MediaModel.getAll('test-user', { search: 'interst' }).items.map((item) => item.id)).toContain(mediaId);

      MediaModel.upsert({ ...mediaItem, title: 'Arrival' });
      expect(MediaModel.getAll('test-user', { search: 'interst' }).items.map((item) => item.id)).not.toContain(mediaId);
      expect(MediaModel.getAll('test-user', { search: 'arriv' }).items.map((item) => item.id)).toContain(mediaId);

      LibraryModel.delete(libId);
      expect(MediaModel.getAll('test-user', { search: 'arriv' }).items.map((item) => item.id)).not.toContain(mediaId);
    });
  });

  describe('Series Rollup', () => {
    it('should group episodes into series with season rollups and watched counts', () => {
      const libId = `test_lib_tv_${Date.now()}`;
      LibraryModel.create({
        id: libId,
        name: 'Test TV',
        path: '/tmp/test_tv',
        type: 'tv',
        created_at: new Date().toISOString()
      });

      const now = new Date().toISOString();
      const episodes = [
        { id: `ep_${Date.now()}_1`, s: 1, e: 1, title: 'Pilot' },
        { id: `ep_${Date.now()}_2`, s: 1, e: 2, title: 'Second' },
        { id: `ep_${Date.now()}_3`, s: 2, e: 1, title: 'S2 Opener' }
      ];

      for (const ep of episodes) {
        MediaModel.upsert({
          id: ep.id,
          library_id: libId,
          title: ep.title,
          original_filename: `Breaking.Bad.S0${ep.s}E0${ep.e}.mkv`,
          relative_path: `S0${ep.s}/Breaking.Bad.S0${ep.s}E0${ep.e}.mkv`,
          full_path: `/tmp/test_tv/S0${ep.s}/ep_${ep.id}.mkv`,
          type: 'episode',
          series_title: 'Breaking Bad',
          season_number: ep.s,
          episode_number: ep.e,
          year: 2008,
          duration: 2700,
          size_bytes: 1024000,
          format: 'mkv',
          is_hdr: false,
          streams_json: '[]',
          poster_path: `/api/media/${ep.id}/thumbnail`,
          created_at: now,
          updated_at: now
        });
      }

      ProgressModel.markWatched('test-user', episodes[0].id);
      ProgressModel.markWatched('test-user', episodes[1].id);

      const all = SeriesModel.getAll('test-user', { libraryId: libId });
      expect(all.length).toBe(1);

      const series = all[0];
      expect(series.title).toBe('Breaking Bad');
      expect(series.episode_count).toBe(3);
      expect(series.season_count).toBe(2);
      expect(series.watched_count).toBe(2);
      expect(SeriesModel.getAll('other-user', { libraryId: libId })[0].watched_count).toBe(0);
      expect(series.total_duration).toBe(8100);

      const fetched = SeriesModel.getById(series.id, 'test-user');
      expect(fetched).not.toBeNull();
      expect(fetched?.title).toBe('Breaking Bad');

      const seasons = SeriesModel.getSeasons(libId, 'Breaking Bad', 'test-user');
      expect(seasons.length).toBe(2);
      expect(seasons[0].season_number).toBe(1);
      expect(seasons[0].episode_count).toBe(2);
      expect(seasons[0].watched_count).toBe(2);
      expect(seasons[1].season_number).toBe(2);
      expect(seasons[1].watched_count).toBe(0);

      const eps = MediaModel.getBySeries(libId, 'Breaking Bad', 'test-user');
      expect(eps.length).toBe(3);
      expect(eps.map((e) => e.id)).toEqual([episodes[0].id, episodes[1].id, episodes[2].id]);

      const searched = SeriesModel.getAll('test-user', { search: 'breaking' });
      expect(searched.some((s) => s.id === series.id)).toBe(true);
    });

    it('should not roll up movies into series', () => {
      const libId = `test_lib_noseries_${Date.now()}`;
      LibraryModel.create({
        id: libId,
        name: 'Test No Series',
        path: '/tmp/test_noseries',
        type: 'movies',
        created_at: new Date().toISOString()
      });

      MediaModel.upsert({
        id: `movie_${Date.now()}`,
        library_id: libId,
        title: 'Some Movie',
        original_filename: 'Some.Movie.2020.mkv',
        relative_path: 'Some.Movie.2020.mkv',
        full_path: `/tmp/test_noseries/movie_${Date.now()}.mkv`,
        type: 'movie',
        duration: 6000,
        size_bytes: 1024000,
        format: 'mkv',
        is_hdr: false,
        streams_json: '[]',
        created_at: new Date().toISOString(),
        updated_at: new Date().toISOString()
      });

      const all = SeriesModel.getAll('test-user', { libraryId: libId });
      expect(all.length).toBe(0);
    });
  });

  describe('Transcoding Engine & HLS', () => {
    it('should detect system hardware capabilities', () => {
      const hw = transcoder.getHardwareStatus();
      expect(hw).toBeDefined();
      expect(typeof hw.ffmpegVersion).toBe('string');
      expect(typeof hw.qsvSupported).toBe('boolean');
      expect(typeof hw.nvencSupported).toBe('boolean');
    });

    it('should generate valid HLS master playlist', () => {
      const master = transcoder.generateMasterPlaylist('item123', 1920, 1080);
      expect(master).toContain('#EXTM3U');
      expect(master).toContain('#EXT-X-STREAM-INF');
      expect(master).toContain('/api/media/item123/hls/1080p/index.m3u8');
    });

    it('should generate valid HLS variant playlist with segments', () => {
      const variant = transcoder.generateVariantPlaylist('item123', 120, '720p');
      expect(variant).toContain('#EXTM3U');
      expect(variant).toContain('#EXT-X-TARGETDURATION');
      expect(variant).toContain('/api/media/item123/hls/720p/segment-0.ts');
      expect(variant).toContain('#EXT-X-ENDLIST');
    });
  });

  describe('Transcode Cache Eviction Policy', () => {
    beforeEach(() => {
      if (!fs.existsSync(TRANSCODE_CACHE_DIR)) {
        fs.mkdirSync(TRANSCODE_CACHE_DIR, { recursive: true });
      }
      transcoder.clearAllCache();
    });

    it('should report cache status accurately', () => {
      const file1 = path.join(TRANSCODE_CACHE_DIR, 'test_status_1.ts');
      fs.writeFileSync(file1, Buffer.alloc(1024)); // 1 KB

      const status = transcoder.getCacheStatus();
      expect(status.fileCount).toBeGreaterThanOrEqual(1);
      expect(status.totalSizeBytes).toBeGreaterThanOrEqual(1024);
      expect(status.maxAgeHours).toBeGreaterThan(0);
      expect(status.maxSizeMb).toBeGreaterThan(0);
    });

    it('should evict expired cache segments based on TTL', () => {
      const fileOld = path.join(TRANSCODE_CACHE_DIR, 'test_expired_1.ts');
      const fileNew = path.join(TRANSCODE_CACHE_DIR, 'test_active_1.ts');

      fs.writeFileSync(fileOld, Buffer.alloc(2048));
      fs.writeFileSync(fileNew, Buffer.alloc(2048));

      // Make fileOld 30 hours old
      const thirtyHoursAgo = new Date(Date.now() - 30 * 60 * 60 * 1000);
      fs.utimesSync(fileOld, thirtyHoursAgo, thirtyHoursAgo);

      const result = transcoder.cleanCache({ maxAgeHours: 24 });
      expect(result.deletedCount).toBe(1);
      expect(result.bytesFreed).toBe(2048);
      expect(fs.existsSync(fileOld)).toBe(false);
      expect(fs.existsSync(fileNew)).toBe(true);
    });

    it('should evict oldest segments when size exceeds budget (LRU)', () => {
      const fileOldest = path.join(TRANSCODE_CACHE_DIR, 'test_lru_1.ts');
      const fileMid = path.join(TRANSCODE_CACHE_DIR, 'test_lru_2.ts');
      const fileNewest = path.join(TRANSCODE_CACHE_DIR, 'test_lru_3.ts');

      fs.writeFileSync(fileOldest, Buffer.alloc(1000));
      fs.writeFileSync(fileMid, Buffer.alloc(1000));
      fs.writeFileSync(fileNewest, Buffer.alloc(1000));

      const time1 = new Date(Date.now() - 3000);
      const time2 = new Date(Date.now() - 2000);
      const time3 = new Date(Date.now() - 1000);

      fs.utimesSync(fileOldest, time1, time1);
      fs.utimesSync(fileMid, time2, time2);
      fs.utimesSync(fileNewest, time3, time3);

      // Budget = 2500 bytes (total is 3000, so oldest should be deleted)
      const result = transcoder.cleanCache({ maxAgeHours: 100, maxSizeBytes: 2500 });
      expect(result.deletedCount).toBe(1);
      expect(fs.existsSync(fileOldest)).toBe(false);
      expect(fs.existsSync(fileMid)).toBe(true);
      expect(fs.existsSync(fileNewest)).toBe(true);
    });
  });
});

