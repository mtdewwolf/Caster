import { describe, expect, it } from 'bun:test';
import {
  CLIENT_CAPABILITY_VERSION,
  CLIENT_PROFILES,
  parseClientCapabilities,
  profileByName,
  supportsVideoCodec
} from '../apps/server/src/transcoder/capabilities';
import {
  describePlaybackPlan,
  planPlayback,
  type PlaybackSource
} from '../apps/server/src/transcoder/playback-plan';

const CHROME = CLIENT_PROFILES.chrome!;
const SAFARI = CLIENT_PROFILES.safari!;
const UNKNOWN = CLIENT_PROFILES.unknown!;

/** An ordinary web-friendly file. */
const FRIENDLY: PlaybackSource = {
  container: 'mp4', videoCodec: 'h264', videoLevel: 40, height: 1080,
  audioCodec: 'aac', audioChannels: 2
};

/** A typical Blu-ray remux. */
const REMUX: PlaybackSource = {
  container: 'mkv', videoCodec: 'h264', videoLevel: 41, height: 1080,
  audioCodec: 'aac', audioChannels: 2
};

const plan = (source: PlaybackSource, capabilities = CHROME, burnInSubtitle = false) =>
  planPlayback({ source, capabilities, burnInSubtitle });

describe('playback planning', () => {
  it('direct plays a file the client can already open', () => {
    const result = plan(FRIENDLY);
    expect(result.method).toBe('direct');
    expect(result.videoAction).toBe('copy');
    expect(result.audioAction).toBe('copy');
  });

  it('remuxes compatible streams out of an incompatible container', () => {
    const result = plan(REMUX);
    // The whole point of the criterion: no re-encoding just to change wrapper.
    expect(result.method).toBe('remux');
    expect(result.videoAction).toBe('copy');
    expect(result.audioAction).toBe('copy');
    expect(result.reasons).toContain('container-unsupported');
  });

  it('transcodes video the client cannot decode', () => {
    const result = plan({ ...FRIENDLY, videoCodec: 'hevc' });
    expect(result.method).toBe('transcode');
    expect(result.videoAction).toBe('transcode');
    expect(result.reasons).toContain('video-codec-unsupported');
  });

  it('separates an unsupported codec from one that is merely too demanding', () => {
    const tooHigh = plan({ ...FRIENDLY, videoLevel: 62 });
    expect(tooHigh.reasons).toContain('video-level-unsupported');
    expect(tooHigh.reasons).not.toContain('video-codec-unsupported');
  });

  it('transcodes video taller than the client supports', () => {
    const result = plan({ ...FRIENDLY, height: 2160 }, UNKNOWN);
    expect(result.reasons).toContain('video-resolution-too-high');
  });

  it('transcodes when the connection cannot carry the bitrate', () => {
    const capabilities = { ...CHROME, maxBitrate: 5_000_000 };
    const result = plan({ ...FRIENDLY, bitRate: 40_000_000 }, capabilities);
    expect(result.reasons).toContain('video-bitrate-too-high');
    expect(result.method).toBe('transcode');
  });

  it('leaves bitrate alone when the client did not measure one', () => {
    expect(plan({ ...FRIENDLY, bitRate: 90_000_000 }).method).toBe('direct');
  });

  it('re-encodes audio the client cannot decode, keeping the video', () => {
    const result = plan({ ...FRIENDLY, audioCodec: 'truehd', audioChannels: 8 });
    expect(result.videoAction).toBe('copy');
    expect(result.audioAction).toBe('transcode');
    expect(result.reasons).toContain('audio-codec-unsupported');
  });

  it('re-encodes audio with more channels than the client has', () => {
    const result = plan({ ...FRIENDLY, audioCodec: 'aac', audioChannels: 6 });
    expect(result.audioAction).toBe('transcode');
    expect(result.reasons).toContain('audio-channels-too-many');
  });

  it('keeps surround intact for a client that handles it', () => {
    const result = plan({ ...FRIENDLY, container: 'mp4', audioCodec: 'ac3', audioChannels: 6 }, SAFARI);
    expect(result.audioAction).toBe('copy');
    expect(result.method).toBe('direct');
  });

  it('tone maps HDR only for a screen that cannot show it', () => {
    expect(plan({ ...FRIENDLY, isHdr: true }, SAFARI).toneMap).toBe(false);

    const flattened = plan({ ...FRIENDLY, isHdr: true }, CHROME);
    expect(flattened.toneMap).toBe(true);
    expect(flattened.reasons).toContain('hdr-tone-map-required');
  });

  it('forces a transcode when subtitles must be drawn on', () => {
    const result = plan(FRIENDLY, CHROME, true);
    expect(result.method).toBe('transcode');
    expect(result.reasons).toContain('subtitle-burn-in-required');
  });

  it('gives two different clients different plans for the same file', () => {
    const source: PlaybackSource = {
      container: 'mkv', videoCodec: 'hevc', height: 2160, isHdr: true,
      audioCodec: 'eac3', audioChannels: 6
    };
    expect(plan(source, SAFARI).method).toBe('remux');
    expect(plan(source, CHROME).method).toBe('transcode');
  });

  it('is deterministic for the same inputs', () => {
    expect(plan(REMUX)).toEqual(plan(REMUX));
  });

  it('says a client described itself with safe assumptions', () => {
    expect(plan(FRIENDLY, UNKNOWN).reasons).toContain('client-capabilities-assumed');
    expect(plan(FRIENDLY, CHROME).reasons).not.toContain('client-capabilities-assumed');
  });
});

