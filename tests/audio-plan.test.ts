import { describe, expect, it } from 'bun:test';
import {
  audioArgsFor,
  audioCacheKey,
  isAudioMode,
  planAudioStream,
  type AudioMode
} from '../apps/server/src/transcoder/audio';

const stereoBitrate = '192k';
const plan = (source: Parameters<typeof planAudioStream>[0], mode: AudioMode = 'stereo') =>
  planAudioStream(source, { mode, stereoBitrate });

describe('audio stream planning', () => {
  it('preserves 5.1 for a client that asked for surround', () => {
    const result = plan({ codec: 'ac3', channels: 6 }, 'surround');
    expect(result.action).toBe('copy');
    expect(result.channels).toBe(6);
    expect(audioArgsFor(result)).toEqual(['-c:a', 'copy']);
  });

  it('preserves 7.1 for a client that asked for surround', () => {
    expect(plan({ codec: 'eac3', channels: 8 }, 'surround').channels).toBe(8);
  });

  it('re-encodes surround that the container cannot carry, keeping the channels', () => {
    const result = plan({ codec: 'dts', channels: 6 }, 'surround');
    expect(result.action).toBe('transcode');
    expect(result.codec).toBe('ac3');
    expect(result.channels).toBe(6);
    expect(result.reason).toBe('surround-transcode');
    expect(audioArgsFor(result)).toEqual(['-c:a', 'ac3', '-ac', '6', '-b:a', '640k']);
  });

  it('scales the surround bitrate with channel count', () => {
    expect(plan({ codec: 'dts', channels: 8 }, 'surround').bitrate).toBe('768k');
    expect(plan({ codec: 'dts', channels: 6 }, 'surround').bitrate).toBe('640k');
  });

  it('downmixes only when the client has not claimed surround support', () => {
    const result = plan({ codec: 'ac3', channels: 6 }, 'stereo');
    expect(result.channels).toBe(2);
    expect(result.codec).toBe('aac');
    expect(result.reason).toBe('stereo-downmix');
  });

  it('copies a stereo source whose codec already fits the container', () => {
    const result = plan({ codec: 'aac', channels: 2 });
    expect(result.action).toBe('copy');
    expect(result.reason).toBe('source-passthrough');
  });

  it('re-encodes a stereo source in an incompatible codec', () => {
    const result = plan({ codec: 'flac', channels: 2 });
    expect(result.action).toBe('transcode');
    expect(result.codec).toBe('aac');
    expect(result.bitrate).toBe(stereoBitrate);
  });

  it('treats unknown source audio as stereo rather than guessing', () => {
    const result = plan({});
    expect(result.channels).toBe(2);
    expect(result.action).toBe('transcode');
  });

  it('maps an explicitly selected track', () => {
    const result = plan({ codec: 'ac3', channels: 6, streamIndex: 3 }, 'surround');
    expect(result.sourceStreamIndex).toBe(3);
  });

  it('gives stereo and surround different cache identities', () => {
    const stereo = plan({ codec: 'ac3', channels: 6 }, 'stereo');
    const surround = plan({ codec: 'ac3', channels: 6 }, 'surround');
    expect(audioCacheKey(stereo)).not.toBe(audioCacheKey(surround));
  });

  it('gives different audio tracks different cache identities', () => {
    const first = plan({ codec: 'ac3', channels: 6, streamIndex: 1 }, 'surround');
    const second = plan({ codec: 'ac3', channels: 6, streamIndex: 2 }, 'surround');
    expect(audioCacheKey(first)).not.toBe(audioCacheKey(second));
  });

  it('is stable for the same inputs', () => {
    const key = () => audioCacheKey(plan({ codec: 'ac3', channels: 6 }, 'surround'));
    expect(key()).toBe(key());
  });

  it('validates the audio mode parameter', () => {
    expect(isAudioMode('surround')).toBe(true);
    expect(isAudioMode('stereo')).toBe(true);
    expect(isAudioMode('quadraphonic')).toBe(false);
    expect(isAudioMode(undefined)).toBe(false);
  });

  it('never emits a downmix argument for a passthrough plan', () => {
    const args = audioArgsFor(plan({ codec: 'ac3', channels: 6 }, 'surround'));
    expect(args).not.toContain('-ac');
  });
});
