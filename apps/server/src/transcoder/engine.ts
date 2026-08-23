import { spawn, execSync } from 'child_process';
import fs from 'fs';
import path from 'path';
import type { CacheCleanResult, HardwareAccelType, QualityProfile, SystemHardwareStatus, TranscodeCacheStatus, TranscodeQuality } from '../types';

export const QUALITY_PROFILES: Record<TranscodeQuality, QualityProfile> = {
  original: {
    name: 'original',
    width: 0,
    height: 0,
    videoBitrate: 'copy',
    maxBitrate: 'copy',
    audioBitrate: 'copy',
    bufsize: 'copy'
  },
  '1080p': {
    name: '1080p',
    width: 1920,
    height: 1080,
    videoBitrate: '8000k',
    maxBitrate: '10000k',
    audioBitrate: '256k',
    bufsize: '16000k'
  },
  '720p': {
    name: '720p',
    width: 1280,
    height: 720,
    videoBitrate: '4000k',
    maxBitrate: '5000k',
    audioBitrate: '192k',
    bufsize: '8000k'
  },
  '480p': {
    name: '480p',
    width: 854,
    height: 480,
    videoBitrate: '1800k',
    maxBitrate: '2500k',
    audioBitrate: '128k',
    bufsize: '4000k'
  },
  '360p': {
    name: '360p',
    width: 640,
    height: 360,
    videoBitrate: '800k',
    maxBitrate: '1200k',
    audioBitrate: '96k',
    bufsize: '2000k'
  }
};

const HLS_SEGMENT_DURATION = 6; // 6 seconds per segment
export const TRANSCODE_CACHE_DIR = process.env.TRANSCODE_CACHE_DIR || path.join(process.cwd(), 'data', 'transcode_cache');
export const TRANSCODE_CACHE_MAX_AGE_HOURS = parseInt(process.env.TRANSCODE_CACHE_MAX_AGE_HOURS || '24', 10);
export const TRANSCODE_CACHE_MAX_SIZE_MB = parseInt(process.env.TRANSCODE_CACHE_MAX_SIZE_MB || '10000', 10); // 10 GB

if (!fs.existsSync(TRANSCODE_CACHE_DIR)) {
  fs.mkdirSync(TRANSCODE_CACHE_DIR, { recursive: true });
}

class TranscodingEngine {
  private activeJobs = 0;
  private hardwareStatus: SystemHardwareStatus | null = null;
  private cleanupTimer: any = null;

  constructor() {
    this.detectHardware();

    // Run initial startup cleanup asynchronously after brief delay
    setTimeout(() => {
      try {
        const res = this.cleanCache();
        if (res.deletedCount > 0) {
          console.log(`🧹 Transcode Cache: Startup cleaned ${res.deletedCount} expired segments (${Math.round(res.bytesFreed / (1024 * 1024))} MB freed)`);
        }
      } catch (err) {
        console.warn('Transcode cache initial cleanup error:', err);
      }
    }, 1000);

    // Schedule hourly eviction interval
    this.cleanupTimer = setInterval(() => {
      try {
        this.cleanCache();
      } catch (err) {
        console.warn('Transcode cache periodic cleanup error:', err);
      }
    }, 60 * 60 * 1000);
  }

  public detectHardware(): SystemHardwareStatus {
    let ffmpegVersion = 'Unknown';
    let qsvSupported = false;
    let nvencSupported = false;
    let vaapiSupported = false;
    let accelType: HardwareAccelType = 'none';

    try {
      const versionOut = execSync('ffmpeg -version', { encoding: 'utf8' });
      ffmpegVersion = versionOut.split('\n')[0] || 'Available';

      const encodersOut = execSync('ffmpeg -encoders', { encoding: 'utf8' });
      qsvSupported = encodersOut.includes('h264_qsv');
      nvencSupported = encodersOut.includes('h264_nvenc');
      vaapiSupported = encodersOut.includes('h264_vaapi');

      // Check device availability
      const hasDri = fs.existsSync('/dev/dri/renderD128');
      
      if (nvencSupported) {
        // Test nvidia if available
        accelType = 'nvenc';
      } else if (hasDri && qsvSupported) {
        accelType = 'qsv';
      } else if (hasDri && vaapiSupported) {
        accelType = 'vaapi';
      } else if (qsvSupported) {
        accelType = 'qsv';
      } else {
        accelType = 'none';
      }
    } catch (e) {
      console.warn('FFmpeg hardware detection warning:', e);
    }

    this.hardwareStatus = {
      accelType,
      devicePath: fs.existsSync('/dev/dri/renderD128') ? '/dev/dri/renderD128' : undefined,
      ffmpegVersion,
      qsvSupported,
      nvencSupported,
      vaapiSupported,
      activeTranscodes: this.activeJobs
    };

    return this.hardwareStatus;
  }