describe('explaining a plan', () => {
  it('says nothing is being changed for a direct play', () => {
    expect(describePlaybackPlan(plan(FRIENDLY))).toContain('directly');
  });

  it('reassures that a remux loses no quality', () => {
    expect(describePlaybackPlan(plan(REMUX))).toContain('no quality is lost');
  });

  it('names the actual cause of a transcode', () => {
    const text = describePlaybackPlan(plan({ ...FRIENDLY, videoCodec: 'hevc' }));
    expect(text).toContain('cannot play this video format');
    // No codec names, no acronyms — this goes on screen for anyone.
    expect(text).not.toContain('hevc');
  });

  it('does not read out a list of every reason', () => {
    const text = describePlaybackPlan(plan({
      container: 'mkv', videoCodec: 'hevc', height: 4320, isHdr: true,
      audioCodec: 'truehd', audioChannels: 8
    }, UNKNOWN));
    expect(text).toContain('other reasons');
  });
});

describe('client capabilities', () => {
  it('falls back to conservative defaults for an unknown device', () => {
    expect(profileByName('nonsense')).toBe(UNKNOWN);
    expect(profileByName(undefined).assumed).toBe(true);
  });

  it('resolves the named profiles', () => {
    expect(profileByName('SAFARI')).toBe(SAFARI);
    expect(profileByName(' chrome ')).toBe(CHROME);
  });

  it('accepts a client declaration', () => {
    const declared = parseClientCapabilities({
      version: CLIENT_CAPABILITY_VERSION,
      containers: ['mkv', 'mp4'],
      videoCodecs: [{ codec: 'hevc', maxLevel: 153 }],
      audioCodecs: ['eac3'],
      maxAudioChannels: 8,
      maxHeight: 2160,
      hdr: true
    });

    expect(declared.containers).toEqual(['mkv', 'mp4']);
    expect(declared.maxAudioChannels).toBe(8);
    expect(supportsVideoCodec(declared, 'hevc', { level: 120 })).toBe(true);
    expect(supportsVideoCodec(declared, 'hevc', { level: 180 })).toBe(false);
  });

  it('ignores a declaration from an unrecognised contract version', () => {
    const declared = parseClientCapabilities({ version: 99, maxAudioChannels: 8 });
    expect(declared.maxAudioChannels).toBe(UNKNOWN.maxAudioChannels);
  });

  it('fills gaps in a partial declaration rather than rejecting it', () => {
    const declared = parseClientCapabilities({ maxAudioChannels: 6 }, CHROME);
    expect(declared.maxAudioChannels).toBe(6);
    expect(declared.containers).toEqual(CHROME.containers);
  });

  it('shrugs off malformed input', () => {
    expect(parseClientCapabilities(null).maxHeight).toBe(UNKNOWN.maxHeight);
    expect(parseClientCapabilities('nonsense').maxHeight).toBe(UNKNOWN.maxHeight);
    expect(parseClientCapabilities({ containers: 'mp4' }).containers).toEqual(UNKNOWN.containers);
    expect(parseClientCapabilities({ videoCodecs: [{}, null] }).videoCodecs).toEqual(UNKNOWN.videoCodecs);
  });

  it('never lets a bad declaration widen what an assumed client claims', () => {
    const declared = parseClientCapabilities({ maxAudioChannels: -4 });
    expect(declared.maxAudioChannels).toBe(UNKNOWN.maxAudioChannels);
    expect(declared.assumed).toBe(true);
  });
});
