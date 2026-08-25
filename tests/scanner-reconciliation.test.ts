import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
import crypto from 'crypto';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { db, initDatabase, LibraryModel, MediaModel } from '../apps/server/src/db';
import { scanLibrary, scanStatus } from '../apps/server/src/scanner/indexer';

describe('scanner discovery reconciliation', () => {
  const suffix = crypto.randomUUID();
  const libraryId = `scan-reconciliation-${suffix}`;
  const mediaId = `scan-reconciliation-media-${suffix}`;
  const playlistId = `scan-reconciliation-playlist-${suffix}`;
  const progressId = `scan-reconciliation-progress-${suffix}`;
  let fixtureRoot = '';
  let mediaPath = '';

  beforeAll(() => {
    initDatabase();
    fixtureRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'caster-scan-reconciliation-'));
    mediaPath = path.join(fixtureRoot, '01 - Existing Track.mp3');
    fs.writeFileSync(mediaPath, Buffer.alloc(4096, 23));

    const now = new Date().toISOString();
    LibraryModel.create({
      id: libraryId,
      name: 'Scanner Reconciliation',
      path: fixtureRoot,
      type: 'music',
      created_at: now
    });
    MediaModel.upsert({
      id: mediaId,
      library_id: libraryId,
      title: 'Existing Track',
      original_filename: path.basename(mediaPath),
      relative_path: path.basename(mediaPath),
      full_path: mediaPath,
      type: 'track',
      duration: 120,
      size_bytes: fs.statSync(mediaPath).size,
      format: 'mp3',
      is_hdr: false,
      streams_json: '[]',
      created_at: now,
      updated_at: now
    });
    db.run(`
      INSERT INTO watch_progress (
        id, user_id, media_id, position_seconds, duration_seconds,
        progress_percent, completed, last_watched_at
      ) VALUES (?, 'admin', ?, 30, 120, 25, 0, ?)
    `, [progressId, mediaId, now]);
    db.run(`
      INSERT INTO playlists (id, user_id, name, revision, created_at, updated_at)
      VALUES (?, 'admin', ?, 1, ?, ?)
    `, [playlistId, `Reconciliation ${suffix}`, now, now]);
    db.run(`
      INSERT INTO playlist_items (id, playlist_id, media_id, position, added_at)
      VALUES (?, ?, ?, 0, ?)
    `, [`${playlistId}-item`, playlistId, mediaId, now]);
  });

  afterAll(() => {
    LibraryModel.delete(libraryId);
    const expectedPrefix = path.join(os.tmpdir(), 'caster-scan-reconciliation-');
    if (fixtureRoot.startsWith(expectedPrefix)) {
      fs.rmSync(fixtureRoot, { recursive: true, force: true });
    }
  });

  it('retains discovered media and dependent state when processing fails', async () => {
    const originalUpsert = MediaModel.upsert;
    MediaModel.upsert = (() => {
      throw new Error('simulated metadata refresh failure');
    }) as typeof MediaModel.upsert;

    let result: Awaited<ReturnType<typeof scanLibrary>>;
    try {
      result = await scanLibrary(libraryId);
    } finally {
      MediaModel.upsert = originalUpsert;
    }

    expect(result!).toEqual({ processed: 1, errors: 1 });
    expect(scanStatus.errors).toContain(
      `Error processing ${mediaPath}: simulated metadata refresh failure`
    );
    expect(db.query('SELECT id FROM media_items WHERE id = ?').get(mediaId)).toEqual({ id: mediaId });
    expect(db.query('SELECT media_id FROM watch_progress WHERE id = ?').get(progressId)).toEqual({
      media_id: mediaId
    });
    expect(db.query('SELECT media_id FROM playlist_items WHERE playlist_id = ?').get(playlistId)).toEqual({
      media_id: mediaId
    });

    const generation = db.query(`
      SELECT status, error
      FROM library_scan_generations
      WHERE library_id = ?
      ORDER BY started_at DESC
      LIMIT 1
    `).get(libraryId) as { status: string; error: string | null };
    expect(generation.status).toBe('completed');
    expect(generation.error).toContain('simulated metadata refresh failure');
    expect(db.query(`
      SELECT COUNT(*) AS count
      FROM library_scan_discoveries
      WHERE library_id = ? AND full_path = ?
    `).get(libraryId, mediaPath)).toEqual({ count: 1 });
  });

  it('does not reconcile when filesystem traversal is incomplete', async () => {
    const originalReadDirectory = fs.readdirSync;
    fs.readdirSync = (() => {
      throw new Error('simulated storage hiccup');
    }) as typeof fs.readdirSync;

    let result: Awaited<ReturnType<typeof scanLibrary>>;
    try {
      result = await scanLibrary(libraryId);
    } finally {
      fs.readdirSync = originalReadDirectory;
    }

    expect(result!).toEqual({ processed: 0, errors: 1 });
    expect(scanStatus.errors).toContain(
      `Error discovering files in ${fixtureRoot}: simulated storage hiccup`
    );
    expect(db.query('SELECT id FROM media_items WHERE id = ?').get(mediaId)).toEqual({ id: mediaId });

    const generation = db.query(`
      SELECT status, error
      FROM library_scan_generations
      WHERE library_id = ?
      ORDER BY started_at DESC
      LIMIT 1
    `).get(libraryId) as { status: string; error: string | null };
    expect(generation.status).toBe('failed');
    expect(generation.error).toContain('simulated storage hiccup');
  });
});
