/**
 * Describing this browser to the server.
 *
 * The server decides whether a file can play as-is, be repackaged, or must be
 * re-encoded — but it can only do that if it knows what this end supports.
 * Everything here is measured with the browser's own codec checks rather than
 * sniffed from the user agent, so a browser that gains a codec is believed
 * without Caster shipping an update.
 */

export const CLIENT_CAPABILITY_VERSION = 1 as const;

export interface DeclaredCapabilities {
  version: typeof CLIENT_CAPABILITY_VERSION;
  containers: string[];
  videoCodecs: Array<{ codec: string; maxLevel?: number }>;
  audioCodecs: string[];
  maxAudioChannels: number;
  maxHeight: number;
  hdr: boolean;
  subtitleCodecs: string[];
}

export interface CapabilityProbe {
  canPlayType?: (type: string) => string;
  isTypeSupported?: (type: string) => boolean;
  /** Screen height in physical pixels, used as the resolution ceiling. */
  screenHeight?: number;
  /** True when the display reports a wide colour gamut. */
  hdr?: boolean;
}

const CONTAINER_TYPES: Array<[string, string]> = [
  ['mp4', 'video/mp4'],
  ['webm', 'video/webm'],
  ['ts', 'video/mp2t; codecs="avc1.42E01E"'],
  ['mov', 'video/quicktime']
];

const VIDEO_TYPES: Array<[string, string]> = [
  ['h264', 'video/mp4; codecs="avc1.640028"'],
  ['hevc', 'video/mp4; codecs="hvc1.1.6.L93.B0"'],
  ['vp9', 'video/webm; codecs="vp9"'],
  ['av1', 'video/mp4; codecs="av01.0.05M.08"']
];

const AUDIO_TYPES: Array<[string, string]> = [
  ['aac', 'audio/mp4; codecs="mp4a.40.2"'],
  ['ac3', 'audio/mp4; codecs="ac-3"'],
  ['eac3', 'audio/mp4; codecs="ec-3"'],
  ['opus', 'audio/webm; codecs="opus"'],
  ['vorbis', 'audio/webm; codecs="vorbis"'],
  ['mp3', 'audio/mpeg'],
  ['flac', 'audio/mp4; codecs="flac"']
];

/** True only when the platform gives a positive answer. */
export function supportsType(probe: CapabilityProbe, type: string): boolean {
  const native = probe.canPlayType?.(type);
  if (native) return true;
  return probe.isTypeSupported?.(type) === true;
}

export function detectClientCapabilities(probe: CapabilityProbe): DeclaredCapabilities {
  const containers = CONTAINER_TYPES
    .filter(([, type]) => supportsType(probe, type))
    .map(([name]) => name);

  const videoCodecs = VIDEO_TYPES
    .filter(([, type]) => supportsType(probe, type))
    .map(([codec]) => ({ codec }));

  const audioCodecs = AUDIO_TYPES
    .filter(([, type]) => supportsType(probe, type))
    .map(([codec]) => codec);

  // A browser that can decode a surround codec is the only reliable signal
  // that surround will actually come out; channel counts are not exposed.
  const surroundCapable = audioCodecs.includes('ac3') || audioCodecs.includes('eac3');

  return {
    version: CLIENT_CAPABILITY_VERSION,
    // Never send an empty list: the server would read it as "supports nothing"
    // rather than "could not tell", and transcode everything forever.
    containers: containers.length > 0 ? containers : ['mp4'],
    videoCodecs: videoCodecs.length > 0 ? videoCodecs : [{ codec: 'h264' }],
    audioCodecs: audioCodecs.length > 0 ? audioCodecs : ['aac'],
    maxAudioChannels: surroundCapable ? 8 : 2,
    maxHeight: Math.max(720, probe.screenHeight ?? 1080),
    hdr: probe.hdr === true,
    subtitleCodecs: ['subrip', 'srt', 'webvtt', 'ass', 'ssa', 'mov_text']
  };
}

/**
 * Which decoder actually plays the stream.
 *
 * The two answers differ. A browser can report that it plays HEVC in a plain
 * file and still refuse it through Media Source Extensions, which is the path
 * hls.js uses — so asking the wrong one produces a stream the player accepts
 * and then shows as a black screen.
 */
export type PlaybackPipeline = 'any' | 'native' | 'mse';

/** Builds the probe from the live browser environment. */
export function browserCapabilityProbe(
  video: HTMLVideoElement | null,
  pipeline: PlaybackPipeline = 'any'
): CapabilityProbe {
  const mediaSource = typeof window !== 'undefined'
    ? (window as unknown as { MediaSource?: { isTypeSupported?: (type: string) => boolean } }).MediaSource
    : undefined;

  const hdr = typeof window !== 'undefined' && typeof window.matchMedia === 'function'
    ? window.matchMedia('(dynamic-range: high)').matches
    : false;

  const useNative = pipeline !== 'mse';
  const useMediaSource = pipeline !== 'native';

  return {
    ...(video && useNative ? { canPlayType: (type: string) => video.canPlayType(type) } : {}),
    ...(useMediaSource && mediaSource?.isTypeSupported
      ? { isTypeSupported: (type: string) => mediaSource.isTypeSupported!(type) }
      : {}),
    ...(typeof window !== 'undefined' && window.screen
      ? { screenHeight: Math.round(window.screen.height * (window.devicePixelRatio || 1)) }
      : {}),
    hdr
  };
}

/** Query fragment carrying the declaration to the server. */
export function capabilitiesQuery(capabilities: DeclaredCapabilities): string {
  return `capabilities=${encodeURIComponent(JSON.stringify(capabilities))}`;
}

export function withCapabilities(url: string, capabilities: DeclaredCapabilities): string {
  const separator = url.includes('?') ? '&' : '?';
  return `${url}${separator}${capabilitiesQuery(capabilities)}`;
}
