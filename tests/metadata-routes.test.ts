import { beforeAll, describe, expect, it } from 'bun:test';
import crypto from 'crypto';
import { db, initDatabase, LibraryModel, MediaModel } from '../apps/server/src/db';
import { MetadataStore } from '../apps/server/src/db/metadata-store';
import { planMetadataMatch } from '../apps/server/src/metadata';
import server from '../apps/server/src/index';

describe('metadata routes', () => {
  const suffix = crypto.randomUUID();
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

  const call = (pathname: string, init: RequestInit = {}) => {
    return server.fetch(new Request(`http://localhost${pathname}`, init));
  };

  beforeAll(() => {
    initDatabase();
    store = new MetadataStore(db);


    LibraryModel.create({
      id: libraryId, name: 'Metadata library', path: `/tmp/${libraryId}`,
      type: 'movie', created_at: new Date().toISOString()
    });

  });

  it('returns null metadata rather than an error when nothing is matched', async () => {
    const mediaId = createMedia();
    const response = await call(`/api/media/${mediaId}/metadata`);
    expect(response.status).toBe(200);

    const body = await response.json() as Record<string, unknown>;
    expect(body.metadata).toBeNull();
    expect(body.supported).toBe(true);
  });

  it('serves stored metadata to a viewer who can already see the item', async () => {
    const mediaId = createMedia();
    storeMetadata(mediaId);

    const response = await call(`/api/media/${mediaId}/metadata`);
    expect(response.status).toBe(200);

    const body = await response.json() as { metadata: Record<string, unknown> };
    expect(body.metadata.overview).toBe('Stored overview');
    expect(body.metadata.artwork).toHaveLength(1);
  });

  it('attaches metadata to the media detail response', async () => {
    const mediaId = createMedia();
    storeMetadata(mediaId);

    const response = await call(`/api/media/${mediaId}`);
    const body = await response.json() as { item: unknown; metadata: Record<string, unknown> | null };

    expect(body.item).toBeTruthy();
    expect(body.metadata?.overview).toBe('Stored overview');
  });

  it('allows correction endpoints without an account gate', async () => {
    const mediaId = createMedia();
    expect([200, 409]).toContain((await call(`/api/media/${mediaId}/metadata/candidates`)).status);
    expect((await call(`/api/media/${mediaId}/metadata/refresh`, { method: 'POST' })).status).toBe(200);
    expect((await call(`/api/media/${mediaId}/metadata`, { method: 'DELETE' })).status).toBe(200);
    expect((await call(`/api/media/${mediaId}/metadata/match`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ providerId: 'fixture', externalId: 'x', entityType: 'movie' })
    })).status).not.toBe(401);
  });

  it('rejects a match against a provider that is not registered', async () => {
    const mediaId = createMedia();
    const response = await call(`/api/media/${mediaId}/metadata/match`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ providerId: 'not-registered', externalId: 'x', entityType: 'movie' })
    });

    expect(response.status).toBe(400);
    expect(await response.json()).toMatchObject({ error: expect.stringContaining('not registered') });
  });

  it('validates the match body', async () => {
    const mediaId = createMedia();
    const response = await call(`/api/media/${mediaId}/metadata/match`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ providerId: 'fixture' })
    });
    expect(response.status).toBe(400);
  });

  it('reports disabled instead of failing when no provider is configured', async () => {
    const mediaId = createMedia();
    const response = await call(`/api/media/${mediaId}/metadata/refresh`, { method: 'POST' });
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ status: 'disabled' });
  });

  it('unmatches back to scanner-derived details', async () => {
    const mediaId = createMedia();
    storeMetadata(mediaId);

    expect((await call(`/api/media/${mediaId}/metadata`, { method: 'DELETE' })).status).toBe(200);

    const after = await call(`/api/media/${mediaId}/metadata`);
    expect((await after.json() as Record<string, unknown>).metadata).toBeNull();
  });

  it('hides metadata for media the caller cannot see', async () => {
    expect((await call(`/api/media/does-not-exist-${suffix}/metadata`)).status).toBe(404);
  });

  it('lists registered providers without an account gate', async () => {
    const response = await call('/api/metadata/providers');
    expect(response.status).toBe(200);
    expect(await response.json()).toHaveProperty('providers');
  });
});
