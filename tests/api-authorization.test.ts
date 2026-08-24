import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
import crypto from 'crypto';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { AccessControlStore } from '../apps/server/src/db/access-control';
import { db, initDatabase, LibraryModel, MediaModel } from '../apps/server/src/db';
import { SqliteUserStore } from '../apps/server/src/db/user-store';
import server from '../apps/server/src/index';

describe('API authorization boundaries', () => {
  const suffix = crypto.randomUUID();
  const adminId = `security-admin-${suffix}`;
  const viewerId = `security-viewer-${suffix}`;
  const deniedViewerId = `security-denied-${suffix}`;
  const adminToken = `admin-token-${suffix}`;
  const viewerToken = `viewer-token-${suffix}`;
  const deniedViewerToken = `denied-token-${suffix}`;
  const viewerPassword = `viewer-password-${suffix}`;
  const libraryId = `security-library-${suffix}`;
  const mediaId = `security-media-${suffix}`;
  let fixtureRoot = '';

  function authorized(pathname: string, token: string, init: RequestInit = {}) {
    const headers = new Headers(init.headers);
    headers.set('Authorization', `Bearer ${token}`);
    return server.fetch(new Request(`http://localhost${pathname}`, { ...init, headers }));
  }

  beforeAll(() => {
    initDatabase();
    const users = new SqliteUserStore(db);
    const access = new AccessControlStore(db);
    users.create(adminId, `security-admin-${suffix}`, 'admin');
    users.create(viewerId, `security-viewer-${suffix}`, 'viewer');
    users.create(deniedViewerId, `security-denied-${suffix}`, 'viewer');
    users.setCredential(adminId, 'api_token', adminToken);
    users.setCredential(viewerId, 'api_token', viewerToken);
    users.setCredential(viewerId, 'password', viewerPassword);
    users.setCredential(deniedViewerId, 'api_token', deniedViewerToken);

    fixtureRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'caster-api-authorization-'));
    const mediaPath = path.join(fixtureRoot, 'private-video.mp4');
    fs.writeFileSync(mediaPath, 'private-media');
    const now = new Date().toISOString();
    LibraryModel.create({
      id: libraryId,
      name: 'Shared Library',
      path: fixtureRoot,
      type: 'movies',
      created_at: now
    });
    MediaModel.upsert({
      id: mediaId,
      library_id: libraryId,
      title: 'Private Video',
      original_filename: 'private-video.mp4',
      relative_path: 'private-video.mp4',
      full_path: mediaPath,
      type: 'movie',
      duration: 12,
      size_bytes: 13,
      format: 'mp4',
      is_hdr: false,
      streams_json: '[]',
      created_at: now,
      updated_at: now
    });
    access.shareLibrary(viewerId, libraryId);
    access.updatePermissions(viewerId, { canStreamRemote: false });
  });

  afterAll(() => {
    LibraryModel.delete(libraryId);
    db.run('DELETE FROM users WHERE id IN (?, ?, ?)', [adminId, viewerId, deniedViewerId]);
    const expectedPrefix = path.join(os.tmpdir(), 'caster-api-authorization-');
    if (fixtureRoot.startsWith(expectedPrefix)) {
      fs.rmSync(fixtureRoot, { recursive: true, force: true });
    }
  });

  it('rejects anonymous metadata and every playback derivative', async () => {
    for (const pathname of [
      `/api/media/${mediaId}`,
      `/api/media/${mediaId}/stream`,
      `/api/media/${mediaId}/hls/master.m3u8`,
      `/api/media/${mediaId}/hls/720p/index.m3u8`,
      `/api/media/${mediaId}/hls/720p/segment-0.ts`,
      `/api/media/${mediaId}/thumbnail`,
      `/api/media/${mediaId}/subtitles/0`
    ]) {
      const response = await server.fetch(new Request(`http://localhost${pathname}`));
      expect(response.status).toBe(401);
    }
  });

  it('returns the same not-found boundary for missing and unauthorized media', async () => {
    const denied = await authorized(`/api/media/${mediaId}`, deniedViewerToken);
    const missing = await authorized('/api/media/does-not-exist', deniedViewerToken);
    expect(denied.status).toBe(404);
    expect(missing.status).toBe(404);
    expect(await denied.json()).toEqual(await missing.json());

    const deniedStream = await authorized(`/api/media/${mediaId}/stream`, deniedViewerToken);
    const missingStream = await authorized('/api/media/does-not-exist/stream', deniedViewerToken);
    expect(deniedStream.status).toBe(404);
    expect(missingStream.status).toBe(404);

    for (const pathname of [
      `/api/media/${mediaId}/thumbnail`,
      `/api/media/${mediaId}/subtitles/0`,
      `/api/media/${mediaId}/hls/master.m3u8`,
      `/api/media/${mediaId}/hls/720p/index.m3u8`,
      `/api/media/${mediaId}/hls/720p/segment-0.ts`
    ]) {
      expect((await authorized(pathname, deniedViewerToken)).status, pathname).toBe(404);
    }
  });

  it('redacts absolute filesystem paths from viewer library and media payloads', async () => {
    const libraries = await authorized('/api/libraries', viewerToken);
    const libraryBody = await libraries.json() as { libraries: Array<Record<string, unknown>> };
    expect(libraries.status).toBe(200);
    expect(libraryBody.libraries).toHaveLength(1);
    expect(libraryBody.libraries[0]).not.toHaveProperty('path');

    const media = await authorized(`/api/media/${mediaId}`, viewerToken);
    const mediaBody = await media.json() as { item: Record<string, unknown> };
    expect(media.status).toBe(200);
    expect(mediaBody.item).not.toHaveProperty('full_path');
    expect(JSON.stringify(mediaBody)).not.toContain(fixtureRoot);

    const adminMedia = await authorized(`/api/media/${mediaId}`, adminToken);
    expect((await adminMedia.json() as { item: Record<string, unknown> }).item.full_path)
      .toBe(path.join(fixtureRoot, 'private-video.mp4'));
  });

  it('enforces the viewer remote-stream capability at the playback boundary', async () => {
    const remote = await server.fetch(new Request(
      `https://media.example/api/media/${mediaId}/stream`,
      { headers: { Authorization: `Bearer ${viewerToken}` } }
    ));
    expect(remote.status).toBe(404);
  });

  it('lets a cast receiver play one granted item without inheriting the user session', async () => {
    const response = await authorized(`/api/media/${mediaId}/cast`, adminToken);
    expect(response.status).toBe(200);
    const access = await response.json() as {
      directUrl: string;
      hlsUrl: string;
      expiresAt: string;
    };
    expect(Date.parse(access.expiresAt)).toBeGreaterThan(Date.now());

    const direct = await server.fetch(new Request(`http://localhost${access.directUrl}`, {
      headers: { Origin: 'https://receiver.example' }
    }));
    expect(direct.status).toBe(200);
    expect(direct.headers.get('Access-Control-Allow-Origin')).toBe('https://receiver.example');
    expect(await direct.text()).toBe('private-media');

    const master = await server.fetch(new Request(`http://localhost${access.hlsUrl}`));
    expect(master.status).toBe(200);
    const playlist = await master.text();
    expect(playlist).toContain('?cast=');

    const tokenQuery = new URL(`http://localhost${access.directUrl}`).search;
    const catalog = await server.fetch(new Request(`http://localhost/api/media${tokenQuery}`));
    expect(catalog.status).toBe(401);
  });

  it('requires the explicit download capability for offline downloads', async () => {
    const access = new AccessControlStore(db);
    expect((await authorized(`/api/media/${mediaId}/download`, viewerToken)).status).toBe(404);
    access.updatePermissions(viewerId, { canDownload: true });
    try {
      const response = await authorized(`/api/media/${mediaId}/download`, viewerToken);
      expect(response.status).toBe(200);
      expect(response.headers.get('Content-Disposition')).toContain('attachment');
      expect(await response.text()).toBe('private-media');
    } finally {
      access.updatePermissions(viewerId, { canDownload: false });
    }
  });

  it('requires delete capability, explicit confirmation, and deletes only within the library root', async () => {
    const deletableId = `deletable-${suffix}`;
    const deletablePath = path.join(fixtureRoot, 'deletable-video.mp4');
    fs.writeFileSync(deletablePath, 'delete-me');
    const now = new Date().toISOString();
    MediaModel.upsert({
      id: deletableId,
      library_id: libraryId,
      title: 'Deletable Video',
      original_filename: path.basename(deletablePath),
      relative_path: path.basename(deletablePath),
      full_path: deletablePath,
      type: 'movie',
      duration: 1,
      size_bytes: 9,
      format: 'mp4',
      is_hdr: false,
      streams_json: '[]',
      created_at: now,
      updated_at: now
    });
    const endpoint = `/api/media/${deletableId}/file`;
    const access = new AccessControlStore(db);

    expect((await authorized(endpoint, viewerToken, { method: 'DELETE' })).status).toBe(404);
    access.updatePermissions(viewerId, { canDeleteMedia: true });
    try {
      expect((await authorized(endpoint, viewerToken, { method: 'DELETE' })).status).toBe(409);
      const deleted = await authorized(endpoint, viewerToken, {
        method: 'DELETE',
        headers: { 'X-Caster-Confirm-Delete': deletableId }
      });
      expect(deleted.status).toBe(200);
      expect(fs.existsSync(deletablePath)).toBe(false);
      expect(MediaModel.getById(deletableId, viewerId)).toBeNull();
    } finally {
      access.updatePermissions(viewerId, { canDeleteMedia: false });
      if (fs.existsSync(deletablePath)) fs.unlinkSync(deletablePath);
      MediaModel.delete(deletableId);
    }
  });

  it('denies outside-root and symbolic-link media deletion records', async () => {
    const outsideRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'caster-delete-outside-'));
    const outsidePath = path.join(outsideRoot, 'outside-video.mp4');
    const symlinkPath = path.join(fixtureRoot, 'linked-video.mp4');
    const outsideId = `outside-${suffix}`;
    const symlinkId = `symlink-${suffix}`;
    fs.writeFileSync(outsidePath, 'keep-me');
    fs.symlinkSync(outsidePath, symlinkPath, 'file');
    const now = new Date().toISOString();
    const insertDeletionRecord = (id: string, fullPath: string) => MediaModel.upsert({
      id,
      library_id: libraryId,
      title: id,
      original_filename: path.basename(fullPath),
      relative_path: path.basename(fullPath),
      full_path: fullPath,
      type: 'movie',
      duration: 1,
      size_bytes: 7,
      format: 'mp4',
      is_hdr: false,
      streams_json: '[]',
      created_at: now,
      updated_at: now
    });
    insertDeletionRecord(outsideId, outsidePath);
    insertDeletionRecord(symlinkId, symlinkPath);

    const access = new AccessControlStore(db);
    access.updatePermissions(viewerId, { canDeleteMedia: true });
    try {
      for (const id of [outsideId, symlinkId]) {
        const response = await authorized(`/api/media/${id}/file`, viewerToken, {
          method: 'DELETE',
          headers: { 'X-Caster-Confirm-Delete': id }
        });
        expect(response.status, id).toBe(409);
        expect(MediaModel.getById(id, viewerId)?.id).toBe(id);
      }
      expect(fs.existsSync(outsidePath)).toBe(true);
      expect(fs.lstatSync(symlinkPath).isSymbolicLink()).toBe(true);
    } finally {
      access.updatePermissions(viewerId, { canDeleteMedia: false });
      MediaModel.delete(outsideId);
      MediaModel.delete(symlinkId);
      if (fs.existsSync(symlinkPath)) fs.unlinkSync(symlinkPath);
      fs.rmSync(outsideRoot, { recursive: true, force: true });
    }
  });

  it('allows viewer progress but denies administrative reads and mutations', async () => {
    const progress = await authorized(`/api/media/${mediaId}/progress`, viewerToken, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ position: 4, duration: 12 })
    });
    expect(progress.status).toBe(200);

    expect((await authorized('/api/system/status', viewerToken)).status).toBe(403);
    expect((await authorized('/api/fs/browse', viewerToken)).status).toBe(403);
    expect((await authorized('/api/libraries/scan/status', viewerToken)).status).toBe(403);
    expect((await authorized('/api/system/status', adminToken)).status).toBe(200);
  });

  it('allows only admins to set or clear a profile PIN without returning its hash', async () => {
    const endpoint = `/api/access/users/${viewerId}/pin`;
    const viewer = await authorized(endpoint, viewerToken, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ pin: '0427' })
    });
    expect(viewer.status).toBe(403);

    const invalid = await authorized(endpoint, adminToken, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ pin: '12' })
    });
    expect(invalid.status).toBe(400);

    const set = await authorized(endpoint, adminToken, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ pin: '0427' })
    });
    expect(set.status).toBe(200);
    expect(await set.json()).toMatchObject({ permissions: { hasProfilePin: true } });

    const clear = await authorized(endpoint, adminToken, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ pin: null })
    });
    expect(clear.status).toBe(200);
    expect(await clear.json()).toMatchObject({ permissions: { hasProfilePin: false } });
  });

  it('rejects cross-origin bearer requests before route execution', async () => {
    const response = await authorized(`/api/media/${mediaId}`, viewerToken, {
      headers: { Origin: 'https://attacker.example' }
    });
    expect(response.status).toBe(403);
    expect(response.headers.get('Access-Control-Allow-Origin')).toBeNull();
  });

  it('applies trusted-origin CORS on actual API success and preflight responses', async () => {
    const original = process.env.CASTER_TRUSTED_ORIGINS;
    process.env.CASTER_TRUSTED_ORIGINS = 'https://player.example';
    try {
      const response = await authorized(`/api/media/${mediaId}`, viewerToken, {
        headers: { Origin: 'https://player.example' }
      });
      expect(response.status).toBe(200);
      expect(response.headers.get('Access-Control-Allow-Origin')).toBe('https://player.example');
      expect(response.headers.get('Access-Control-Allow-Credentials')).toBe('true');
      expect(response.headers.get('Vary')).toContain('Origin');

      const preflight = await server.fetch(new Request(
        `http://localhost/api/media/${mediaId}/hls/720p/segment-0.ts`,
        { method: 'OPTIONS', headers: { Origin: 'https://player.example' } }
      ));
      expect(preflight.status).toBe(204);
      expect(preflight.headers.get('Access-Control-Allow-Origin')).toBe('https://player.example');
      expect(preflight.headers.get('Access-Control-Allow-Credentials')).toBe('true');

      const deletePreflight = await server.fetch(new Request(
        `http://localhost/api/media/${mediaId}/file`,
        {
          method: 'OPTIONS',
          headers: {
            Origin: 'https://player.example',
            'Access-Control-Request-Method': 'DELETE',
            'Access-Control-Request-Headers': 'authorization,x-caster-confirm-delete'
          }
        }
      ));
      expect(deletePreflight.status).toBe(204);
      expect(deletePreflight.headers.get('Access-Control-Allow-Origin'))
        .toBe('https://player.example');
      expect(deletePreflight.headers.get('Access-Control-Allow-Headers'))
        .toContain('X-Caster-Confirm-Delete');
    } finally {
      if (original === undefined) delete process.env.CASTER_TRUSTED_ORIGINS;
      else process.env.CASTER_TRUSTED_ORIGINS = original;
    }
  });

  it('enforces CSRF source checks on actual cookie-authenticated progress writes', async () => {
    const login = await server.fetch(new Request('http://localhost/api/auth/login', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Origin: 'http://localhost' },
      body: JSON.stringify({ username: `security-viewer-${suffix}`, password: viewerPassword })
    }));
    expect(login.status).toBe(200);
    const cookie = login.headers.get('Set-Cookie')?.split(';', 1)[0];
    expect(cookie).toBeTruthy();

    const missingSource = await server.fetch(new Request(
      `http://localhost/api/media/${mediaId}/progress`,
      {
        method: 'POST',
        headers: { Cookie: cookie!, 'Content-Type': 'application/json' },
        body: JSON.stringify({ position: 5, duration: 12 })
      }
    ));
    expect(missingSource.status).toBe(403);

    const sameOrigin = await server.fetch(new Request(
      `http://localhost/api/media/${mediaId}/progress`,
      {
        method: 'POST',
        headers: {
          Cookie: cookie!,
          'Content-Type': 'application/json',
          Origin: 'http://localhost'
        },
        body: JSON.stringify({ position: 5, duration: 12 })
      }
    ));
    expect(sameOrigin.status).toBe(200);
  });

  it('applies content restrictions to lists and every playback derivative', async () => {
    const access = new AccessControlStore(db);
    const ratingEndpoint = `/api/media/${mediaId}/content-rating`;
    const rated = await authorized(ratingEndpoint, adminToken, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ contentRating: 'R' })
    });
    expect(rated.status).toBe(200);
    expect(await rated.json()).toMatchObject({
      item: { id: mediaId, content_rating: 'R', content_rating_level: 4 }
    });
    const viewerRatingUpdate = await authorized(ratingEndpoint, viewerToken, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ contentRating: 'PG' })
    });
    expect(viewerRatingUpdate.status).toBe(403);
    access.updatePermissions(viewerId, { maxContentRating: 'PG-13', allowUnrated: false });

    try {
      const list = await authorized('/api/media', viewerToken);
      expect((await list.json() as { items: Array<{ id: string }> }).items
        .some((item) => item.id === mediaId)).toBe(false);
      const libraries = await authorized('/api/libraries', viewerToken);
      const libraryBody = await libraries.json() as {
        libraries: Array<{ id: string; item_count: number }>;
      };
      expect(libraryBody.libraries.find((library) => library.id === libraryId)?.item_count).toBe(0);

      for (const pathname of [
        `/api/media/${mediaId}`,
        `/api/media/${mediaId}/stream`,
        `/api/media/${mediaId}/hls/master.m3u8`,
        `/api/media/${mediaId}/hls/720p/index.m3u8`,
        `/api/media/${mediaId}/hls/720p/segment-0.ts`,
        `/api/media/${mediaId}/thumbnail`,
        `/api/media/${mediaId}/subtitles/0`
      ]) {
        expect((await authorized(pathname, viewerToken)).status, pathname).toBe(404);
      }
    } finally {
      access.updatePermissions(viewerId, { maxContentRating: null, allowUnrated: true });
      await authorized(ratingEndpoint, adminToken, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ contentRating: null })
      });
    }
  });
});
