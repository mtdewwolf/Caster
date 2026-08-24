import { spawn, execFileSync, type ChildProcessWithoutNullStreams } from 'child_process';
import fs from 'fs';
import path from 'path';
import crypto from 'crypto';
import type {
  ActiveTranscodeSession,
  CacheCleanResult,
  HardwareAccelType,
  QualityProfile,
  SystemHardwareStatus,
  TranscodeCacheStatus,
  TranscodeQuality,
  TranscodeSessionStatus
} from '../types';

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

function positiveIntegerEnv(name: string, fallback: number): number {
  const value = Number.parseInt(process.env[name] || '', 10);
  return Number.isSafeInteger(value) && value > 0 ? value : fallback;
}

export const TRANSCODE_MAX_CONCURRENT = positiveIntegerEnv('TRANSCODE_MAX_CONCURRENT', 2);
export const TRANSCODE_CACHE_MAX_AGE_HOURS = positiveIntegerEnv('TRANSCODE_CACHE_MAX_AGE_HOURS', 24);
export const TRANSCODE_CACHE_MAX_SIZE_MB = positiveIntegerEnv('TRANSCODE_CACHE_MAX_SIZE_MB', 10000); // 10 GB

if (!fs.existsSync(TRANSCODE_CACHE_DIR)) {
  fs.mkdirSync(TRANSCODE_CACHE_DIR, { recursive: true });
}

interface ActiveTranscodeJob extends ActiveTranscodeSession {
  process?: ChildProcessWithoutNullStreams;
  killed: boolean;
}

interface ExecFileOptions {
  encoding: 'utf8';
  timeout?: number;
}

export interface TranscodingEngineDependencies {
  execFileSync(command: string, args: string[], options: ExecFileOptions): string;
  spawn(command: string, args: string[]): ChildProcessWithoutNullStreams;
  existsSync(filePath: string): boolean;
  readdirSync(directoryPath: string): string[];
  platform: NodeJS.Platform;
  scheduleMaintenance: boolean;
  warn(...args: unknown[]): void;
}

const DEFAULT_ENGINE_DEPENDENCIES: TranscodingEngineDependencies = {
  execFileSync: (command, args, options) => String(execFileSync(command, args, options)),
  spawn: (command, args) => spawn(command, args),
  existsSync: (filePath) => fs.existsSync(filePath),
  readdirSync: (directoryPath) => fs.readdirSync(directoryPath, { encoding: 'utf8' }),
  platform: process.platform,
  scheduleMaintenance: true,
  warn: (...args) => console.warn(...args)
};

export class TranscodeCapacityError extends Error {
  constructor(public readonly limit: number) {
    super(`Transcode concurrency limit reached (${limit})`);
    this.name = 'TranscodeCapacityError';
  }
}

export class TranscodeKilledError extends Error {
  constructor() {
    super('Transcode was terminated by an administrator');
    this.name = 'TranscodeKilledError';
  }
}

export class TranscodingEngine {
  private readonly activeJobs = new Map<string, ActiveTranscodeJob>();
  private readonly inFlightSegments = new Map<string, Promise<Buffer>>();
  private readonly cacheWrites = new Set<string>();
  private readonly dependencies: TranscodingEngineDependencies;
  private hardwareStatus: SystemHardwareStatus | null = null;
  private qsvDevicePath: string | undefined;
  private vaapiDevicePath: string | undefined;
  private nvidiaDevicePath: string | undefined;
  private cleanupTimer: any = null;