  public getHardwareStatus(): SystemHardwareStatus {
    if (!this.hardwareStatus) {
      return this.detectHardware();
    }
    this.hardwareStatus.activeTranscodes = this.activeJobs;
    return this.hardwareStatus;
  }

  public setPreferredAccel(type: HardwareAccelType) {
    if (this.hardwareStatus) {
      this.hardwareStatus.accelType = type;
    }
  }

  /**
   * Generates HLS Master Playlist (.m3u8) for adaptive bitrate
   */
  public generateMasterPlaylist(mediaId: string, itemWidth: number = 1920, itemHeight: number = 1080): string {
    const lines = ['#EXTM3U', '#EXT-X-VERSION:3'];

    const profiles: TranscodeQuality[] = ['1080p', '720p', '480p', '360p'];

    for (const quality of profiles) {
      const p = QUALITY_PROFILES[quality];
      // Only include qualities less than or equal to source resolution (or at least 360p)
      if (itemHeight && itemHeight < p.height && quality !== '360p') {
        continue;
      }

      const bandwidth = parseInt(p.maxBitrate, 10) * 1000 + parseInt(p.audioBitrate, 10) * 1000;
      lines.push(
        `#EXT-X-STREAM-INF:BANDWIDTH=${bandwidth},RESOLUTION=${p.width}x${p.height},NAME="${quality}"`,
        `/api/media/${mediaId}/hls/${quality}/index.m3u8`
      );
    }

    return lines.join('\n') + '\n';
  }

  /**
   * Generates HLS Variant Playlist (.m3u8) for a specific quality
   */
  public generateVariantPlaylist(mediaId: string, duration: number, quality: TranscodeQuality): string {
    const totalSegments = Math.ceil(duration / HLS_SEGMENT_DURATION);
    const lines = [
      '#EXTM3U',
      '#EXT-X-VERSION:3',
      `#EXT-X-TARGETDURATION:${HLS_SEGMENT_DURATION + 1}`,
      '#EXT-X-MEDIA-SEQUENCE:0',
      '#EXT-X-PLAYLIST-TYPE:VOD'
    ];

    for (let i = 0; i < totalSegments; i++) {
      const segDuration = i === totalSegments - 1 ? (duration % HLS_SEGMENT_DURATION || HLS_SEGMENT_DURATION) : HLS_SEGMENT_DURATION;
      lines.push(
        `#EXTINF:${segDuration.toFixed(3)},`,
        `/api/media/${mediaId}/hls/${quality}/segment-${i}.ts`
      );
    }

    lines.push('#EXT-X-ENDLIST');
    return lines.join('\n') + '\n';
  }

  /**
   * Returns current transcode cache statistics
   */
  public getCacheStatus(): TranscodeCacheStatus {
    let fileCount = 0;
    let totalSizeBytes = 0;

    if (fs.existsSync(TRANSCODE_CACHE_DIR)) {
      const files = fs.readdirSync(TRANSCODE_CACHE_DIR);
      for (const file of files) {
        if (file.endsWith('.ts')) {
          try {
            const stat = fs.statSync(path.join(TRANSCODE_CACHE_DIR, file));
            fileCount++;
            totalSizeBytes += stat.size;
          } catch {}
        }
      }
    }

    return {
      cacheDir: TRANSCODE_CACHE_DIR,
      fileCount,
      totalSizeBytes,
      totalSizeMb: Math.round((totalSizeBytes / (1024 * 1024)) * 100) / 100,
      maxAgeHours: TRANSCODE_CACHE_MAX_AGE_HOURS,
      maxSizeMb: TRANSCODE_CACHE_MAX_SIZE_MB
    };
  }

