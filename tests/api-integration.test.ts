import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
import crypto from 'crypto';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { Hono } from 'hono';
import {
  ADMIN_USER_ID,
  PUBLIC_USER_ID,
  authRouter,
  requireAdminForMutations
} from '../apps/server/src/auth';
import { initDatabase, LibraryModel, MediaModel, ProgressModel } from '../apps/server/src/db';
import { apiRouter } from '../apps/server/src/routes/api';
import { scanStatus } from '../apps/server/src/scanner/indexer';
import server from '../apps/server/src/index';

describe('API integration regressions', () => {
  const app = new Hono();
  const adminToken = `integration-token-${crypto.randomUUID()}`;
  const originalAdminPassword = process.env.ADMIN_PASSWORD;
  const originalAdminToken = process.env.ADMIN_TOKEN;
  let fixtureRoot = '';
  let libraryId = '';
  let mediaId = '';
  let mediaPath = '';

  app.use('/api/*', requireAdminForMutations);
  app.route('/api/auth', authRouter);
  app.route('/api', apiRouter);

  function adminRequest(pathname: string, init: RequestInit = {}): Promise<Response> {
    const headers = new Headers(init.headers);
    headers.set('Authorization', `Bearer ${adminToken}`);
    return app.request(pathname, { ...init, headers });
  }

  beforeAll(() => {
    process.env.ADMIN_PASSWORD = 'integration-password';
    process.env.ADMIN_TOKEN = adminToken;
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
    if (originalAdminPassword === undefined) delete process.env.ADMIN_PASSWORD;
    else process.env.ADMIN_PASSWORD = originalAdminPassword;
    if (originalAdminToken === undefined) delete process.env.ADMIN_TOKEN;
    else process.env.ADMIN_TOKEN = originalAdminToken;

    const expectedPrefix = path.join(os.tmpdir(), 'caster-api-integration-');
    if (fixtureRoot.startsWith(expectedPrefix)) {
      fs.rmSync(fixtureRoot, { recursive: true, force: true });
    }
  });

  it('guards every registered API mutation with admin authentication', async () => {
    const mutationMethods = new Set(['POST', 'PUT', 'PATCH', 'DELETE']);
    const routes = apiRouter.routes.filter((route) => mutationMethods.has(route.method));
    const results: Array<{ method: string; path: string; status: number }> = [];

    for (const route of routes) {
      const concretePath = route.path.replace(/:[^/]+/g, 'test-value');
      const response = await app.request(`/api${concretePath}`, { method: route.method });
      results.push({ method: route.method, path: route.path, status: response.status });
    }

    expect(routes.length).toBeGreaterThan(0);
    expect(results.filter((result) => result.status !== 401)).toEqual([]);

    const logoutResponse = await app.request('/api/auth/logout', { method: 'POST' });
    expect(logoutResponse.status).toBe(200);
  });

  it('returns stable 400 responses for malformed JSON bodies', async () => {
    const requests = [
      { path: '/api/libraries', method: 'POST' },
      { path: `/api/media/${mediaId}/progress`, method: 'POST' },
      { path: '/api/system/hardware/accel', method: 'POST' },
      { path: '/api/system/cache/clear', method: 'POST' }
    ];

    for (const request of requests) {
      const response = await adminRequest(request.path, {
        method: request.method,
        headers: { 'Content-Type': 'application/json' },
        body: '{'
      });

      expect(response.status).toBe(400);
      expect(await response.json()).toEqual({ error: 'Invalid JSON body' });
    }
  });

  it('validates library, scanner, pagination, and progress query inputs', async () => {
    const invalidType = await adminRequest('/api/libraries', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: 'Invalid', path: fixtureRoot, type: 'documents' })
    });
    const invalidPath = await adminRequest('/api/libraries', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        name: 'Missing',
        path: path.join(fixtureRoot, 'does-not-exist'),
        type: 'movies'
      })
    });
    const missingScan = await adminRequest('/api/libraries/does-not-exist/scan', {
      method: 'POST'
    });
    const invalidLimit = await app.request('/api/media?limit=not-a-number');
    const invalidOffset = await app.request('/api/media?offset=-1');
    const invalidProgressStatus = await app.request('/api/media/progress?status=unknown');

    expect(invalidType.status).toBe(400);
    expect(await invalidType.json()).toEqual({ error: 'Invalid library type' });
    expect(invalidPath.status).toBe(400);
    expect(await invalidPath.json()).toEqual({ error: 'Library path not found or not accessible' });
    expect(missingScan.status).toBe(404);
    expect(await missingScan.json()).toEqual({ error: 'Library not found' });
    expect(invalidLimit.status).toBe(400);
    expect(invalidOffset.status).toBe(400);
    expect(invalidProgressStatus.status).toBe(400);

    scanStatus.isScanning = true;
    try {
      const busyScan = await adminRequest(`/api/libraries/${libraryId}/scan`, { method: 'POST' });
      expect(busyScan.status).toBe(409);
      expect(await busyScan.json()).toEqual({ error: 'A scan is already in progress' });
    } finally {
      scanStatus.isScanning = false;
      scanStatus.libraryId = null;
    }
  });

  it('isolates route-level progress by principal and rejects invalid updates', async () => {
    ProgressModel.upsert(PUBLIC_USER_ID, mediaId, 20, 100);
    ProgressModel.upsert(ADMIN_USER_ID, mediaId, 40, 100);

    const anonymousItem = await app.request(`/api/media/${mediaId}`);
    const adminItem = await adminRequest(`/api/media/${mediaId}`);
    expect(anonymousItem.status).toBe(404);
    expect((await adminItem.json()).item.progress.position_seconds).toBe(40);

    const update = await adminRequest(`/api/media/${mediaId}/progress`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ position: 65, duration: 100 })
    });
    expect(update.status).toBe(200);
    expect(await update.json()).toMatchObject({
      progress: {
        user_id: ADMIN_USER_ID,
        media_id: mediaId,
        position_seconds: 65,
        duration_seconds: 100
      }
    });
    expect(MediaModel.getById(mediaId, PUBLIC_USER_ID)?.progress?.position_seconds).toBe(20);

    const invalidUpdates = [
      { position: -1, duration: 100 },
      { position: 'not-a-number', duration: 100 },
      { position: 10, duration: 0 }
    ];
    for (const body of invalidUpdates) {
      const response = await adminRequest(`/api/media/${mediaId}/progress`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body)
      });
      expect(response.status).toBe(400);
    }

    const missingMedia = await adminRequest('/api/media/does-not-exist/progress', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ position: 10, duration: 100 })
    });
    expect(missingMedia.status).toBe(404);
  });

  it('serves valid byte ranges and rejects malformed or unsatisfiable ranges', async () => {
    const full = await adminRequest(`/api/media/${mediaId}/stream`);
    expect(full.status).toBe(200);
    expect(full.headers.get('Content-Length')).toBe('10');
    expect(await full.text()).toBe('0123456789');

    const partial = await adminRequest(`/api/media/${mediaId}/stream`, {
      headers: { Range: 'bytes=2-5' }
    });
    expect(partial.status).toBe(206);
    expect(partial.headers.get('Content-Range')).toBe('bytes 2-5/10');
    expect(partial.headers.get('Content-Length')).toBe('4');
    expect(await partial.text()).toBe('2345');

    const suffix = await adminRequest(`/api/media/${mediaId}/stream`, {
      headers: { Range: 'bytes=-3' }
    });
    expect(suffix.status).toBe(206);
    expect(await suffix.text()).toBe('789');

    for (const range of ['bytes=20-30', 'bytes=5-2', 'bytes=0-1,4-5', 'items=0-1']) {
      const response = await adminRequest(`/api/media/${mediaId}/stream`, {
        headers: { Range: range }
      });
      expect(response.status).toBe(416);
      expect(response.headers.get('Content-Range')).toBe('bytes */10');
    }
  });

  it('validates HLS, subtitle, hardware, and cache control requests', async () => {
    const master = await adminRequest(`/api/media/${mediaId}/hls/master.m3u8`);
    expect(master.status).toBe(200);
    expect(master.headers.get('Content-Type')).toContain('application/vnd.apple.mpegurl');
    expect(await master.text()).toContain(`/api/media/${mediaId}/hls/720p/index.m3u8`);

    const invalidQuality = await adminRequest(`/api/media/${mediaId}/hls/ultra/index.m3u8`);
    const invalidSegment = await adminRequest(
      `/api/media/${mediaId}/hls/720p/segment-0.ts.extra`
    );
    const invalidSubtitle = await adminRequest(`/api/media/${mediaId}/subtitles/not-a-number`);
    expect(invalidQuality.status).toBe(400);
    expect(invalidSegment.status).toBe(400);
    expect(invalidSubtitle.status).toBe(400);

    const invalidHardware = await adminRequest('/api/system/hardware/accel', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ accel: 'magic' })
    });
    const invalidCache = await adminRequest('/api/system/cache/clear', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ maxAgeHours: -1 })
    });
    const defaultCacheClean = await adminRequest('/api/system/cache/clear', { method: 'POST' });
    expect(invalidHardware.status).toBe(400);
    expect(invalidCache.status).toBe(400);
    expect(defaultCacheClean.status).toBe(200);
  });

  it('exposes safe transcode diagnostics and returns JSON for unknown API routes', async () => {
    const diagnostics = await adminRequest('/api/system/transcodes');
    expect(diagnostics.status).toBe(200);
    expect(await diagnostics.json()).toMatchObject({
      activeTranscodes: 0,
      acceptingTranscodes: true,
      sessions: []
    });

    const missing = await server.fetch(new Request('http://localhost/api/does-not-exist', {
      headers: { Authorization: `Bearer ${adminToken}` }
    }));
    expect(missing.status).toBe(404);
    expect(missing.headers.get('Content-Type')).toContain('application/json');
    expect(await missing.json()).toEqual({ error: 'API route not found' });
  });
});