  constructor(dependencies: Partial<TranscodingEngineDependencies> = {}) {
    this.dependencies = { ...DEFAULT_ENGINE_DEPENDENCIES, ...dependencies };
    this.detectHardware();

    if (!this.dependencies.scheduleMaintenance) return;

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
    const renderDevices = this.findRenderDevices();
    const nvidiaDevice = this.findNvidiaDevice();
    this.qsvDevicePath = undefined;
    this.vaapiDevicePath = undefined;
    this.nvidiaDevicePath = nvidiaDevice;

    try {
      const versionOut = this.dependencies.execFileSync('ffmpeg', ['-version'], {
        encoding: 'utf8',
        timeout: 5000
      });
      ffmpegVersion = versionOut.split('\n')[0] || 'Available';

      const encodersOut = this.dependencies.execFileSync('ffmpeg', ['-hide_banner', '-encoders'], {
        encoding: 'utf8',
        timeout: 5000
      });
      const isLinux = this.dependencies.platform === 'linux';
      const isWindows = this.dependencies.platform === 'win32';

      // FFmpeg distributions commonly list hardware encoders even when the
      // host has no matching GPU, driver, device mapping, or permissions. A
      // short functional encode probe makes the status describe what this
      // process can actually use instead of what FFmpeg was compiled with.
      nvencSupported =
        encodersOut.includes('h264_nvenc') &&
        (isWindows || (isLinux && Boolean(nvidiaDevice))) &&
        this.probeHardwareEncoder('nvenc', nvidiaDevice);

      if (encodersOut.includes('h264_qsv')) {
        if (isWindows) {
          qsvSupported = this.probeHardwareEncoder('qsv');
        } else if (isLinux) {
          this.qsvDevicePath = renderDevices.find((devicePath) =>
            this.probeHardwareEncoder('qsv', devicePath)
          );
          qsvSupported = Boolean(this.qsvDevicePath);
        }
      }

      if (encodersOut.includes('h264_vaapi') && isLinux) {
        this.vaapiDevicePath = renderDevices.find((devicePath) =>
          this.probeHardwareEncoder('vaapi', devicePath)
        );
        vaapiSupported = Boolean(this.vaapiDevicePath);
      }

      if (nvencSupported) accelType = 'nvenc';
      else if (qsvSupported) accelType = 'qsv';
      else if (vaapiSupported) accelType = 'vaapi';
    } catch (e) {
      this.dependencies.warn('FFmpeg hardware detection warning:', e);
    }

    this.hardwareStatus = {
      accelType,
      devicePath: this.devicePathForAccel(accelType),
      ffmpegVersion,
      qsvSupported,
      nvencSupported,
      vaapiSupported,
      activeTranscodes: this.activeJobs.size,
      maxConcurrentTranscodes: TRANSCODE_MAX_CONCURRENT
    };

    return this.hardwareStatus;
  }

  private findRenderDevices(): string[] {
    if (this.dependencies.platform !== 'linux') return [];

    try {
      return this.dependencies
        .readdirSync('/dev/dri')
        .filter((name) => /^renderD\d+$/.test(name))
        .sort((left, right) => left.localeCompare(right, 'en', { numeric: true }))
        .map((deviceName) => path.posix.join('/dev/dri', deviceName));
    } catch {
      return [];
    }
  }

  private findNvidiaDevice(): string | undefined {
    if (this.dependencies.platform !== 'linux') return undefined;

    const devicePaths = ['/dev/nvidia0', '/dev/nvidiactl'];
    return devicePaths.find((devicePath) => this.dependencies.existsSync(devicePath));
  }

  private devicePathForAccel(accel: HardwareAccelType): string | undefined {
    if (accel === 'nvenc') return this.nvidiaDevicePath;
    if (accel === 'qsv') return this.qsvDevicePath;
    if (accel === 'vaapi') return this.vaapiDevicePath;
    return undefined;
  }

  private probeHardwareEncoder(accel: Exclude<HardwareAccelType, 'none'>, devicePath?: string): boolean {
    const args = ['-hide_banner', '-loglevel', 'error'];

    if (accel === 'qsv' && devicePath) {
      args.push('-qsv_device', devicePath);
    } else if (accel === 'vaapi' && devicePath) {
      args.push('-vaapi_device', devicePath);
    }

    args.push(
      '-f', 'lavfi',
      '-i', 'color=c=black:s=64x64:r=1',
      '-frames:v', '1',
      '-an'
    );

    if (accel === 'vaapi') {
      args.push('-vf', 'format=nv12,hwupload');
    }

    args.push('-c:v', `h264_${accel}`, '-f', 'null', '-');

    try {
      this.dependencies.execFileSync('ffmpeg', args, {
        encoding: 'utf8',
        timeout: 5000
      });
      return true;
    } catch {
      return false;
    }
  }

