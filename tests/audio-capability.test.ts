import { describe, expect, it } from 'bun:test';
import {
  audioModeFor,
  supportsSurround,
  withAudioMode
} from '../apps/web/src/features/playback/audio-capability';

describe('client surround detection', () => {
  it('asks for surround when the platform reports native support', () => {
    expect(audioModeFor({ canPlayType: () => 'probably' })).toBe('surround');
    expect(audioModeFor({ canPlayType: () => 'maybe' })).toBe('surround');
  });

  it('stays on stereo when the platform says no', () => {
    expect(audioModeFor({ canPlayType: () => '' })).toBe('stereo');
  });

  it('stays on stereo when nothing can be probed', () => {
    // An environment that exposes neither check must not opt into surround.
    expect(audioModeFor({})).toBe('stereo');
  });

  it('falls back to the Media Source check', () => {
    expect(supportsSurround({ canPlayType: () => '', isTypeSupported: () => true })).toBe(true);
    expect(supportsSurround({ canPlayType: () => '', isTypeSupported: () => false })).toBe(false);
  });

  it('only accepts a strict true from the Media Source check', () => {
    expect(supportsSurround({ isTypeSupported: (() => 'yes') as any })).toBe(false);
  });

  it('leaves stereo out of the URL so existing links are unchanged', () => {
    expect(withAudioMode('/api/media/x/hls/master.m3u8', 'stereo'))
      .toBe('/api/media/x/hls/master.m3u8');
  });

  it('appends surround with the right separator', () => {
    expect(withAudioMode('/api/media/x/hls/master.m3u8', 'surround'))
      .toBe('/api/media/x/hls/master.m3u8?audio=surround');
    expect(withAudioMode('/api/media/x/hls/master.m3u8?cast=abc', 'surround'))
      .toBe('/api/media/x/hls/master.m3u8?cast=abc&audio=surround');
  });
});
