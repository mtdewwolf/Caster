import { describe, it, expect, beforeEach } from 'bun:test';
import { parseFilename } from '../apps/server/src/scanner/metadata';
import { transcoder } from '../apps/server/src/transcoder/engine';
import { initDatabase, LibraryModel, MediaModel, ProgressModel } from '../apps/server/src/db';

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
});