  public getHardwareStatus(): SystemHardwareStatus {
    if (!this.hardwareStatus) {
      return this.detectHardware();
    }
    this.hardwareStatus.activeTranscodes = this.activeJobs.size;
    this.hardwareStatus.maxConcurrentTranscodes = TRANSCODE_MAX_CONCURRENT;
    return this.hardwareStatus;
  }

  public getTranscodeStatus(): TranscodeSessionStatus {
    return {
      activeTranscodes: this.activeJobs.size,
      maxConcurrentTranscodes: TRANSCODE_MAX_CONCURRENT,
      acceptingTranscodes: this.activeJobs.size < TRANSCODE_MAX_CONCURRENT,
      sessions: Array.from(this.activeJobs.values(), ({ process: _process, killed: _killed, ...session }) => session)
    };
  }

  public killAllTranscodes(): number {
    const jobs = Array.from(this.activeJobs.values());
    for (const job of jobs) {
      job.killed = true;
      if (job.process && job.process.exitCode === null && job.process.signalCode === null) {
        try {
          job.process.kill('SIGKILL');
        } catch (err) {
          console.warn(`Failed to terminate transcode ${job.id}:`, err);
        }
      }
    }
    return jobs.length;
  }

  public setPreferredAccel(type: HardwareAccelType) {
    if (this.hardwareStatus) {
      this.hardwareStatus.accelType = type;
      this.hardwareStatus.devicePath = this.devicePathForAccel(this.hardwareStatus.accelType);
    }
  }

