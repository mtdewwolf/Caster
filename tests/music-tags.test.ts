import { describe, expect, it } from 'bun:test';
import path from 'path';
import { normalizeMusicTags } from '../apps/server/src/scanner/music-tags';

describe('music tag normalization', () => {
  it('normalizes case-insensitive ffprobe tags and fractional positions', () => {
    const tags = normalizeMusicTags({
      TITLE: '  First   Light ',
      ARTIST: 'Nova',
      'ALBUM ARTIST': 'The Novas',
      Album: 'Skyline',
      TRACKNUMBER: '03/12',
      DISC: '2/2',
      DATE: '2024-05-17',
      GENRE: 'Ambient'
    }, {
      filePath: path.join('music', 'ignored.mp3')
    });

    expect(tags).toEqual({
      title: 'First Light',
      artist: 'Nova',
      albumArtist: 'The Novas',
      album: 'Skyline',
      trackNumber: 3,
      discNumber: 2,
      genre: 'Ambient',
      year: 2024
    });
  });

  it('uses Artist/Album and numbered filename fallbacks for untagged files', () => {
    const libraryPath = path.resolve('library');
    const tags = normalizeMusicTags({}, {
      libraryPath,
      filePath: path.join(libraryPath, 'North Star', 'Night Drive', '07 - Home Again.flac')
    });

    expect(tags).toMatchObject({
      title: 'Home Again',
      artist: 'North Star',
      albumArtist: 'North Star',
      album: 'Night Drive',
      trackNumber: 7
    });
  });

  it('recognizes disc directories without treating them as album names', () => {
    const libraryPath = path.resolve('library');
    const tags = normalizeMusicTags({}, {
      libraryPath,
      filePath: path.join(libraryPath, 'Artist', 'Double Album', 'Disc 2', '01 Finale.flac')
    });

    expect(tags).toMatchObject({
      artist: 'Artist',
      albumArtist: 'Artist',
      album: 'Double Album',
      discNumber: 2,
      trackNumber: 1,
      title: 'Finale'
    });
  });

  it('does not derive metadata from a path outside the declared library', () => {
    const tags = normalizeMusicTags({}, {
      libraryPath: path.resolve('library-a'),
      filePath: path.resolve('library-b', 'Artist', 'Album', 'song.mp3'),
      fallbackTitle: 'Known title'
    });

    expect(tags).toMatchObject({
      title: 'Known title',
      artist: 'Unknown Artist',
      albumArtist: 'Unknown Artist',
      album: 'Unknown Album'
    });
  });
});

