import { Hono, type Context } from 'hono';
import fs from 'fs';
import os from 'os';
import path from 'path';
import crypto from 'crypto';
import { ExternalSubtitleModel, LibraryModel, MediaModel, ProgressModel, SeriesModel } from '../db';
import { scanAllLibraries, scanLibrary, scanStatus } from '../scanner/indexer';
import { convertSrtToVtt } from '../scanner/subtitles';
import { ensureMediaThumbnail, getThumbnailPath } from '../scanner/thumbnails';
import {
  QUALITY_PROFILES,
  TranscodeCapacityError,
  TranscodeKilledError,
  transcoder
} from '../transcoder/engine';
import type { HardwareAccelType, TranscodeQuality } from '../types';
import { getCurrentUserId } from '../auth';

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
const MEDIA_PAGE_MAX_LIMIT = 500;
const PROGRESS_PAGE_MAX_LIMIT = 1000;

type LibraryType = 'movies' | 'tv' | 'music' | 'home_videos';

const LIBRARY_TYPES = new Set<LibraryType>(['movies', 'tv', 'music', 'home_videos']);

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

interface ByteRange {
  start: number;
  end: number;
}

async function readJsonObject(c: Context): Promise<Record<string, unknown> | null> {
  try {
    const body = await c.req.json<unknown>();
    if (!body || typeof body !== 'object' || Array.isArray(body)) return null;
    return body as Record<string, unknown>;
  } catch {
    return null;
  }
}

function parseIntegerQuery(
  value: string | undefined,
  fallback: number,
  minimum: number,
  maximum: number
): number | null {
  if (value === undefined) return fallback;
  if (!/^\d+$/.test(value)) return null;

  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && parsed >= minimum && parsed <= maximum
    ? parsed
    : null;
}

