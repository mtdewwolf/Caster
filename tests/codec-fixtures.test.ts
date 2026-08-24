import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
import fs from 'fs';
import path from 'path';
import {
  MEDIA_FIXTURE_MATRIX,
  assertMediaFixtureCapabilities,
  createRuntimeMediaFixtures,
  detectMediaToolCapabilities,
  getMissingMediaFixtureCapabilities,
  parseFfmpegFilters,
  probeMediaFile,
  probeVideoPacketTimes,
  removeRuntimeMediaFixtures,
  type GeneratedMediaFixtures
} from './fixtures/media-fixtures';

const capabilities = detectMediaToolCapabilities();

describe('FFmpeg capability parsing', () => {
  it('accepts both two-flag and three-flag filter listings', () => {
    const filters = parseFfmpegFilters(`
 .. color             |->V       Generate a solid color.
... sine              |->A       Generate a sine wave.
..C anullsrc          |->A       Generate silent audio.
`);

    expect(filters).toEqual(new Set(['color', 'sine', 'anullsrc']));
  });
});

function tagValue(tags: Record<string, string> | undefined, name: string): string | undefined {
  const entry = Object.entries(tags || {}).find(([key]) => key.toLowerCase() === name.toLowerCase());
  return entry?.[1];
}

describe('Runtime codec/media fixture matrix', () => {
  let fixtures: GeneratedMediaFixtures;

  beforeAll(() => {
    assertMediaFixtureCapabilities(capabilities);
    fixtures = createRuntimeMediaFixtures(capabilities);
  }, 30_000);

  afterAll(() => {
    if (fixtures) removeRuntimeMediaFixtures(fixtures);
  });

  it('detects every required software capability explicitly', () => {
    expect(capabilities.ffmpegAvailable).toBe(true);
    expect(capabilities.ffprobeAvailable).toBe(true);
    expect(capabilities.ffmpegVersion).toMatch(/^ffmpeg version /i);
    expect(capabilities.ffprobeVersion).toMatch(/^ffprobe version /i);
    expect(getMissingMediaFixtureCapabilities(capabilities)).toEqual([]);
  });

  for (const specification of MEDIA_FIXTURE_MATRIX) {
    it(`generates and probes ${specification.description}`, () => {
      const filePath = fixtures.files[specification.id];
      const probe = probeMediaFile(filePath);
      const formatNames = probe.format.format_name.split(',');
      const duration = Number(probe.format.duration);
      const size = Number(probe.format.size);

      expect(path.dirname(filePath)).toBe(fixtures.root);
      expect(fs.existsSync(filePath)).toBe(true);
      expect(formatNames).toContain(specification.expectedFormatName);
      expect(duration).toBeGreaterThanOrEqual(1.1);
      expect(duration).toBeLessThanOrEqual(1.35);
      expect(size).toBeGreaterThan(0);
      expect(size).toBeLessThan(512 * 1024);
      expect(probe.streams).toHaveLength(specification.expectedStreams.length);

      for (const expectedStream of specification.expectedStreams) {
        const stream = probe.streams.find((candidate) => candidate.codec_type === expectedStream.codecType);
        expect(stream).toBeDefined();
        expect(stream?.codec_name).toBe(expectedStream.codecName);

        if ('width' in expectedStream) expect(stream?.width).toBe(expectedStream.width);
        if ('height' in expectedStream) expect(stream?.height).toBe(expectedStream.height);
        if ('channels' in expectedStream) expect(stream?.channels).toBe(expectedStream.channels);
        if ('channelLayout' in expectedStream) {
          expect(stream?.channel_layout?.toLowerCase()).toContain(expectedStream.channelLayout);
        }
      }
    });
  }

  it('preserves embedded subtitle metadata and a matching external sidecar', () => {
    const matroska = probeMediaFile(fixtures.files['matroska-mpeg4-ac3-surround-subs']);
    const subtitle = matroska.streams.find((stream) => stream.codec_type === 'subtitle');
    const sidecar = fs.readFileSync(fixtures.sidecarSubtitlePath, 'utf8');

    expect(subtitle?.codec_name).toBe('subrip');
    expect(tagValue(subtitle?.tags, 'language')).toBe('eng');
    expect(tagValue(subtitle?.tags, 'title')).toBe('Synthetic captions');
    expect(subtitle?.disposition?.default).toBe(1);
    expect(path.basename(fixtures.sidecarSubtitlePath)).toBe('Synthetic.Movie.2026.en.srt');
    expect(sidecar).toContain('Synthetic fixture caption.');
    expect(sidecar).toContain('Seek target caption.');
  });

  it('exposes duration, time-base, and packet timestamps usable for seeking', () => {
    const mp4Path = fixtures.files['mp4-h264-aac-stereo'];
    const probe = probeMediaFile(mp4Path);
    const video = probe.streams.find((stream) => stream.codec_type === 'video');
    const packetTimes = probeVideoPacketTimes(mp4Path, 0.5, 0.3);

    expect(Number(probe.format.start_time)).toBe(0);
    expect(Number(probe.format.duration)).toBeGreaterThanOrEqual(1.1);
    expect(video?.time_base).toMatch(/^1\/\d+$/);
    expect(video?.avg_frame_rate).toBe('10/1');
    expect(Number(video?.duration_ts)).toBeGreaterThan(0);
    expect(Number(video?.nb_frames)).toBeGreaterThanOrEqual(12);
    expect(packetTimes.length).toBeGreaterThan(0);
    expect(packetTimes.some((timestamp) => timestamp >= 0.45 && timestamp <= 0.8)).toBe(true);
  });
});
