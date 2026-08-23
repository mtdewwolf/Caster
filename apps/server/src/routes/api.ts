import { Hono } from 'hono';
import fs from 'fs';
import os from 'os';
import path from 'path';
import crypto from 'crypto';
import { ExternalSubtitleModel, LibraryModel, MediaModel, ProgressModel, SeriesModel } from '../db';
import { scanAllLibraries, scanLibrary, scanStatus } from '../scanner/indexer';
import { convertSrtToVtt } from '../scanner/subtitles';
import { transcoder } from '../transcoder/engine';
import type { HardwareAccelType, TranscodeQuality } from '../types';

export const apiRouter = new Hono();

const VIDEO_EXTENSIONS = new Set([
  '.mp4', '.mkv', '.mov', '.avi', '.webm', '.ts', '.m4v', '.flv', '.wmv', '.iso'
]);
const AUDIO_EXTENSIONS = new Set([
  '.mp3', '.flac', '.aac', '.m4a', '.wav', '.ogg', '.opus', '.wma', '.alac'
]);
const SKIP_DIRECTORY_NAMES = new Set([
  'node_modules',
  '@eaDir',
  '#recycle',
  '$RECYCLE.BIN',
  'System Volume Information',
  'lost+found',
  '.snapshots',
  '.git',
  'Windows',
  'Program Files',
  'Program Files (x86)',
  'ProgramData',
  'AppData'
]);
const SUGGEST_SCAN_DEPTH = 3;
const SUGGEST_MAX_DIRECTORIES = 800;
const SUGGEST_MAX_RESULTS = 24;

type LibraryType = 'movies' | 'tv' | 'music' | 'home_videos';

interface FilesystemEntry {
  name: string;
  path: string;
  hasMedia: boolean;
}

interface FolderSuggestion {
  path: string;
  name: string;
  type: LibraryType;
  mediaFileCount: number;
  alreadyAdded: boolean;
}

function isMediaFile(fileName: string): boolean {
  const extension = path.extname(fileName).toLowerCase();
  return VIDEO_EXTENSIONS.has(extension) || AUDIO_EXTENSIONS.has(extension);
}

function shouldSkipDirectory(name: string): boolean {
  return name.startsWith('.') || SKIP_DIRECTORY_NAMES.has(name);
}

function safeReadDirectory(directoryPath: string): fs.Dirent[] | null {
  try {
    return fs.readdirSync(directoryPath, { withFileTypes: true });
  } catch {
    return null;
  }
}

function normalizeExistingDirectory(requestedPath: string): string | null {
  try {
    const resolved = path.resolve(requestedPath);
    return fs.statSync(resolved).isDirectory() ? resolved : null;
  } catch {
    return null;
  }
}

function listDriveRoots(): string[] {
  if (process.platform !== 'win32') return ['/'];

  const drives: string[] = [];
  for (let charCode = 65; charCode <= 90; charCode += 1) {
    const drive = `${String.fromCharCode(charCode)}:\\`;
    try {
      if (fs.statSync(drive).isDirectory()) drives.push(drive);
    } catch {
      // Missing and inaccessible drives are intentionally omitted.
    }
  }
  return drives;
}

function directoryHasMedia(directoryPath: string): boolean {
  const entries = safeReadDirectory(directoryPath);
  return entries?.some((entry) => entry.isFile() && isMediaFile(entry.name)) ?? false;
}

function getSuggestionRoots(): string[] {
  const candidates = process.platform === 'win32'
    ? listDriveRoots()
    : [
        '/media',
        '/mnt',
        '/data',
        '/srv',
        '/volume1',
        '/volume2',
        path.join(os.homedir(), 'Movies'),
        path.join(os.homedir(), 'TV'),
        path.join(os.homedir(), 'Music'),
        path.join(os.homedir(), 'Videos')
      ];

  const roots = new Set<string>();
  for (const candidate of candidates) {
    const normalized = normalizeExistingDirectory(candidate);
    if (normalized) roots.add(normalized);
  }
  return [...roots];
}

function looksLikeEpisode(fileName: string): boolean {
  return /s\d{1,2}\s?[._ -]?e\d{1,3}/i.test(fileName) || /\d{1,2}x\d{2}\b/i.test(fileName);
}

