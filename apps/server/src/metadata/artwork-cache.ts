import crypto from 'crypto';
import fs from 'fs';
import path from 'path';
import type { Database } from 'bun:sqlite';

/**
 * Keeps a local copy of provider artwork.
 *
 * Without this every poster in the library is a live request to the provider's
 * CDN: the images vanish if the provider is down, if the server is offline, or
 * if a URL is rotated. Caching them locally also means the acceptance criterion
 * "provider outages never make local media unplayable" holds for how the
 * library *looks*, not just whether it plays.
 *
 * The cache is deliberately best-effort. A download failure leaves the remote
 * URL in place and the page still renders; nothing here can fail a scan.
 */

export const ARTWORK_MAX_BYTES = 12 * 1024 * 1024;

export interface ArtworkCacheOptions {
  database: Database;
  directory?: string;
  /** Total budget before least-recently-cached files are evicted. */
  maxTotalBytes?: number;
  maxFileBytes?: number;
  fetchImpl?: typeof fetch;
  now?: () => number;
  warn?: (...args: unknown[]) => void;
}

export interface CachedArtwork {
  localFile: string;
  bytes: number;
}

const EXTENSION_BY_TYPE: Record<string, string> = {
  'image/jpeg': '.jpg',
  'image/png': '.png',
  'image/webp': '.webp',
  'image/avif': '.avif',
  'image/svg+xml': '.svg'
};

export function defaultArtworkDirectory(): string {
  return path.join(process.env.MEDIA_DATA_DIR || path.join(process.cwd(), 'data'), 'artwork');
}

/** Stable, collision-free filename for a remote URL. */
export function artworkFileName(url: string, contentType?: string): string {
  const digest = crypto.createHash('sha256').update(url).digest('hex').slice(0, 40);
  const fromType = contentType ? EXTENSION_BY_TYPE[contentType.split(';')[0]!.trim().toLowerCase()] : undefined;
  const fromUrl = /\.(jpe?g|png|webp|avif|svg)$/i.exec(url)?.[0]?.toLowerCase();
  return `${digest}${fromType ?? fromUrl ?? '.img'}`;
}

export class ArtworkCache {
  readonly directory: string;
  readonly #database: Database;
  readonly #maxTotalBytes: number;
  readonly #maxFileBytes: number;
  readonly #fetch: typeof fetch;
  readonly #now: () => number;
  readonly #warn: (...args: unknown[]) => void;

  constructor(options: ArtworkCacheOptions) {
    this.#database = options.database;
    this.directory = options.directory ?? defaultArtworkDirectory();
    this.#maxTotalBytes = options.maxTotalBytes ?? 512 * 1024 * 1024;
    this.#maxFileBytes = options.maxFileBytes ?? ARTWORK_MAX_BYTES;
    this.#fetch = options.fetchImpl ?? fetch;
    this.#now = options.now ?? (() => Date.now());
    this.#warn = options.warn ?? ((...args) => console.warn(...args));
  }

  filePath(localFile: string): string {
    return path.join(this.directory, localFile);
  }

