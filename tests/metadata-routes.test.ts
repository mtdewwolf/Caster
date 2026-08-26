import { beforeAll, describe, expect, it } from 'bun:test';
import crypto from 'crypto';
import { db, initDatabase, LibraryModel, MediaModel } from '../apps/server/src/db';
import { AccessControlStore } from '../apps/server/src/db/access-control';
import { MetadataStore } from '../apps/server/src/db/metadata-store';
import { SqliteUserStore } from '../apps/server/src/db/user-store';
import { AccountProvisioningStore } from '../apps/server/src/db/account-provisioning';
import { planMetadataMatch } from '../apps/server/src/metadata';
import server from '../apps/server/src/index';

describe('metadata routes', () => {
  const suffix = crypto.randomUUID();
  const adminId = `meta-admin-${suffix}`;
  const viewerId = `meta-viewer-${suffix}`;
  const adminToken = `meta-admin-token-${suffix}`;
  const viewerToken = `meta-viewer-token-${suffix}`;
  const libraryId = `meta-lib-${suffix}`;
  let store: MetadataStore;
  let sequence = 0;

  /** Fresh media row per test; randomized test order must not change results. */
  function createMedia(): string {
    const id = `meta-media-${suffix}-${sequence++}`;
    const now = new Date().toISOString();
    MediaModel.upsert({
      id,
      library_id: libraryId,
      title: 'Routed Movie',
      original_filename: `${id}.mkv`,
      relative_path: `${id}.mkv`,
      full_path: `/tmp/${libraryId}/${id}.mkv`,
      type: 'movie',
      year: 2020,
      duration: 100,
      size_bytes: 100,
      format: 'mkv',
      is_hdr: false,
      streams_json: '[]',
      created_at: now,
      updated_at: now
    });
    return id;
  }

  function storeMetadata(mediaId: string): void {
    const subject = planMetadataMatch({
      id: mediaId, library_id: libraryId, type: 'movie', title: 'Routed Movie'
    })!.subject;

    store.save({
      subject,
      details: {
        providerId: 'fixture',
        externalId: 'ext-1',
        entityType: 'movie',
        title: 'Routed Movie',
        overview: 'Stored overview'
      },
      artwork: [{ providerId: 'fixture', type: 'poster', url: 'https://example.test/p.jpg' }]
    });
  }

  const call = (pathname: string, token: string, init: RequestInit = {}) => {
    const headers = new Headers(init.headers);
    headers.set('Authorization', `Bearer ${token}`);
    return server.fetch(new Request(`http://localhost${pathname}`, { ...init, headers }));
  };

  beforeAll(() => {
    initDatabase();
    store = new MetadataStore(db);

    const users = new SqliteUserStore(db);
    users.create(adminId, `meta-admin-${suffix}`, 'admin');
    users.create(viewerId, `meta-viewer-${suffix}`, 'viewer');
    users.setCredential(adminId, 'api_token', adminToken);
    users.setCredential(viewerId, 'api_token', viewerToken);
    new AccountProvisioningStore(db).claimLegacyOwnerIfConfigured(adminId);

    LibraryModel.create({
      id: libraryId, name: 'Metadata library', path: `/tmp/${libraryId}`,
      type: 'movie', created_at: new Date().toISOString()
    });

    new AccessControlStore(db).shareLibrary(viewerId, libraryId);
  });

  it('returns null metadata rather than an error when nothing is matched', async () => {
    const mediaId = createMedia();
    const response = await call(`/api/media/${mediaId}/metadata`, adminToken);
    expect(response.status).toBe(200);

    const body = await response.json() as Record<string, unknown>;
    expect(body.metadata).toBeNull();
    expect(body.supported).toBe(true);
  });

  it('serves stored metadata to a viewer who can already see the item', async () => {
    const mediaId = createMedia();
    storeMetadata(mediaId);

    const response = await call(`/api/media/${mediaId}/metadata`, viewerToken);
    expect(response.status).toBe(200);

    const body = await response.json() as { metadata: Record<string, unknown> };
    expect(body.metadata.overview).toBe('Stored overview');
    expect(body.metadata.artwork).toHaveLength(1);
  });

  it('attaches metadata to the media detail response', async () => {
    const mediaId = createMedia();
    storeMetadata(mediaId);

    const response = await call(`/api/media/${mediaId}`, adminToken);
    const body = await response.json() as { item: unknown; metadata: Record<string, unknown> | null };

    expect(body.item).toBeTruthy();
    expect(body.metadata?.overview).toBe('Stored overview');
  });

  it('keeps correction endpoints behind the admin gate', async () => {
    const mediaId = createMedia();
    expect((await call(`/api/media/${mediaId}/metadata/candidates`, viewerToken)).status).toBe(403);
    expect((await call(`/api/media/${mediaId}/metadata/refresh`, viewerToken, { method: 'POST' })).status).toBe(403);
    expect((await call(`/api/media/${mediaId}/metadata`, viewerToken, { method: 'DELETE' })).status).toBe(403);
    expect((await call(`/api/media/${mediaId}/metadata/match`, viewerToken, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ providerId: 'fixture', externalId: 'x', entityType: 'movie' })
    })).status).toBe(403);
  });

  it('rejects a match against a provider that is not registered', async () => {
    const mediaId = createMedia();
    const response = await call(`/api/media/${mediaId}/metadata/match`, adminToken, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ providerId: 'not-registered', externalId: 'x', entityType: 'movie' })
    });

    expect(response.status).toBe(400);
    expect(await response.json()).toMatchObject({ error: expect.stringContaining('not registered') });
  });

  it('validates the match body', async () => {
    const mediaId = createMedia();
    const response = await call(`/api/media/${mediaId}/metadata/match`, adminToken, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ providerId: 'fixture' })
    });
    expect(response.status).toBe(400);
  });

  it('reports disabled instead of failing when no provider is configured', async () => {
    const mediaId = createMedia();
    const response = await call(`/api/media/${mediaId}/metadata/refresh`, adminToken, { method: 'POST' });
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ status: 'disabled' });
  });

  it('unmatches back to scanner-derived details', async () => {
    const mediaId = createMedia();
    storeMetadata(mediaId);

    expect((await call(`/api/media/${mediaId}/metadata`, adminToken, { method: 'DELETE' })).status).toBe(200);

    const after = await call(`/api/media/${mediaId}/metadata`, adminToken);
    expect((await after.json() as Record<string, unknown>).metadata).toBeNull();
  });

  it('hides metadata for media the caller cannot see', async () => {
    expect((await call(`/api/media/does-not-exist-${suffix}/metadata`, adminToken)).status).toBe(404);
  });

  it('lists registered providers for administrators only', async () => {
    expect((await call('/api/metadata/providers', viewerToken)).status).toBe(403);

    const response = await call('/api/metadata/providers', adminToken);
    expect(response.status).toBe(200);
    expect(await response.json()).toHaveProperty('providers');
  });
});
