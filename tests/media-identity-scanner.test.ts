import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
import crypto from 'crypto';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { db, initDatabase, LibraryModel } from '../apps/server/src/db';
import { scanLibrary } from '../apps/server/src/scanner/indexer';

describe('scanner rename reconciliation', () => {
  const suffix = crypto.randomUUID();
  const libraryId = `identity-scan-${suffix}`;
  let temporaryRoot = '';

  beforeAll(() => {
    initDatabase();
    temporaryRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'caster-identity-scan-'));
    LibraryModel.create({
      id: libraryId,
      name: 'Identity Scan Music',
      path: temporaryRoot,
      type: 'music',
      created_at: new Date().toISOString()
    });
  });

  afterAll(() => {
    LibraryModel.delete(libraryId);
    const expectedPrefix = path.join(os.tmpdir(), 'caster-identity-scan-');
    if (temporaryRoot.startsWith(expectedPrefix)) {
      fs.rmSync(temporaryRoot, { recursive: true, force: true });
    }
  });

  it('keeps the media ID and marker when a scanned file is renamed', async () => {
    const original = path.join(temporaryRoot, 'Artist', 'Album', '01 - Original.mp3');
    const renamed = path.join(temporaryRoot, 'Artist', 'Album', '01 - Renamed.mp3');
    fs.mkdirSync(path.dirname(original), { recursive: true });
    fs.writeFileSync(original, Buffer.alloc(4096, 11));

    await scanLibrary(libraryId);
    const first = db.query(`
      SELECT id, content_fingerprint FROM media_items WHERE library_id = ?
    `).get(libraryId) as { id: string; content_fingerprint: string };
    expect(first.content_fingerprint).toStartWith('sampled-sha256-v1:');
    const now = new Date().toISOString();
    db.run(`
      INSERT INTO media_markers (
        id, media_id, marker_type, start_seconds, end_seconds, state,
        source, created_at, updated_at
      ) VALUES (?, ?, 'intro', 0, 2, 'active', 'manual', ?, ?)
    `, [`identity-marker-${suffix}`, first.id, now, now]);

    fs.renameSync(original, renamed);
    await scanLibrary(libraryId);

    expect(db.query(`
      SELECT id, full_path FROM media_items WHERE library_id = ?
    `).get(libraryId)).toEqual({ id: first.id, full_path: renamed });
    expect(db.query(`
      SELECT media_id FROM media_markers WHERE id = ?
    `).get(`identity-marker-${suffix}`)).toEqual({ media_id: first.id });
  });
});
