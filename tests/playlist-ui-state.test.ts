import { describe, expect, it } from 'bun:test';
import { movePlaylistEntry, type PlaylistEntry } from '../apps/web/src/features/music/playlist-api';

function entry(id: string, position: number): PlaylistEntry {
  return {
    id,
    playlist_id: 'playlist-1',
    media_id: `media-${id}`,
    position,
    added_at: '2026-01-01T00:00:00.000Z',
    media: {
      id: `media-${id}`,
      library_id: 'music',
      title: id,
      original_filename: `${id}.mp3`,
      relative_path: `${id}.mp3`,
      type: 'track',
      duration: 100,
      size_bytes: 1,
      format: 'mp3',
      is_hdr: false,
      streams_json: '[]',
      created_at: '2026-01-01T00:00:00.000Z',
      updated_at: '2026-01-01T00:00:00.000Z'
    }
  };
}

describe('playlist UI ordering state', () => {
  it('moves an entry and rewrites dense positions without mutating input', () => {
    const original = [entry('one', 0), entry('two', 1), entry('three', 2)];
    const moved = movePlaylistEntry(original, 'two', 1);
    expect(moved.map((item) => [item.id, item.position])).toEqual([
      ['one', 0], ['three', 1], ['two', 2]
    ]);
    expect(original.map((item) => item.id)).toEqual(['one', 'two', 'three']);
  });

  it('keeps ordering at boundaries or for an unknown entry', () => {
    const original = [entry('one', 0), entry('two', 1)];
    expect(movePlaylistEntry(original, 'one', -1).map((item) => item.id)).toEqual(['one', 'two']);
    expect(movePlaylistEntry(original, 'two', 1).map((item) => item.id)).toEqual(['one', 'two']);
    expect(movePlaylistEntry(original, 'missing', 1).map((item) => item.id)).toEqual(['one', 'two']);
  });
});