  /**
   * Downloads any artwork rows that have no local copy yet.
   *
   * Returns how many were cached. Every failure is swallowed into that count —
   * the caller is enriching metadata, not fetching images, and must not fail
   * because a CDN returned a 503.
   */
  async cachePending(limit = 24): Promise<number> {
    const rows = this.#database.query(`
      SELECT id, url FROM metadata_artwork
      WHERE local_file IS NULL
      ORDER BY id ASC
      LIMIT ?
    `).all(limit) as Array<{ id: number; url: string }>;

    let cached = 0;
    for (const row of rows) {
      const stored = await this.download(row.url);
      if (!stored) continue;
      this.#database.run(`
        UPDATE metadata_artwork SET local_file = ?, bytes = ?, cached_at = ? WHERE id = ?
      `, [stored.localFile, stored.bytes, new Date(this.#now()).toISOString(), row.id]);
      cached += 1;
    }

    if (cached > 0) this.enforceBudget();
    return cached;
  }

  /** Fetches one image to disk. Returns null on any failure. */
  async download(url: string): Promise<CachedArtwork | null> {
    let parsed: URL;
    try {
      parsed = new URL(url);
    } catch {
      return null;
    }
    // Only ever reach out over HTTP(S); a provider must not be able to make the
    // server read a local file by handing back a file:// URL.
    if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') return null;

    try {
      const response = await this.#fetch(parsed.href, { redirect: 'follow' });
      if (!response.ok) return null;

      const declaredLength = Number(response.headers.get('content-length') ?? '0');
      if (declaredLength > this.#maxFileBytes) return null;

      const body = Buffer.from(await response.arrayBuffer());
      if (body.length === 0 || body.length > this.#maxFileBytes) return null;

      const localFile = artworkFileName(parsed.href, response.headers.get('content-type') ?? undefined);
      fs.mkdirSync(this.directory, { recursive: true });
      fs.writeFileSync(this.filePath(localFile), body);

      return { localFile, bytes: body.length };
    } catch (error) {
      this.#warn(`Could not cache artwork ${url}:`, error);
      return null;
    }
  }

  totalBytes(): number {
    const row = this.#database.query(`
      SELECT COALESCE(SUM(bytes), 0) AS total FROM metadata_artwork WHERE local_file IS NOT NULL
    `).get() as { total: number };
    return row?.total ?? 0;
  }

  /**
   * Evicts least-recently-cached images until the cache fits its budget.
   *
   * Evicting only forgets the local copy — the remote URL stays on the row, so
   * the image still displays and can be re-cached later.
   */
  enforceBudget(): number {
    let total = this.totalBytes();
    if (total <= this.#maxTotalBytes) return 0;

    const rows = this.#database.query(`
      SELECT id, local_file, bytes FROM metadata_artwork
      WHERE local_file IS NOT NULL
      ORDER BY cached_at ASC, id ASC
    `).all() as Array<{ id: number; local_file: string; bytes: number | null }>;

    let evicted = 0;
    for (const row of rows) {
      if (total <= this.#maxTotalBytes) break;
      this.forget(row.id, row.local_file);
      total -= row.bytes ?? 0;
      evicted += 1;
    }
    return evicted;
  }

  /** Drops one local copy, keeping the row and its remote URL. */
  forget(id: number, localFile: string): void {
    try {
      fs.rmSync(this.filePath(localFile), { force: true });
    } catch (error) {
      this.#warn(`Could not remove cached artwork ${localFile}:`, error);
    }
    this.#database.run(
      'UPDATE metadata_artwork SET local_file = NULL, bytes = NULL, cached_at = NULL WHERE id = ?',
      [id]
    );
  }

  /** Deletes files on disk that no row refers to any more. */
  pruneOrphanFiles(): number {
    if (!fs.existsSync(this.directory)) return 0;

    const referenced = new Set(
      (this.#database.query(`
        SELECT DISTINCT local_file FROM metadata_artwork WHERE local_file IS NOT NULL
      `).all() as Array<{ local_file: string }>).map((row) => row.local_file)
    );

    let removed = 0;
    for (const name of fs.readdirSync(this.directory)) {
      if (referenced.has(name)) continue;
      try {
        fs.rmSync(path.join(this.directory, name), { force: true });
        removed += 1;
      } catch (error) {
        this.#warn(`Could not remove orphaned artwork ${name}:`, error);
      }
    }
    return removed;
  }

  /** Clears every local copy, leaving remote URLs intact. */
  clear(): number {
    const rows = this.#database.query(`
      SELECT id, local_file FROM metadata_artwork WHERE local_file IS NOT NULL
    `).all() as Array<{ id: number; local_file: string }>;

    for (const row of rows) this.forget(row.id, row.local_file);
    return rows.length;
  }

  status(): { directory: string; fileCount: number; totalBytes: number; maxTotalBytes: number } {
    const row = this.#database.query(`
      SELECT COUNT(*) AS count FROM metadata_artwork WHERE local_file IS NOT NULL
    `).get() as { count: number };

    return {
      directory: this.directory,
      fileCount: row?.count ?? 0,
      totalBytes: this.totalBytes(),
      maxTotalBytes: this.#maxTotalBytes
    };
  }
}
