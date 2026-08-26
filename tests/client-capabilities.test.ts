import { describe, expect, it } from 'bun:test';
import {
  browserCapabilityProbe,
  capabilitiesQuery,
  detectClientCapabilities,
  withCapabilities,
  type CapabilityProbe
} from '../apps/web/src/features/playback/client-capabilities';
import { parseClientCapabilities, CLIENT_PROFILES } from '../apps/server/src/transcoder/capabilities';
import { planPlayback } from '../apps/server/src/transcoder/playback-plan';

/**
 * A browser that answers yes only for the exact codec strings listed.
 *
 * Matching on loose substrings is how a fixture accidentally claims support
 * for a codec it never meant to — `video/mp4` is a prefix of the AV1 type.
 */
const probeFor = (codecs: string[], containers: string[]): CapabilityProbe => ({
  canPlayType: (type) => {
    const codecMatch = /codecs="([^"]+)"/.exec(type)?.[1];
    if (codecMatch) return codecs.some((codec) => codecMatch.startsWith(codec)) ? 'probably' : '';
    return containers.includes(type) ? 'probably' : '';
  },
  screenHeight: 2160
});

const SAFARI_LIKE = probeFor(
  ['avc1', 'hvc1', 'mp4a', 'ac-3', 'ec-3'],
  ['video/mp4', 'video/quicktime']
);
const CHROME_LIKE = probeFor(
  ['avc1', 'vp9', 'av01', 'mp4a', 'opus'],
  ['video/mp4', 'video/webm']
);

describe('describing this browser', () => {
  it('reports what the platform actually says it can decode', () => {
    const capabilities = detectClientCapabilities(SAFARI_LIKE);
    expect(capabilities.videoCodecs.map((entry) => entry.codec)).toEqual(['h264', 'hevc']);
    expect(capabilities.audioCodecs).toContain('ac3');
    expect(capabilities.containers).toContain('mp4');
  });

  it('claims surround only when a surround codec decodes', () => {
    expect(detectClientCapabilities(SAFARI_LIKE).maxAudioChannels).toBe(8);
    expect(detectClientCapabilities(CHROME_LIKE).maxAudioChannels).toBe(2);
  });

  it('never declares that it supports nothing', () => {
    // An empty list would read as "supports nothing" and transcode forever.
    const silent = detectClientCapabilities({});
    expect(silent.containers).toEqual(['mp4']);
    expect(silent.videoCodecs).toEqual([{ codec: 'h264' }]);
    expect(silent.audioCodecs).toEqual(['aac']);
  });

  it('takes its resolution ceiling from the screen', () => {
    expect(detectClientCapabilities({ screenHeight: 2160 }).maxHeight).toBe(2160);
    // Never below a sane floor, however small the reported screen.
    expect(detectClientCapabilities({ screenHeight: 200 }).maxHeight).toBe(720);
  });

  it('claims HDR only when the display reports it', () => {
    expect(detectClientCapabilities({ hdr: true }).hdr).toBe(true);
    expect(detectClientCapabilities({}).hdr).toBe(false);
  });
});

describe('the declaration the server receives', () => {
  it('survives the round trip intact', () => {
    const declared = detectClientCapabilities(SAFARI_LIKE);
    const query = capabilitiesQuery(declared);
    const parsed = parseClientCapabilities(
      JSON.parse(decodeURIComponent(query.replace('capabilities=', '')))
    );

    expect(parsed.audioCodecs).toEqual(declared.audioCodecs);
    expect(parsed.maxAudioChannels).toBe(declared.maxAudioChannels);
    expect(parsed.videoCodecs.map((entry) => entry.codec))
      .toEqual(declared.videoCodecs.map((entry) => entry.codec));
  });

  it('lets a capable browser direct play what a limited one cannot', () => {
    const source = {
      container: 'mp4', videoCodec: 'hevc', height: 2160,
      audioCodec: 'eac3', audioChannels: 6
    };

    const capable = parseClientCapabilities(detectClientCapabilities(SAFARI_LIKE));
    const limited = parseClientCapabilities(detectClientCapabilities(CHROME_LIKE));

    expect(planPlayback({ source, capabilities: capable }).method).toBe('direct');
    expect(planPlayback({ source, capabilities: limited }).method).toBe('transcode');
  });

  it('is more generous than the assumed profile it replaces', () => {
    const declared = parseClientCapabilities(detectClientCapabilities(CHROME_LIKE));
    expect(declared.maxHeight).toBeGreaterThan(CLIENT_PROFILES.unknown!.maxHeight);
  });

  it('appends to a URL with the right separator', () => {
    const declared = detectClientCapabilities(CHROME_LIKE);
    expect(withCapabilities('/api/x', declared)).toContain('/api/x?capabilities=');
    expect(withCapabilities('/api/x?a=1', declared)).toContain('&capabilities=');
  });

  it('encodes safely for a query string', () => {
    const query = capabilitiesQuery(detectClientCapabilities(CHROME_LIKE));
    expect(query).not.toContain('{');
    expect(query).not.toContain('"');
  });
});

describe('asking the decoder that will actually play the stream', () => {
  const globalWindow = globalThis as unknown as { window?: unknown };

  function withFakeWindow(isTypeSupported: (type: string) => boolean, run: () => void) {
    const previous = globalWindow.window;
    globalWindow.window = {
      MediaSource: { isTypeSupported },
      matchMedia: () => ({ matches: false }),
      screen: { height: 1080 },
      devicePixelRatio: 1
    };
    try {
      run();
    } finally {
      if (previous === undefined) delete globalWindow.window;
      else globalWindow.window = previous;
    }
  }

  const video = {
    // A browser that plays HEVC from a file but refuses it through Media
    // Source Extensions is the case that produces a black screen.
    canPlayType: (type: string) => (type.includes('hvc1') ? 'probably' : ''),
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
  } as any;

  it('believes only Media Source when the stream goes through hls.js', () => {
    withFakeWindow((type) => type.includes('avc1'), () => {
      const probe = browserCapabilityProbe(video, 'mse');
      const declared = detectClientCapabilities(probe);
      expect(declared.videoCodecs.map((entry) => entry.codec)).not.toContain('hevc');
    });
  });

  it('believes the element itself when the browser plays the playlist', () => {
    withFakeWindow((type) => type.includes('avc1'), () => {
      const probe = browserCapabilityProbe(video, 'native');
      const declared = detectClientCapabilities(probe);
      expect(declared.videoCodecs.map((entry) => entry.codec)).toContain('hevc');
    });
  });
});
