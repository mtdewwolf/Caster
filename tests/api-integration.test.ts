import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
import crypto from 'crypto';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { Hono } from 'hono';
import { db, initDatabase, LibraryModel, MediaModel, ProgressModel } from '../apps/server/src/db';
import { PUBLIC_USER_ID } from '../apps/server/src/identity';
import { apiRouter } from '../apps/server/src/routes/api';
import { scanStatus } from '../apps/server/src/scanner/indexer';
import server from '../apps/server/src/index';

describe('API integration regressions', () => {
  const app = new Hono();
  let fixtureRoot = '';
  let libraryId = '';
  let mediaId = '';
  let mediaPath = '';

  app.route('/api', apiRouter);

  function request(pathname: string, init: RequestInit = {}): Promise<Response> {
    return app.request(pathname, init);
  }

  beforeAll(() => {
    initDatabase();

    fixtureRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'caster-api-integration-'));
    mediaPath = path.join(fixtureRoot, 'Range.Test.2026.mp4');
    fs.writeFileSync(mediaPath, '0123456789');

    const suffix = crypto.randomUUID();
    libraryId = `integration_library_${suffix}`;
    mediaId = `integration_media_${suffix}`;
    const now = new Date().toISOString();

    LibraryModel.create({
      id: libraryId,
      name: 'API Integration Library',
      path: fixtureRoot,
      type: 'movies',
      created_at: now
    });
    MediaModel.upsert({
      id: mediaId,
      library_id: libraryId,
      title: 'Range Test',
      original_filename: path.basename(mediaPath),
      relative_path: path.basename(mediaPath),
      full_path: mediaPath,
      type: 'movie',
      duration: 100,
      size_bytes: 10,
      format: 'mp4',
      width: 1280,
      height: 720,
      is_hdr: false,
      streams_json: '[]',
      created_at: now,
      updated_at: now
    });
  });

  afterAll(() => {
    if (libraryId) LibraryModel.delete(libraryId);
    const expectedPrefix = path.join(os.tmpdir(), 'caster-api-integration-');
    if (fixtureRoot.startsWith(expectedPrefix)) {
      fs.rmSync(fixtureRoot, { recursive: true, force: true });
    }
  });

  it('allows registered API mutations without account credentials', async () => {
    const mutationMethods = new Set(['POST', 'PUT', 'PATCH', 'DELETE']);
    const routes = apiRouter.routes.filter((route) => mutationMethods.has(route.method));
    const results: Array<{ method: string; path: string; status: number }> = [];

    for (const route of routes) {
      const concretePath = route.path.replace(/:[^/]+/g, 'test-value');
      const response = await request(`/api${concretePath}`, { method: route.method });
      results.push({ method: route.method, path: route.path, status: response.status });
    }

    expect(routes.length).toBeGreaterThan(0);
    expect(results.every((result) => result.status !== 401 && result.status !== 403)).toBe(true);
  });

  it('adds and removes the folders a library is made of', async () => {
    // Empty folders: the background rescan each change triggers has nothing to
    // find, so it cannot disturb the fixture library the other tests use.
    const prefix = path.join(os.tmpdir(), 'caster-api-roots-');
    const first = fs.mkdtempSync(`${prefix}a-`);
    const second = fs.mkdtempSync(`${prefix}b-`);
    let createdId = '';

    try {
      const created = await request('/api/libraries', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: 'Split Library', paths: [first, second], type: 'movies' })
      });
      expect(created.status).toBe(200);
      const createdLibrary = (await created.json()).library;
      createdId = createdLibrary.id;
      expect(createdLibrary.paths).toEqual([first, second]);
      expect(createdLibrary.path).toBe(first);

      const duplicate = await request(`/api/libraries/${createdId}/paths`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ path: second })
      });
      expect(duplicate.status).toBe(409);
      expect(await duplicate.json()).toMatchObject({
        error: 'That folder is already part of this library'
      });

      // Scanning a folder and its parent into one library would index the same
      // files twice.
      const insideSecond = path.join(second, 'inside');
      fs.mkdirSync(insideSecond, { recursive: true });
      const nested = await request(`/api/libraries/${createdId}/paths`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ path: insideSecond })
      });
      expect(nested.status).toBe(409);
      expect((await nested.json()).error).toContain(second);

      const removed = await request(`/api/libraries/${createdId}/paths`, {
        method: 'DELETE',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ path: first })
      });
      expect(removed.status).toBe(200);
      expect((await removed.json()).library).toMatchObject({ path: second, paths: [second] });

      const lastOne = await request(`/api/libraries/${createdId}/paths`, {
        method: 'DELETE',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ path: second })
      });
      expect(lastOne.status).toBe(409);
      expect(await lastOne.json()).toMatchObject({
        error: 'A library must keep at least one folder. Delete the library instead.'
      });
    } finally {
      if (createdId) LibraryModel.delete(createdId);
      for (const root of [first, second]) {
        if (root.startsWith(prefix)) fs.rmSync(root, { recursive: true, force: true });
      }
    }
  });

  it('returns stable 400 responses for malformed JSON bodies', async () => {
    const requests = [
      { path: '/api/libraries', method: 'POST' },
      { path: `/api/media/${mediaId}/progress`, method: 'POST' },
      { path: '/api/system/hardware/accel', method: 'POST' },
      { path: '/api/system/cache/clear', method: 'POST' }
    ];

    for (const requestSpec of requests) {
      const response = await request(requestSpec.path, {
        method: requestSpec.method,
        headers: { 'Content-Type': 'application/json' },
        body: '{'
      });

      expect(response.status).toBe(400);
      expect(await response.json()).toEqual({ error: 'Invalid JSON body' });
    }
  });

  it('validates library, scanner, pagination, and progress query inputs', async () => {
    const invalidType = await request('/api/libraries', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: 'Invalid', path: fixtureRoot, type: 'documents' })
    });
    const invalidPath = await request('/api/libraries', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        name: 'Missing',
        path: path.join(fixtureRoot, 'does-not-exist'),
        type: 'movies'
      })
    });
    const missingScan = await request('/api/libraries/does-not-exist/scan', {
      method: 'POST'
    });
    const invalidLimit = await app.request('/api/media?limit=not-a-number');
    const invalidOffset = await app.request('/api/media?offset=-1');
    const invalidProgressStatus = await app.request('/api/media/progress?status=unknown');

    expect(invalidType.status).toBe(400);
    expect(await invalidType.json()).toEqual({ error: 'Invalid library type' });
    expect(invalidPath.status).toBe(400);
    expect(await invalidPath.json()).toEqual({
      error: `Folder not found or not accessible: ${path.join(fixtureRoot, 'does-not-exist')}`
    });
    expect(missingScan.status).toBe(404);
    expect(await missingScan.json()).toEqual({ error: 'Library not found' });
    expect(invalidLimit.status).toBe(400);
    expect(invalidOffset.status).toBe(400);
    expect(invalidProgressStatus.status).toBe(400);

    scanStatus.isScanning = true;
    try {
      const busyScan = await request(`/api/libraries/${libraryId}/scan`, { method: 'POST' });
      expect(busyScan.status).toBe(409);
      expect(await busyScan.json()).toEqual({ error: 'A scan is already in progress' });
    } finally {
      scanStatus.isScanning = false;
      scanStatus.libraryId = null;
    }
  });

  it('uses the shared public progress owner and rejects invalid updates', async () => {
    ProgressModel.upsert(PUBLIC_USER_ID, mediaId, 20, 100);

    const item = await request(`/api/media/${mediaId}`);
    expect(item.status).toBe(200);
    expect((await item.json()).item.progress.position_seconds).toBe(20);

    const update = await request(`/api/media/${mediaId}/progress`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ position: 65, duration: 100 })
    });
    expect(update.status).toBe(200);
    expect(await update.json()).toMatchObject({
      progress: {
        user_id: PUBLIC_USER_ID,
        media_id: mediaId,
        position_seconds: 65,
        duration_seconds: 100
      }
    });
    expect(MediaModel.getById(mediaId, PUBLIC_USER_ID)?.progress?.position_seconds).toBe(65);

    const invalidUpdates = [
      { position: -1, duration: 100 },
      { position: 'not-a-number', duration: 100 },
      { position: 10, duration: 0 }
    ];
    for (const body of invalidUpdates) {
      const response = await request(`/api/media/${mediaId}/progress`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body)
      });
      expect(response.status).toBe(400);
    }

    const missingMedia = await request('/api/media/does-not-exist/progress', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ position: 10, duration: 100 })
    });
    expect(missingMedia.status).toBe(404);
  });

  it('serves valid byte ranges and rejects malformed or unsatisfiable ranges', async () => {
    const full = await request(`/api/media/${mediaId}/stream`);
    expect(full.status).toBe(200);
    expect(full.headers.get('Content-Length')).toBe('10');
    expect(await full.text()).toBe('0123456789');

    const partial = await request(`/api/media/${mediaId}/stream`, {
      headers: { Range: 'bytes=2-5' }
    });
    expect(partial.status).toBe(206);
    expect(partial.headers.get('Content-Range')).toBe('bytes 2-5/10');
    expect(partial.headers.get('Content-Length')).toBe('4');
    expect(await partial.text()).toBe('2345');

    const suffix = await request(`/api/media/${mediaId}/stream`, {
      headers: { Range: 'bytes=-3' }
    });
    expect(suffix.status).toBe(206);
    expect(await suffix.text()).toBe('789');

    for (const range of ['bytes=20-30', 'bytes=5-2', 'bytes=0-1,4-5', 'items=0-1']) {
      const response = await request(`/api/media/${mediaId}/stream`, {
        headers: { Range: range }
      });
      expect(response.status).toBe(416);
      expect(response.headers.get('Content-Range')).toBe('bytes */10');
    }
  });

  it('carries the client and connection description into every segment URL', async () => {
    const master = await request(
      `/api/media/${mediaId}/hls/master.m3u8?client=chrome&network=remote`
    );
    const masterText = await master.text();
    expect(masterText).toContain('client=chrome');
    expect(masterText).toContain('network=remote');

    const variant = await request(
      `/api/media/${mediaId}/hls/720p/index.m3u8?client=chrome&network=remote`
    );
    const variantText = await variant.text();
    // A segment planned for a different device than its playlist was is how a
    // stream ends up with a codec the player cannot decode.
    expect(variantText).toContain('client=chrome');
    expect(variantText).toContain('network=remote');
  });

  it('advertises less bandwidth to a viewer over the internet', async () => {
    const bandwidths = async (query: string) => {
      const response = await request(`/api/media/${mediaId}/hls/master.m3u8${query}`);
      const text = await response.text();
      return [...text.matchAll(/BANDWIDTH=(\d+)/g)].map((match) => Number(match[1]));
    };

    const lan = await bandwidths('?client=chrome&network=lan');
    const remote = await bandwidths('?client=chrome&network=remote');

    expect(lan.length).toBeGreaterThan(0);
    expect(lan[0]!).toBeGreaterThan(remote[0]!);
  });

  it('turns away a segment request whose packaging does not match the stream', async () => {
    // A device that described nothing gets H.264 in MPEG-TS, so asking for a
    // fragmented segment means the playlist is stale rather than the segment
    // being missing — and it must not start an encoder to find that out.
    const response = await request(`/api/media/${mediaId}/hls/720p/segment-0.m4s`);
    expect(response.status).toBe(404);
    expect(await response.text()).toContain('reload the playlist');
  });

  it('validates HLS, subtitle, hardware, and cache control requests', async () => {
    const master = await request(`/api/media/${mediaId}/hls/master.m3u8`);
    expect(master.status).toBe(200);
    expect(master.headers.get('Content-Type')).toContain('application/vnd.apple.mpegurl');
    expect(await master.text()).toContain(`/api/media/${mediaId}/hls/720p/index.m3u8`);

    const invalidQuality = await request(`/api/media/${mediaId}/hls/ultra/index.m3u8`);
    const invalidSegment = await request(
      `/api/media/${mediaId}/hls/720p/segment-0.ts.extra`
    );
    const invalidSubtitle = await request(`/api/media/${mediaId}/subtitles/not-a-number`);
    expect(invalidQuality.status).toBe(400);
    expect(invalidSegment.status).toBe(400);
    expect(invalidSubtitle.status).toBe(400);

    const invalidHardware = await request('/api/system/hardware/accel', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ accel: 'magic' })
    });
    const invalidCache = await request('/api/system/cache/clear', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ maxAgeHours: -1 })
    });
    const defaultCacheClean = await request('/api/system/cache/clear', { method: 'POST' });
    expect(invalidHardware.status).toBe(400);
    expect(invalidCache.status).toBe(400);
    expect(defaultCacheClean.status).toBe(200);
  });

  it('exposes safe transcode diagnostics and returns JSON for unknown API routes', async () => {
    const diagnostics = await request('/api/system/transcodes');
    expect(diagnostics.status).toBe(200);
    expect(await diagnostics.json()).toMatchObject({
      activeTranscodes: 0,
      acceptingTranscodes: true,
      sessions: []
    });

    const missing = await server.fetch(new Request('http://localhost/api/does-not-exist'));
    expect(missing.status).toBe(404);
    expect(missing.headers.get('Content-Type')).toContain('application/json');
    expect(await missing.json()).toEqual({ error: 'API route not found' });
  });
});