function detectLibraryType(mediaFiles: string[]): LibraryType {
  let audioCount = 0;
  let videoCount = 0;
  let episodeCount = 0;

  for (const fileName of mediaFiles) {
    const extension = path.extname(fileName).toLowerCase();
    if (AUDIO_EXTENSIONS.has(extension)) audioCount += 1;
    if (VIDEO_EXTENSIONS.has(extension)) videoCount += 1;
    if (looksLikeEpisode(fileName)) episodeCount += 1;
  }

  if (audioCount > videoCount) return 'music';
  if (episodeCount > 0) return 'tv';
  return 'movies';
}

function collectFolderSuggestions(): FolderSuggestion[] {
  const existingLibraries = LibraryModel.getAll().map((library) => path.resolve(library.path));
  const pathMatches = (left: string, right: string) => process.platform === 'win32'
    ? left.toLowerCase() === right.toLowerCase()
    : left === right;

  const queue = getSuggestionRoots().map((directoryPath) => ({ directoryPath, depth: 0 }));
  const visited = new Set<string>();
  const found = new Map<string, { count: number; samples: string[] }>();
  let scannedDirectories = 0;

  while (queue.length > 0 && scannedDirectories < SUGGEST_MAX_DIRECTORIES) {
    const next = queue.shift()!;
    const directoryPath = path.resolve(next.directoryPath);
    if (visited.has(directoryPath)) continue;
    visited.add(directoryPath);
    scannedDirectories += 1;

    const entries = safeReadDirectory(directoryPath);
    if (!entries) continue;

    const mediaFiles: string[] = [];
    for (const entry of entries) {
      if (entry.isDirectory() && !shouldSkipDirectory(entry.name)) {
        if (next.depth < SUGGEST_SCAN_DEPTH) {
          queue.push({ directoryPath: path.join(directoryPath, entry.name), depth: next.depth + 1 });
        }
      } else if (entry.isFile() && isMediaFile(entry.name)) {
        mediaFiles.push(entry.name);
      }
    }

    if (mediaFiles.length > 0) {
      found.set(directoryPath, {
        count: mediaFiles.length,
        samples: mediaFiles.slice(0, 12)
      });
    }
  }

  return [...found.entries()]
    .map(([directoryPath, media]) => ({
      path: directoryPath,
      name: path.basename(directoryPath) || directoryPath,
      type: detectLibraryType(media.samples),
      mediaFileCount: media.count,
      alreadyAdded: existingLibraries.some((libraryPath) => pathMatches(libraryPath, directoryPath))
    }))
    .sort((left, right) => right.mediaFileCount - left.mediaFileCount || left.name.localeCompare(right.name))
    .slice(0, SUGGEST_MAX_RESULTS);
}

// ---------------- Filesystem Browser API ---------------- //

apiRouter.get('/fs/browse', (c) => {
  const requestedPath = c.req.query('path');

  if (!requestedPath?.trim()) {
    const entries: FilesystemEntry[] = listDriveRoots().map((root) => ({
      name: root,
      path: root,
      hasMedia: false
    }));

    if (process.platform !== 'win32') {
      for (const directoryPath of getSuggestionRoots()) {
        if (entries.some((entry) => entry.path === directoryPath)) continue;
        entries.push({
          name: path.basename(directoryPath) || directoryPath,
          path: directoryPath,
          hasMedia: directoryHasMedia(directoryPath)
        });
      }
    }

    return c.json({ isRoot: true, current: '', parent: null, entries });
  }

  const current = normalizeExistingDirectory(requestedPath);
  if (!current) {
    return c.json({ error: 'Path not found or not accessible' }, 404);
  }

  const directoryEntries = safeReadDirectory(current);
  if (!directoryEntries) {
    return c.json({ error: 'Path not found or not accessible' }, 404);
  }

  const entries: FilesystemEntry[] = directoryEntries
    .filter((entry) => entry.isDirectory() && !shouldSkipDirectory(entry.name))
    .map((entry) => {
      const entryPath = path.join(current, entry.name);
      return {
        name: entry.name,
        path: entryPath,
        hasMedia: directoryHasMedia(entryPath)
      };
    })
    .sort((left, right) => left.name.localeCompare(right.name));
  const parent = path.dirname(current);

  return c.json({
    isRoot: false,
    current,
    parent: parent === current ? null : parent,
    entries
  });
});

apiRouter.get('/fs/suggest', (c) => {
  try {
    return c.json({ suggestions: collectFolderSuggestions() });
  } catch (error) {
    console.error('Failed to suggest media folders:', error);
    return c.json({ suggestions: [] });
  }
});

