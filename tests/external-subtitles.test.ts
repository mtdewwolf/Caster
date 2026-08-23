import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { convertSrtToVtt, findExternalSubtitles } from '../apps/server/src/scanner/subtitles';
import { initDatabase, LibraryModel, MediaModel } from '../apps/server/src/db';
import { apiRouter } from '../apps/server/src/routes/api';
import { scanLibrary } from '../apps/server/src/scanner/indexer';

const SAMPLE_SRT = [
  '\uFEFF1',
  '00:00:01,000 --> 00:00:04,500',
  'Hello <i>world</i>!',
  '',
  '2',
  '00:01:12,250 --> 00:01:15,000',
  'Second cue.',
  ''
].join('\r\n');

describe('External subtitles (.srt sidecars)', () => {
  let fixtureRoot: string;

  beforeAll(() => {
    initDatabase();
    fixtureRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'caster-external-subs-'));
    fs.writeFileSync(path.join(fixtureRoot, 'Sample.Movie.2020.mkv'), 'fixture');
    fs.writeFileSync(path.join(fixtureRoot, 'Sample.Movie.2020.srt'), SAMPLE_SRT);
    fs.writeFileSync(path.join(fixtureRoot, 'Sample.Movie.2020.en.srt'), SAMPLE_SRT);
    fs.writeFileSync(path.join(fixtureRoot, 'Sample.Movie.2020.forced.srt'), SAMPLE_SRT);
    fs.writeFileSync(path.join(fixtureRoot, 'Unrelated.srt'), SAMPLE_SRT);
    fs.writeFileSync(path.join(fixtureRoot, 'Sample.Movies.srt'), SAMPLE_SRT);
  });

  afterAll(() => {
    const expectedPrefix = path.join(os.tmpdir(), 'caster-external-subs-');
    if (fixtureRoot.startsWith(expectedPrefix)) {
      fs.rmSync(fixtureRoot, { recursive: true, force: true });
    }
  });

  describe('convertSrtToVtt', () => {
    it('prepares a valid WebVTT document from SRT input', () => {
      const vtt = convertSrtToVtt(SAMPLE_SRT);
      expect(vtt.startsWith('WEBVTT\n\n')).toBe(true);
      expect(vtt).toContain('00:00:01.000 --> 00:00:04.500');
      expect(vtt).toContain('00:01:12.250 --> 00:01:15.000');
      expect(vtt).toContain('Hello <i>world</i>!');
      expect(vtt).not.toContain('\uFEFF');
      expect(vtt).not.toContain('\r');
      expect(vtt).not.toMatch(/\d{2}:\d{2}:\d{2},\d{3}/);
    });

    it('keeps an existing WEBVTT header intact', () => {
      const vtt = convertSrtToVtt('WEBVTT\n\n00:00:01,000 --> 00:00:02,000\nHi\n');
      expect(vtt.match(/WEBVTT/g)?.length).toBe(1);
    });
  });

  describe('findExternalSubtitles', () => {
    it('matches exact stems and tagged siblings, skipping unrelated files', () => {
      const found = findExternalSubtitles(path.join(fixtureRoot, 'Sample.Movie.2020.mkv'));
      expect(found.map((f) => f.filename)).toEqual([
        'Sample.Movie.2020.en.srt',
        'Sample.Movie.2020.forced.srt',
        'Sample.Movie.2020.srt'
      ]);
      expect(found[0].language).toBe('en');
      expect(found[1].language).toBeUndefined();
      expect(found[2].language).toBeUndefined();
    });
  });

  describe('scan indexing & subtitles route', () => {
    let libraryId: string;
    let itemId: string;

    beforeAll(async () => {
      libraryId = `test_lib_subs_${Date.now()}`;
      LibraryModel.create({
        id: libraryId,
        name: 'Subs Test',
        path: fixtureRoot,
        type: 'movies',
        created_at: new Date().toISOString()
      });
      await scanLibrary(libraryId);

      const { items } = MediaModel.getAll({ libraryId });
      expect(items.length).toBe(1);
      itemId = items[0].id;
    });

    afterAll(() => {
      LibraryModel.delete(libraryId);
    });

    it('appends external tracks to streams_json with synthetic indexes', () => {
      const item = MediaModel.getById(itemId)!;
      const streams = JSON.parse(item.streams_json);
      const subs = streams.filter((s: any) => s.codec_type === 'subtitle');

      expect(subs.length).toBe(3);
      expect(subs.map((s: any) => s.index)).toEqual([1000, 1001, 1002]);
      expect(subs.every((s: any) => s.is_external === true && s.codec_name === 'srt')).toBe(true);
      expect(subs.find((s: any) => s.language === 'en')).toBeDefined();
    });

    it('serves an external sidecar as WebVTT via the subtitles route', async () => {
      const response = await apiRouter.request(`/media/${itemId}/subtitles/1001`);
      expect(response.status).toBe(200);
      expect(response.headers.get('Content-Type')).toContain('text/vtt');

      const body = await response.text();
      expect(body.startsWith('WEBVTT')).toBe(true);
      expect(body).toContain('00:00:01.000 --> 00:00:04.500');
    });

    it('returns 404 when the indexed sidecar file is gone', async () => {
      const item = MediaModel.getById(itemId)!;
      const streams = JSON.parse(item.streams_json);
      const orphanIndex = streams.filter((s: any) => s.codec_type === 'subtitle')[0].index;
      const target = findExternalSubtitles(item.full_path)[orphanIndex - 1000];
      fs.renameSync(target.path, `${target.path}.bak`);

      try {
        const response = await apiRouter.request(`/media/${itemId}/subtitles/${orphanIndex}`);
        expect(response.status).toBe(404);
      } finally {
        fs.renameSync(`${target.path}.bak`, target.path);
      }
    });
  });
});
