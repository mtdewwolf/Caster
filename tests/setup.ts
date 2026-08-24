import { afterAll } from 'bun:test';
import fs from 'fs';
import os from 'os';
import path from 'path';

const testRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'caster-test-run-'));

// Database and media helpers read these values when their modules are first
// imported. Keeping them in a preload guarantees tests never open ./data/media.db
// or write thumbnails/transcode segments into an operator's data directory.
process.env.MEDIA_DATA_DIR = path.join(testRoot, 'data');
process.env.THUMBNAILS_DIR = path.join(testRoot, 'thumbnails');
process.env.TRANSCODE_CACHE_DIR = path.join(testRoot, 'transcode-cache');

afterAll(async () => {
  try {
    const { db } = await import('../apps/server/src/db');
    db.run('PRAGMA wal_checkpoint(TRUNCATE)');
    db.close();
    Bun.gc(true);
  } finally {
    const resolvedRoot = path.resolve(testRoot);
    const resolvedTempDirectory = path.resolve(os.tmpdir());
    const isOwnedTestDirectory =
      resolvedRoot.startsWith(`${resolvedTempDirectory}${path.sep}`) &&
      path.basename(resolvedRoot).startsWith('caster-test-run-');

    if (isOwnedTestDirectory) {
      fs.rmSync(resolvedRoot, {
        recursive: true,
        force: true,
        maxRetries: 10,
        retryDelay: 100
      });
    }
  }
});
