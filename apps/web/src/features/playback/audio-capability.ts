/**
 * Whether this browser can decode a multichannel stream.
 *
 * The server downmixes to stereo unless the client says otherwise, so a browser
 * that stays quiet keeps the old, always-safe behaviour. Only a positive answer
 * from the platform's own codec check opts into surround.
 */

export type AudioMode = 'stereo' | 'surround';

/** Container/codec pairs that carry surround through an HLS pipeline. */
export const SURROUND_PROBE_TYPES: readonly string[] = [
  'audio/mp4; codecs="ac-3"',
  'audio/mp4; codecs="ec-3"',
  'audio/mp2t; codecs="ac-3"'
];

export interface SurroundProbe {
  /** Native playback check, normally HTMLMediaElement.canPlayType. */
  canPlayType?: (type: string) => string;
  /** Media Source Extensions check, normally MediaSource.isTypeSupported. */
  isTypeSupported?: (type: string) => boolean;
}

export function supportsSurround(probe: SurroundProbe): boolean {
  return SURROUND_PROBE_TYPES.some((type) => {
    // canPlayType returns "probably" | "maybe" | "" — anything non-empty is a
    // yes, and an empty string is an explicit no.
    const native = probe.canPlayType?.(type);
    if (native) return true;
    return probe.isTypeSupported?.(type) === true;
  });
}

export function audioModeFor(probe: SurroundProbe): AudioMode {
  return supportsSurround(probe) ? 'surround' : 'stereo';
}

/** Builds the probe from the live browser environment. */
export function browserSurroundProbe(video: HTMLVideoElement | null): SurroundProbe {
  const mediaSource = typeof window !== 'undefined'
    ? (window as unknown as { MediaSource?: { isTypeSupported?: (type: string) => boolean } }).MediaSource
    : undefined;

  return {
    ...(video ? { canPlayType: (type: string) => video.canPlayType(type) } : {}),
    ...(mediaSource?.isTypeSupported
      ? { isTypeSupported: (type: string) => mediaSource.isTypeSupported!(type) }
      : {})
  };
}

/** Appends the audio preference to an HLS URL, leaving stereo implicit. */
export function withAudioMode(url: string, mode: AudioMode): string {
  if (mode === 'stereo') return url;
  return url.includes('?') ? `${url}&audio=${mode}` : `${url}?audio=${mode}`;
}
