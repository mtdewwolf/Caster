import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
import crypto from 'crypto';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { db, initDatabase, LibraryModel, MediaModel } from '../apps/server/src/db';
import { SqliteUserStore } from '../apps/server/src/db/user-store';
import { apiRouter } from '../apps/server/src/routes/api';
import { scanLibrary } from '../apps/server/src/scanner/indexer';
import { getThumbnailPath } from '../apps/server/src/scanner/thumbnails';

describe('Thumbnail generation and backfill', () => {
  const originalThumbnailDirectory = process.env.THUMBNAILS_DIR;
  const adminId = `thumbnail-admin-${crypto.randomUUID()}`;
  const adminToken = `thumbnail-token-${crypto.randomUUID()}`;
  let fixtureRoot: string;
  let thumbnailDirectory: string;
  let libraryId: string;
  let mediaId: string;

  function adminRequest(pathname: string, init: RequestInit = {}): Promise<Response> {
    const headers = new Headers(init.headers);
    headers.set('Authorization', `Bearer ${adminToken}`);
    return apiRouter.request(pathname, { ...init, headers });
  }

  beforeAll(async () => {
    initDatabase();
    const users = new SqliteUserStore(db);
    users.create(adminId, adminId, 'admin');
    users.setCredential(adminId, 'api_token', adminToken);
    fixtureRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'caster-thumbnails-'));
    thumbnailDirectory = path.join(fixtureRoot, 'thumbnails');
    process.env.THUMBNAILS_DIR = thumbnailDirectory;

    const videoPath = path.join(fixtureRoot, 'Thumbnail.Test.2026.mp4');
    const ffmpeg = Bun.spawnSync([
      'ffmpeg',
      '-loglevel', 'error',
      '-f', 'lavfi',
      '-i', 'color=c=blue:s=64x64:d=12:r=1',
      '-c:v', 'mpeg4',
      '-y',
      videoPath
    ]);
    if (ffmpeg.exitCode !== 0) {
      throw new Error(`Unable to create thumbnail test video: ${ffmpeg.stderr.toString()}`);
    }

    libraryId = `test_lib_thumbnails_${crypto.randomUUID()}`;
    LibraryModel.create({
      id: libraryId,
      name: 'Thumbnail Test',
      path: fixtureRoot,
      type: 'movies',
      created_at: new Date().toISOString()
    });
    await scanLibrary(libraryId);

    const { items } = MediaModel.getAll('test-user', { libraryId });
    expect(items).toHaveLength(1);
    mediaId = items[0].id;
  });

  afterAll(() => {
    if (libraryId) LibraryModel.delete(libraryId);
    db.run('DELETE FROM users WHERE id = ?', [adminId]);
    if (originalThumbnailDirectory === undefined) delete process.env.THUMBNAILS_DIR;
    else process.env.THUMBNAILS_DIR = originalThumbnailDirectory;

    const expectedPrefix = path.join(os.tmpdir(), 'caster-thumbnails-');
    if (fixtureRoot?.startsWith(expectedPrefix)) {
      fs.rmSync(fixtureRoot, { recursive: true, force: true });
    }
  });

  it('generates a thumbnail during the initial scan', () => {
    expect(fs.existsSync(getThumbnailPath(mediaId))).toBe(true);
    expect(MediaModel.getById(mediaId, 'test-user')?.poster_path).toBe(`/api/media/${mediaId}/thumbnail`);
  });

  it('backfills a missing thumbnail on a later scan', async () => {
    fs.unlinkSync(getThumbnailPath(mediaId));

    await scanLibrary(libraryId);

    expect(fs.existsSync(getThumbnailPath(mediaId))).toBe(true);
    expect(MediaModel.getById(mediaId, 'test-user')?.poster_path).toBe(`/api/media/${mediaId}/thumbnail`);
  });

  it('force-regenerates a thumbnail through POST and serves it from the configured directory', async () => {
    fs.writeFileSync(getThumbnailPath(mediaId), 'stale');

    const regenerateResponse = await adminRequest(`/media/${mediaId}/thumbnail`, { method: 'POST' });

    expect(regenerateResponse.status).toBe(200);
    expect(await regenerateResponse.json()).toEqual({
      success: true,
      thumbnailUrl: `/api/media/${mediaId}/thumbnail`
    });
    expect(fs.statSync(getThumbnailPath(mediaId)).size).toBeGreaterThan('stale'.length);

    const thumbnailResponse = await adminRequest(`/media/${mediaId}/thumbnail`);
    expect(thumbnailResponse.status).toBe(200);
    expect(thumbnailResponse.headers.get('Content-Type')).toBe('image/jpeg');
  });

  it('returns 404 when asked to regenerate an unknown media item', async () => {
    const response = await apiRouter.request('/media/does-not-exist/thumbnail', { method: 'POST' });
    expect(response.status).toBe(404);
  });
});
