import crypto from 'crypto';
import fs from 'fs';

const FINGERPRINT_VERSION = 'sampled-sha256-v1';
const SAMPLE_BYTES = 64 * 1024;

function sampleOffsets(size: number): number[] {
  if (size <= SAMPLE_BYTES) return [0];
  const last = Math.max(0, size - SAMPLE_BYTES);
  const middle = Math.max(0, Math.floor((size - SAMPLE_BYTES) / 2));
  return [...new Set([0, middle, last])];
}

/**
 * Computes a path-independent, bounded fingerprint for rename reconciliation.
 * Small files are hashed completely; large files hash fixed head/middle/tail
 * samples plus their exact byte length. The source file is never modified.
 */
export function contentFingerprint(filePath: string): string {
  const stats = fs.statSync(filePath);
  if (!stats.isFile()) throw new TypeError('Content fingerprints require a regular file');

  const hash = crypto.createHash('sha256');
  hash.update(`${FINGERPRINT_VERSION}\0${stats.size}\0`);
  const handle = fs.openSync(filePath, 'r');
  try {
    for (const offset of sampleOffsets(stats.size)) {
      const length = Math.min(SAMPLE_BYTES, Math.max(0, stats.size - offset));
      const sample = Buffer.allocUnsafe(length);
      const bytesRead = length > 0 ? fs.readSync(handle, sample, 0, length, offset) : 0;
      hash.update(`${offset}:${bytesRead}\0`);
      if (bytesRead > 0) hash.update(sample.subarray(0, bytesRead));
    }
  } finally {
    fs.closeSync(handle);
  }
  return `${FINGERPRINT_VERSION}:${hash.digest('hex')}`;
}
