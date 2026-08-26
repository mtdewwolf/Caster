import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import { Database } from 'bun:sqlite';
import { Hono } from 'hono';
import { MediaMarkerStore } from '../apps/server/src/db/media-marker-store';
import {
  createPlaybackRouter,
  type PlaybackMedia
} from '../apps/server/src/routes/playback';
import { runDatabaseMigrations } from '../apps/server/src/db/migrations';
import {
  MarkerAnalysisScheduler,
  type MarkerAnalysisInput,
  type MarkerAnalysisResult
} from '../apps/server/src/markers';

interface FixtureMedia extends PlaybackMedia {
  title: string;
}

describe('persistent playback markers', () => {
  let database: Database;
  let markers: MediaMarkerStore;
  let app: Hono;
  let mediaById: Map<string, FixtureMedia>;
  let analysisScheduler: MarkerAnalysisScheduler<MarkerAnalysisInput, MarkerAnalysisResult>;

  beforeEach(() => {
    database = new Database(':memory:');
    database.run('PRAGMA foreign_keys = ON');
    runDatabaseMigrations(database);

    const now = new Date().toISOString();
    database.run(`
      INSERT INTO libraries (id, name, path, type, created_at)
      VALUES ('tv', 'TV', '/tv', 'tv', ?)
    `, [now]);
    database.run(`
      INSERT INTO media_items (
        id, library_id, title, original_filename, relative_path, full_path,
        type, duration, created_at, updated_at
      ) VALUES
        ('episode-1', 'tv', 'Episode 1', 'e1.mkv', 'e1.mkv', '/tv/e1.mkv',
         'episode', 1200, ?, ?),
        ('episode-2', 'tv', 'Episode 2', 'e2.mkv', 'e2.mkv', '/tv/e2.mkv',
         'episode', 1250, ?, ?),
        ('movie-1', 'tv', 'Movie', 'movie.mkv', 'movie.mkv', '/tv/movie.mkv',
         'movie', 7200, ?, ?)
    `, [now, now, now, now, now, now]);

    let tick = 0;
    markers = new MediaMarkerStore(
      database,
      () => `2026-08-24T00:00:${String(tick++).padStart(2, '0')}.000Z`
    );
    mediaById = new Map([
      ['episode-1', {
        id: 'episode-1', type: 'episode', duration: 1200, title: 'Episode 1', full_path: '/tv/e1.mkv'
      }],
      ['episode-2', {
        id: 'episode-2', type: 'episode', duration: 1250, title: 'Episode 2', full_path: '/tv/e2.mkv'
      }],
      ['movie-1', { id: 'movie-1', type: 'movie', duration: 7200, title: 'Movie' }]
    ]);
    analysisScheduler = new MarkerAnalysisScheduler(async (input) => ({
      detectorCount: 1,
      candidateCount: 0,
      markers: markers.getAll(input.mediaId),
      warnings: []
    }), { timeoutMs: 1000 });

    app = new Hono();
    app.route('/api/media', createPlaybackRouter<FixtureMedia>({
      markerStore: markers,
      resolveMedia: (context, mediaId) => {
        if (context.req.header('x-deny') === 'true') return null;
        return mediaById.get(mediaId) ?? null;
      },
      resolveNextEpisode: (_context, media) => media.id === 'episode-1'
        ? { id: 'episode-2', title: 'Episode 2' }
        : null,
      analysisScheduler
    }));
  });

  afterEach(() => database.close());

  it('preserves manual corrections and disabled tombstones over detector output', () => {
    const detected = markers.upsertDetected({
      mediaId: 'episode-1',
      type: 'intro',
      startSeconds: 5,
      endSeconds: 80,
      source: 'chapter',
      confidence: 0.75,
      analyzerVersion: 'chapters-v1'
    });
    expect(detected).toMatchObject({ source: 'chapter', revision: 1 });

    const manual = markers.upsertManual({
      mediaId: 'episode-1',
      type: 'intro',
      startSeconds: 10,
      endSeconds: 95
    });
    expect(manual).toMatchObject({
      source: 'manual', state: 'active', startSeconds: 10, endSeconds: 95, revision: 2
    });

    const ignoredDetection = markers.upsertDetected({
      mediaId: 'episode-1',
      type: 'intro',
      startSeconds: 0,
      endSeconds: 60,
      source: 'audio',
      confidence: 0.99
    });
    expect(ignoredDetection).toMatchObject({
      source: 'manual', startSeconds: 10, endSeconds: 95, revision: 2
    });

    const disabled = markers.disableManual('episode-1', 'intro');
    expect(disabled).toMatchObject({
      state: 'disabled', source: 'manual', startSeconds: null, endSeconds: null, revision: 3
    });
    expect(markers.getActive('episode-1')).toEqual([]);

    markers.upsertDetected({
      mediaId: 'episode-1', type: 'intro', startSeconds: 1, endSeconds: 40, source: 'frame'
    });
    expect(markers.get('episode-1', 'intro')).toMatchObject({ state: 'disabled', revision: 3 });
  });

  it('validates detector inputs and cascades markers with their media identity', () => {
    expect(() => markers.upsertManual({
      mediaId: 'episode-1', type: 'intro', startSeconds: -1, endSeconds: 20
    })).toThrow('startSeconds');
    expect(() => markers.upsertDetected({
      mediaId: 'episode-1', type: 'credits', startSeconds: 1000, endSeconds: 1190,
      source: 'audio', confidence: 2
    })).toThrow('confidence');

    markers.upsertManual({
      mediaId: 'episode-1', type: 'credits', startSeconds: 1100, endSeconds: 1190
    });
    database.run(`DELETE FROM media_items WHERE id = 'episode-1'`);
    expect(markers.getAll('episode-1')).toEqual([]);
  });

  it('returns active playback markers and an already-scoped next episode', async () => {
    markers.upsertManual({
      mediaId: 'episode-1', type: 'intro', startSeconds: 8, endSeconds: 70
    });
    markers.disableManual('episode-1', 'credits');

    const response = await app.request('/api/media/episode-1/playback');
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      markers: [{
        type: 'intro', startSeconds: 8, endSeconds: 70, source: 'manual', confidence: null
      }],
      nextEpisode: { id: 'episode-2', title: 'Episode 2' }
    });

    const denied = await app.request('/api/media/episode-1/playback', {
      headers: { 'x-deny': 'true' }
    });
    expect(denied.status).toBe(404);
    expect(await denied.json()).toEqual({ error: 'Media not found' });
  });

  it('validates manual marker replacements without an account gate', async () => {
    const viewer = await app.request('/api/media/episode-1/markers/intro', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ enabled: true, startSeconds: 5, endSeconds: 60 })
    });
    expect(viewer.status).toBe(200);

    const adminHeaders = { 'Content-Type': 'application/json' };
    for (const [path, body] of [
      ['/api/media/episode-1/markers/recap', { enabled: false }],
      ['/api/media/episode-1/markers/intro', { enabled: true, startSeconds: 80, endSeconds: 40 }],
      ['/api/media/episode-1/markers/intro', { enabled: true, startSeconds: 0, endSeconds: 1300 }],
      ['/api/media/movie-1/markers/intro', { enabled: false }]
    ] as const) {
      const response = await app.request(path, {
        method: 'PUT', headers: adminHeaders, body: JSON.stringify(body)
      });
      expect(response.status).toBe(400);
    }

    const saved = await app.request('/api/media/episode-1/markers/credits', {
      method: 'PUT',
      headers: adminHeaders,
      body: JSON.stringify({ enabled: true, startSeconds: 1100, endSeconds: 1195 })
    });
    expect(saved.status).toBe(200);
    expect(await saved.json()).toMatchObject({
      marker: {
        mediaId: 'episode-1', type: 'credits', state: 'active', source: 'manual',
        startSeconds: 1100, endSeconds: 1195
      }
    });

    const disabled = await app.request('/api/media/episode-1/markers/credits', {
      method: 'PUT', headers: adminHeaders, body: JSON.stringify({ enabled: false })
    });
    expect(disabled.status).toBe(200);
    expect(await disabled.json()).toMatchObject({ marker: { state: 'disabled', source: 'manual' } });
  });

  it('exposes marker editing and bounded analysis status endpoints', async () => {

    const adminHeaders = {};
    const queued = await app.request('/api/media/episode-1/markers/analysis', {
      method: 'POST', headers: adminHeaders
    });
    expect(queued.status).toBe(202);
    expect(await queued.json()).toMatchObject({ accepted: true, status: { state: 'queued' } });
    expect((await analysisScheduler.waitFor('episode-1')).state).toBe('completed');

    const status = await app.request('/api/media/episode-1/markers/analysis', {
      headers: adminHeaders
    });
    expect(status.status).toBe(200);
    expect(await status.json()).toMatchObject({ status: { mediaId: 'episode-1', state: 'completed' } });

    const editor = await app.request('/api/media/episode-1/markers', { headers: adminHeaders });
    expect(editor.status).toBe(200);
    expect(await editor.json()).toMatchObject({ markers: [], analysis: { state: 'completed' } });

    const movie = await app.request('/api/media/movie-1/markers/analysis', {
      method: 'POST', headers: adminHeaders
    });
    expect(movie.status).toBe(400);
  });
});
