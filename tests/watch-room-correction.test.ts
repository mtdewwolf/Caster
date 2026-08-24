import { describe, expect, it } from 'bun:test';
import { decideDriftCorrection } from '../apps/web/src/features/watch-together/correction';
import {
  buildWatchRoomInviteUrl,
  readWatchRoomInvite
} from '../apps/web/src/features/watch-together/invite-fragment';

describe('Watch Together drift correction', () => {
  it('does nothing inside 250ms and restores normal speed', () => {
    expect(decideDriftCorrection({
      localPositionSeconds: 10,
      localPaused: false,
      targetPositionSeconds: 10.25,
      targetPaused: false
    })).toEqual({ kind: 'none', playbackRate: 1 });
  });

  it('uses bounded speed correction through two seconds in either direction', () => {
    expect(decideDriftCorrection({
      localPositionSeconds: 10,
      localPaused: false,
      targetPositionSeconds: 10.251,
      targetPaused: false
    })).toEqual({ kind: 'rate', playbackRate: 1.05 });
    expect(decideDriftCorrection({
      localPositionSeconds: 12,
      localPaused: false,
      targetPositionSeconds: 10,
      targetPaused: false
    })).toEqual({ kind: 'rate', playbackRate: 0.95 });
  });

  it('hard seeks beyond two seconds and hard-aligns paused or resumed state', () => {
    expect(decideDriftCorrection({
      localPositionSeconds: 10,
      localPaused: false,
      targetPositionSeconds: 12.001,
      targetPaused: false
    })).toEqual({ kind: 'seek', positionSeconds: 12.001, playbackRate: 1 });
    expect(decideDriftCorrection({
      localPositionSeconds: 10,
      localPaused: false,
      targetPositionSeconds: 10,
      targetPaused: true
    })).toEqual({ kind: 'hard-sync', positionSeconds: 10, paused: true, playbackRate: 1 });
    expect(decideDriftCorrection({
      localPositionSeconds: 10,
      localPaused: true,
      targetPositionSeconds: 10.1,
      targetPaused: false
    })).toEqual({ kind: 'hard-sync', positionSeconds: 10.1, paused: false, playbackRate: 1 });
  });
});

describe('Watch Together invite fragments', () => {
  it('keeps the room secret in the fragment rather than the query string', () => {
    const url = buildWatchRoomInviteUrl(
      'room_abc',
      'very-secret',
      'https://caster.example/library?sort=title'
    );
    const parsed = new URL(url);
    expect(parsed.searchParams.has('invite')).toBe(false);
    expect(readWatchRoomInvite(parsed.hash)).toEqual({
      roomId: 'room_abc', inviteToken: 'very-secret'
    });
  });
});
