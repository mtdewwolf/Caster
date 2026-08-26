import fs from 'fs';
import type { Database } from 'bun:sqlite';

interface MediaIdentityRow {
  id: string;
  full_path: string;
  library_id: string;
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
  /** How a reconciled identity was matched, for diagnostics. */
  via?: 'same-library' | 'path-history' | 'cross-library';
}

export interface PathHistoryEntry {
  fullPath: string;
  libraryId: string | null;
  firstSeenAt: string;
  lastSeenAt: string;
}

/**
 * Keeps media IDs opaque and stable across file moves and renames.
 *
 * Watch progress, playlists and markers all hang off the media ID, so losing it
 * loses a person's history. Matching is deliberately conservative: a candidate
 * is only adopted when its old path is genuinely gone and exactly one candidate
 * fits. Where a fingerprint alone cannot decide between duplicates, the path
 * history breaks the tie — a file returning to somewhere it has lived before is
 * far more likely to be the same item than a coincidental duplicate.
 */
export class MediaIdentityStore {
  constructor(
    private readonly database: Database,
    private readonly pathExists: (filePath: string) => boolean = fs.existsSync
  ) {}

  resolve(input: ResolveMediaIdentityInput): ResolvedMediaIdentity {
    const existing = this.database.query(`
      SELECT id, full_path, library_id FROM media_items WHERE full_path = ?
    `).get(input.fullPath) as MediaIdentityRow | null;

    if (existing) {
      this.recordPath(existing.id, input.fullPath, input.libraryId);
      return { id: existing.id, kind: 'existing' };
    }

    const reconciled = this.#reconcile(input);
    if (reconciled) {
      this.recordPath(reconciled.id, input.fullPath, input.libraryId);
      return reconciled;
    }

    return { id: input.newId, kind: 'new' };
  }

  #reconcile(input: ResolveMediaIdentityInput): ResolvedMediaIdentity | null {
    const sameLibrary = this.#missingCandidates(input, { crossLibrary: false });

    if (sameLibrary.length === 1) {
      return this.#adopt(sameLibrary[0]!, input, 'same-library');
    }

    // Several identical files in the same library. Prefer the one that has
    // lived at this exact path before, if any single one has.
    if (sameLibrary.length > 1) {
      const remembered = this.#candidatesKnownAtPath(sameLibrary, input.fullPath);
      return remembered.length === 1
        ? this.#adopt(remembered[0]!, input, 'path-history')
        : null;
    }

    // Nothing in this library. A file moved between libraries keeps its
    // identity, but only when its previous location is genuinely gone —
    // the current scan's path set says nothing about other libraries.
    const crossLibrary = this.#missingCandidates(input, { crossLibrary: true });
    return crossLibrary.length === 1
      ? this.#adopt(crossLibrary[0]!, input, 'cross-library')
      : null;
  }

  #missingCandidates(
    input: ResolveMediaIdentityInput,
    options: { crossLibrary: boolean }
  ): MediaIdentityRow[] {
    const rows = this.database.query(`
      SELECT id, full_path, library_id
      FROM media_items
      WHERE content_fingerprint = ? AND full_path != ? AND library_id ${options.crossLibrary ? '!=' : '='} ?
      ORDER BY id
    `).all(
      input.contentFingerprint,
      input.fullPath,
      input.libraryId
    ) as MediaIdentityRow[];

    return rows.filter((candidate) => (
      // Within the library being scanned, the discovered path set is the
      // authority. Elsewhere, only the filesystem can say.
      !options.crossLibrary && input.currentLibraryPaths
        ? !input.currentLibraryPaths.has(candidate.full_path)
        : !this.pathExists(candidate.full_path)
    ));
  }

  #candidatesKnownAtPath(
    candidates: readonly MediaIdentityRow[],
    fullPath: string
  ): MediaIdentityRow[] {
    const known = new Set(
      (this.database.query(`
        SELECT media_id FROM media_path_history WHERE full_path = ?
      `).all(fullPath) as Array<{ media_id: string }>).map((row) => row.media_id)
    );
    return candidates.filter((candidate) => known.has(candidate.id));
  }

  #adopt(
    candidate: MediaIdentityRow,
    input: ResolveMediaIdentityInput,
    via: NonNullable<ResolvedMediaIdentity['via']>
  ): ResolvedMediaIdentity | null {
    const update = this.database.run(`
      UPDATE media_items
      SET full_path = ?, relative_path = ?, original_filename = ?, library_id = ?, updated_at = ?
      WHERE id = ? AND full_path = ?
    `, [
      input.fullPath,
      input.relativePath,
      input.originalFilename,
      input.libraryId,
      new Date().toISOString(),
      candidate.id,
      candidate.full_path
    ]);

    // A losing race means another writer already moved this row; treat the file
    // as new rather than overwriting whatever they decided.
    if (update.changes !== 1) return null;

    // Record where it came from as well as where it went. Rows indexed before
    // history existed would otherwise lose their origin the moment they move.
    this.recordPath(candidate.id, candidate.full_path, candidate.library_id);
    return { id: candidate.id, kind: 'reconciled', via };
  }

  /** Notes that this media currently lives at this path. */
  recordPath(mediaId: string, fullPath: string, libraryId: string): void {
    const now = new Date().toISOString();
    this.database.run(`
      INSERT INTO media_path_history (media_id, full_path, library_id, first_seen_at, last_seen_at)
      VALUES (?, ?, ?, ?, ?)
      ON CONFLICT(media_id, full_path) DO UPDATE SET
        library_id = excluded.library_id,
        last_seen_at = excluded.last_seen_at
    `, [mediaId, fullPath, libraryId, now, now]);
  }

  /** Every path this media has occupied, most recently seen first. */
  getPathHistory(mediaId: string): PathHistoryEntry[] {
    const rows = this.database.query(`
      SELECT full_path, library_id, first_seen_at, last_seen_at
      FROM media_path_history
      WHERE media_id = ?
      ORDER BY last_seen_at DESC, full_path ASC
    `).all(mediaId) as Array<Record<string, any>>;

    return rows.map((row) => ({
      fullPath: row.full_path,
      libraryId: row.library_id ?? null,
      firstSeenAt: row.first_seen_at,
      lastSeenAt: row.last_seen_at
    }));
  }
}