// ---------------- Libraries API ---------------- //

apiRouter.get('/libraries', (c) => {
  const libraries = LibraryModel.getAll();
  return c.json({ libraries });
});

apiRouter.post('/libraries', async (c) => {
  const body = await c.req.json();
  const { name, path: dirPath, type } = body;

  if (!name || !dirPath || !type) {
    return c.json({ error: 'Missing name, path, or type' }, 400);
  }

  const id = `lib_${crypto.randomBytes(4).toString('hex')}`;
  const now = new Date().toISOString();

  const lib = LibraryModel.create({
    id,
    name,
    path: dirPath,
    type,
    created_at: now
  });

  // Automatically start scan in background
  scanLibrary(id).catch(console.error);

  return c.json({ library: lib });
});

apiRouter.delete('/libraries/:id', (c) => {
  const id = c.req.param('id');
  LibraryModel.delete(id);
  return c.json({ success: true });
});

apiRouter.post('/libraries/:id/scan', async (c) => {
  const id = c.req.param('id');
  try {
    // Run scan in background
    scanLibrary(id).catch(console.error);
    return c.json({ status: 'started', libraryId: id });
  } catch (err: any) {
    return c.json({ error: err.message }, 400);
  }
});

apiRouter.post('/libraries/scan-all', (c) => {
  scanAllLibraries().catch(console.error);
  return c.json({ status: 'started' });
});

apiRouter.get('/libraries/scan/status', (c) => {
  return c.json(scanStatus);
});

// ---------------- Media Items API ---------------- //

apiRouter.get('/media', (c) => {
  const query = c.req.query();
  const libraryId = query.libraryId;
  const type = query.type;
  const search = query.search;
  const resolution = query.resolution;
  const sort = query.sort;
  const limit = query.limit ? parseInt(query.limit, 10) : 50;
  const offset = query.offset ? parseInt(query.offset, 10) : 0;

  const result = MediaModel.getAll({
    libraryId,
    type,
    search,
    resolution,
    sort,
    limit,
    offset
  });

  return c.json(result);
});

apiRouter.get('/media/continue-watching', (c) => {
  const items = MediaModel.getContinueWatching(12);
  return c.json({ items });
});

// ---------------- Progress Page API ---------------- //

apiRouter.get('/media/progress', (c) => {
  const status = c.req.query('status');
  const limit = c.req.query('limit') ? parseInt(c.req.query('limit'), 10) : 200;
  const items = MediaModel.getProgressItems({ status, limit });
  return c.json({ items });
});

apiRouter.post('/media/:id/progress/watched', (c) => {
  const id = c.req.param('id');
  const item = MediaModel.getById(id);
  if (!item) {
    return c.json({ error: 'Media not found' }, 404);
  }
  const progress = ProgressModel.markWatched(id);
  return c.json({ progress });
});

apiRouter.post('/media/:id/progress/unwatched', (c) => {
  const id = c.req.param('id');
  ProgressModel.remove(id);
  return c.json({ success: true });
});

apiRouter.delete('/media/:id/progress', (c) => {
  const id = c.req.param('id');
  ProgressModel.remove(id);
  return c.json({ success: true });
});

apiRouter.get('/media/:id', (c) => {
  const id = c.req.param('id');
  const item = MediaModel.getById(id);
  if (!item) {
    return c.json({ error: 'Media not found' }, 404);
  }
  return c.json({ item });
});

// ---------------- Series Rollup API ---------------- //

apiRouter.get('/series', (c) => {
  const libraryId = c.req.query('libraryId');
  const search = c.req.query('search');
  const items = SeriesModel.getAll({ libraryId, search });
  return c.json({ items });
});

apiRouter.get('/series/:id', (c) => {
  const id = c.req.param('id');
  const series = SeriesModel.getById(id);
  if (!series) {
    return c.json({ error: 'Series not found' }, 404);
  }
  const seasons = SeriesModel.getSeasons(series.library_id, series.title);
  return c.json({ series, seasons });
});

apiRouter.get('/series/:id/episodes', (c) => {
  const id = c.req.param('id');
  const series = SeriesModel.getById(id);
  if (!series) {
    return c.json({ error: 'Series not found' }, 404);
  }
  const items = MediaModel.getBySeries(series.library_id, series.title);
  return c.json({ series, items });
});

// ---------------- Direct Play Streaming (HTTP Range 206) ---------------- //

