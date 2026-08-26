/**
 * Audio stream planning for transcoded output.
 *
 * The engine used to hardcode `-c:a aac -ac 2`, which downmixed every 5.1 and
 * 7.1 track to stereo no matter what the client could play. This decides per
 * request instead: keep the original stream when the client can take it,
 * re-encode to a surround codec when it cannot take the source codec but can
 * take the channels, and only downmix when there is no other option.
 *
 * Nothing here calls FFmpeg — it returns the argument list, so the decision is
 * testable without spawning anything.
 */

export type AudioMode = 'stereo' | 'surround' | 'auto';

export const AUDIO_MODES: readonly AudioMode[] = ['stereo', 'surround', 'auto'];

export function isAudioMode(value: unknown): value is AudioMode {
  return typeof value === 'string' && (AUDIO_MODES as readonly string[]).includes(value);
}

export interface AudioSourceInfo {
  codec?: string | undefined;
  channels?: number | undefined;
  streamIndex?: number | undefined;
}

export interface AudioPlanRequest {
  /** What the client says it can handle. Unknown clients get `stereo`. */
  mode: AudioMode;
  /** Fallback bitrate for a stereo encode, from the quality profile. */
  stereoBitrate: string;
}

export type AudioAction = 'copy' | 'transcode';

export interface AudioPlan {
  action: AudioAction;
  codec: string;
  channels: number;
  bitrate?: string;
  /** Which input stream to map, when the caller selected a specific track. */
  sourceStreamIndex?: number;
  /** Stable, human-readable explanation for diagnostics and cache identity. */
  reason:
    | 'source-passthrough'
    | 'surround-transcode'
    | 'stereo-downmix'
    | 'stereo-transcode';
}

/** Codecs an MPEG-TS segment can carry untouched. */
const TS_COPYABLE_CODECS = new Set(['aac', 'ac3', 'eac3', 'mp3', 'mp2']);

/** Codecs that carry more than two channels on the widest range of clients. */
const SURROUND_CODEC = 'ac3';

/** Bitrate for a surround encode, scaled by channel count. */
function surroundBitrate(channels: number): string {
  if (channels >= 8) return '768k';
  if (channels >= 6) return '640k';
  return '384k';
}

function normalizeCodec(codec: string | undefined): string {
  return (codec ?? '').trim().toLowerCase();
}

function normalizeChannels(channels: number | undefined): number {
  return Number.isFinite(channels) && (channels as number) > 0
    ? Math.floor(channels as number)
    : 2;
}

export function planAudioStream(
  source: AudioSourceInfo,
  request: AudioPlanRequest
): AudioPlan {
  const selected = source.streamIndex !== undefined && Number.isSafeInteger(source.streamIndex)
    ? { sourceStreamIndex: source.streamIndex }
    : {};
  const codec = normalizeCodec(source.codec);
  const channels = normalizeChannels(source.channels);
  const wantsSurround = request.mode === 'surround' || request.mode === 'auto';

  // Stereo or mono sources have nothing to preserve, so copy when the codec
  // already fits the container and re-encode otherwise.
  if (channels <= 2) {
    return TS_COPYABLE_CODECS.has(codec)
      ? { ...selected, action: 'copy', codec, channels, reason: 'source-passthrough' }
      : {
          ...selected,
          action: 'transcode',
          codec: 'aac',
          channels,
          bitrate: request.stereoBitrate,
          reason: 'stereo-transcode'
        };
  }

  // A client that has not said it handles surround gets a deliberate downmix
  // rather than a stream it may not be able to decode.
  if (!wantsSurround) {
    return {
      ...selected,
      action: 'transcode',
      codec: 'aac',
      channels: 2,
      bitrate: request.stereoBitrate,
      reason: 'stereo-downmix'
    };
  }

  if (TS_COPYABLE_CODECS.has(codec)) {
    return { ...selected, action: 'copy', codec, channels, reason: 'source-passthrough' };
  }

  return {
    ...selected,
    action: 'transcode',
    codec: SURROUND_CODEC,
    channels,
    bitrate: surroundBitrate(channels),
    reason: 'surround-transcode'
  };
}

/** FFmpeg output arguments for a plan. */
export function audioArgsFor(plan: AudioPlan): string[] {
  if (plan.action === 'copy') return ['-c:a', 'copy'];

  const args = ['-c:a', plan.codec, '-ac', String(plan.channels)];
  if (plan.bitrate) args.push('-b:a', plan.bitrate);
  return args;
}

/**
 * Cache-identity fragment for a plan.
 *
 * A stereo segment and a surround segment of the same media at the same quality
 * are different bytes, so the audio decision has to be part of the cache key.
 * Without this a surround client would be served whatever the first stereo
 * viewer caused to be written.
 */
export function audioCacheKey(plan: AudioPlan): string {
  const track = plan.sourceStreamIndex !== undefined ? `t${plan.sourceStreamIndex}` : 'td';
  return plan.action === 'copy'
    ? `copy-${plan.codec || 'src'}-${plan.channels}-${track}`
    : `${plan.codec}-${plan.channels}-${track}`;
}