function parseFiniteNumber(value: unknown): number | null {
  if (typeof value !== 'number' && typeof value !== 'string') return null;
  if (typeof value === 'string' && value.trim() === '') return null;

  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function isTranscodeQuality(value: string): value is TranscodeQuality {
  return Object.prototype.hasOwnProperty.call(QUALITY_PROFILES, value);
}

function parseByteRange(value: string, fileSize: number): ByteRange | null {
  const match = /^bytes=(\d*)-(\d*)$/.exec(value.trim());
  if (!match || (!match[1] && !match[2]) || fileSize <= 0) return null;

  if (!match[1]) {
    const suffixLength = Number(match[2]);
    if (!Number.isSafeInteger(suffixLength) || suffixLength <= 0) return null;
    return {
      start: Math.max(0, fileSize - suffixLength),
      end: fileSize - 1
    };
  }

  const start = Number(match[1]);
  const requestedEnd = match[2] ? Number(match[2]) : fileSize - 1;
  if (
    !Number.isSafeInteger(start) ||
    !Number.isSafeInteger(requestedEnd) ||
    start < 0 ||
    start >= fileSize ||
    requestedEnd < start
  ) {
    return null;
  }

  return { start, end: Math.min(requestedEnd, fileSize - 1) };
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
  const body = await readJsonObject(c);
  if (!body) {
    return c.json({ error: 'Invalid JSON body' }, 400);
  }

  const name = typeof body.name === 'string' ? body.name.trim() : '';
  const requestedPath = typeof body.path === 'string' ? body.path.trim() : '';
  const requestedType = typeof body.type === 'string' ? body.type : '';

  if (!name || !requestedPath || !requestedType) {
    return c.json({ error: 'Missing name, path, or type' }, 400);
  }
  if (!LIBRARY_TYPES.has(requestedType as LibraryType)) {
    return c.json({ error: 'Invalid library type' }, 400);
  }
  const type = requestedType as LibraryType;

  const dirPath = normalizeExistingDirectory(requestedPath);
  if (!dirPath) {
    return c.json({ error: 'Library path not found or not accessible' }, 400);
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
  void scanLibrary(id).catch(console.error);

  return c.json({ library: lib });
});

apiRouter.delete('/libraries/:id', (c) => {
  const id = c.req.param('id');
  LibraryModel.delete(id);
  return c.json({ success: true });
});

apiRouter.post('/libraries/:id/scan', (c) => {
  const id = c.req.param('id');
  if (!LibraryModel.getById(id)) {
    return c.json({ error: 'Library not found' }, 404);
  }
  if (scanStatus.isScanning) {
    return c.json({ error: 'A scan is already in progress' }, 409);
  }

  // Run scan in the background after validating all synchronous preconditions.
  void scanLibrary(id).catch((error) => console.error(`Library scan ${id} failed:`, error));
  return c.json({ status: 'started', libraryId: id });
});

apiRouter.post('/libraries/scan-all', (c) => {
  if (scanStatus.isScanning) {
    return c.json({ error: 'A scan is already in progress' }, 409);
  }

  void scanAllLibraries().catch((error) => console.error('Library scan failed:', error));
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
  const limit = parseIntegerQuery(query.limit, 50, 1, MEDIA_PAGE_MAX_LIMIT);
  const offset = parseIntegerQuery(query.offset, 0, 0, Number.MAX_SAFE_INTEGER);

  if (limit === null || offset === null) {
    return c.json(
      { error: `limit must be between 1 and ${MEDIA_PAGE_MAX_LIMIT}; offset must be a non-negative integer` },
      400
    );
  }

  const result = MediaModel.getAll(getCurrentUserId(c), {
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
  const items = MediaModel.getContinueWatching(getCurrentUserId(c), 12);
  return c.json({ items });
});

// ---------------- Progress Page API ---------------- //

apiRouter.get('/media/progress', (c) => {
  const status = c.req.query('status');
  const requestedLimit = c.req.query('limit');
  const limit = parseIntegerQuery(requestedLimit, 200, 1, PROGRESS_PAGE_MAX_LIMIT);

  if (status && status !== 'in_progress' && status !== 'completed') {
    return c.json({ error: 'status must be in_progress or completed' }, 400);
  }
  if (limit === null) {
    return c.json({ error: `limit must be between 1 and ${PROGRESS_PAGE_MAX_LIMIT}` }, 400);
  }

  const items = MediaModel.getProgressItems(getCurrentUserId(c), { status, limit });
  return c.json({ items });
});

apiRouter.post('/media/:id/progress/watched', (c) => {
  const id = c.req.param('id');
  const userId = getCurrentUserId(c);
  const item = MediaModel.getById(id, userId);
  if (!item) {
    return c.json({ error: 'Media not found' }, 404);
  }
  const progress = ProgressModel.markWatched(userId, id);
  return c.json({ progress });
});

apiRouter.post('/media/:id/progress/unwatched', (c) => {
  const id = c.req.param('id');
  ProgressModel.remove(getCurrentUserId(c), id);
  return c.json({ success: true });
});

apiRouter.delete('/media/:id/progress', (c) => {
  const id = c.req.param('id');
  ProgressModel.remove(getCurrentUserId(c), id);
  return c.json({ success: true });
});

apiRouter.get('/media/:id', (c) => {
  const id = c.req.param('id');
  const item = MediaModel.getById(id, getCurrentUserId(c));
  if (!item) {
    return c.json({ error: 'Media not found' }, 404);
  }
  return c.json({ item });
});

// ---------------- Series Rollup API ---------------- //

apiRouter.get('/series', (c) => {
  const libraryId = c.req.query('libraryId');
  const search = c.req.query('search');
  const items = SeriesModel.getAll(getCurrentUserId(c), { libraryId, search });
  return c.json({ items });
});

apiRouter.get('/series/:id', (c) => {
  const id = c.req.param('id');
  const userId = getCurrentUserId(c);
  const series = SeriesModel.getById(id, userId);
  if (!series) {
    return c.json({ error: 'Series not found' }, 404);
  }
  const seasons = SeriesModel.getSeasons(series.library_id, series.title, userId);
  return c.json({ series, seasons });
});

apiRouter.get('/series/:id/episodes', (c) => {
  const id = c.req.param('id');
  const userId = getCurrentUserId(c);
  const series = SeriesModel.getById(id, userId);
  if (!series) {
    return c.json({ error: 'Series not found' }, 404);
  }
  const items = MediaModel.getBySeries(series.library_id, series.title, userId);
  return c.json({ series, items });
});

// ---------------- Direct Play Streaming (HTTP Range 206) ---------------- //

apiRouter.get('/media/:id/stream', async (c) => {
  const id = c.req.param('id');
  const item = MediaModel.getById(id, getCurrentUserId(c));
  if (!item || !fs.existsSync(item.full_path)) {
    return c.text('Media file not found', 404);
  }

  const stat = fs.statSync(item.full_path);
  const fileSize = stat.size;
  const range = c.req.header('range');

  const contentType = getMimeType(item.format);

  if (range) {
    const parsedRange = parseByteRange(range, fileSize);
    if (!parsedRange) {
      return new Response('Requested range not satisfiable', {
        status: 416,
        headers: {
          'Content-Range': `bytes */${fileSize}`,
          'Accept-Ranges': 'bytes'
        }
      });
    }

    const { start, end } = parsedRange;
    const chunkSize = end - start + 1;

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
        'Content-Length': chunkSize.toString(),
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
  const item = MediaModel.getById(id, getCurrentUserId(c));
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
  const requestedQuality = c.req.param('quality');
  if (!isTranscodeQuality(requestedQuality)) {
    return c.text('Invalid transcode quality', 400);
  }

  const quality = requestedQuality;
  const item = MediaModel.getById(id, getCurrentUserId(c));
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
  const requestedQuality = c.req.param('quality');
  if (!isTranscodeQuality(requestedQuality)) {
    return c.text('Invalid transcode quality', 400);
  }

  const quality = requestedQuality;
  const segmentFile = c.req.param('segment'); // e.g. "segment-0.ts"

  const seqMatch = segmentFile.match(/^segment-(\d+)\.ts$/);
  if (!seqMatch) {
    return c.text('Invalid segment name', 400);
  }

  const seq = Number(seqMatch[1]);
  if (!Number.isSafeInteger(seq)) {
    return c.text('Invalid segment name', 400);
  }
  const item = MediaModel.getById(id, getCurrentUserId(c));
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
    if (err instanceof TranscodeCapacityError) {
      c.header('Retry-After', '2');
      return c.json({ error: err.message, maxConcurrentTranscodes: err.limit }, 429);
    }
    if (err instanceof TranscodeKilledError) {
      return c.json({ error: err.message }, 503);
    }
    return c.text('Segment transcode failed', 500);
  }
});

// ---------------- Thumbnails & Subtitles ---------------- //

apiRouter.get('/media/:id/thumbnail', (c) => {
  const id = c.req.param('id');
  const thumbPath = getThumbnailPath(id);

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

apiRouter.post('/media/:id/thumbnail', async (c) => {
  const id = c.req.param('id');
  const item = MediaModel.getById(id, getCurrentUserId(c));
  if (!item) {
    return c.json({ error: 'Media not found' }, 404);
  }

  const thumbnail = await ensureMediaThumbnail(item, { force: true });
  if (!thumbnail.ok) {
    if (thumbnail.reason === 'unsupported_media') {
      return c.json({ error: 'Thumbnails are not supported for this media type' }, 400);
    }
    if (thumbnail.reason === 'source_not_found') {
      return c.json({ error: 'Media file not found' }, 404);
    }
    return c.json({ error: 'Thumbnail generation failed' }, 500);
  }

  MediaModel.updatePosterPath(id, thumbnail.url);
  return c.json({ success: true, thumbnailUrl: thumbnail.url });
});

apiRouter.get('/media/:id/subtitles/:index', async (c) => {
  const id = c.req.param('id');
  const requestedTrackIndex = c.req.param('index');
  if (!/^\d+$/.test(requestedTrackIndex)) {
    return c.text('Invalid subtitle track', 400);
  }

  const trackIndex = Number(requestedTrackIndex);
  if (!Number.isSafeInteger(trackIndex)) {
    return c.text('Invalid subtitle track', 400);
  }

  const item = MediaModel.getById(id, getCurrentUserId(c));
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
      return c.text('Subtitle extraction failed', 500);
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
    console.error(`Error extracting subtitle track ${trackIndex} from media ${id}:`, err);
    return c.text('Subtitle extraction failed', 500);
  }
});

// ---------------- Watch Progress Tracking ---------------- //

apiRouter.post('/media/:id/progress', async (c) => {
  const id = c.req.param('id');
  const body = await readJsonObject(c);
  if (!body) {
    return c.json({ error: 'Invalid JSON body' }, 400);
  }

  const position = parseFiniteNumber(body.position);
  const duration = parseFiniteNumber(body.duration);
  if (position === null || duration === null || position < 0 || duration <= 0) {
    return c.json(
      { error: 'position must be non-negative and duration must be greater than zero' },
      400
    );
  }

  if (!MediaModel.getById(id, getCurrentUserId(c))) {
    return c.json({ error: 'Media not found' }, 404);
  }

  const progress = ProgressModel.upsert(
    getCurrentUserId(c),
    id,
    Math.min(position, duration),
    duration
  );
  return c.json({ progress });
});

// ---------------- System Status & Hardware Accel ---------------- //

apiRouter.get('/system/status', (c) => {
  const hw = transcoder.getHardwareStatus();
  return c.json({
    server: 'Caster Personal Media Server',
    version: '1.0.0',
    platform: process.platform,
    arch: process.arch,
    uptime: process.uptime(),
    hardware: hw
  });
});

apiRouter.get('/system/transcodes', (c) => {
  return c.json(transcoder.getTranscodeStatus());
});

apiRouter.post('/system/hardware/accel', async (c) => {
  const body = await readJsonObject(c);
  if (!body) {
    return c.json({ error: 'Invalid JSON body' }, 400);
  }

  const accel = body.accel as HardwareAccelType;
  if (!['qsv', 'nvenc', 'vaapi', 'none'].includes(accel)) {
    return c.json({ error: 'Invalid acceleration type' }, 400);
  }
  transcoder.setPreferredAccel(accel);
  return c.json({ success: true, hardware: transcoder.getHardwareStatus() });
});

// Mutating API routes are admin-authenticated by the server middleware.
apiRouter.post('/system/transcodes/kill', (c) => {
  const killed = transcoder.killAllTranscodes();
  return c.json({
    success: true,
    killed,
    transcodes: transcoder.getTranscodeStatus()
  });
});

// ---------------- Transcode Cache Management API ---------------- //

apiRouter.get('/system/cache/status', (c) => {
  const status = transcoder.getCacheStatus();
  return c.json(status);
});

apiRouter.post('/system/cache/clear', async (c) => {
  let maxAgeHours: number | undefined = undefined;
  let maxSizeBytes: number | undefined = undefined;

  const body = c.req.raw.body === null ? {} : await readJsonObject(c);
  if (!body) {
    return c.json({ error: 'Invalid JSON body' }, 400);
  }

  if (body.maxAgeHours !== undefined) {
    const parsed = parseFiniteNumber(body.maxAgeHours);
    if (parsed === null || parsed < 0) {
      return c.json({ error: 'maxAgeHours must be a non-negative number' }, 400);
    }
    maxAgeHours = parsed;
  }
  if (body.maxSizeMb !== undefined) {
    const parsed = parseFiniteNumber(body.maxSizeMb);
    if (parsed === null || parsed < 0) {
      return c.json({ error: 'maxSizeMb must be a non-negative number' }, 400);
    }
    maxSizeBytes = parsed * 1024 * 1024;
  }

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