apiRouter.get('/media/:id/stream', async (c) => {
  const id = c.req.param('id');
  const item = MediaModel.getById(id);
  if (!item || !fs.existsSync(item.full_path)) {
    return c.text('Media file not found', 404);
  }

  const stat = fs.statSync(item.full_path);
  const fileSize = stat.size;
  const range = c.req.header('range');

  const contentType = getMimeType(item.format);

  if (range) {
    const parts = range.replace(/bytes=/, '').split('-');
    const start = parseInt(parts[0], 10);
    const end = parts[1] ? parseInt(parts[1], 10) : fileSize - 1;
    const chunksize = end - start + 1;

    const fileStream = fs.createReadStream(item.full_path, { start, end });
    
    // Return node stream as Web ReadableStream for Hono
    const webStream = new ReadableStream({
      start(controller) {
        fileStream.on('data', (chunk) => controller.enqueue(chunk));
        fileStream.on('end', () => controller.close());
        fileStream.on('error', (err) => controller.error(err));
      },
      cancel() {
        fileStream.destroy();
      }
    });

    return new Response(webStream, {
      status: 206,
      headers: {
        'Content-Range': `bytes ${start}-${end}/${fileSize}`,
        'Accept-Ranges': 'bytes',
        'Content-Length': chunksize.toString(),
        'Content-Type': contentType
      }
    });
  } else {
    const fileStream = fs.createReadStream(item.full_path);
    const webStream = new ReadableStream({
      start(controller) {
        fileStream.on('data', (chunk) => controller.enqueue(chunk));
        fileStream.on('end', () => controller.close());
        fileStream.on('error', (err) => controller.error(err));
      },
      cancel() {
        fileStream.destroy();
      }
    });

    return new Response(webStream, {
      status: 200,
      headers: {
        'Content-Length': fileSize.toString(),
        'Accept-Ranges': 'bytes',
        'Content-Type': contentType
      }
    });
  }
});

// ---------------- HLS Dynamic Transcoding API ---------------- //

apiRouter.get('/media/:id/hls/master.m3u8', (c) => {
  const id = c.req.param('id');
  const item = MediaModel.getById(id);
  if (!item) return c.text('Not found', 404);

  const playlist = transcoder.generateMasterPlaylist(id, item.width || 1920, item.height || 1080);
  return new Response(playlist, {
    headers: {
      'Content-Type': 'application/vnd.apple.mpegurl',
      'Cache-Control': 'no-cache'
    }
  });
});

apiRouter.get('/media/:id/hls/:quality/index.m3u8', (c) => {
  const id = c.req.param('id');
  const quality = c.req.param('quality') as TranscodeQuality;
  const item = MediaModel.getById(id);
  if (!item) return c.text('Not found', 404);

  const playlist = transcoder.generateVariantPlaylist(id, item.duration || 3600, quality);
  return new Response(playlist, {
    headers: {
      'Content-Type': 'application/vnd.apple.mpegurl',
      'Cache-Control': 'no-cache'
    }
  });
});

apiRouter.get('/media/:id/hls/:quality/:segment', async (c) => {
  const id = c.req.param('id');
  const quality = c.req.param('quality') as TranscodeQuality;
  const segmentFile = c.req.param('segment'); // e.g. "segment-0.ts"

  const seqMatch = segmentFile.match(/segment-(\d+)\.ts/);
  if (!seqMatch) {
    return c.text('Invalid segment name', 400);
  }

  const seq = parseInt(seqMatch[1], 10);
  const item = MediaModel.getById(id);
  if (!item || !fs.existsSync(item.full_path)) {
    return c.text('Media not found', 404);
  }

    try {
      const chunkBuffer = await transcoder.getHlsSegment(item.full_path, id, quality, seq);
      return new Response(new Uint8Array(chunkBuffer), {
      headers: {
        'Content-Type': 'video/mp2t',
        'Cache-Control': 'public, max-age=86400'
      }
    });
  } catch (err: any) {
    console.error('Error generating HLS segment:', err);
    return c.text('Segment transcode failed', 500);
  }
});

// ---------------- Thumbnails & Subtitles ---------------- //

apiRouter.get('/media/:id/thumbnail', (c) => {
  const id = c.req.param('id');
  const thumbPath = path.join(process.cwd(), 'data', 'thumbnails', `${id}.jpg`);

  if (fs.existsSync(thumbPath)) {
    const file = Bun.file(thumbPath);
    return new Response(file, {
      headers: {
        'Content-Type': 'image/jpeg',
        'Cache-Control': 'public, max-age=604800'
      }
    });
  }

  return c.text('Thumbnail not found', 404);
});

