import { afterAll, afterEach, beforeAll, describe, expect, it } from 'bun:test';
import crypto from 'crypto';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { Hono } from 'hono';
import { requireAdminForMutations } from '../apps/server/src/auth';
import { initDatabase, LibraryModel, MediaModel } from '../apps/server/src/db';
import { db } from '../apps/server/src/db';
import { AccountProvisioningStore } from '../apps/server/src/db/account-provisioning';
import { SqliteUserStore } from '../apps/server/src/db/user-store';
import { apiRouter } from '../apps/server/src/routes/api';
import { scanStatus } from '../apps/server/src/scanner/indexer';
import {
  TranscodeCapacityError,
  TranscodeKilledError,
  transcoder
} from '../apps/server/src/transcoder/engine';

describe('scanner and playback route failures', () => {
  const app = new Hono();
  const adminId = `playback-scanner-admin-${crypto.randomUUID()}`;
  const adminToken = `playback-scanner-token-${crypto.randomUUID()}`;
  const originalGetHlsSegment = transcoder.getHlsSegment;
  const originalScanStatus = {
    ...scanStatus,
    errors: [...scanStatus.errors]
  };

  let fixtureRoot = '';
  let scanRoot = '';
  let scanLibraryId = '';
  let playbackLibraryId = '';
  let mediaId = '';
  let mediaPath = '';
  let missingSourceMediaId = '';

  app.use('/api/*', requireAdminForMutations);
  app.route('/api', apiRouter);

  function adminRequest(pathname: string, init: RequestInit = {}): Promise<Response> {
    const headers = new Headers(init.headers);
    headers.set('Authorization', `Bearer ${adminToken}`);
    return app.request(pathname, { ...init, headers });
  }

  async function withMockedHlsSegment(
    implementation: typeof transcoder.getHlsSegment,
    assertion: () => Promise<void>
  ): Promise<void> {
    const previousImplementation = transcoder.getHlsSegment;
    const previousConsoleError = console.error;
    transcoder.getHlsSegment = implementation;
    console.error = () => {};
    try {
      await assertion();
    } finally {
      transcoder.getHlsSegment = previousImplementation;
      console.error = previousConsoleError;
    }
  }

  beforeAll(() => {
    initDatabase();
    const users = new SqliteUserStore(db);
    users.create(adminId, adminId, 'admin');
    users.setCredential(adminId, 'api_token', adminToken);
    new AccountProvisioningStore(db).claimLegacyOwnerIfConfigured(adminId);

    fixtureRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'caster-playback-scanner-'));
    scanRoot = path.join(fixtureRoot, 'empty-library');
    fs.mkdirSync(scanRoot);

    mediaPath = path.join(fixtureRoot, 'Playback.Test.2026.mp4');
    fs.writeFileSync(mediaPath, 'test transport stream source');

    const suffix = crypto.randomUUID();
    scanLibraryId = `scanner_route_${suffix}`;
    playbackLibraryId = `playback_route_${suffix}`;
    mediaId = `playback_media_${suffix}`;
    missingSourceMediaId = `missing_source_media_${suffix}`;
    const now = new Date().toISOString();

    LibraryModel.create({
      id: scanLibraryId,
      name: 'Scanner Route Empty Library',
      path: scanRoot,
      type: 'movies',
      created_at: now
    });
    LibraryModel.create({
      id: playbackLibraryId,
      name: 'Playback Route Library',
      path: fixtureRoot,
      type: 'movies',
      created_at: now
    });

    MediaModel.upsert({
      id: mediaId,
      library_id: playbackLibraryId,
      title: 'Playback Test',
      original_filename: path.basename(mediaPath),
      relative_path: path.basename(mediaPath),
      full_path: mediaPath,
      type: 'movie',
      duration: 120,
      size_bytes: fs.statSync(mediaPath).size,
      format: 'mp4',
      width: 1280,
      height: 720,
      is_hdr: false,
      streams_json: '[]',
      created_at: now,
      updated_at: now
    });
    MediaModel.upsert({
      id: missingSourceMediaId,
      library_id: playbackLibraryId,
      title: 'Missing Playback Source',
      original_filename: 'missing.mp4',
      relative_path: 'missing.mp4',
      full_path: path.join(fixtureRoot, 'missing.mp4'),
      type: 'movie',
      duration: 120,
      size_bytes: 0,
      format: 'mp4',
      width: 1280,
      height: 720,
      is_hdr: false,
      streams_json: '[]',
      created_at: now,
      updated_at: now
    });
  });

  afterEach(() => {
    transcoder.getHlsSegment = originalGetHlsSegment;
    Object.assign(scanStatus, originalScanStatus, {
      errors: [...originalScanStatus.errors]
    });
  });

  afterAll(() => {
    if (scanLibraryId) LibraryModel.delete(scanLibraryId);
    if (playbackLibraryId) LibraryModel.delete(playbackLibraryId);
    db.run('DELETE FROM users WHERE id = ?', [adminId]);

    const expectedPrefix = path.join(os.tmpdir(), 'caster-playback-scanner-');
    if (fixtureRoot.startsWith(expectedPrefix)) {
      fs.rmSync(fixtureRoot, { recursive: true, force: true });
    }
  });

  it('starts a scan for an existing library and exposes its completed status', async () => {
    const response = await adminRequest(`/api/libraries/${scanLibraryId}/scan`, {
      method: 'POST'
    });

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      status: 'started',
      libraryId: scanLibraryId
    });

    const statusResponse = await app.request('/api/libraries/scan/status');
    expect(statusResponse.status).toBe(200);
    expect(await statusResponse.json()).toMatchObject({
      isScanning: false,
      libraryId: null,
      totalFiles: 0,
      processedFiles: 0,
      errors: []
    });
    expect(LibraryModel.getById(scanLibraryId)?.last_scanned_at).toBeString();
  });

  it('reports busy scanner state and rejects scan-all while another scan is active', async () => {
    Object.assign(scanStatus, {
      isScanning: true,
      libraryId: scanLibraryId,
      totalFiles: 8,
      processedFiles: 3,
      currentFile: 'Episode.03.mkv',
      errors: ['fixture warning']
    });

    const statusResponse = await app.request('/api/libraries/scan/status');
    expect(statusResponse.status).toBe(200);
    expect(await statusResponse.json()).toEqual({
      isScanning: true,
      libraryId: scanLibraryId,
      totalFiles: 8,
      processedFiles: 3,
      currentFile: 'Episode.03.mkv',
      errors: ['fixture warning']
    });

    const scanAllResponse = await adminRequest('/api/libraries/scan-all', {
      method: 'POST'
    });
    expect(scanAllResponse.status).toBe(409);
    expect(await scanAllResponse.json()).toEqual({
      error: 'A scan is already in progress'
    });
  });

  it('maps transcode capacity exhaustion to 429 with retry metadata', async () => {
    await withMockedHlsSegment(
      async () => {
        throw new TranscodeCapacityError(4);
      },
      async () => {
        const response = await adminRequest(
          `/api/media/${mediaId}/hls/720p/segment-2.ts`
        );

        expect(response.status).toBe(429);
        expect(response.headers.get('Retry-After')).toBe('2');
        expect(await response.json()).toEqual({
          error: 'Transcode concurrency limit reached (4)',
          maxConcurrentTranscodes: 4
        });
      }
    );
  });

  it('maps administrator-killed transcodes to 503', async () => {
    await withMockedHlsSegment(
      async () => {
        throw new TranscodeKilledError();
      },
      async () => {
        const response = await adminRequest(
          `/api/media/${mediaId}/hls/480p/segment-1.ts`
        );

        expect(response.status).toBe(503);
        expect(await response.json()).toEqual({
          error: 'Transcode was terminated by an administrator'
        });
      }
    );
  });

  it('maps unexpected transcode errors to a stable 500 response', async () => {
    await withMockedHlsSegment(
      async () => {
        throw new Error('fixture transcoder failure');
      },
      async () => {
        const response = await adminRequest(
          `/api/media/${mediaId}/hls/360p/segment-0.ts`
        );

        expect(response.status).toBe(500);
        expect(await response.text()).toBe('Segment transcode failed');
      }
    );
  });

  it('returns 404 before transcoding when media or its source file is missing', async () => {
    let transcodeCalls = 0;
    await withMockedHlsSegment(
      async () => {
        transcodeCalls += 1;
        return Buffer.from('should not be returned');
      },
      async () => {
        const missingId = `absent_media_${crypto.randomUUID()}`;
        const master = await app.request(`/api/media/${missingId}/hls/master.m3u8`);
        const variant = await app.request(`/api/media/${missingId}/hls/720p/index.m3u8`);
        const segment = await app.request(
          `/api/media/${missingId}/hls/720p/segment-0.ts`
        );
        const missingSource = await app.request(
          `/api/media/${missingSourceMediaId}/hls/720p/segment-0.ts`
        );

        expect(master.status).toBe(404);
        expect(await master.text()).toBe('Not found');
        expect(variant.status).toBe(404);
        expect(await variant.text()).toBe('Not found');
        expect(segment.status).toBe(404);
        expect(await segment.text()).toBe('Media not found');
        expect(missingSource.status).toBe(404);
        expect(await missingSource.text()).toBe('Media not found');
        expect(transcodeCalls).toBe(0);
      }
    );
  });

  it('strictly rejects unsupported qualities and malformed segment names', async () => {
    const invalidVariantQualities = ['720P', '2160p'];
    for (const quality of invalidVariantQualities) {
      const response = await app.request(`/api/media/${mediaId}/hls/${quality}/index.m3u8`);
      expect(response.status).toBe(400);
      expect(await response.text()).toBe('Invalid transcode quality');
    }

    const invalidSegmentQuality = await app.request(
      `/api/media/${mediaId}/hls/ultra/segment-0.ts`
    );
    expect(invalidSegmentQuality.status).toBe(400);
    expect(await invalidSegmentQuality.text()).toBe('Invalid transcode quality');

    const invalidSegments = [
      'segment--1.ts',
      'segment-1.5.ts',
      'Segment-1.ts',
      'segment-1.TS',
      'segment-9007199254740992.ts'
    ];
    for (const segment of invalidSegments) {
      const response = await app.request(
        `/api/media/${mediaId}/hls/720p/${segment}`
      );
      expect(response.status).toBe(400);
      expect(await response.text()).toBe('Invalid segment name');
    }
  });
});