  /**
   * Evicts expired transcode cache segments and enforces maximum size budget (LRU)
   */
  public cleanCache(options?: { maxAgeHours?: number; maxSizeBytes?: number }): CacheCleanResult {
    const maxAgeHours = options?.maxAgeHours ?? TRANSCODE_CACHE_MAX_AGE_HOURS;
    const maxSizeBytes = options?.maxSizeBytes ?? (TRANSCODE_CACHE_MAX_SIZE_MB * 1024 * 1024);
    const now = Date.now();
    const maxAgeMs = maxAgeHours * 60 * 60 * 1000;

    let deletedCount = 0;
    let bytesFreed = 0;

    if (!fs.existsSync(TRANSCODE_CACHE_DIR)) {
      return { deletedCount: 0, bytesFreed: 0, remainingCount: 0, remainingBytes: 0 };
    }

    interface CacheFileInfo {
      name: string;
      fullPath: string;
      size: number;
      mtime: number;
    }

    const cacheFiles: CacheFileInfo[] = [];

    const fileNames = fs.readdirSync(TRANSCODE_CACHE_DIR);
    for (const name of fileNames) {
      if (!name.endsWith('.ts')) continue;
      const fullPath = path.join(TRANSCODE_CACHE_DIR, name);
      try {
        const stat = fs.statSync(fullPath);
        // Evict expired files first (TTL)
        if (now - stat.mtimeMs > maxAgeMs) {
          fs.unlinkSync(fullPath);
          deletedCount++;
          bytesFreed += stat.size;
        } else {
          cacheFiles.push({
            name,
            fullPath,
            size: stat.size,
            mtime: stat.mtimeMs
          });
        }
      } catch (err) {
        console.warn(`Failed to inspect/delete cache file ${name}:`, err);
      }
    }

    // Check size budget (LRU eviction)
    let currentTotalBytes = cacheFiles.reduce((acc, f) => acc + f.size, 0);

    if (currentTotalBytes > maxSizeBytes) {
      // Sort oldest mtime first for LRU eviction
      cacheFiles.sort((a, b) => a.mtime - b.mtime);

      for (const file of cacheFiles) {
        if (currentTotalBytes <= maxSizeBytes) break;
        try {
          fs.unlinkSync(file.fullPath);
          deletedCount++;
          bytesFreed += file.size;
          currentTotalBytes -= file.size;
        } catch (err) {
          console.warn(`Failed to delete LRU cache file ${file.name}:`, err);
        }
      }
    }

    const remainingFiles = fs.readdirSync(TRANSCODE_CACHE_DIR).filter((f) => f.endsWith('.ts'));
    let remainingBytes = 0;
    for (const f of remainingFiles) {
      try {
        remainingBytes += fs.statSync(path.join(TRANSCODE_CACHE_DIR, f)).size;
      } catch {}
    }

    return {
      deletedCount,
      bytesFreed,
      remainingCount: remainingFiles.length,
      remainingBytes
    };
  }

  /**
   * Clears all transcode cache files immediately
   */
  public clearAllCache(): CacheCleanResult {
    return this.cleanCache({ maxAgeHours: 0, maxSizeBytes: 0 });
  }

  /**
   * Transcodes an individual HLS segment on the fly with hardware acceleration
   */
  public async getHlsSegment(filePath: string, mediaId: string, quality: TranscodeQuality, seq: number): Promise<Buffer> {
    const cacheKey = `${mediaId}_${quality}_seg${seq}.ts`;
    const cacheFile = path.join(TRANSCODE_CACHE_DIR, cacheKey);

    // Return cached segment if already exists
    if (fs.existsSync(cacheFile)) {
      // Update access time for LRU tracking
      try {
        const now = new Date();
        fs.utimes(cacheFile, now, now, () => {});
      } catch {}
      return fs.readFileSync(cacheFile);
    }

    const startTime = seq * HLS_SEGMENT_DURATION;
    const profile = QUALITY_PROFILES[quality] || QUALITY_PROFILES['720p'];
    const accel = this.hardwareStatus?.accelType || 'none';

    this.activeJobs++;

    try {
      const buffer = await this.transcodeSegment(filePath, startTime, HLS_SEGMENT_DURATION, profile, accel);
      // Asynchronously cache segment
      fs.writeFile(cacheFile, buffer, () => {});
      return buffer;
    } finally {
      this.activeJobs = Math.max(0, this.activeJobs - 1);
    }
  }

