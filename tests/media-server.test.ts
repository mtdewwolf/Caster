import { describe, it, expect, beforeEach } from 'bun:test';
import fs from 'fs';
import path from 'path';
import { parseFilename } from '../apps/server/src/scanner/metadata';
import { transcoder, TRANSCODE_CACHE_DIR } from '../apps/server/src/transcoder/engine';
import { initDatabase, LibraryModel, MediaModel, ProgressModel, SeriesModel } from '../apps/server/src/db';

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

      const progress = ProgressModel.upsert(mediaId, 120, 600); // 20%
      expect(progress.position_seconds).toBe(120);
      expect(progress.progress_percent).toBe(20);
      expect(progress.completed).toBe(false);

      const completedProgress = ProgressModel.upsert(mediaId, 580, 600); // >92%
      expect(completedProgress.completed).toBe(true);
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
      expect(MediaModel.getAll({ search: 'interst' }).items.map((item) => item.id)).toContain(mediaId);

      MediaModel.upsert({ ...mediaItem, title: 'Arrival' });
      expect(MediaModel.getAll({ search: 'interst' }).items.map((item) => item.id)).not.toContain(mediaId);
      expect(MediaModel.getAll({ search: 'arriv' }).items.map((item) => item.id)).toContain(mediaId);

      LibraryModel.delete(libId);
      expect(MediaModel.getAll({ search: 'arriv' }).items.map((item) => item.id)).not.toContain(mediaId);
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

      ProgressModel.markWatched(episodes[0].id);
      ProgressModel.markWatched(episodes[1].id);

      const all = SeriesModel.getAll({ libraryId: libId });
      expect(all.length).toBe(1);

      const series = all[0];
      expect(series.title).toBe('Breaking Bad');
      expect(series.episode_count).toBe(3);
      expect(series.season_count).toBe(2);
      expect(series.watched_count).toBe(2);
      expect(series.total_duration).toBe(8100);

      const fetched = SeriesModel.getById(series.id);
      expect(fetched).not.toBeNull();
      expect(fetched?.title).toBe('Breaking Bad');

      const seasons = SeriesModel.getSeasons(libId, 'Breaking Bad');
      expect(seasons.length).toBe(2);
      expect(seasons[0].season_number).toBe(1);
      expect(seasons[0].episode_count).toBe(2);
      expect(seasons[0].watched_count).toBe(2);
      expect(seasons[1].season_number).toBe(2);
      expect(seasons[1].watched_count).toBe(0);

      const eps = MediaModel.getBySeries(libId, 'Breaking Bad');
      expect(eps.length).toBe(3);
      expect(eps.map((e) => e.id)).toEqual([episodes[0].id, episodes[1].id, episodes[2].id]);

      const searched = SeriesModel.getAll({ search: 'breaking' });
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

      const all = SeriesModel.getAll({ libraryId: libId });
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

