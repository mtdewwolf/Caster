import { describe, expect, it } from 'bun:test';
import {
  isImageSubtitle,
  planSubtitles,
  subtitleBurnInFilter,
  subtitleCacheKey,
  subtitleKind,
  summarizeSubtitleTracks
} from '../apps/server/src/transcoder/subtitles';

const streams = [
  { index: 0, codec_type: 'video', codec_name: 'h264' },
  { index: 1, codec_type: 'audio', codec_name: 'ac3' },
  { index: 2, codec_type: 'subtitle', codec_name: 'subrip', language: 'eng' },
  { index: 3, codec_type: 'subtitle', codec_name: 'hdmv_pgs_subtitle', language: 'eng' },
  { index: 4, codec_type: 'subtitle', codec_name: 'dvd_subtitle', language: 'fra' },
  { index: 1000, codec_type: 'subtitle', codec_name: 'srt', language: 'deu', is_external: true }
];

const tracks = summarizeSubtitleTracks(streams);

describe('subtitle classification', () => {
  it('recognises Blu-ray and DVD subtitles as images', () => {
    expect(isImageSubtitle('hdmv_pgs_subtitle')).toBe(true);
    expect(isImageSubtitle('dvd_subtitle')).toBe(true);
    expect(isImageSubtitle('dvb_subtitle')).toBe(true);
  });

  it('recognises the usual text formats', () => {
    expect(subtitleKind('subrip')).toBe('text');
    expect(subtitleKind('ass')).toBe('text');
    expect(subtitleKind('mov_text')).toBe('text');
  });

  it('is case-insensitive and tolerates whitespace', () => {
    expect(isImageSubtitle('  HDMV_PGS_SUBTITLE ')).toBe(true);
  });

  it('does not guess about a codec it has never seen', () => {
    expect(subtitleKind('some_future_codec')).toBe('unknown');
    expect(isImageSubtitle('some_future_codec')).toBe(false);
    expect(subtitleKind(undefined)).toBe('unknown');
  });

  it('summarises only the subtitle streams', () => {
    expect(tracks.map((track) => track.index)).toEqual([2, 3, 4, 1000]);
  });

  it('flags exactly the tracks that need burning in', () => {
    expect(tracks.filter((track) => track.requiresBurnIn).map((track) => track.index))
      .toEqual([3, 4]);
  });

  it('never asks to burn in an external sidecar', () => {
    const external = summarizeSubtitleTracks([
      { index: 1000, codec_type: 'subtitle', codec_name: 'hdmv_pgs_subtitle', is_external: true }
    ]);
    expect(external[0]!.requiresBurnIn).toBe(false);
  });
});

describe('subtitle planning', () => {
  it('does nothing when no track is selected', () => {
    expect(planSubtitles({ tracks })).toEqual({ action: 'none' });
  });

  it('does nothing for a text track the player can render itself', () => {
    expect(planSubtitles({ streamIndex: 2, tracks })).toEqual({ action: 'none' });
  });

  it('burns in a selected image track', () => {
    expect(planSubtitles({ streamIndex: 3, tracks }))
      .toEqual({ action: 'burn-in', streamIndex: 3 });
  });

  it('ignores a selection that matches no track', () => {
    expect(planSubtitles({ streamIndex: 99, tracks })).toEqual({ action: 'none' });
  });

  it('gives a burned-in stream its own cache identity', () => {
    const none = subtitleCacheKey({ action: 'none' });
    const burned = subtitleCacheKey({ action: 'burn-in', streamIndex: 3 });
    const other = subtitleCacheKey({ action: 'burn-in', streamIndex: 4 });

    expect(none).not.toBe(burned);
    expect(burned).not.toBe(other);
  });

  it('composites the subtitle over the scaled picture', () => {
    const filter = subtitleBurnInFilter(3, 'scale=640:360');
    expect(filter).toBe('[0:v]scale=640:360[scaled];[scaled][0:3]overlay[vout]');
  });

  it('still produces a valid chain with no scaling', () => {
    expect(subtitleBurnInFilter(3, '')).toBe('[0:v][0:3]overlay[vout]');
  });
});
