/**
 * Subtitle delivery planning.
 *
 * Text subtitles (SRT, ASS, MOV_TEXT) convert cleanly to WebVTT and ride
 * alongside the video as a separate track the player styles itself. Image
 * subtitles — PGS from Blu-ray, VobSub from DVD, DVB from broadcast — are
 * pictures, not text: there is nothing to convert, so the only way to show them
 * is to draw them onto the video during encoding.
 *
 * That difference matters to the caller, because burning in forces a transcode
 * on media that might otherwise have direct played. This decides which path a
 * track takes and returns the FFmpeg arguments, without calling FFmpeg.
 */

/** Subtitle codecs that are bitmap images rather than text. */
const IMAGE_SUBTITLE_CODECS = new Set([
  'hdmv_pgs_subtitle',
  'pgssub',
  'dvd_subtitle',
  'dvdsub',
  'vobsub',
  'dvb_subtitle',
  'dvbsub',
  'xsub'
]);

/** Subtitle codecs that convert to WebVTT. */
const TEXT_SUBTITLE_CODECS = new Set([
  'subrip', 'srt', 'ass', 'ssa', 'mov_text', 'webvtt', 'text', 'eia_608', 'subviewer'
]);

export type SubtitleKind = 'text' | 'image' | 'unknown';

export function subtitleKind(codecName: string | undefined): SubtitleKind {
  const codec = (codecName ?? '').trim().toLowerCase();
  if (!codec) return 'unknown';
  if (IMAGE_SUBTITLE_CODECS.has(codec)) return 'image';
  if (TEXT_SUBTITLE_CODECS.has(codec)) return 'text';
  return 'unknown';
}

export function isImageSubtitle(codecName: string | undefined): boolean {
  return subtitleKind(codecName) === 'image';
}

export interface SubtitleTrackInfo {
  index: number;
  codec_type?: string;
  codec_name?: string;
  language?: string | undefined;
  title?: string | undefined;
  is_external?: boolean | undefined;
}

export interface SubtitleTrackSummary {
  index: number;
  codecName: string;
  kind: SubtitleKind;
  language?: string | undefined;
  title?: string | undefined;
  isExternal: boolean;
  /** True when showing this track means drawing it onto the video. */
  requiresBurnIn: boolean;
}

export function summarizeSubtitleTracks(
  streams: readonly SubtitleTrackInfo[]
): SubtitleTrackSummary[] {
  return streams
    .filter((stream) => stream.codec_type === 'subtitle')
    .map((stream) => {
      const kind = subtitleKind(stream.codec_name);
      return {
        index: stream.index,
        codecName: (stream.codec_name ?? '').toLowerCase(),
        kind,
        language: stream.language,
        title: stream.title,
        isExternal: stream.is_external === true,
        // External sidecars are always text files, whatever the embedded
        // tracks look like.
        requiresBurnIn: kind === 'image' && stream.is_external !== true
      };
    });
}

export type SubtitlePlan =
  /** Nothing selected, or a text track the player renders itself. */
  | { action: 'none' }
  /** Draw this track's images onto the video during encoding. */
  | { action: 'burn-in'; streamIndex: number };

export interface SubtitleSelection {
  /** Selected subtitle stream index, or undefined for none. */
  streamIndex?: number | undefined;
  tracks: readonly SubtitleTrackSummary[];
}

export function planSubtitles(selection: SubtitleSelection): SubtitlePlan {
  if (selection.streamIndex === undefined) return { action: 'none' };

  const track = selection.tracks.find((candidate) => candidate.index === selection.streamIndex);
  if (!track || !track.requiresBurnIn) return { action: 'none' };

  return { action: 'burn-in', streamIndex: track.index };
}

/**
 * FFmpeg arguments that draw an image subtitle onto the video.
 *
 * `overlay` composites the subtitle picture over the decoded frame. This has to
 * run before any hardware upload, so a burn-in falls back to CPU scaling — the
 * caller passes the video filter it would otherwise have used and gets one
 * combined chain back.
 */
export function subtitleBurnInFilter(streamIndex: number, videoFilter: string): string {
  const scaled = videoFilter ? `[0:v]${videoFilter}[scaled];[scaled]` : '[0:v]';
  return `${scaled}[0:${streamIndex}]overlay[vout]`;
}

/** Cache-identity fragment, so a burned-in stream is never served as a plain one. */
export function subtitleCacheKey(plan: SubtitlePlan): string {
  return plan.action === 'burn-in' ? `sub${plan.streamIndex}` : 'nosub';
}
