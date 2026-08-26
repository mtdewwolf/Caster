import { Hono, type Context } from 'hono';
import fs from 'fs';
import os from 'os';
import path from 'path';
import crypto from 'crypto';
import { db, ExternalSubtitleModel, LibraryModel, MediaModel, ProgressModel, SeriesModel } from '../db';
import { isWatchedFilter, MEDIA_SORT_OPTIONS, WATCHED_FILTERS } from '../db';
import { AccessControlStore, type AccessPrincipal } from '../db/access-control';
import { createMusicLibraryStore } from '../db/music-library';
import { MediaMarkerStore } from '../db/media-marker-store';
import { clientIsRemote } from '../security/client-network';
import {
  anonymousOpenAccessAllowed,
  requestClientNetworkInput
} from '../security/request-security';
import { scanAllLibraries, scanLibrary, scanStatus } from '../scanner/indexer';
import { convertSrtToVtt } from '../scanner/subtitles';
import { ensureMediaThumbnail, getThumbnailPath } from '../scanner/thumbnails';
import {
  QUALITY_PROFILES,
  SegmentUnavailableError,
  TranscodeCapacityError,
  TranscodeKilledError,
  transcoder,
  type StreamRequestOptions
} from '../transcoder/engine';
import {
  INIT_SEGMENT_NAME,
  isNetworkClass,
  segmentContentType,
  type NetworkClass
} from '../transcoder/quality';
import type { HardwareAccelType, TranscodeQuality } from '../types';
import { normalizeContentRating } from '../content-ratings';
import {
  getCurrentUserId,
  isProtectedModeEnabled,
  resolvePrincipal,
  type AuthPrincipal
} from '../auth';
import { createMusicRouter } from './music';
import { createPlaybackRouter } from './playback';
import { createMetadataProvidersRouter, createMetadataRouter, publicMetadata } from './metadata';
import { planMetadataMatch } from '../metadata/scanner-adapter';
import { isAudioMode, type AudioMode, type AudioSourceInfo } from '../transcoder/audio';
import { summarizeSubtitleTracks } from '../transcoder/subtitles';
import {
  parseClientCapabilities,
  profileByName,
  type ClientCapabilities
} from '../transcoder/capabilities';
import {
  describePlaybackPlan,
  planPlayback,
  type PlaybackPlan
} from '../transcoder/playback-plan';
import { TitleStore } from '../db/title-store';
import { readLibrarySchedules, updateLibrarySchedule } from '../db/scan-lock-store';
import { autoScanRuntime } from '../scanner/runtime';

const titleStore = new TitleStore(db);
import {
  artworkCache,
  metadataEnrichment,
  metadataRegistry,
  metadataStore
} from '../metadata/runtime';
import { playlistRouter } from './playlists';
import { createWatchTogetherRouter } from './watch-together';
import { createCastAccessToken } from '../security/cast-access';

export const apiRouter = new Hono();
const accessControl = new AccessControlStore(db);
const markerStore = new MediaMarkerStore(db);

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

function accessPrincipal(c: Context): AccessPrincipal | null {
  const principal = resolvePrincipal(c);
  if (principal) {
    return { userId: principal.id, role: principal.role, active: true };
  }

  // Explicit local/open mode retains the original account-free experience.
  // Its synthetic admin role is used only for ACL bypass; request-security
  // middleware still locks administrative routes until auth is configured.
  if (!isProtectedModeEnabled() && anonymousOpenAccessAllowed(c)) {
    return { userId: getCurrentUserId(c), role: 'admin', active: true };
  }
  return null;
}

function requestIsRemote(c: Context): boolean {
  return clientIsRemote(requestClientNetworkInput(c));
}

function mediaIsAccessible(
  c: Context,
  mediaId: string,
  action: 'discover' | 'stream' | 'download' | 'delete' = 'discover'
): boolean {
  const principal = accessPrincipal(c);
  return !!principal && accessControl.canAccessMedia(principal, mediaId, {
    action,
    remote: action === 'stream' && requestIsRemote(c)
  });
}

function libraryScopeFor(c: Context): string[] | undefined {
  const principal = accessPrincipal(c);
  return principal ? accessControl.getLibraryScope(principal) : [];
}

function contentRatingScopeFor(c: Context) {
  const principal = accessPrincipal(c);
  return principal ? accessControl.getContentRatingScope(principal) : undefined;
}

function castQuerySuffix(c: Context): string {
  const principal = resolvePrincipal(c);
  const token = principal?.credential === 'cast' ? c.req.query('cast') : undefined;
  return token ? `?cast=${encodeURIComponent(token)}` : '';
}

function libraryIsInScope(scope: readonly string[] | undefined, libraryId: string): boolean {
  return scope === undefined || scope.includes(libraryId);
}

function viewerSafeLibrary<T extends { path?: string }>(principal: AuthPrincipal | null, library: T): T | Omit<T, 'path'> {
  if (principal?.role === 'admin') return library;
  const { path: _path, ...safe } = library;
  return safe;
}

