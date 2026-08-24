import fs from 'fs';
import path from 'path';
import crypto from 'crypto';
import { extractMediaMetadata, parseFilename } from './metadata';
import { EXTERNAL_SUBTITLE_INDEX_BASE, findExternalSubtitles } from './subtitles';
import { ensureMediaThumbnail } from './thumbnails';
import { ExternalSubtitleModel, LibraryModel, MediaModel } from '../db';
import type { Library, MediaItem } from '../types';

const VIDEO_EXTENSIONS = new Set(['.mp4', '.mkv', '.mov', '.avi', '.webm', '.ts', '.m4v', '.flv', '.wmv', '.iso']);
const AUDIO_EXTENSIONS = new Set(['.mp3', '.flac', '.aac', '.m4a', '.wav', '.ogg', '.opus', '.wma', '.alac']);

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

  if (scanStatus.isScanning) {
    throw new Error('A scan is already in progress');
  }

  scanStatus.isScanning = true;
  scanStatus.libraryId = libraryId;
  scanStatus.processedFiles = 0;
  scanStatus.errors = [];

  try {
    if (!fs.existsSync(library.path)) {
      throw new Error(`Directory does not exist: ${library.path}`);
    }

    const files = findMediaFiles(library.path, library.type);
    scanStatus.totalFiles = files.length;

    const validFullPaths: string[] = [];

    for (const filePath of files) {
      scanStatus.currentFile = path.basename(filePath);
      try {
        await processMediaFile(library, filePath);
        validFullPaths.push(filePath);
      } catch (err: any) {
        scanStatus.errors.push(`Error processing ${filePath}: ${err.message}`);
        console.error(`Failed to process ${filePath}:`, err);
      }
      scanStatus.processedFiles++;
    }

    // Remove deleted files
    MediaModel.deleteNotFoundInPaths(library.id, validFullPaths);
    LibraryModel.updateLastScanned(library.id);

    return {
      processed: scanStatus.processedFiles,
      errors: scanStatus.errors.length
    };
  } finally {
    scanStatus.isScanning = false;
    scanStatus.libraryId = null;
  }
}

function findMediaFiles(dirPath: string, libraryType: string): string[] {
  const results: string[] = [];

  function walk(currentDir: string) {
    let entries: fs.Dirent[] = [];
    try {
      entries = fs.readdirSync(currentDir, { withFileTypes: true });
    } catch {
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
          if (AUDIO_EXTENSIONS.has(ext)) results.push(full);
        } else {
          if (VIDEO_EXTENSIONS.has(ext)) results.push(full);
        }
      }
    }
  }

  walk(dirPath);
  return results;
}

async function processMediaFile(library: Library, filePath: string): Promise<void> {
  const filename = path.basename(filePath);
  const relativePath = path.relative(library.path, filePath);
  const stats = fs.statSync(filePath);

  const fileId = crypto.createHash('md5').update(filePath).digest('hex').substring(0, 16);
  const parsed = parseFilename(filename, library.type);
  const metadata = await extractMediaMetadata(filePath);

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
    title: parsed.title || filename,
    original_filename: filename,
    relative_path: relativePath,
    full_path: filePath,
    type: parsed.type,
    series_title: parsed.seriesTitle,
    season_number: parsed.seasonNumber,
    episode_number: parsed.episodeNumber,
    year: parsed.year,
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
    streams_json: JSON.stringify(streams),
    poster_path: posterPath,
    content_rating: metadata?.content_rating,
    created_at: now,
    updated_at: now
  };

  MediaModel.upsert(mediaItem);
  ExternalSubtitleModel.replaceAllForMedia(fileId, externalTracks);
}
