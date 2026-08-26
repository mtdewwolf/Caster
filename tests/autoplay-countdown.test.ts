import { describe, expect, it } from 'bun:test';
import {
  autoplayReducer,
  DEFAULT_AUTOPLAY_SECONDS,
  initialAutoplayState,
  isCountdownVisible,
  shouldAdvance,
  type AutoplayAction,
  type AutoplayState
} from '../apps/web/src/features/playback/autoplay';

const run = (actions: AutoplayAction[], from: AutoplayState = initialAutoplayState) =>
  actions.reduce(autoplayReducer, from);

describe('autoplay countdown', () => {
  it('does not advance the moment playback ends', () => {
    const state = run([{ type: 'playback-ended' }]);
    expect(state.status).toBe('counting');
    expect(state.secondsRemaining).toBe(DEFAULT_AUTOPLAY_SECONDS);
    expect(shouldAdvance(state)).toBe(false);
    expect(isCountdownVisible(state)).toBe(true);
  });

  it('advances only after the countdown reaches zero', () => {
    let state = run([{ type: 'playback-ended', seconds: 3 }]);
    for (let remaining = 2; remaining >= 1; remaining -= 1) {
      state = autoplayReducer(state, { type: 'tick' });
      expect(state.status).toBe('counting');
      expect(state.secondsRemaining).toBe(remaining);
    }
    state = autoplayReducer(state, { type: 'tick' });
    expect(shouldAdvance(state)).toBe(true);
  });

  it('stops for good when the person cancels', () => {
    const cancelled = run([{ type: 'playback-ended', seconds: 5 }, { type: 'tick' }, { type: 'cancel' }]);
    expect(cancelled.status).toBe('cancelled');
    expect(isCountdownVisible(cancelled)).toBe(false);

    // Further ticks and a repeated end event must not resurrect the countdown.
    const after = run([{ type: 'tick' }, { type: 'playback-ended' }], cancelled);
    expect(after.status).toBe('cancelled');
    expect(shouldAdvance(after)).toBe(false);
  });

  it('lets the person skip the wait', () => {
    const state = run([{ type: 'playback-ended' }, { type: 'advance-now' }]);
    expect(shouldAdvance(state)).toBe(true);
    expect(state.secondsRemaining).toBe(0);
  });

  it('clears a cancellation when a new item starts', () => {
    const cancelled = run([{ type: 'playback-ended' }, { type: 'cancel' }]);
    const restarted = run([{ type: 'reset' }, { type: 'playback-ended' }], cancelled);
    expect(restarted.status).toBe('counting');
  });

  it('never counts down from less than one second', () => {
    expect(run([{ type: 'playback-ended', seconds: 0 }]).secondsRemaining).toBe(1);
    expect(run([{ type: 'playback-ended', seconds: -4 }]).secondsRemaining).toBe(1);
  });

  it('ignores a duplicate end event once it is already advancing', () => {
    const advancing = run([{ type: 'playback-ended' }, { type: 'advance-now' }]);
    expect(autoplayReducer(advancing, { type: 'playback-ended' })).toBe(advancing);
  });
});
