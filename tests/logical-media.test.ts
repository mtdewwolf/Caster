import { beforeEach, describe, expect, it } from 'bun:test';
import { Database } from 'bun:sqlite';
import { runDatabaseMigrations } from '../apps/server/src/db/migrations';
import { TitleStore } from '../apps/server/src/db/title-store';
import {
  normalizeName,
  showIdFor,
  titleIdentityFor,
  versionLabelFor
} from '../apps/server/src/db/logical-media';
import { seriesSubjectId } from '../apps/server/src/db/metadata-store';

describe('logical identity', () => {
  it('folds punctuation and case out of a name', () => {
    expect(normalizeName('Blade.Runner.2049')).toBe('blade runner 2049');
    expect(normalizeName("The Devil's Advocate")).toBe('the devils advocate');
    expect(normalizeName('  Spaced   Out  ')).toBe('spaced out');
  });

  it('gives two spellings of the same film one identity', () => {
    const a = titleIdentityFor({ libraryId: 'lib', type: 'movie', title: 'Blade Runner 2049', year: 2017 });
    const b = titleIdentityFor({ libraryId: 'lib', type: 'movie', title: 'Blade.Runner.2049', year: 2017 });
    expect(a!.id).toBe(b!.id);
  });

  it('keeps a remake separate from the original', () => {
    const original = titleIdentityFor({ libraryId: 'lib', type: 'movie', title: 'Dune', year: 1984 });
    const remake = titleIdentityFor({ libraryId: 'lib', type: 'movie', title: 'Dune', year: 2021 });
    expect(original!.id).not.toBe(remake!.id);
  });

  it('keeps the same film in two libraries separate', () => {
    const a = titleIdentityFor({ libraryId: 'lib-a', type: 'movie', title: 'Dune', year: 2021 });
    const b = titleIdentityFor({ libraryId: 'lib-b', type: 'movie', title: 'Dune', year: 2021 });
    expect(a!.id).not.toBe(b!.id);
  });

  it('identifies an episode by its show, season and number', () => {
    const identity = titleIdentityFor({
      libraryId: 'lib', type: 'episode', title: 'Pilot',
      seriesTitle: 'Example Show', seasonNumber: 1, episodeNumber: 1
    })!;

    expect(identity.showId).toBe(showIdFor('lib', 'Example Show'));
    expect(identity.seasonNumber).toBe(1);
    // The episode title varies between releases; the numbering does not.
    const renamed = titleIdentityFor({
      libraryId: 'lib', type: 'episode', title: 'Pilot (Extended)',
      seriesTitle: 'Example Show', seasonNumber: 1, episodeNumber: 1
    })!;
    expect(renamed.id).toBe(identity.id);
  });

  it('refuses to guess an identity it cannot derive', () => {
    expect(titleIdentityFor({ libraryId: 'lib', type: 'track', title: 'Song' })).toBeNull();
    expect(titleIdentityFor({ libraryId: 'lib', type: 'episode', title: 'Orphan' })).toBeNull();
    expect(titleIdentityFor({ libraryId: 'lib', type: 'movie', title: '   ' })).toBeNull();
  });

  it('uses one derivation for shows and series metadata', () => {
    // If these ever diverge, series metadata silently points at nothing.
    expect(seriesSubjectId('lib', 'Example Show')).toBe(showIdFor('lib', 'Example Show'));
  });

  it('labels a version by what makes it different', () => {
    expect(versionLabelFor({
      resolution_label: '4K', is_hdr: true, video_codec: 'hevc',
      audio_channel_layout: '5.1', format: 'mkv'
    })).toBe('4K · HDR · HEVC · 5.1 · MKV');
    expect(versionLabelFor({})).toBe('Original');
  });
});

