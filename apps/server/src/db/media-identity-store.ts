import fs from 'fs';
import type { Database } from 'bun:sqlite';

interface MediaIdentityRow {
  id: string;
  full_path: string;
}

export interface ResolveMediaIdentityInput {
  libraryId: string;
  fullPath: string;
  relativePath: string;
  originalFilename: string;
  contentFingerprint: string;
  newId: string;
  /** Exact paths discovered in the current library scan, when available. */
  currentLibraryPaths?: ReadonlySet<string>;
}

export interface ResolvedMediaIdentity {
  id: string;
  kind: 'existing' | 'reconciled' | 'new';
}

/**
 * Keeps media IDs opaque and stable across unambiguous path changes. A
 * candidate is eligible only when its old source path no longer exists. If
 * multiple missing rows share a fingerprint, no guess is made.
 */
export class MediaIdentityStore {
  constructor(
    private readonly database: Database,
    private readonly pathExists: (filePath: string) => boolean = fs.existsSync
  ) {}

  resolve(input: ResolveMediaIdentityInput): ResolvedMediaIdentity {
    const existing = this.database.query(`
      SELECT id, full_path FROM media_items WHERE full_path = ?
    `).get(input.fullPath) as MediaIdentityRow | null;
    if (existing) return { id: existing.id, kind: 'existing' };

    const candidates = (this.database.query(`
      SELECT id, full_path
      FROM media_items
      WHERE library_id = ? AND content_fingerprint = ? AND full_path != ?
      ORDER BY id
    `).all(
      input.libraryId,
      input.contentFingerprint,
      input.fullPath
    ) as MediaIdentityRow[]).filter((candidate) => (
      input.currentLibraryPaths
        ? !input.currentLibraryPaths.has(candidate.full_path)
        : !this.pathExists(candidate.full_path)
    ));

    if (candidates.length !== 1) return { id: input.newId, kind: 'new' };

    const candidate = candidates[0];
    const update = this.database.run(`
      UPDATE media_items
      SET full_path = ?, relative_path = ?, original_filename = ?, updated_at = ?
      WHERE id = ? AND full_path = ?
    `, [
      input.fullPath,
      input.relativePath,
      input.originalFilename,
      new Date().toISOString(),
      candidate.id,
      candidate.full_path
    ]);
    return update.changes === 1
      ? { id: candidate.id, kind: 'reconciled' }
      : { id: input.newId, kind: 'new' };
  }
}
