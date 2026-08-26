/**
 * What a client can actually play.
 *
 * Caster used to decide this in the browser with a manual Direct Play / HLS
 * toggle, which meant the server had no idea what the other end could handle
 * and every device got the same treatment. A capability set is what lets the
 * server answer "can this play as-is?" per device instead of guessing.
 *
 * The shape is versioned because native clients will send it over the wire: a
 * future breaking change lives alongside v1 rather than silently changing what
 * an old client's declaration means.
 */

export const CLIENT_CAPABILITY_VERSION = 1 as const;

export interface VideoCodecSupport {
  codec: string;
  /** Highest profile the client decodes, e.g. "high" or "main10". */
  maxProfile?: string | undefined;
  /** Highest level × 10, matching FFprobe's convention (4.1 → 41). */
  maxLevel?: number | undefined;
}

export interface ClientCapabilities {
  version: typeof CLIENT_CAPABILITY_VERSION;
  /** Container formats the client can demux. */
  containers: readonly string[];
  videoCodecs: readonly VideoCodecSupport[];
  audioCodecs: readonly string[];
  maxAudioChannels: number;
  maxHeight: number;
  /** Bits per second the connection can sustain, if the client measured it. */
  maxBitrate?: number | undefined;
  hdr: boolean;
  /** Subtitle codecs the client renders itself. */
  subtitleCodecs: readonly string[];
  /** True when this came from a device that did not describe itself. */
  assumed?: boolean | undefined;
}

const TEXT_SUBTITLES = ['subrip', 'srt', 'webvtt', 'ass', 'ssa', 'mov_text'] as const;

function profile(
  overrides: Partial<ClientCapabilities> & Pick<ClientCapabilities, 'containers' | 'videoCodecs' | 'audioCodecs'>
): ClientCapabilities {
  return {
    version: CLIENT_CAPABILITY_VERSION,
    maxAudioChannels: 2,
    maxHeight: 1080,
    hdr: false,
    subtitleCodecs: TEXT_SUBTITLES,
    ...overrides
  };
}

/**
 * Representative device profiles.
 *
 * These are starting points a client can send verbatim or adjust. They are
 * deliberately on the cautious side of what each platform claims: a wrong
 * "yes" means a black screen, a wrong "no" costs some CPU.
 */
export const CLIENT_PROFILES: Record<string, ClientCapabilities> = {
  chrome: profile({
    containers: ['mp4', 'webm', 'ts'],
    videoCodecs: [
      { codec: 'h264', maxProfile: 'high', maxLevel: 52 },
      { codec: 'vp9' },
      { codec: 'av1' }
    ],
    audioCodecs: ['aac', 'opus', 'vorbis', 'mp3', 'flac'],
    maxAudioChannels: 2,
    maxHeight: 2160
  }),

  safari: profile({
    containers: ['mp4', 'mov', 'ts'],
    videoCodecs: [
      { codec: 'h264', maxProfile: 'high', maxLevel: 52 },
      { codec: 'hevc', maxProfile: 'main10' }
    ],
    // Safari is the browser that reliably passes surround through.
    audioCodecs: ['aac', 'ac3', 'eac3', 'mp3', 'alac'],
    maxAudioChannels: 8,
    maxHeight: 2160,
    hdr: true
  }),

  firefox: profile({
    containers: ['mp4', 'webm'],
    videoCodecs: [{ codec: 'h264', maxProfile: 'high', maxLevel: 51 }, { codec: 'vp9' }],
    audioCodecs: ['aac', 'opus', 'vorbis', 'mp3', 'flac'],
    maxHeight: 2160
  }),

  'tv-generic': profile({
    containers: ['mp4', 'mkv', 'ts'],
    videoCodecs: [
      { codec: 'h264', maxProfile: 'high', maxLevel: 51 },
      { codec: 'hevc', maxProfile: 'main10' }
    ],
    audioCodecs: ['aac', 'ac3', 'eac3'],
    maxAudioChannels: 6,
    maxHeight: 2160,
    hdr: true
  }),

  /**
   * A device that told us nothing.
   *
   * Everything here is what essentially any player from the last decade
   * handles. The cost of being wrong in this direction is a transcode; the cost
   * of guessing generously is media that will not play at all.
   */
  unknown: profile({
    containers: ['mp4'],
    videoCodecs: [{ codec: 'h264', maxProfile: 'main', maxLevel: 41 }],
    audioCodecs: ['aac'],
    maxAudioChannels: 2,
    maxHeight: 1080,
    assumed: true
  })
};

