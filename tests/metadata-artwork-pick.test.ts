import { describe, expect, it } from 'bun:test';
import { pickArtwork } from '../apps/web/src/components/MetadataPanel';
import type { MediaMetadata, MetadataArtwork } from '../apps/web/src/types';

function metadataWith(artwork: MetadataArtwork[]): MediaMetadata {
  return {
    subject: { type: 'media', id: 'm1' },
    providerId: 'fixture', externalId: 'e1',
    title: null, originalTitle: null, overview: null, tagline: null,
    releaseDate: null, genres: [], studios: [], networks: [],
    rating: null, contentRating: null, cast: [], crew: [], externalIds: [],
    matchConfidence: null, matchSource: 'provider', locked: false,
    refreshedAt: '2026-01-01T00:00:00.000Z',
    artwork
  };
}

const art = (kind: string, url: string, width: number | null = null): MetadataArtwork =>
  ({ providerId: 'fixture', kind, url, width, height: null, language: null });

describe('artwork selection', () => {
  it('returns nothing when there is no metadata', () => {
    expect(pickArtwork(null, 'poster')).toBeNull();
  });

  it('returns nothing when no artwork of that kind exists', () => {
    expect(pickArtwork(metadataWith([art('poster', 'p.jpg')]), 'backdrop')).toBeNull();
  });

  it('prefers the widest image of the requested kind', () => {
    const metadata = metadataWith([
      art('backdrop', 'small.jpg', 780),
      art('backdrop', 'large.jpg', 1920),
      art('backdrop', 'medium.jpg', 1280)
    ]);
    expect(pickArtwork(metadata, 'backdrop')).toBe('large.jpg');
  });

  it('does not mix kinds when choosing', () => {
    const metadata = metadataWith([
      art('poster', 'poster.jpg', 2000),
      art('backdrop', 'backdrop.jpg', 1280)
    ]);
    expect(pickArtwork(metadata, 'backdrop')).toBe('backdrop.jpg');
  });

  it('still returns an image when no width is reported', () => {
    expect(pickArtwork(metadataWith([art('poster', 'only.jpg')]), 'poster')).toBe('only.jpg');
  });
});
