import { Hono } from 'hono';
import fs from 'fs';
import path from 'path';
import crypto from 'crypto';
import { LibraryModel, MediaModel, ProgressModel } from '../db';
import { scanAllLibraries, scanLibrary, scanStatus } from '../scanner/indexer';
import { transcoder } from '../transcoder/engine';
import type { HardwareAccelType, TranscodeQuality } from '../types';

export const apiRouter = new Hono();

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

apiRouter.get('/media/:id', (c) => {
  const id = c.req.param('id');
  const item = MediaModel.getById(id);
  if (!item) {
    return c.json({ error: 'Media not found' }, 404);
  }
  return c.json({ item });
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