function viewerSafeMedia<T extends { full_path?: string }>(principal: AuthPrincipal | null, media: T): T | Omit<T, 'full_path'> {
  if (principal?.role === 'admin') return media;
  const { full_path: _fullPath, ...safe } = media;
  return safe;
}

function viewerSafeMediaList<T extends { full_path?: string }>(c: Context, items: T[]) {
  const principal = resolvePrincipal(c);
  return items.map((item) => viewerSafeMedia(principal, item));
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
  const scope = libraryScopeFor(c);
  const allowed = scope && new Set(scope);
  const principal = resolvePrincipal(c);
  const libraries = LibraryModel.getAll({ contentRatingScope: contentRatingScopeFor(c) })
    .filter((library) => !allowed || allowed.has(library.id))
    .map((library) => viewerSafeLibrary(principal, library));
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

// Per-library scanning policy. Both switches default to off, so nothing starts
// watching an operator's filesystem without being asked.
apiRouter.patch('/libraries/:id/scanning', async (c) => {
  const libraryId = c.req.param('id');
  if (!LibraryModel.getById(libraryId)) {
    return c.json({ error: 'Library not found' }, 404);
  }

  const body = await readJsonObject(c);
  if (!body) return c.json({ error: 'Invalid JSON body' }, 400);

  const settings: {
    autoScan?: boolean;
    watchFilesystem?: boolean;
    scanIntervalMinutes?: number | null;
  } = {};

  if (body.autoScan !== undefined) {
    if (typeof body.autoScan !== 'boolean') {
      return c.json({ error: 'autoScan must be true or false' }, 400);
    }
    settings.autoScan = body.autoScan;
  }
  if (body.watchFilesystem !== undefined) {
    if (typeof body.watchFilesystem !== 'boolean') {
      return c.json({ error: 'watchFilesystem must be true or false' }, 400);
    }
    settings.watchFilesystem = body.watchFilesystem;
  }
  if (body.scanIntervalMinutes !== undefined) {
    const minutes = body.scanIntervalMinutes;
    if (minutes !== null && (typeof minutes !== 'number' || !Number.isInteger(minutes) || minutes < 5)) {
      return c.json({ error: 'scanIntervalMinutes must be null or an integer of at least 5' }, 400);
    }
    settings.scanIntervalMinutes = minutes;
  }

  if (!updateLibrarySchedule(db, libraryId, settings)) {
    return c.json({ error: 'No scanning settings were provided' }, 400);
  }

  // Start or stop the watcher to match what was just asked for.
  autoScanRuntime.syncWatchers();

  const schedule = readLibrarySchedules(db).find((entry) => entry.libraryId === libraryId);
  return c.json({ scanning: schedule ?? null });
});

apiRouter.get('/libraries/scanning', (c) => {
  return c.json({ libraries: readLibrarySchedules(db) });
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
  const genre = query.genre;
  const sort = query.sort;

  if (sort && !MEDIA_SORT_OPTIONS.includes(sort)) {
    return c.json({ error: `sort must be one of: ${MEDIA_SORT_OPTIONS.join(', ')}` }, 400);
  }
  if (query.watched !== undefined && !isWatchedFilter(query.watched)) {
    return c.json({ error: `watched must be one of: ${WATCHED_FILTERS.join(', ')}` }, 400);
  }
  if (query.hdr !== undefined && query.hdr !== 'true' && query.hdr !== 'false') {
    return c.json({ error: 'hdr must be true or false' }, 400);
  }
  const limit = parseIntegerQuery(query.limit, 50, 1, MEDIA_PAGE_MAX_LIMIT);
  const offset = parseIntegerQuery(query.offset, 0, 0, Number.MAX_SAFE_INTEGER);

  if (limit === null || offset === null) {
    return c.json(
      { error: `limit must be between 1 and ${MEDIA_PAGE_MAX_LIMIT}; offset must be a non-negative integer` },
      400
    );
  }

  const allowedLibraryIds = libraryScopeFor(c);
  if (libraryId && !libraryIsInScope(allowedLibraryIds, libraryId)) {
    return c.json({ items: [], total: 0 });
  }

  const result = MediaModel.getAll(getCurrentUserId(c), {
    libraryId,
    allowedLibraryIds,
    contentRatingScope: contentRatingScopeFor(c),
    type,
    search,
    resolution,
    genre,
    ...(query.watched !== undefined ? { watched: query.watched } : {}),
    ...(query.hdr !== undefined ? { hdr: query.hdr === 'true' } : {}),
    sort,
    limit,
    offset
  });

  return c.json({
    ...result,
    items: viewerSafeMediaList(c, result.items)
  });
});

// One request per home render. Rows are already viewer-scoped, so an empty row
// means "nothing to show you" rather than "you are not allowed to see this".
apiRouter.get('/media/home', (c) => {
  const userId = getCurrentUserId(c);
  const libraryScope = libraryScopeFor(c);
  const ratingScope = contentRatingScopeFor(c);
  const rowLimit = parseIntegerQuery(c.req.query('limit'), 12, 1, 50);
  if (rowLimit === null) {
    return c.json({ error: 'limit must be between 1 and 50' }, 400);
  }

  const rows = {
    continueWatching: MediaModel.getContinueWatching(userId, rowLimit, libraryScope, ratingScope),
    nextUp: MediaModel.getNextUp(userId, rowLimit, libraryScope, ratingScope),
    recentlyAdded: MediaModel.getRecentlyAdded(userId, rowLimit, libraryScope, ratingScope),
    recentlyWatched: MediaModel.getRecentlyWatched(userId, rowLimit, libraryScope, ratingScope)
  };

  return c.json({
    rows: Object.fromEntries(
      Object.entries(rows).map(([key, items]) => [key, viewerSafeMediaList(c, items)])
    )
  });
});

apiRouter.get('/media/genres', (c) => {
  return c.json({
    genres: MediaModel.getGenres({
      libraryId: c.req.query('libraryId'),
      type: c.req.query('type'),
      allowedLibraryIds: libraryScopeFor(c),
      contentRatingScope: contentRatingScopeFor(c)
    })
  });
});

apiRouter.get('/media/continue-watching', (c) => {
  const items = MediaModel.getContinueWatching(
    getCurrentUserId(c), 12, libraryScopeFor(c), contentRatingScopeFor(c)
  );
  return c.json({ items: viewerSafeMediaList(c, items) });
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

  const items = MediaModel.getProgressItems(getCurrentUserId(c), {
    status,
    limit,
    allowedLibraryIds: libraryScopeFor(c),
    contentRatingScope: contentRatingScopeFor(c)
  });
  return c.json({ items: viewerSafeMediaList(c, items) });
});

apiRouter.post('/media/:id/progress/watched', (c) => {
  const id = c.req.param('id');
  if (!mediaIsAccessible(c, id)) {
    return c.json({ error: 'Media not found' }, 404);
  }
  const userId = getCurrentUserId(c);
  const item = MediaModel.getById(
    id, userId, libraryScopeFor(c), contentRatingScopeFor(c)
  );
  if (!item) {
    return c.json({ error: 'Media not found' }, 404);
  }
  const progress = ProgressModel.markWatched(userId, id);
  return c.json({ progress });
});

apiRouter.post('/media/:id/progress/unwatched', (c) => {
  const id = c.req.param('id');
  if (!mediaIsAccessible(c, id)) {
    return c.json({ error: 'Media not found' }, 404);
  }
  ProgressModel.remove(getCurrentUserId(c), id);
  return c.json({ success: true });
});

apiRouter.delete('/media/:id/progress', (c) => {
  const id = c.req.param('id');
  if (!mediaIsAccessible(c, id)) {
    return c.json({ error: 'Media not found' }, 404);
  }
  ProgressModel.remove(getCurrentUserId(c), id);
  return c.json({ success: true });
});

apiRouter.get('/media/:id', (c) => {
  const id = c.req.param('id');
  if (!mediaIsAccessible(c, id)) {
    return c.json({ error: 'Media not found' }, 404);
  }
  const item = MediaModel.getById(
    id, getCurrentUserId(c), libraryScopeFor(c), contentRatingScopeFor(c)
  );
  if (!item) {
    return c.json({ error: 'Media not found' }, 404);
  }
  // Detail views want the descriptive layer alongside the technical one. It is
  // attached rather than merged so the scanner-derived fields stay authoritative
  // for playback and a missing provider simply yields metadata: null.
  const plan = planMetadataMatch(item);
  const metadata = plan ? metadataStore.get(plan.subject) : null;
  return c.json({
    item: viewerSafeMedia(resolvePrincipal(c), item),
    metadata: metadata ? publicMetadata(metadata) : null,
    // Image subtitles cannot be handed to the player as a text track, so the
    // client needs to know which ones force a burned-in transcode.
    subtitleTracks: subtitleTracksFor(item),
    // What this client would get, and why — so the player can explain itself
    // rather than showing a bare protocol badge.
    playback: (() => {
      const plan = playbackPlanFor(c, item, false);
      return { ...plan, summary: describePlaybackPlan(plan) };
    })(),
    // Other files of the same work. A single-version title reports just itself,
    // so clients can render a picker without special-casing the common case.
    versions: titleStore.getVersionsForMedia(id)
  });
});

apiRouter.patch('/media/:id/content-rating', async (c) => {
  const id = c.req.param('id');
  if (!MediaModel.getById(id, getCurrentUserId(c))) {
    return c.json({ error: 'Media not found' }, 404);
  }
  const body = await readJsonObject(c);
  if (!body || (body.contentRating !== null && typeof body.contentRating !== 'string')) {
    return c.json({ error: 'contentRating must be a supported rating string or null' }, 400);
  }
  const normalized = body.contentRating === null
    ? null
    : normalizeContentRating(body.contentRating);
  if (body.contentRating !== null && !normalized) {
    return c.json({ error: 'Unsupported content rating' }, 400);
  }
  const item = MediaModel.updateContentRating(id, normalized, getCurrentUserId(c));
  return c.json({ item: viewerSafeMedia(resolvePrincipal(c), item!) });
});

// ---------------- Series Rollup API ---------------- //

apiRouter.get('/series', (c) => {
  const libraryId = c.req.query('libraryId');
  const search = c.req.query('search');
  const allowedLibraryIds = libraryScopeFor(c);
  if (libraryId && !libraryIsInScope(allowedLibraryIds, libraryId)) {
    return c.json({ items: [] });
  }
  const items = SeriesModel.getAll(getCurrentUserId(c), {
    libraryId,
    search,
    allowedLibraryIds,
    contentRatingScope: contentRatingScopeFor(c)
  });
  return c.json({ items });
});

apiRouter.get('/series/:id', (c) => {
  const id = c.req.param('id');
  const userId = getCurrentUserId(c);
  const allowedLibraryIds = libraryScopeFor(c);
  const ratingScope = contentRatingScopeFor(c);
  const series = SeriesModel.getById(id, userId, allowedLibraryIds, ratingScope);
  if (!series || !libraryIsInScope(allowedLibraryIds, series.library_id)) {
    return c.json({ error: 'Series not found' }, 404);
  }
  const seasons = SeriesModel.getSeasons(
    series.library_id, series.title, userId, allowedLibraryIds, ratingScope
  );
  return c.json({ series, seasons });
});

apiRouter.get('/series/:id/episodes', (c) => {
  const id = c.req.param('id');
  const userId = getCurrentUserId(c);
  const allowedLibraryIds = libraryScopeFor(c);
  const ratingScope = contentRatingScopeFor(c);
  const series = SeriesModel.getById(id, userId, allowedLibraryIds, ratingScope);
  if (!series || !libraryIsInScope(allowedLibraryIds, series.library_id)) {
    return c.json({ error: 'Series not found' }, 404);
  }
  const items = MediaModel.getBySeries(
    series.library_id, series.title, userId, allowedLibraryIds, ratingScope
  );
  return c.json({ series, items: viewerSafeMediaList(c, items) });
});

// ---------------- Direct Play Streaming (HTTP Range 206) ---------------- //

apiRouter.get('/media/:id/download', (c) => {
  const id = c.req.param('id');
  if (!mediaIsAccessible(c, id, 'download')) {
    return c.json({ error: 'Media not found' }, 404);
  }
  const item = MediaModel.getById(
    id, getCurrentUserId(c), libraryScopeFor(c), contentRatingScopeFor(c)
  );
  if (!item || !fs.existsSync(item.full_path)) {
    return c.json({ error: 'Media not found' }, 404);
  }
  const filename = path.basename(item.original_filename || item.full_path)
    .replace(/[\r\n"]/g, '_');
  c.header('Content-Type', 'application/octet-stream');
  c.header('Content-Disposition', `attachment; filename="${filename}"`);
  c.header('Content-Length', String(fs.statSync(item.full_path).size));
  return c.body(Bun.file(item.full_path).stream());
});

apiRouter.delete('/media/:id/file', (c) => {
  const id = c.req.param('id');
  if (!mediaIsAccessible(c, id, 'delete')) {
    return c.json({ error: 'Media not found' }, 404);
  }
  if (c.req.header('x-caster-confirm-delete') !== id) {
    return c.json({ error: 'Confirm deletion with X-Caster-Confirm-Delete set to the media ID' }, 409);
  }
  const item = MediaModel.getById(
    id, getCurrentUserId(c), libraryScopeFor(c), contentRatingScopeFor(c)
  );
  const library = item ? LibraryModel.getById(item.library_id) : null;
  if (!item || !library) {
    return c.json({ error: 'Media not found' }, 404);
  }

  let realLibraryPath: string;
  let realMediaPath: string;
  try {
    const mediaEntry = fs.lstatSync(item.full_path);
    if (!mediaEntry.isFile() || mediaEntry.isSymbolicLink()) {
      return c.json({ error: 'Media source must be a regular file' }, 409);
    }
    realLibraryPath = fs.realpathSync.native(library.path);
    realMediaPath = fs.realpathSync.native(item.full_path);
  } catch (error) {
    const code = error && typeof error === 'object' && 'code' in error
      ? String(error.code)
      : '';
    if (code === 'ENOENT' || code === 'ENOTDIR') {
      return c.json({ error: 'Media not found' }, 404);
    }
    return c.json({ error: 'Media source could not be safely resolved' }, 409);
  }
  const relativeTarget = path.relative(realLibraryPath, realMediaPath);
  if (!relativeTarget || relativeTarget.startsWith(`..${path.sep}`) || relativeTarget === '..' || path.isAbsolute(relativeTarget)) {
    return c.json({ error: 'Media source is outside its library root' }, 409);
  }

  try {
    // Re-resolve immediately before unlinking so a swapped path is denied
    // instead of deleting a different filesystem entry.
    if (fs.realpathSync.native(item.full_path) !== realMediaPath) {
      return c.json({ error: 'Media source changed during deletion' }, 409);
    }
    fs.unlinkSync(realMediaPath);
  } catch (error) {
    const code = error && typeof error === 'object' && 'code' in error
      ? String(error.code)
      : '';
    if (code === 'ENOENT' || code === 'ENOTDIR') {
      return c.json({ error: 'Media not found' }, 404);
    }
    return c.json({ error: 'Media source could not be deleted' }, 409);
  }
  MediaModel.delete(id);
  return c.json({ success: true });
});

apiRouter.get('/media/:id/stream', async (c) => {
  const id = c.req.param('id');
  if (!mediaIsAccessible(c, id, 'stream')) {
    return c.text('Media file not found', 404);
  }
  const item = MediaModel.getById(id, getCurrentUserId(c), libraryScopeFor(c));
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

// Browsers hand media URLs to Cast/AirPlay receivers, which do not share the
// browser session. Issue a time-limited URL scoped to this user and media item.
apiRouter.get('/media/:id/cast', (c) => {
  const id = c.req.param('id');
  if (!mediaIsAccessible(c, id, 'stream')) {
    return c.json({ error: 'Media not found' }, 404);
  }

  const principal = resolvePrincipal(c);
  const grant = principal
    ? createCastAccessToken(principal.id, id)
    : null;
  const suffix = grant ? `?cast=${encodeURIComponent(grant.token)}` : '';
  const base = `/api/media/${encodeURIComponent(id)}`;
  return c.json({
    directUrl: `${base}/stream${suffix}`,
    hlsUrl: `${base}/hls/master.m3u8${suffix}`,
    hlsQualityUrls: {
      '1080p': `${base}/hls/1080p/index.m3u8${suffix}`,
      '720p': `${base}/hls/720p/index.m3u8${suffix}`,
      '480p': `${base}/hls/480p/index.m3u8${suffix}`
    },
    subtitleUrlBase: `${base}/subtitles/`,
    query: suffix,
    expiresAt: grant?.expiresAt ?? null
  });
});

// ---------------- HLS Dynamic Transcoding API ---------------- //

/** Audio preference from the request, defaulting to the safe stereo path. */
function audioModeFor(c: any): AudioMode {
  const requested = c.req.query('audio');
  return isAudioMode(requested) ? requested : 'stereo';
}

/**
 * The audio decision has to survive into segment URLs, otherwise a client that
 * asked for surround on the playlist silently gets stereo segments.
 */
function audioQuerySuffix(c: any, existingSuffix: string): string {
  const parts: string[] = [];
  const mode = c.req.query('audio');
  if (isAudioMode(mode) && mode !== 'stereo') parts.push(`audio=${encodeURIComponent(mode)}`);
  const track = c.req.query('audioTrack');
  if (track && /^\d+$/.test(track)) parts.push(`audioTrack=${encodeURIComponent(track)}`);
  const subtitle = c.req.query('subtitle');
  if (subtitle && /^\d+$/.test(subtitle)) parts.push(`subtitle=${encodeURIComponent(subtitle)}`);
  // The client's own description has to survive into segment URLs as well.
  // Without it the playlist is planned for one device and the segments for a
  // conservative stranger, and the two disagree about codec and bitrate.
  const client = c.req.query('client');
  if (client && /^[a-zA-Z0-9_-]{1,32}$/.test(client)) {
    parts.push(`client=${encodeURIComponent(client)}`);
  }
  const capabilities = c.req.query('capabilities');
  if (typeof capabilities === 'string' && capabilities.length > 0 && capabilities.length <= 2048) {
    parts.push(`capabilities=${encodeURIComponent(capabilities)}`);
  }
  const network = c.req.query('network');
  if (isNetworkClass(network)) parts.push(`network=${encodeURIComponent(network)}`);
  if (parts.length === 0) return existingSuffix;
  return existingSuffix
    ? `${existingSuffix}&${parts.join('&')}`
    : `?${parts.join('&')}`;
}

/**
 * What the requesting client can play.
 *
 * A client may name a profile, send its own declaration, or say nothing — in
 * which case it gets the conservative assumed set rather than a guess.
 */
function capabilitiesFor(c: any): ClientCapabilities {
  const base = profileByName(c.req.query('client'));
  const declared = c.req.query('capabilities');
  if (!declared) return base;
  try {
    return parseClientCapabilities(JSON.parse(declared), base);
  } catch {
    return base;
  }
}

/**
 * Where the viewer is watching from.
 *
 * A device on the same network can be given far more bitrate than one on a
 * hotel connection. The client says which it is; when it says nothing, the
 * request's own network origin decides, and the local network is assumed.
 */
function networkFor(c: any): NetworkClass {
  const declared = c.req.query('network');
  if (isNetworkClass(declared)) return declared;
  try {
    return clientIsRemote(requestClientNetworkInput(c)) ? 'remote' : 'lan';
  } catch {
    return 'lan';
  }
}

/** What the encoder needs to know about this client, connection and source. */
function streamRequestFor(c: any, item: any): StreamRequestOptions {
  return {
    capabilities: capabilitiesFor(c),
    network: networkFor(c),
    source: {
      height: typeof item?.height === 'number' ? item.height : undefined,
      bitRate: typeof item?.bit_rate === 'number' ? item.bit_rate : undefined,
      frameRate: typeof item?.frame_rate === 'number' ? item.frame_rate : undefined
    }
  };
}

/** The playback decision for this item and this client. */
function playbackPlanFor(c: any, item: any, burnInSubtitle: boolean): PlaybackPlan {
  return planPlayback({
    capabilities: capabilitiesFor(c),
    burnInSubtitle,
    source: {
      container: item.format,
      videoCodec: item.video_codec,
      height: item.height,
      bitRate: item.bit_rate,
      isHdr: Boolean(item.is_hdr),
      audioCodec: item.audio_codec,
      audioChannels: item.audio_channels
    }
  });
}

/** Subtitle tracks for an item, with the image ones flagged for burn-in. */
function subtitleTracksFor(item: any) {
  try {
    return summarizeSubtitleTracks(JSON.parse(item.streams_json || '[]'));
  } catch {
    return [];
  }
}

/** The selected subtitle track, when the client asked to burn one in. */
function subtitleSelectionFor(c: any, item: any) {
  const requested = c.req.query('subtitle');
  const tracks = subtitleTracksFor(item);
  if (!requested || !/^\d+$/.test(requested)) return { tracks };
  return { tracks, streamIndex: Number(requested) };
}

/** Resolves which audio stream to plan against, honouring an explicit track. */
function audioSourceFor(c: any, item: any): AudioSourceInfo {
  const requestedTrack = c.req.query('audioTrack');
  if (requestedTrack && /^\d+$/.test(requestedTrack)) {
    const streamIndex = Number(requestedTrack);
    try {
      const streams = JSON.parse(item.streams_json || '[]') as Array<Record<string, any>>;
      const match = streams.find((stream) =>
        stream.codec_type === 'audio' && stream.index === streamIndex);
      if (match) {
        return {
          codec: match.codec_name,
          channels: match.channels,
          streamIndex
        };
      }
    } catch {
      // A malformed streams blob falls back to the item's default track.
    }
  }
  return { codec: item.audio_codec, channels: item.audio_channels };
}

apiRouter.get('/media/:id/hls/master.m3u8', (c) => {
  const id = c.req.param('id');
  if (!mediaIsAccessible(c, id, 'stream')) return c.text('Not found', 404);
  const item = MediaModel.getById(id, getCurrentUserId(c), libraryScopeFor(c));
  if (!item) return c.text('Not found', 404);

  const playlist = transcoder.generateMasterPlaylist(
    id,
    item.width || 1920,
    item.height || 1080,
    audioQuerySuffix(c, castQuerySuffix(c)),
    streamRequestFor(c, item)
  );
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
  if (!mediaIsAccessible(c, id, 'stream')) return c.text('Not found', 404);
  const item = MediaModel.getById(id, getCurrentUserId(c), libraryScopeFor(c));
  if (!item) return c.text('Not found', 404);

  const selection = subtitleSelectionFor(c, item);
  const { packaging } = transcoder.describeStreamPackaging(
    quality,
    playbackPlanFor(c, item, selection.streamIndex !== undefined),
    streamRequestFor(c, item),
    selection.streamIndex !== undefined
  );
  const playlist = transcoder.generateVariantPlaylist(
    id,
    item.duration || 3600,
    quality,
    audioQuerySuffix(c, castQuerySuffix(c)),
    packaging
  );
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
  // "segment-0.ts" for MPEG-TS, "segment-0.m4s" for fragmented MP4, or the
  // one initialisation segment a fragmented stream begins with.
  const segmentFile = c.req.param('segment');
  const wantsInit = segmentFile === INIT_SEGMENT_NAME;

  const seqMatch = segmentFile.match(/^segment-(\d+)\.(ts|m4s)$/);
  if (!seqMatch && !wantsInit) {
    return c.text('Invalid segment name', 400);
  }

  const seq = wantsInit ? 0 : Number(seqMatch![1]);
  if (!Number.isSafeInteger(seq)) {
    return c.text('Invalid segment name', 400);
  }
  if (!mediaIsAccessible(c, id, 'stream')) {
    return c.text('Media not found', 404);
  }
  const item = MediaModel.getById(id, getCurrentUserId(c), libraryScopeFor(c));
  if (!item || !fs.existsSync(item.full_path)) {
    return c.text('Media not found', 404);
  }

    try {
      const selection = subtitleSelectionFor(c, item);
      const audio = { source: audioSourceFor(c, item), mode: audioModeFor(c) };
      const plan = playbackPlanFor(c, item, selection.streamIndex !== undefined);
      const stream = streamRequestFor(c, item);
      const { packaging } = transcoder.describeStreamPackaging(
        quality, plan, stream, selection.streamIndex !== undefined
      );

      // A request for the wrong extension is a stale playlist, not a segment
      // that happens to be missing — say so rather than encoding it twice.
      if (!wantsInit && seqMatch![2] !== (packaging === 'fmp4' ? 'm4s' : 'ts')) {
        return c.json({ error: 'This stream is packaged differently; reload the playlist' }, 404);
      }

      const chunkBuffer = wantsInit
        ? await transcoder.getHlsInitSegment(
            item.full_path, id, quality, audio, selection, plan, stream
          )
        : await transcoder.getHlsSegment(
            item.full_path, id, quality, seq, audio, selection, plan, stream
          );
      return new Response(new Uint8Array(chunkBuffer), {
      headers: {
        'Content-Type': wantsInit ? 'video/mp4' : segmentContentType(packaging),
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
    if (err instanceof SegmentUnavailableError) {
      // Either the request is past the end of the stream or the encoder could
      // not reach it in time; neither is a server fault.
      return c.json({ error: err.message }, 404);
    }
    return c.text('Segment transcode failed', 500);
  }
});

// ---------------- Thumbnails & Subtitles ---------------- //

apiRouter.get('/media/:id/thumbnail', (c) => {
  const id = c.req.param('id');
  if (!mediaIsAccessible(c, id)) {
    return c.text('Thumbnail not found', 404);
  }
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
  if (!mediaIsAccessible(c, id)) {
    return c.json({ error: 'Media not found' }, 404);
  }
  const item = MediaModel.getById(id, getCurrentUserId(c), libraryScopeFor(c));
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

  if (!mediaIsAccessible(c, id, 'stream')) {
    return c.text('Media not found', 404);
  }

  const item = MediaModel.getById(id, getCurrentUserId(c), libraryScopeFor(c));
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

  // An image subtitle has no text to hand back. Say so plainly instead of
  // returning an empty cue list the player would silently render as nothing.
  const track = subtitleTracksFor(item).find((candidate) => candidate.index === trackIndex);
  if (track?.requiresBurnIn) {
    return c.json({
      error: 'This subtitle track is an image format and must be burned into the video',
      codec: track.codecName,
      burnInRequired: true
    }, 409);
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
  if (!mediaIsAccessible(c, id)) {
    return c.json({ error: 'Media not found' }, 404);
  }
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

  if (!MediaModel.getById(id, getCurrentUserId(c), libraryScopeFor(c))) {
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

apiRouter.route('/music', createMusicRouter({
  store: createMusicLibraryStore(db),
  getUserId: (c) => getCurrentUserId(c),
  getScope: (c) => ({
    allowedLibraryIds: libraryScopeFor(c),
    contentRatingScope: contentRatingScopeFor(c)
  }),
  serializeTrack: (c, track) => viewerSafeMedia(resolvePrincipal(c), track)
}));

apiRouter.route('/playlists', playlistRouter);

apiRouter.route('/watch-rooms', createWatchTogetherRouter({
  getAuthenticatedUserId: (c) => resolvePrincipal(c)?.id ?? null,
  resolveMedia: (c, id) => {
    if (!mediaIsAccessible(c, id, 'stream')) return null;
    return MediaModel.getById(
      id,
      getCurrentUserId(c),
      libraryScopeFor(c),
      contentRatingScopeFor(c)
    );
  }
}));

const viewerScopedMedia = (c: any, id: string) => {
  if (!mediaIsAccessible(c, id)) return null;
  return MediaModel.getById(
    id, getCurrentUserId(c), libraryScopeFor(c), contentRatingScopeFor(c)
  );
};

apiRouter.route('/media', createMetadataRouter({
  store: metadataStore,
  enrichment: metadataEnrichment,
  registry: metadataRegistry,
  resolveMedia: viewerScopedMedia,
  isAdmin: (c) => resolvePrincipal(c)?.role === 'admin'
}));

apiRouter.route('/metadata', createMetadataProvidersRouter({
  registry: metadataRegistry,
  artworkCache,
  isAdmin: (c) => resolvePrincipal(c)?.role === 'admin'
}));

const ARTWORK_MIME_TYPES: Record<string, string> = {
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  png: 'image/png',
  webp: 'image/webp',
  avif: 'image/avif',
  svg: 'image/svg+xml'
};

/** Image content types. The general media helper only knows video containers. */
function artworkMimeType(fileName: string): string {
  const extension = path.extname(fileName).replace('.', '').toLowerCase();
  return ARTWORK_MIME_TYPES[extension] ?? 'application/octet-stream';
}

// Cached provider artwork. The filename is a content hash written by the cache
// itself, so it is validated rather than trusted and never joined from raw input.
apiRouter.get('/artwork/:file', (c) => {
  const requested = c.req.param('file');
  if (!/^[0-9a-f]{40}\.[a-z0-9]{1,5}$/.test(requested)) {
    return c.text('Not found', 404);
  }

  const filePath = artworkCache.filePath(requested);
  if (!fs.existsSync(filePath)) {
    return c.text('Not found', 404);
  }

  c.header('Content-Type', artworkMimeType(requested));
  c.header('Cache-Control', 'public, max-age=604800, immutable');
  return c.body(Bun.file(filePath).stream());
});

apiRouter.route('/media', createPlaybackRouter({
  markerStore,
  resolveMedia: (c, id) => {
    if (!mediaIsAccessible(c, id)) return null;
    return MediaModel.getById(
      id,
      getCurrentUserId(c),
      libraryScopeFor(c),
      contentRatingScopeFor(c)
    );
  },
  resolveNextEpisode: (c, item) => {
    if (!item.series_title) return null;
    const items = MediaModel.getBySeries(
      item.library_id,
      item.series_title,
      getCurrentUserId(c),
      libraryScopeFor(c),
      contentRatingScopeFor(c)
    );
    const currentIndex = items.findIndex((candidate) => candidate.id === item.id);
    const next = currentIndex >= 0 ? items[currentIndex + 1] : undefined;
    return next ? viewerSafeMedia(resolvePrincipal(c), next) : null;
  },
  isAdmin: (c) => resolvePrincipal(c)?.role === 'admin'
}));

// ---------------- Account Access Administration ---------------- //

function managedAccessPrincipal(userId: string): AccessPrincipal | null {
  const user = db.query(`
    SELECT id, role, active FROM users WHERE id = ?
  `).get(userId) as { id: string; role: 'admin' | 'viewer'; active: number } | null;
  return user
    ? { userId: user.id, role: user.role, active: user.active === 1 }
    : null;
}

apiRouter.get('/access/users/:userId/libraries', (c) => {
  const principal = managedAccessPrincipal(c.req.param('userId'));
  if (!principal) return c.json({ error: 'User not found' }, 404);
  return c.json({ libraryIds: accessControl.getAllowedLibraryIds(principal) });
});

apiRouter.put('/access/users/:userId/libraries', async (c) => {
  const userId = c.req.param('userId');
  if (!managedAccessPrincipal(userId)) return c.json({ error: 'User not found' }, 404);

  const body = await readJsonObject(c);
  if (!body || !Array.isArray(body.libraryIds)
    || body.libraryIds.some((id) => typeof id !== 'string' || id.length === 0)) {
    return c.json({ error: 'libraryIds must be an array of library IDs' }, 400);
  }

  const libraryIds = [...new Set(body.libraryIds as string[])];
  const knownIds = new Set(LibraryModel.getAll().map((library) => library.id));
  if (libraryIds.some((id) => !knownIds.has(id))) {
    return c.json({ error: 'One or more libraries do not exist' }, 400);
  }

  const updateGrants = db.transaction(() => {
    const currentIds = new Set(
      (db.query(`
        SELECT library_id FROM user_library_access WHERE user_id = ?
      `).all(userId) as Array<{ library_id: string }>).map((row) => row.library_id)
    );
    for (const libraryId of currentIds) {
      if (!libraryIds.includes(libraryId)) accessControl.unshareLibrary(userId, libraryId);
    }
    for (const libraryId of libraryIds) {
      if (!currentIds.has(libraryId)) accessControl.shareLibrary(userId, libraryId);
    }
  });
  updateGrants();

  return c.json({ libraryIds });
});

apiRouter.get('/access/users/:userId/permissions', (c) => {
  const userId = c.req.param('userId');
  if (!managedAccessPrincipal(userId)) return c.json({ error: 'User not found' }, 404);
  return c.json({ permissions: accessControl.getPermissions(userId) });
});

apiRouter.patch('/access/users/:userId/permissions', async (c) => {
  const userId = c.req.param('userId');
  if (!managedAccessPrincipal(userId)) return c.json({ error: 'User not found' }, 404);
  const body = await readJsonObject(c);
  if (!body) return c.json({ error: 'Invalid JSON body' }, 400);

  const booleanKeys = [
    'allowUnrated',
    'canDownload',
    'canStreamRemote',
    'canDeleteMedia',
    'canManageProfiles'
  ] as const;
  if (booleanKeys.some((key) => body[key] !== undefined && typeof body[key] !== 'boolean')) {
    return c.json({ error: 'Permission flags must be boolean values' }, 400);
  }
  if (body.maxContentRating !== undefined
    && body.maxContentRating !== null
    && typeof body.maxContentRating !== 'string') {
    return c.json({ error: 'maxContentRating must be a rating string or null' }, 400);
  }

  try {
    const permissions = accessControl.updatePermissions(userId, {
      maxContentRating: body.maxContentRating as string | null | undefined,
      allowUnrated: body.allowUnrated as boolean | undefined,
      canDownload: body.canDownload as boolean | undefined,
      canStreamRemote: body.canStreamRemote as boolean | undefined,
      canDeleteMedia: body.canDeleteMedia as boolean | undefined,
      canManageProfiles: body.canManageProfiles as boolean | undefined
    });
    return c.json({ permissions });
  } catch (error) {
    return c.json({ error: error instanceof Error ? error.message : 'Invalid permissions' }, 400);
  }
});

apiRouter.patch('/access/users/:userId/pin', async (c) => {
  const userId = c.req.param('userId');
  if (!managedAccessPrincipal(userId)) return c.json({ error: 'User not found' }, 404);
  const body = await readJsonObject(c);
  if (!body || (body.pin !== null && typeof body.pin !== 'string')) {
    return c.json({ error: 'pin must be a 4 to 12 digit string or null' }, 400);
  }

  try {
    accessControl.setProfilePin(userId, body.pin as string | null);
    return c.json({ permissions: accessControl.getPermissions(userId) });
  } catch (error) {
    return c.json({ error: error instanceof Error ? error.message : 'Invalid profile PIN' }, 400);
  }
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
