/**
 * Which subtitle tracks the browser can render on its own.
 *
 * Text subtitles become a WebVTT `<track>` the player styles itself. Image
 * subtitles — Blu-ray PGS, DVD VobSub, broadcast DVB — are pictures with no
 * text to extract, so they can only appear if the server draws them onto the
 * video. The list mirrors the server's; both sides have to agree or a viewer
 * ends up with a subtitle track that renders nothing.
 */

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

export function isImageSubtitle(codecName: string | undefined): boolean {
  return IMAGE_SUBTITLE_CODECS.has((codecName ?? '').trim().toLowerCase());
}
