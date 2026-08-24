import { Database } from 'bun:sqlite';
import fs from 'node:fs';
import path from 'node:path';
import { runDatabaseMigrations } from '../../apps/server/src/db/migrations';
import {
  HARBOR_MEDIA_ID,
  HARBOR_TITLE,
  MOONRISE_MEDIA_ID,
  MOONRISE_TITLE,
  SEEDED_LIBRARY_ID,
  SEEDED_LIBRARY_NAME,
  getE2ERuntimePaths
} from './constants';

const paths = getE2ERuntimePaths();
const relativeRuntimePath = path.relative(paths.playwrightRoot, paths.runtimeRoot);

if (
  relativeRuntimePath === '' ||
  relativeRuntimePath.startsWith('..') ||
  path.isAbsolute(relativeRuntimePath)
) {
  throw new Error(
    `Refusing to prepare an E2E runtime outside ${paths.playwrightRoot}: ${paths.runtimeRoot}`
  );
}

fs.rmSync(paths.runtimeRoot, { recursive: true, force: true });
for (const directory of [
  paths.dataDir,
  paths.mediaDir,
  paths.emptyLibraryDir,
  paths.thumbnailsDir,
  paths.transcodeCacheDir
]) {
  fs.mkdirSync(directory, { recursive: true });
}

const moonrisePath = path.join(paths.mediaDir, 'moonrise-test-feature.mp4');
const harborPath = path.join(paths.mediaDir, 'harbor-test-feature.webm');

// The browser suite validates the direct-stream request and player shell, not
// codec decoding. Package C owns real codec fixtures; these bytes simply make
// the seeded media paths readable by the production streaming route.
fs.writeFileSync(moonrisePath, 'Caster E2E direct-stream fixture: Moonrise\n');
fs.writeFileSync(harborPath, 'Caster E2E direct-stream fixture: Harbor\n');

const database = new Database(path.join(paths.dataDir, 'media.db'));
database.run('PRAGMA foreign_keys = ON');
runDatabaseMigrations(database);

const now = new Date('2026-01-01T00:00:00.000Z').toISOString();
database.run(
  `INSERT INTO libraries (id, name, path, type, created_at)
   VALUES (?, ?, ?, 'movies', ?)`,
  [SEEDED_LIBRARY_ID, SEEDED_LIBRARY_NAME, paths.mediaDir, now]
);

const insertMedia = database.prepare(`
  INSERT INTO media_items (
    id, library_id, title, original_filename, relative_path, full_path,
    type, year, duration, size_bytes, format, video_codec, width, height,
    resolution_label, frame_rate, bit_rate, is_hdr, audio_codec,
    audio_channels, audio_channel_layout, audio_language, streams_json,
    created_at, updated_at
  ) VALUES (
    $id, $library_id, $title, $original_filename, $relative_path, $full_path,
    'movie', $year, $duration, $size_bytes, $format, $video_codec, $width,
    $height, $resolution_label, $frame_rate, $bit_rate, 0, $audio_codec,
    2, 'stereo', 'eng', $streams_json, $created_at, $updated_at
  )
`);

function seedMedia(item: {
  id: string;
  title: string;
  filePath: string;
  year: number;
  duration: number;
  format: string;
  resolutionLabel: string;
  width: number;
  height: number;
}) {
  insertMedia.run({
    $id: item.id,
    $library_id: SEEDED_LIBRARY_ID,
    $title: item.title,
    $original_filename: path.basename(item.filePath),
    $relative_path: path.basename(item.filePath),
    $full_path: item.filePath,
    $year: item.year,
    $duration: item.duration,
    $size_bytes: fs.statSync(item.filePath).size,
    $format: item.format,
    $video_codec: 'h264',
    $width: item.width,
    $height: item.height,
    $resolution_label: item.resolutionLabel,
    $frame_rate: 24,
    $bit_rate: 800_000,
    $audio_codec: 'aac',
    $streams_json: JSON.stringify([
      {
        index: 0,
        codec_type: 'video',
        codec_name: 'h264',
        width: item.width,
        height: item.height
      },
      {
        index: 1,
        codec_type: 'audio',
        codec_name: 'aac',
        channels: 2,
        channel_layout: 'stereo',
        language: 'eng'
      }
    ]),
    $created_at: now,
    $updated_at: now
  });
}

seedMedia({
  id: MOONRISE_MEDIA_ID,
  title: MOONRISE_TITLE,
  filePath: moonrisePath,
  year: 2025,
  duration: 120,
  format: 'mp4',
  resolutionLabel: '1080p',
  width: 1920,
  height: 1080
});

seedMedia({
  id: HARBOR_MEDIA_ID,
  title: HARBOR_TITLE,
  filePath: harborPath,
  year: 2024,
  duration: 90,
  format: 'webm',
  resolutionLabel: '720p',
  width: 1280,
  height: 720
});

database.close();
