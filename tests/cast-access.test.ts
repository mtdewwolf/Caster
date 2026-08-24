import { describe, expect, it } from 'bun:test';
import {
  createCastAccessToken,
  verifyCastAccessToken
} from '../apps/server/src/security/cast-access';

describe('cast playback access', () => {
  const secret = new Uint8Array(32).fill(7);
  const now = Date.parse('2026-08-24T12:00:00.000Z');

  it('authorizes only playback derivatives for the granted media item', () => {
    const grant = createCastAccessToken('viewer-1', 'movie-1', {
      secret,
      now,
      ttlMs: 60_000
    });

    for (const pathname of [
      '/api/media/movie-1/stream',
      '/api/media/movie-1/thumbnail',
      '/api/media/movie-1/subtitles/2',
      '/api/media/movie-1/hls/master.m3u8',
      '/api/media/movie-1/hls/720p/index.m3u8',
      '/api/media/movie-1/hls/720p/segment-12.ts'
    ]) {
      expect(verifyCastAccessToken(grant.token, pathname, { secret, now })?.userId).toBe('viewer-1');
    }

    expect(verifyCastAccessToken(grant.token, '/api/media/movie-2/stream', { secret, now })).toBeNull();
    expect(verifyCastAccessToken(grant.token, '/api/media/movie-1', { secret, now })).toBeNull();
    expect(verifyCastAccessToken(grant.token, '/api/libraries', { secret, now })).toBeNull();
  });

  it('rejects expired and tampered grants', () => {
    const grant = createCastAccessToken('viewer-1', 'movie-1', {
      secret,
      now,
      ttlMs: 1_000
    });
    expect(verifyCastAccessToken(grant.token, '/api/media/movie-1/stream', {
      secret,
      now: now + 1_000
    })).toBeNull();

    const tampered = `${grant.token.slice(0, -1)}${grant.token.endsWith('a') ? 'b' : 'a'}`;
    expect(verifyCastAccessToken(tampered, '/api/media/movie-1/stream', { secret, now })).toBeNull();
  });
});
