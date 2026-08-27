import fs from 'fs';
import path from 'path';
import crypto from 'crypto';
import { extractMediaMetadata, parseFilename } from './metadata';
import { normalizeMusicTags } from './music-tags';
import { contentFingerprint } from './content-fingerprint';
import { EXTERNAL_SUBTITLE_INDEX_BASE, findExternalSubtitles } from './subtitles';
import { ensureMediaThumbnail } from './thumbnails';
import { db, ExternalSubtitleModel, LibraryModel, MediaModel } from '../db';
import { MediaIdentityStore } from '../db/media-identity-store';
import { TitleStore } from '../db/title-store';
import { ScanLockStore } from '../db/scan-lock-store';
import { rootForPath } from '../db/library-roots';
import { enqueueMediaMarkerAnalysis } from '../markers';
import { metadataEnrichment } from '../metadata/runtime';
import { metadataStore } from '../metadata/runtime';
import type { Library, MediaItem } from '../types';

const VIDEO_EXTENSIONS = new Set(['.mp4', '.mkv', '.mov', '.avi', '.webm', '.ts', '.m4v', '.flv', '.wmv', '.iso']);
const AUDIO_EXTENSIONS = new Set(['.mp3', '.flac', '.aac', '.m4a', '.wav', '.ogg', '.opus', '.wma', '.alac']);
const mediaIdentityStore = new MediaIdentityStore(db);
const titleStore = new TitleStore(db);
const scanLocks = new ScanLockStore(db);

export class LibraryBusyError extends Error {
  constructor(libraryId: string) {
    super(`Library ${libraryId} is already being scanned`);
    this.name = 'LibraryBusyError';
  }
}

/** Clears locks left behind by a process that stopped mid-scan. */
export function releaseAbandonedScanLocks(): number {
  return scanLocks.releaseStale();
}

export interface ScanStatus {
  isScanning: boolean;
  libraryId: string | null;
  totalFiles: number;
  processedFiles: number;
  currentFile: string;
  errors: string[];
}

export const scanStatus: ScanStatus = {
  isScanning: false,
  libraryId: null,
  totalFiles: 0,
  processedFiles: 0,
  currentFile: '',
  errors: []
};

interface MediaDiscoveryResult {
  files: string[];
  complete: boolean;
  errors: string[];
}

export async function scanAllLibraries(): Promise<void> {
  const libraries = LibraryModel.getAll();
  for (const lib of libraries) {
    await scanLibrary(lib.id);
  }
}

export async function scanLibrary(libraryId: string): Promise<{ processed: number; errors: number }> {
  const library = LibraryModel.getById(libraryId);
  if (!library) {
    throw new Error(`Library ${libraryId} not found`);
  }

  // The guard is per-library and outlives this process, so scanning films no
  // longer blocks scanning music and a crash mid-scan cannot wedge a library.
  if (!scanLocks.acquire(libraryId)) {
    throw new LibraryBusyError(libraryId);
  }

  scanStatus.isScanning = true;
  scanStatus.libraryId = libraryId;
  scanStatus.totalFiles = 0;
  scanStatus.processedFiles = 0;
  scanStatus.currentFile = '';
  scanStatus.errors = [];

  try {
    // A generation identifies one filesystem snapshot. It is deliberately
    // created before discovery so every stage of this scan uses the same ID.
    const scanGenerationId = crypto.randomUUID();
    // A library can span several directories. They are discovered as one
    // snapshot so reconciliation sees the whole library, not one root at a
    // time — reconciling per root would delete every other root's media.
    const discovery = findMediaFiles(libraryRoots(library), library.type);
    const currentLibraryPaths = new Set(discovery.files);
    scanStatus.totalFiles = discovery.files.length;

    for (const error of discovery.errors) {
      recordScanError(error);
    }

    let staged = false;
    try {
      // Stage the filesystem result before any metadata, thumbnail, or marker
      // work. Reconciliation can therefore distinguish an undiscovered path
      // from a discovered path whose processing failed later.
      MediaModel.stageDiscoveredPaths(library.id, scanGenerationId, discovery.files);
      staged = true;
    } catch (error) {
      recordScanError(`Error staging discovered paths for ${describeLibrary(library)}: ${errorMessage(error)}`, error);
    }

    if (staged) {
      for (const filePath of discovery.files) {
        scanStatus.currentFile = path.basename(filePath);
        try {
          await processMediaFile(library, filePath, currentLibraryPaths);
        } catch (error) {
          recordScanError(`Error processing ${filePath}: ${errorMessage(error)}`, error);
        }
        scanStatus.processedFiles++;
        // Report in periodically so a long scan is never mistaken for a
        // crashed one and have its lock taken away.
        if (scanStatus.processedFiles % 50 === 0) scanLocks.heartbeat(library.id);
      }
    }

    // A partial traversal is not a filesystem snapshot. Never reconcile from
    // it, because an unreadable directory could contain all of the media that
    // would otherwise be mistaken for deleted files.
    if (discovery.complete && staged) {
      MediaModel.reconcileLibraryScan(library.id, scanGenerationId);
      LibraryModel.updateLastScanned(library.id);
      try {
        titleStore.pruneEmpty();
        metadataStore.pruneOrphanedMedia();
      } catch (error) {
        recordScanError(`Error pruning orphaned metadata for ${describeLibrary(library)}: ${errorMessage(error)}`, error);
      }
    }

    return {
      processed: scanStatus.processedFiles,
      errors: scanStatus.errors.length
    };
  } catch (error) {
    recordScanError(`Library scan failed for ${describeLibrary(library)}: ${errorMessage(error)}`, error);
    return {
      processed: scanStatus.processedFiles,
      errors: scanStatus.errors.length
    };
  } finally {
    scanStatus.isScanning = false;
    scanStatus.libraryId = null;
    scanLocks.release(libraryId);
  }
}