export const DEFAULT_PROFILE_NAME = 'unknown';

export function profileByName(name: string | undefined): ClientCapabilities {
  const key = (name ?? '').trim().toLowerCase();
  return CLIENT_PROFILES[key] ?? CLIENT_PROFILES[DEFAULT_PROFILE_NAME]!;
}

function stringList(value: unknown, fallback: readonly string[]): readonly string[] {
  if (!Array.isArray(value)) return fallback;
  const items = value.filter((entry): entry is string => typeof entry === 'string' && entry.trim() !== '');
  return items.length > 0 ? items.map((entry) => entry.trim().toLowerCase()) : fallback;
}

function positiveNumber(value: unknown, fallback: number): number {
  return typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : fallback;
}

/**
 * Reads a client's own declaration, falling back to a profile field by field.
 *
 * A malformed or partial declaration degrades to the conservative default
 * rather than being rejected — a client that gets one field wrong should still
 * get playback, just less optimally.
 */
export function parseClientCapabilities(
  input: unknown,
  base: ClientCapabilities = CLIENT_PROFILES[DEFAULT_PROFILE_NAME]!
): ClientCapabilities {
  if (!input || typeof input !== 'object' || Array.isArray(input)) return base;
  const declared = input as Record<string, unknown>;

  if (declared.version !== undefined && declared.version !== CLIENT_CAPABILITY_VERSION) {
    // An unrecognised contract version is not trusted at all.
    return base;
  }

  const videoCodecs = Array.isArray(declared.videoCodecs)
    ? declared.videoCodecs
        .filter((entry): entry is Record<string, unknown> => Boolean(entry) && typeof entry === 'object')
        .map((entry) => ({
          codec: String(entry.codec ?? '').trim().toLowerCase(),
          maxProfile: typeof entry.maxProfile === 'string' ? entry.maxProfile.toLowerCase() : undefined,
          maxLevel: typeof entry.maxLevel === 'number' ? entry.maxLevel : undefined
        }))
        .filter((entry) => entry.codec !== '')
    : base.videoCodecs;

  return {
    version: CLIENT_CAPABILITY_VERSION,
    containers: stringList(declared.containers, base.containers),
    videoCodecs: videoCodecs.length > 0 ? videoCodecs : base.videoCodecs,
    audioCodecs: stringList(declared.audioCodecs, base.audioCodecs),
    maxAudioChannels: positiveNumber(declared.maxAudioChannels, base.maxAudioChannels),
    maxHeight: positiveNumber(declared.maxHeight, base.maxHeight),
    maxBitrate: typeof declared.maxBitrate === 'number' && declared.maxBitrate > 0
      ? declared.maxBitrate
      : base.maxBitrate,
    hdr: typeof declared.hdr === 'boolean' ? declared.hdr : base.hdr,
    subtitleCodecs: stringList(declared.subtitleCodecs, base.subtitleCodecs),
    ...(base.assumed ? { assumed: true } : {})
  };
}

export function supportsVideoCodec(
  capabilities: ClientCapabilities,
  codec: string | undefined,
  options: { profile?: string | undefined; level?: number | undefined } = {}
): boolean {
  const wanted = (codec ?? '').trim().toLowerCase();
  if (!wanted) return false;

  const support = capabilities.videoCodecs.find((entry) => entry.codec === wanted);
  if (!support) return false;

  // A level the client cannot decode is a hard no, even for a codec it knows.
  if (support.maxLevel !== undefined && options.level !== undefined && options.level > support.maxLevel) {
    return false;
  }
  return true;
}

export function supportsAudioCodec(
  capabilities: ClientCapabilities,
  codec: string | undefined
): boolean {
  const wanted = (codec ?? '').trim().toLowerCase();
  return wanted !== '' && capabilities.audioCodecs.includes(wanted);
}

export function supportsContainer(
  capabilities: ClientCapabilities,
  container: string | undefined
): boolean {
  const wanted = (container ?? '').trim().toLowerCase();
  return wanted !== '' && capabilities.containers.includes(wanted);
}