apiRouter.get('/media/:id/subtitles/:index', async (c) => {
  const id = c.req.param('id');
  const trackIndex = parseInt(c.req.param('index'), 10);
  const item = MediaModel.getById(id);
  if (!item || !fs.existsSync(item.full_path)) {
    return c.text('Media not found', 404);
  }

  const externalTrack = ExternalSubtitleModel.getByMediaAndIndex(id, trackIndex);
  if (externalTrack) {
    if (!fs.existsSync(externalTrack.file_path)) {
      return c.text('Subtitle file not found', 404);
    }
    try {
      const srt = fs.readFileSync(externalTrack.file_path, 'utf-8');
      return new Response(convertSrtToVtt(srt), {
        headers: {
          'Content-Type': 'text/vtt; charset=utf-8',
          'Cache-Control': 'public, max-age=86400'
        }
      });
    } catch (err: any) {
      console.error(`Error reading external subtitle ${externalTrack.file_path}:`, err);
      return c.text('WEBVTT\n\n', 200, { 'Content-Type': 'text/vtt' });
    }
  }

  try {
    const vtt = await transcoder.extractSubtitlesVtt(item.full_path, trackIndex);
    return new Response(vtt, {
      headers: {
        'Content-Type': 'text/vtt; charset=utf-8',
        'Cache-Control': 'public, max-age=86400'
      }
    });
  } catch (err: any) {
    return c.text('WEBVTT\n\n', 200, { 'Content-Type': 'text/vtt' });
  }
});

// ---------------- Watch Progress Tracking ---------------- //

apiRouter.post('/media/:id/progress', async (c) => {
  const id = c.req.param('id');
  const body = await c.req.json();
  const position = parseFloat(body.position || '0');
  const duration = parseFloat(body.duration || '0');

  const progress = ProgressModel.upsert(id, position, duration);
  return c.json({ progress });
});

// ---------------- System Status & Hardware Accel ---------------- //

apiRouter.get('/system/status', (c) => {
  const hw = transcoder.getHardwareStatus();
  return c.json({
    server: 'NovaStream Personal Media Server',
    version: '1.0.0',
    platform: process.platform,
    arch: process.arch,
    uptime: process.uptime(),
    hardware: hw
  });
});

apiRouter.post('/system/hardware/accel', async (c) => {
  const body = await c.req.json();
  const accel = body.accel as HardwareAccelType;
  if (!['qsv', 'nvenc', 'vaapi', 'none'].includes(accel)) {
    return c.json({ error: 'Invalid acceleration type' }, 400);
  }
  transcoder.setPreferredAccel(accel);
  return c.json({ success: true, hardware: transcoder.getHardwareStatus() });
});

// ---------------- Transcode Cache Management API ---------------- //

apiRouter.get('/system/cache/status', (c) => {
  const status = transcoder.getCacheStatus();
  return c.json(status);
});

apiRouter.post('/system/cache/clear', async (c) => {
  let maxAgeHours: number | undefined = undefined;
  let maxSizeBytes: number | undefined = undefined;

  try {
    const body = await c.req.json().catch(() => ({}));
    if (body.maxAgeHours !== undefined) maxAgeHours = Number(body.maxAgeHours);
    if (body.maxSizeMb !== undefined) maxSizeBytes = Number(body.maxSizeMb) * 1024 * 1024;
  } catch {}

  const result = transcoder.cleanCache({ maxAgeHours, maxSizeBytes });
  return c.json({ success: true, result });
});

function getMimeType(format: string): string {
  const ext = format.toLowerCase();
  switch (ext) {
    case 'mp4':
    case 'm4v':
      return 'video/mp4';
    case 'mkv':
      return 'video/x-matroska';
    case 'webm':
      return 'video/webm';
    case 'mov':
      return 'video/quicktime';
    case 'avi':
      return 'video/x-msvideo';
    case 'ts':
      return 'video/mp2t';
    case 'mp3':
      return 'audio/mpeg';
    case 'flac':
      return 'audio/flac';
    case 'aac':
      return 'audio/aac';
    case 'm4a':
      return 'audio/mp4';
    case 'wav':
      return 'audio/wav';
    case 'ogg':
    case 'opus':
      return 'audio/ogg';
    default:
      return 'video/mp4';
  }
}