  /**
   * Generates HLS Master Playlist (.m3u8) for adaptive bitrate
   */
  public generateMasterPlaylist(
    mediaId: string,
    itemWidth: number = 1920,
    itemHeight: number = 1080,
    querySuffix: string = ''
  ): string {
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
        `/api/media/${mediaId}/hls/${quality}/index.m3u8${querySuffix}`
      );
    }

    return lines.join('\n') + '\n';
  }

  /**
   * Generates HLS Variant Playlist (.m3u8) for a specific quality
   */
  public generateVariantPlaylist(
    mediaId: string,
    duration: number,
    quality: TranscodeQuality,
    querySuffix: string = ''
  ): string {
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
        `/api/media/${mediaId}/hls/${quality}/segment-${i}.ts${querySuffix}`
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
        if (this.cacheWrites.has(fullPath)) {
          cacheFiles.push({
            name,
            fullPath,
            size: stat.size,
            mtime: stat.mtimeMs
          });
        } else if (now - stat.mtimeMs > maxAgeMs) {
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
        if (this.cacheWrites.has(file.fullPath)) continue;
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
        fs.utimesSync(cacheFile, now, now);
      } catch {}
      return fs.readFileSync(cacheFile);
    }

    // Coalesce simultaneous requests for the same segment into one FFmpeg job.
    const existing = this.inFlightSegments.get(cacheKey);
    if (existing) return existing;

    const request = this.runTranscode(filePath, mediaId, quality, seq, cacheFile);
    this.inFlightSegments.set(cacheKey, request);

    try {
      return await request;
    } finally {
      if (this.inFlightSegments.get(cacheKey) === request) {
        this.inFlightSegments.delete(cacheKey);
      }
    }
  }

  private async runTranscode(
    filePath: string,
    mediaId: string,
    quality: TranscodeQuality,
    seq: number,
    cacheFile: string
  ): Promise<Buffer> {
    if (this.activeJobs.size >= TRANSCODE_MAX_CONCURRENT) {
      throw new TranscodeCapacityError(TRANSCODE_MAX_CONCURRENT);
    }

    const job: ActiveTranscodeJob = {
      id: crypto.randomUUID(),
      mediaId,
      quality,
      sequence: seq,
      startedAt: new Date().toISOString(),
      killed: false
    };
    this.activeJobs.set(job.id, job);

    const startTime = seq * HLS_SEGMENT_DURATION;
    const profile = QUALITY_PROFILES[quality] || QUALITY_PROFILES['720p'];
    const accel = this.hardwareStatus?.accelType || 'none';

    try {
      const buffer = await this.transcodeSegment(filePath, startTime, HLS_SEGMENT_DURATION, profile, accel, job);
      if (job.killed) throw new TranscodeKilledError();

      // A completed write immediately enforces the cache budget, so growth is
      // bounded between periodic maintenance runs as well as across restarts.
      this.cacheWrites.add(cacheFile);
      try {
        await fs.promises.writeFile(cacheFile, buffer);
        if (job.killed) {
          await fs.promises.unlink(cacheFile).catch(() => {});
          throw new TranscodeKilledError();
        }
      } catch (err) {
        await fs.promises.unlink(cacheFile).catch(() => {});
        if (err instanceof TranscodeKilledError) throw err;
        console.warn(`Failed to cache transcode segment ${cacheFile}:`, err);
      } finally {
        this.cacheWrites.delete(cacheFile);
      }
      try {
        this.cleanCache();
      } catch (err) {
        console.warn('Failed to enforce transcode cache budget:', err);
      }
      return buffer;
    } finally {
      this.activeJobs.delete(job.id);
    }
  }

  private transcodeSegment(
    filePath: string,
    startTime: number,
    duration: number,
    profile: QualityProfile,
    accel: HardwareAccelType,
    job: ActiveTranscodeJob
  ): Promise<Buffer> {
    return new Promise((resolve, reject) => {
      if (job.killed) {
        reject(new TranscodeKilledError());
        return;
      }

      const args: string[] = ['-hide_banner', '-loglevel', 'error'];
      const hardwareDevicePath = this.devicePathForAccel(accel);

      // Seek before input for super fast keyframe seeking
      args.push('-ss', startTime.toString());

      // Hardware acceleration input flags
      if (accel === 'nvenc') {
        args.push('-hwaccel', 'cuda');
      } else if (accel === 'vaapi' && hardwareDevicePath) {
        args.push('-hwaccel', 'vaapi', '-vaapi_device', hardwareDevicePath);
      } else if (accel === 'qsv') {
        args.push('-hwaccel', 'qsv');
        if (hardwareDevicePath) {
          args.push('-qsv_device', hardwareDevicePath);
        }
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

      const ffmpeg = this.dependencies.spawn('ffmpeg', args);
      job.process = ffmpeg;
      const chunks: Buffer[] = [];
      let errLog = '';
      let settled = false;

      const finish = (callback: () => void) => {
        if (settled) return;
        settled = true;
        if (job.process === ffmpeg) job.process = undefined;
        callback();
      };

      ffmpeg.stdout.on('data', (chunk) => {
        chunks.push(chunk);
      });

      ffmpeg.stderr.on('data', (chunk) => {
        errLog += chunk.toString();
      });

      ffmpeg.on('close', (code) => {
        if (settled) return;
        if (job.killed) {
          finish(() => reject(new TranscodeKilledError()));
          return;
        }
        if (code === 0 && chunks.length > 0) {
          finish(() => resolve(Buffer.concat(chunks)));
        } else {
          // If hardware failed, try CPU fallback
          if (accel !== 'none') {
            // Avoid paying the same known-bad hardware startup penalty for
            // every later segment. Capability remains visible so an operator
            // can explicitly retry it after fixing a transient device issue.
            if (this.hardwareStatus?.accelType === accel) {
              this.hardwareStatus.accelType = 'none';
              this.hardwareStatus.devicePath = undefined;
            }
            this.dependencies.warn(`Hardware accel (${accel}) segment failed, falling back to CPU. Error:`, errLog);
            finish(() => {
              this.transcodeSegment(filePath, startTime, duration, profile, 'none', job)
                .then(resolve)
                .catch(reject);
            });
          } else {
            finish(() => reject(new Error(`FFmpeg transcoding failed (code ${code}): ${errLog}`)));
          }
        }
      });

      ffmpeg.on('error', (err) => {
        if (settled) return;
        finish(() => reject(job.killed ? new TranscodeKilledError() : err));
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
