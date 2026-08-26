import {
  supportsAudioCodec,
  supportsContainer,
  supportsVideoCodec,
  type ClientCapabilities
} from './capabilities';

/**
 * Deciding how a file reaches a player.
 *
 * Three outcomes, cheapest first. **Direct play** sends the file untouched.
 * **Remux** repackages the same streams into a container the client can open —
 * no re-encoding, so it costs almost nothing. **Transcode** re-encodes, which
 * is the expensive path and should only happen when something genuinely cannot
 * be played as-is.
 *
 * Every decision carries reason codes, so the player can say *why* rather than
 * showing a bare "HLS" badge, and so a support question has an answer.
 */

export type PlaybackMethod = 'direct' | 'remux' | 'transcode';
export type StreamAction = 'copy' | 'transcode';

export type PlaybackReason =
  | 'container-supported'
  | 'container-unsupported'
  | 'video-supported'
  | 'video-codec-unsupported'
  | 'video-level-unsupported'
  | 'video-resolution-too-high'
  | 'video-bitrate-too-high'
  | 'audio-supported'
  | 'audio-codec-unsupported'
  | 'audio-channels-too-many'
  | 'hdr-tone-map-required'
  | 'subtitle-burn-in-required'
  | 'client-capabilities-assumed';

export interface PlaybackSource {
  container?: string | undefined;
  videoCodec?: string | undefined;
  videoProfile?: string | undefined;
  videoLevel?: number | undefined;
  height?: number | undefined;
  bitRate?: number | undefined;
  isHdr?: boolean | undefined;
  audioCodec?: string | undefined;
  audioChannels?: number | undefined;
}

export interface PlaybackPlanRequest {
  source: PlaybackSource;
  capabilities: ClientCapabilities;
  /** True when an image subtitle was selected and must be drawn on. */
  burnInSubtitle?: boolean | undefined;
}

export interface PlaybackPlan {
  method: PlaybackMethod;
  videoAction: StreamAction;
  audioAction: StreamAction;
  /** Whether HDR must be flattened for this client. */
  toneMap: boolean;
  reasons: PlaybackReason[];
}

/** Plain-language explanation of each reason, for the player. */
const REASON_TEXT: Record<PlaybackReason, string> = {
  'container-supported': 'your device can open this file type',
  'container-unsupported': 'your device cannot open this file type',
  'video-supported': 'your device can play this video',
  'video-codec-unsupported': 'your device cannot play this video format',
  'video-level-unsupported': 'this video is more demanding than your device supports',
  'video-resolution-too-high': 'this video is higher resolution than your device supports',
  'video-bitrate-too-high': 'this video is too high quality for the current connection',
  'audio-supported': 'your device can play this audio',
  'audio-codec-unsupported': 'your device cannot play this audio format',
  'audio-channels-too-many': 'this audio has more channels than your device supports',
  'hdr-tone-map-required': 'HDR is being converted for a screen that cannot show it',
  'subtitle-burn-in-required': 'the selected subtitles have to be drawn onto the picture',
  'client-capabilities-assumed': 'your device did not say what it supports, so safe settings were used'
};

export function planPlayback(request: PlaybackPlanRequest): PlaybackPlan {
  const { source, capabilities } = request;
  const reasons: PlaybackReason[] = [];

  if (capabilities.assumed) reasons.push('client-capabilities-assumed');

  // ---- video ----
  let videoAction: StreamAction = 'copy';
  const codecSupported = supportsVideoCodec(capabilities, source.videoCodec, {
    profile: source.videoProfile,
    level: source.videoLevel
  });

  if (!codecSupported) {
    videoAction = 'transcode';
    // Distinguish "wrong codec" from "right codec, too demanding" — they lead
    // to different advice for someone trying to fix it.
    const known = capabilities.videoCodecs.some(
      (entry) => entry.codec === (source.videoCodec ?? '').trim().toLowerCase()
    );
    reasons.push(known ? 'video-level-unsupported' : 'video-codec-unsupported');
  }

  if (source.height !== undefined && source.height > capabilities.maxHeight) {
    videoAction = 'transcode';
    reasons.push('video-resolution-too-high');
  }

  if (
    capabilities.maxBitrate !== undefined &&
    source.bitRate !== undefined &&
    source.bitRate > capabilities.maxBitrate
  ) {
    videoAction = 'transcode';
    reasons.push('video-bitrate-too-high');
  }

  const toneMap = Boolean(source.isHdr) && !capabilities.hdr;
  if (toneMap) {
    videoAction = 'transcode';
    reasons.push('hdr-tone-map-required');
  }

  if (request.burnInSubtitle) {
    videoAction = 'transcode';
    reasons.push('subtitle-burn-in-required');
  }

  if (videoAction === 'copy') reasons.push('video-supported');

  // ---- audio ----
  let audioAction: StreamAction = 'copy';
  if (!supportsAudioCodec(capabilities, source.audioCodec)) {
    audioAction = 'transcode';
    reasons.push('audio-codec-unsupported');
  } else if (
    source.audioChannels !== undefined &&
    source.audioChannels > capabilities.maxAudioChannels
  ) {
    audioAction = 'transcode';
    reasons.push('audio-channels-too-many');
  } else {
    reasons.push('audio-supported');
  }

  // ---- container ----
  const containerSupported = supportsContainer(capabilities, source.container);
  reasons.push(containerSupported ? 'container-supported' : 'container-unsupported');

  // Re-encoding anything means the output container is ours to choose, so the
  // container question only decides between direct play and a remux.
  const method: PlaybackMethod = videoAction === 'transcode' || audioAction === 'transcode'
    ? 'transcode'
    : containerSupported ? 'direct' : 'remux';

  return { method, videoAction, audioAction, toneMap, reasons };
}

/** One sentence a person can act on. */
export function describePlaybackPlan(plan: PlaybackPlan): string {
  const causes = plan.reasons
    .filter((reason) => !reason.endsWith('-supported'))
    .filter((reason) => reason !== 'client-capabilities-assumed')
    .map((reason) => REASON_TEXT[reason]);

  if (plan.method === 'direct') {
    return 'Playing the original file directly.';
  }

  if (plan.method === 'remux') {
    return 'Repackaging the original video and audio for your device — no quality is lost.';
  }

  if (causes.length === 0) {
    return 'Converting this video for your device.';
  }

  const [first, ...rest] = causes;
  const detail = rest.length > 0
    ? `${first}, and ${rest.length === 1 ? rest[0] : `${rest.length} other reasons`}`
    : first;

  return `Converting because ${detail}.`;
}

export function reasonText(reason: PlaybackReason): string {
  return REASON_TEXT[reason];
}
