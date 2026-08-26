import { describe, expect, it } from 'bun:test';
import { isImageSubtitle as serverIsImage } from '../apps/server/src/transcoder/subtitles';
import { isImageSubtitle as clientIsImage } from '../apps/web/src/features/playback/subtitle-capability';

const CODECS = [
  'hdmv_pgs_subtitle', 'pgssub', 'dvd_subtitle', 'dvdsub', 'vobsub',
  'dvb_subtitle', 'dvbsub', 'xsub',
  'subrip', 'srt', 'ass', 'ssa', 'mov_text', 'webvtt', 'text',
  'some_future_codec', '', '   '
];

describe('client subtitle capability', () => {
  it('agrees with the server on every codec it knows about', () => {
    // A disagreement here means a viewer selects a subtitle that renders
    // nothing: the client offers it as text while the server refuses to.
    for (const codec of CODECS) {
      expect({ codec, image: clientIsImage(codec) })
        .toEqual({ codec, image: serverIsImage(codec) });
    }
  });

  it('treats missing and malformed codec names as not-image', () => {
    expect(clientIsImage(undefined)).toBe(false);
    expect(clientIsImage('')).toBe(false);
  });

  it('is case-insensitive, matching the server', () => {
    expect(clientIsImage('HDMV_PGS_SUBTITLE')).toBe(true);
    expect(clientIsImage(' DVD_Subtitle ')).toBe(true);
  });
});