/**
 * The directories a library covers.
 *
 * `paths` is the real answer; `path` is the fallback for a library row written
 * before roots existed, or by a tool that only knew about the column.
 */
function libraryRoots(library: Library): string[] {
  return library.paths?.length ? library.paths : [library.path];
}

function describeLibrary(library: Library): string {
  return `${library.name} (${libraryRoots(library).join(', ')})`;
}

function findMediaFiles(roots: readonly string[], libraryType: Library['type']): MediaDiscoveryResult {
  // Roots are kept from overlapping when they are added, but a symlink or a
  // bind mount can still lead two of them to the same file. Dedupe, because a
  // file indexed twice is a duplicate the catalog cannot explain.
  const results = new Set<string>();
  const errors: string[] = [];
  let complete = true;

  function walk(currentDir: string) {
    let entries: fs.Dirent[] = [];
    try {
      entries = fs.readdirSync(currentDir, { withFileTypes: true });
    } catch (error) {
      complete = false;
      errors.push(`Error discovering files in ${currentDir}: ${errorMessage(error)}`);
      return;
    }

    for (const entry of entries) {
      const full = path.join(currentDir, entry.name);
      if (entry.isDirectory()) {
        // Skip hidden and system folders
        if (!entry.name.startsWith('.') && entry.name !== '@eaDir' && entry.name !== '$RECYCLE.BIN') {
          walk(full);
        }
      } else if (entry.isFile()) {
        const ext = path.extname(entry.name).toLowerCase();
        if (libraryType === 'music') {
          if (AUDIO_EXTENSIONS.has(ext)) results.add(full);
        } else {
          if (VIDEO_EXTENSIONS.has(ext)) results.add(full);
        }
      }
    }
  }

  for (const root of roots) {
    walk(root);
  }

  return { files: [...results].sort(), complete, errors };
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function recordScanError(message: string, error?: unknown): void {
  scanStatus.errors.push(message);
  if (error !== undefined) {
    console.error(message, error);
  } else {
    console.error(message);
  }
}

async function processMediaFile(
  library: Library,
  filePath: string,
  currentLibraryPaths: ReadonlySet<string>
): Promise<void> {
  const filename = path.basename(filePath);
  // Relative paths are what the UI shows and what filename parsing works from,
  // so they must be relative to the root this file came from. Measuring against
  // the wrong root of a multi-directory library yields a path full of "..".
  const root = rootForPath(libraryRoots(library), filePath) ?? library.path;
  const relativePath = path.relative(root, filePath);
  const stats = fs.statSync(filePath);

  const fingerprint = contentFingerprint(filePath);
  const identity = mediaIdentityStore.resolve({
    libraryId: library.id,
    fullPath: filePath,
    relativePath,
    originalFilename: filename,
    contentFingerprint: fingerprint,
    newId: `media_${crypto.randomUUID()}`,
    currentLibraryPaths
  });
  const fileId = identity.id;
  const parsed = parseFilename(filename, library.type);
  const metadata = await extractMediaMetadata(filePath);
  const musicTags = parsed.type === 'track'
    ? normalizeMusicTags(metadata?.format_tags, {
        filePath,
        libraryPath: root,
        fallbackTitle: parsed.title
      })
    : undefined;

  const streams = [...(metadata?.streams || [])];
  const externalTracks: Array<{ streamIndex: number; filePath: string; language?: string }> = [];
  if (parsed.type !== 'track') {
    const sidecars = findExternalSubtitles(filePath);
    for (let i = 0; i < sidecars.length; i++) {
      const streamIndex = EXTERNAL_SUBTITLE_INDEX_BASE + i;
      streams.push({
        index: streamIndex,
        codec_type: 'subtitle',
        codec_name: 'srt',
        codec_long_name: 'SubRip (external)',
        language: sidecars[i].language,
        is_external: true
      });
      externalTracks.push({
        streamIndex,
        filePath: sidecars[i].path,
        language: sidecars[i].language
      });
    }
  }

  const now = new Date().toISOString();

  // Existing files are left alone; missing thumbnails are retried on every scan.
  const thumbnail = await ensureMediaThumbnail({
    id: fileId,
    full_path: filePath,
    type: parsed.type,
    duration: metadata?.duration || 0
  });
  const posterPath = thumbnail.ok ? thumbnail.url : undefined;

  const mediaItem: Omit<MediaItem, 'progress' | 'library_name'> = {
    id: fileId,
    library_id: library.id,
    title: musicTags?.title || parsed.title || filename,
    original_filename: filename,
    relative_path: relativePath,
    full_path: filePath,
    type: parsed.type,
    series_title: parsed.seriesTitle,
    season_number: parsed.seasonNumber,
    episode_number: parsed.episodeNumber,
    year: musicTags?.year ?? parsed.year,
    duration: metadata?.duration || 0,
    size_bytes: stats.size,
    format: path.extname(filePath).replace('.', '').toLowerCase(),
    video_codec: metadata?.video?.codec,
    width: metadata?.video?.width,
    height: metadata?.video?.height,
    resolution_label: metadata?.video?.resolution_label,
    frame_rate: metadata?.video?.frame_rate,
    bit_rate: metadata?.video?.bit_rate || metadata?.bit_rate,
    is_hdr: metadata?.video?.is_hdr || false,
    audio_codec: metadata?.audio?.codec,
    audio_channels: metadata?.audio?.channels,
    audio_channel_layout: metadata?.audio?.channel_layout,
    audio_language: metadata?.audio?.language,
    artist: musicTags?.artist,
    album_artist: musicTags?.albumArtist,
    album: musicTags?.album,
    track_number: musicTags?.trackNumber,
    disc_number: musicTags?.discNumber,
    genre: musicTags?.genre,
    streams_json: JSON.stringify(streams),
    content_fingerprint: fingerprint,
    poster_path: posterPath,
    content_rating: metadata?.content_rating,
    created_at: now,
    updated_at: now
  };

  MediaModel.upsert(mediaItem);
  // Group this file under the work it belongs to, and normalise its streams
  // out of the JSON blob. Both are derived, so a rescan is idempotent.
  titleStore.linkMedia(fileId, {
    libraryId: library.id,
    type: mediaItem.type,
    title: mediaItem.title,
    seriesTitle: mediaItem.series_title,
    seasonNumber: mediaItem.season_number,
    episodeNumber: mediaItem.episode_number,
    year: mediaItem.year
  });
  titleStore.replaceStreams(fileId, streams);
  ExternalSubtitleModel.replaceAllForMedia(fileId, externalTracks);
  // Descriptive metadata is enrichment, not indexing: queued in the background
  // so a slow or missing provider never delays or fails the scan.
  metadataEnrichment.enqueue(mediaItem);
  if (mediaItem.type === 'episode') {
    enqueueMediaMarkerAnalysis({
      mediaId: mediaItem.id,
      fullPath: mediaItem.full_path,
      duration: mediaItem.duration
    });
  }
}