describe('titles and versions', () => {
  let database: Database;
  let store: TitleStore;

  function insertMedia(id: string, over: Record<string, any> = {}) {
    const now = '2026-01-01T00:00:00.000Z';
    const row = {
      library_id: 'lib', title: 'Dune', type: 'movie', year: 2021,
      height: 1080, bit_rate: 8_000_000, resolution_label: '1080p',
      video_codec: 'h264', format: 'mkv', is_hdr: 0, duration: 9000, size_bytes: 1000,
      ...over
    };
    database.run(`
      INSERT INTO media_items (
        id, library_id, title, original_filename, relative_path, full_path, type, year,
        duration, size_bytes, format, video_codec, height, bit_rate, resolution_label,
        is_hdr, streams_json, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, '[]', ?, ?)
    `, [
      id, row.library_id, row.title, `${id}.mkv`, `${id}.mkv`, `/media/${id}.mkv`,
      row.type, row.year, row.duration, row.size_bytes, row.format, row.video_codec,
      row.height, row.bit_rate, row.resolution_label, row.is_hdr, now, now
    ]);
    return row;
  }

  const link = (id: string, over: Record<string, any> = {}) =>
    store.linkMedia(id, {
      libraryId: 'lib', type: 'movie', title: 'Dune', year: 2021, ...over
    });

  beforeEach(() => {
    database = new Database(':memory:');
    runDatabaseMigrations(database);
    database.run(
      `INSERT INTO libraries (id, name, path, type, created_at) VALUES ('lib', 'Lib', '/media', 'movie', '2026-01-01T00:00:00.000Z')`
    );
    store = new TitleStore(database);
  });

  it('groups two files of the same film under one title', () => {
    insertMedia('uhd', { height: 2160, resolution_label: '4K', bit_rate: 60_000_000, is_hdr: 1 });
    insertMedia('hd');
    const first = link('uhd')!;
    const second = link('hd')!;

    expect(first.id).toBe(second.id);
    expect(store.getTitle(first.id)!.versionCount).toBe(2);
  });

  it('offers the highest-fidelity version first', () => {
    insertMedia('hd');
    insertMedia('uhd', { height: 2160, resolution_label: '4K', bit_rate: 60_000_000, is_hdr: 1 });
    link('hd');
    link('uhd');

    const versions = store.getVersionsForMedia('hd');
    expect(versions.map((version) => version.mediaId)).toEqual(['uhd', 'hd']);
    expect(versions[0]).toMatchObject({ isPreferred: true, resolutionLabel: '4K', isHdr: true });
    expect(versions[1]!.isPreferred).toBe(false);
  });

  it('reports a lone file as a single version, not as no versions', () => {
    insertMedia('only');
    link('only');
    expect(store.getVersionsForMedia('only')).toHaveLength(1);
  });

  it('creates the show behind an episode', () => {
    insertMedia('ep', { type: 'episode', title: 'Pilot' });
    const identity = store.linkMedia('ep', {
      libraryId: 'lib', type: 'episode', title: 'Pilot',
      seriesTitle: 'Example Show', seasonNumber: 1, episodeNumber: 1
    })!;

    const show = database.query('SELECT id, name FROM shows WHERE id = ?').get(identity.showId!) as any;
    expect(show).toEqual({ id: showIdFor('lib', 'Example Show'), name: 'Example Show' });
  });

  it('is idempotent across rescans', () => {
    insertMedia('uhd');
    link('uhd');
    link('uhd');
    link('uhd');

    const count = database.query('SELECT COUNT(*) AS count FROM titles').get() as { count: number };
    expect(count.count).toBe(1);
  });

  it('leaves music without a title rather than inventing one', () => {
    insertMedia('song', { type: 'track', title: 'Song' });
    expect(store.linkMedia('song', { libraryId: 'lib', type: 'track', title: 'Song' })).toBeNull();
    expect(store.titleIdForMedia('song')).toBeNull();
  });

  it('normalises streams out of the JSON blob', () => {
    insertMedia('uhd');
    store.replaceStreams('uhd', [
      { index: 0, codec_type: 'video', codec_name: 'hevc', width: 3840, height: 2160 },
      { index: 1, codec_type: 'audio', codec_name: 'truehd', channels: 8, language: 'eng' },
      { index: 2, codec_type: 'subtitle', codec_name: 'hdmv_pgs_subtitle', is_forced: true },
      { codec_type: 'audio' }
    ]);

    const streams = store.getStreams('uhd');
    // The malformed entry with no index is dropped rather than stored broken.
    expect(streams).toHaveLength(3);
    expect(streams[1]).toMatchObject({ codecType: 'audio', channels: 8, language: 'eng' });
    expect(streams[2]!.isForced).toBe(true);
  });

  it('replaces streams rather than accumulating them', () => {
    insertMedia('uhd');
    store.replaceStreams('uhd', [{ index: 0, codec_type: 'video', codec_name: 'h264' }]);
    store.replaceStreams('uhd', [{ index: 0, codec_type: 'video', codec_name: 'hevc' }]);

    const streams = store.getStreams('uhd');
    expect(streams).toHaveLength(1);
    expect(streams[0]!.codecName).toBe('hevc');
  });

  it('removes titles nothing points at any more', () => {
    insertMedia('uhd');
    const identity = link('uhd')!;
    database.run('PRAGMA foreign_keys = ON');
    database.run('DELETE FROM media_items WHERE id = ?', ['uhd']);

    expect(store.pruneEmpty().titles).toBe(1);
    expect(store.getTitle(identity.id)).toBeNull();
  });
});
