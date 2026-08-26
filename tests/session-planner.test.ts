import { describe, expect, it } from 'bun:test';
import {
  decideSegmentSource,
  DEFAULT_LOOKAHEAD_SEGMENTS,
  sessionDirectoryName,
  sessionKey,
  type SessionWindow
} from '../apps/server/src/transcoder/session-planner';

const window = (over: Partial<SessionWindow> = {}): SessionWindow => ({
  startSegment: 0,
  highestReady: 10,
  running: true,
  ...over
});

const decide = (requested: number, session: SessionWindow | null, lookahead = 12) =>
  decideSegmentSource(requested, session, { lookaheadLimit: lookahead });

describe('segment source planning', () => {
  it('starts a session where the viewer actually is', () => {
    expect(decide(0, null)).toEqual({ action: 'start', startSegment: 0 });
    expect(decide(250, null)).toEqual({ action: 'start', startSegment: 250 });
  });

  it('serves anything the encoder has already written', () => {
    expect(decide(0, window())).toEqual({ action: 'serve' });
    expect(decide(10, window())).toEqual({ action: 'serve' });
  });

  it('waits for a segment the encoder is close behind on', () => {
    expect(decide(11, window())).toEqual({ action: 'wait' });
    expect(decide(22, window())).toEqual({ action: 'wait' });
  });

  it('re-seeks rather than waiting out a long jump forward', () => {
    expect(decide(23, window())).toEqual({
      action: 'restart', startSegment: 23, reason: 'seek-forward'
    });
  });

  it('re-seeks when the viewer scrubs back past the session start', () => {
    expect(decide(4, window({ startSegment: 5, highestReady: 20 }))).toEqual({
      action: 'restart', startSegment: 4, reason: 'seek-backward'
    });
  });

  it('restarts instead of waiting forever on a dead encoder', () => {
    expect(decide(11, window({ running: false }))).toEqual({
      action: 'restart', startSegment: 11, reason: 'encoder-stopped'
    });
  });

  it('still serves finished segments from a stopped encoder', () => {
    expect(decide(10, window({ running: false }))).toEqual({ action: 'serve' });
  });

  it('handles a session that has produced nothing yet', () => {
    const fresh = window({ startSegment: 7, highestReady: 6 });
    expect(decide(7, fresh)).toEqual({ action: 'wait' });
    expect(decide(6, fresh)).toEqual({
      action: 'restart', startSegment: 6, reason: 'seek-backward'
    });
  });

  it('treats a nonsensical lookahead as at least one segment', () => {
    expect(decide(11, window(), 0)).toEqual({ action: 'wait' });
    expect(decide(12, window(), 0)).toEqual({
      action: 'restart', startSegment: 12, reason: 'seek-forward'
    });
  });

  it('has a sane default lookahead', () => {
    expect(DEFAULT_LOOKAHEAD_SEGMENTS).toBeGreaterThan(0);
    expect(decideSegmentSource(11, window())).toEqual({ action: 'wait' });
  });
});

describe('session identity', () => {
  it('separates media, quality and audio settings', () => {
    expect(sessionKey('m1', '720p', 'aac-2-td')).not.toBe(sessionKey('m1', '1080p', 'aac-2-td'));
    expect(sessionKey('m1', '720p', 'aac-2-td')).not.toBe(sessionKey('m1', '720p', 'copy-ac3-6-td'));
    expect(sessionKey('m1', '720p', 'aac-2-td')).not.toBe(sessionKey('m2', '720p', 'aac-2-td'));
  });

  it('is stable for identical inputs, so viewers share one encoder', () => {
    expect(sessionKey('m1', '720p', 'aac-2-td')).toBe(sessionKey('m1', '720p', 'aac-2-td'));
  });

  it('produces a directory name safe for any media id', () => {
    const name = sessionDirectoryName(sessionKey('../../etc/passwd', '720p', 'aac-2-td'), 'abc');
    expect(name).not.toContain('/');
    expect(name).not.toContain('..');
    expect(name.startsWith('session_')).toBe(true);
  });

  it('gives two sessions of the same stream different directories', () => {
    const key = sessionKey('m1', '720p', 'aac-2-td');
    expect(sessionDirectoryName(key, 'first')).not.toBe(sessionDirectoryName(key, 'second'));
  });
});