  private transcodeSegment(
    filePath: string,
    startTime: number,
    duration: number,
    profile: QualityProfile,
    accel: HardwareAccelType
  ): Promise<Buffer> {
    return new Promise((resolve, reject) => {
      const args: string[] = ['-hide_banner', '-loglevel', 'error'];

      // Seek before input for super fast keyframe seeking
      args.push('-ss', startTime.toString());

      // Hardware acceleration input flags
      if (accel === 'nvenc') {
        args.push('-hwaccel', 'cuda');
      } else if (accel === 'vaapi' && fs.existsSync('/dev/dri/renderD128')) {
        args.push('-hwaccel', 'vaapi', '-vaapi_device', '/dev/dri/renderD128');
      } else if (accel === 'qsv') {
        args.push('-hwaccel', 'qsv');
      }

      args.push('-i', filePath, '-t', duration.toString());

      // Video encoding parameters
      if (accel === 'nvenc') {
        args.push(
          '-c:v', 'h264_nvenc',
          '-preset', 'p4',
          '-b:v', profile.videoBitrate,
          '-maxrate', profile.maxBitrate,
          '-bufsize', profile.bufsize,
          '-vf', `scale=${profile.width}:${profile.height}:force_original_aspect_ratio=decrease,pad=${profile.width}:${profile.height}:(ow-iw)/2:(oh-ih)/2`
        );
      } else if (accel === 'qsv') {
        args.push(
          '-c:v', 'h264_qsv',
          '-preset', 'veryfast',
          '-b:v', profile.videoBitrate,
          '-maxrate', profile.maxBitrate,
          '-bufsize', profile.bufsize,
          '-vf', `scale=${profile.width}:${profile.height}:force_original_aspect_ratio=decrease`
        );
      } else if (accel === 'vaapi') {
        args.push(
          '-vf', `format=nv12|vaapi,hwupload,scale_vaapi=w=${profile.width}:h=${profile.height}`,
          '-c:v', 'h264_vaapi',
          '-b:v', profile.videoBitrate,
          '-maxrate', profile.maxBitrate,
          '-bufsize', profile.bufsize
        );
      } else {
        // CPU fallback with ultrafast preset
        args.push(
          '-c:v', 'libx264',
          '-preset', 'ultrafast',
          '-tune', 'zerolatency',
          '-b:v', profile.videoBitrate,
          '-maxrate', profile.maxBitrate,
          '-bufsize', profile.bufsize,
          '-vf', `scale=${profile.width}:${profile.height}:force_original_aspect_ratio=decrease,pad=${profile.width}:${profile.height}:(ow-iw)/2:(oh-ih)/2`
        );
      }

      // Audio & Container parameters
      args.push(
        '-c:a', 'aac',
        '-ac', '2',
        '-b:a', profile.audioBitrate,
        '-f', 'mpegts',
        'pipe:1'
      );

      const ffmpeg = spawn('ffmpeg', args);
      const chunks: Buffer[] = [];
      let errLog = '';

      ffmpeg.stdout.on('data', (chunk) => {
        chunks.push(chunk);
      });

      ffmpeg.stderr.on('data', (chunk) => {
        errLog += chunk.toString();
      });

      ffmpeg.on('close', (code) => {
        if (code === 0 && chunks.length > 0) {
          resolve(Buffer.concat(chunks));
        } else {
          // If hardware failed, try CPU fallback
          if (accel !== 'none') {
            console.warn(`Hardware accel (${accel}) segment failed, falling back to CPU. Error:`, errLog);
            this.transcodeSegment(filePath, startTime, duration, profile, 'none')
              .then(resolve)
              .catch(reject);
          } else {
            reject(new Error(`FFmpeg transcoding failed (code ${code}): ${errLog}`));
          }
        }
      });

      ffmpeg.on('error', (err) => {
        reject(err);
      });
    });
  }

  /**
   * Extracts WebVTT subtitles from an internal subtitle track
   */
  public async extractSubtitlesVtt(filePath: string, streamIndex: number): Promise<string> {
    return new Promise((resolve, reject) => {
      const ffmpeg = spawn('ffmpeg', [
        '-hide_banner',
        '-loglevel', 'error',
        '-i', filePath,
        '-map', `0:${streamIndex}`,
        '-f', 'webvtt',
        'pipe:1'
      ]);

      let output = '';
      ffmpeg.stdout.on('data', (chunk) => {
        output += chunk.toString();
      });

      ffmpeg.on('close', (code) => {
        if (code === 0 && output) {
          resolve(output);
        } else {
          // Fallback empty VTT
          resolve('WEBVTT\n\n');
        }
      });

      ffmpeg.on('error', (err) => {
        reject(err);
      });
    });
  }
}

export const transcoder = new TranscodingEngine();
