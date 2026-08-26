import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { Database } from 'bun:sqlite';
import { runDatabaseMigrations } from '../apps/server/src/db/migrations';
import { MetadataStore } from '../apps/server/src/db/metadata-store';
import { ArtworkCache, artworkFileName } from '../apps/server/src/metadata/artwork-cache';

describe('local artwork cache', () => {
  let database: Database;
  let store: MetadataStore;
  let directory: string;
  let requested: string[];

  const subject = { type: 'media' as const, id: 'm1' };

  function imageResponse(body: string, contentType = 'image/jpeg'): Response {
    return new Response(body, { status: 200, headers: { 'content-type': contentType } });
  }

  function cacheWith(
    handler: (url: string) => Response | Promise<Response>,
    options: { maxTotalBytes?: number; maxFileBytes?: number } = {}
  ) {
    return new ArtworkCache({
      database,
      directory,
      warn: () => {},
      ...options,
      fetchImpl: (async (input: any) => {
        const url = typeof input === 'string' ? input : input.url;
        requested.push(url);
        return handler(url);
      }) as typeof fetch
    });
  }

  function saveArtwork(urls: string[]) {
    store.save({
      subject,
      details: { providerId: 'fixture', externalId: 'e1', entityType: 'movie', title: 'Film' },
      artwork: urls.map((url, index) => ({
        providerId: 'fixture',
        type: index === 0 ? 'poster' : 'backdrop',
        url
      }))
    });
  }

  beforeEach(() => {
    database = new Database(':memory:');
    runDatabaseMigrations(database);
    store = new MetadataStore(database);
    directory = fs.mkdtempSync(path.join(os.tmpdir(), 'caster-artwork-'));
    requested = [];
  });

  afterEach(() => {
    fs.rmSync(directory, { recursive: true, force: true });
    database.close();
  });

  it('serves the provider URL until an image is cached', () => {
    saveArtwork(['https://images.test/poster.jpg']);
    const [art] = store.getArtwork(subject);

    expect(art!.url).toBe('https://images.test/poster.jpg');
    expect(art!.cached).toBe(false);
  });

  it('serves a local path once cached', async () => {
    saveArtwork(['https://images.test/poster.jpg']);
    const cache = cacheWith(() => imageResponse('image-bytes'));

    expect(await cache.cachePending()).toBe(1);

    const [art] = store.getArtwork(subject);
    expect(art!.url).toMatch(/^\/api\/artwork\/[0-9a-f]{40}\.jpg$/);
    expect(art!.cached).toBe(true);
    expect(art!.remoteUrl).toBe('https://images.test/poster.jpg');
    expect(fs.existsSync(cache.filePath(art!.url.split('/').pop()!))).toBe(true);
  });

  it('keeps the provider URL working when the download fails', async () => {
    saveArtwork(['https://images.test/poster.jpg']);
    const cache = cacheWith(() => new Response('nope', { status: 503 }));

    expect(await cache.cachePending()).toBe(0);

    const [art] = store.getArtwork(subject);
    expect(art!.url).toBe('https://images.test/poster.jpg');
    expect(art!.cached).toBe(false);
  });

  it('survives a provider that throws outright', async () => {
    saveArtwork(['https://images.test/poster.jpg']);
    const cache = cacheWith(() => { throw new Error('network down'); });

    expect(await cache.cachePending()).toBe(0);
  });

  it('does not re-download an image it already has', async () => {
    saveArtwork(['https://images.test/poster.jpg']);
    const cache = cacheWith(() => imageResponse('image-bytes'));

    await cache.cachePending();
    await cache.cachePending();

    expect(requested).toHaveLength(1);
  });

  it('refuses a non-HTTP URL', async () => {
    const cache = cacheWith(() => imageResponse('x'));
    // A provider must not be able to make the server read its own disk.
    expect(await cache.download('file:///etc/passwd')).toBeNull();
    expect(await cache.download('not a url')).toBeNull();
    expect(requested).toHaveLength(0);
  });

  it('refuses an image larger than the per-file limit', async () => {
    saveArtwork(['https://images.test/huge.jpg']);
    const cache = cacheWith(() => imageResponse('x'.repeat(100)), { maxFileBytes: 10 });

    expect(await cache.cachePending()).toBe(0);
  });

  it('evicts the oldest images when over budget', async () => {
    saveArtwork(['https://images.test/a.jpg', 'https://images.test/b.jpg']);
    const cache = cacheWith(() => imageResponse('x'.repeat(50)), { maxTotalBytes: 60 });

    await cache.cachePending();

    const status = cache.status();
    expect(status.totalBytes).toBeLessThanOrEqual(60);
    expect(status.fileCount).toBe(1);
  });

  it('leaves the provider URL usable after eviction', async () => {
    saveArtwork(['https://images.test/a.jpg', 'https://images.test/b.jpg']);
    const cache = cacheWith(() => imageResponse('x'.repeat(50)), { maxTotalBytes: 60 });
    await cache.cachePending();

    const art = store.getArtwork(subject);
    const evicted = art.find((image) => !image.cached)!;
    expect(evicted.url).toMatch(/^https:\/\/images\.test\//);
  });

  it('reports what it is holding', async () => {
    saveArtwork(['https://images.test/poster.jpg']);
    const cache = cacheWith(() => imageResponse('12345'));
    await cache.cachePending();

    expect(cache.status()).toMatchObject({ fileCount: 1, totalBytes: 5, directory });
  });

  it('clears every local copy without losing the artwork', async () => {
    saveArtwork(['https://images.test/poster.jpg']);
    const cache = cacheWith(() => imageResponse('image-bytes'));
    await cache.cachePending();

    expect(cache.clear()).toBe(1);
    expect(cache.status().fileCount).toBe(0);
    expect(store.getArtwork(subject)[0]!.url).toBe('https://images.test/poster.jpg');
  });

  it('removes files no row refers to any more', async () => {
    saveArtwork(['https://images.test/poster.jpg']);
    const cache = cacheWith(() => imageResponse('image-bytes'));
    await cache.cachePending();

    fs.writeFileSync(path.join(directory, 'stray.jpg'), 'junk');
    expect(cache.pruneOrphanFiles()).toBe(1);
    expect(fs.existsSync(path.join(directory, 'stray.jpg'))).toBe(false);
    expect(cache.status().fileCount).toBe(1);
  });

  it('names files by content hash with a safe extension', () => {
    const name = artworkFileName('https://images.test/poster.jpg', 'image/png');
    expect(name).toMatch(/^[0-9a-f]{40}\.png$/);
    // The same URL always maps to the same file.
    expect(artworkFileName('https://images.test/poster.jpg', 'image/png')).toBe(name);
  });

  it('never produces a path separator in a filename', () => {
    expect(artworkFileName('https://images.test/../../etc/passwd')).not.toContain('/');
  });
});
