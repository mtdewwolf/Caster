import crypto from 'crypto';
import fs from 'fs';
import path from 'path';
import type { MediaItem } from '../types';
import { generateThumbnail } from './metadata';

const THUMBNAIL_MEDIA_TYPES = new Set(['movie', 'episode', 'video']);
const thumbnailJobs = new Map<string, Promise<ThumbnailResult>>();

type ThumbnailMedia = Pick<MediaItem, 'id' | 'full_path' | 'type' | 'duration'>;

export interface ThumbnailResult {
  ok: boolean;
  generated: boolean;
  path: string;
  url: string;
  reason?: 'unsupported_media' | 'source_not_found' | 'generation_failed';
}

export function getThumbnailDirectory(): string {
  return process.env.THUMBNAILS_DIR || path.join(process.cwd(), 'data', 'thumbnails');
}

export function getThumbnailPath(mediaId: string): string {
  return path.join(getThumbnailDirectory(), `${mediaId}.jpg`);
}

export function getThumbnailUrl(mediaId: string): string {
  return `/api/media/${mediaId}/thumbnail`;
}

export function supportsThumbnail(type: string): boolean {
  return THUMBNAIL_MEDIA_TYPES.has(type);
}

export function getThumbnailSeekTime(duration: number): number {
  return duration > 60 ? Math.min(120, Math.floor(duration * 0.15)) : 10;
}

/**
 * Ensures a media item has a thumbnail. Non-forced calls backfill missing files,
 * while forced calls regenerate into a temporary file before replacing the old
 * thumbnail so a failed ffmpeg run does not destroy a working image.
 */
export function ensureMediaThumbnail(
  media: ThumbnailMedia,
  options: { force?: boolean } = {}
): Promise<ThumbnailResult> {
  const existingJob = thumbnailJobs.get(media.id);
  if (existingJob) return existingJob;

  const job = createMediaThumbnail(media, options.force === true).finally(() => {
    thumbnailJobs.delete(media.id);
  });
  thumbnailJobs.set(media.id, job);
  return job;
}

async function createMediaThumbnail(media: ThumbnailMedia, force: boolean): Promise<ThumbnailResult> {
  const targetPath = getThumbnailPath(media.id);
  const url = getThumbnailUrl(media.id);

  if (!supportsThumbnail(media.type)) {
    return { ok: false, generated: false, path: targetPath, url, reason: 'unsupported_media' };
  }

  if (!fs.existsSync(media.full_path)) {
    return { ok: false, generated: false, path: targetPath, url, reason: 'source_not_found' };
  }

  if (!force && fs.existsSync(targetPath)) {
    return { ok: true, generated: false, path: targetPath, url };
  }

  const temporaryPath = path.join(
    path.dirname(targetPath),
    `.${media.id}.${crypto.randomUUID()}.tmp.jpg`
  );

  try {
    const generated = await generateThumbnail(
      media.full_path,
      temporaryPath,
      getThumbnailSeekTime(media.duration || 0)
    );

    if (!generated) {
      return { ok: false, generated: false, path: targetPath, url, reason: 'generation_failed' };
    }

    fs.copyFileSync(temporaryPath, targetPath);
    return { ok: true, generated: true, path: targetPath, url };
  } catch (error) {
    console.error(`Failed to generate thumbnail for ${media.full_path}:`, error);
    return { ok: false, generated: false, path: targetPath, url, reason: 'generation_failed' };
  } finally {
    try {
      if (fs.existsSync(temporaryPath)) {
        fs.unlinkSync(temporaryPath);
      }
    } catch (error) {
      console.warn(`Failed to clean up temporary thumbnail ${temporaryPath}:`, error);
    }
  }
}
