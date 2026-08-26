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
import {
  audioCacheKey,
  planAudioStream,
  type AudioMode,
  type AudioPlan,
  type AudioSourceInfo
} from './audio';
import {
  decideSegmentSource,
  DEFAULT_LOOKAHEAD_SEGMENTS,
  sessionKey
} from './session-planner';
import {
  SegmentUnavailableError,
  SessionStoppedError,
  TranscodeSession
} from './session';

export { SegmentUnavailableError, SessionStoppedError, TranscodeSession } from './session';
import {
  planSubtitles,
  subtitleCacheKey,
  type SubtitlePlan,
  type SubtitleTrackSummary
} from './subtitles';
export * from './subtitles';
export * from './capabilities';
export * from './playback-plan';
export * from './quality';
import type { PlaybackPlan } from './playback-plan';
import { profileByName, type ClientCapabilities } from './capabilities';
import {
  encoderNameFor,
  encoderNamesFrom,
  encodersFromFfmpegList,
  INIT_SEGMENT_NAME,
  packagingFor,
  profileForSelection,
  segmentExtension,
  selectQuality,
  type EncoderAvailability,
  type NetworkClass,
  type OutputCodec,
  type QualitySelection,
  type SegmentPackaging
} from './quality';

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

/** A file that is part of a stream, whichever packaging produced it. */
function isSegmentFile(name: string): boolean {
  return name.endsWith('.ts') || name.endsWith('.m4s') || name === INIT_SEGMENT_NAME;
}
export const TRANSCODE_CACHE_DIR = process.env.TRANSCODE_CACHE_DIR || path.join(process.cwd(), 'data', 'transcode_cache');

function positiveIntegerEnv(name: string, fallback: number): number {
  const value = Number.parseInt(process.env[name] || '', 10);
  return Number.isSafeInteger(value) && value > 0 ? value : fallback;
}

export const TRANSCODE_MAX_CONCURRENT = positiveIntegerEnv('TRANSCODE_MAX_CONCURRENT', 2);
export const TRANSCODE_CACHE_MAX_AGE_HOURS = positiveIntegerEnv('TRANSCODE_CACHE_MAX_AGE_HOURS', 24);
export const TRANSCODE_CACHE_MAX_SIZE_MB = positiveIntegerEnv('TRANSCODE_CACHE_MAX_SIZE_MB', 10000); // 10 GB

/** How far ahead of the encoder a request waits before re-seeking instead. */
export const TRANSCODE_LOOKAHEAD_SEGMENTS =
  positiveIntegerEnv('TRANSCODE_LOOKAHEAD_SEGMENTS', DEFAULT_LOOKAHEAD_SEGMENTS);
/** Idle time before an unwatched session is stopped and its files removed. */
export const TRANSCODE_SESSION_IDLE_MS =
  positiveIntegerEnv('TRANSCODE_SESSION_IDLE_SECONDS', 120) * 1000;
/** Longest a single segment request will wait for the encoder to reach it. */
export const TRANSCODE_SEGMENT_WAIT_MS =
  positiveIntegerEnv('TRANSCODE_SEGMENT_WAIT_SECONDS', 45) * 1000;
export const TRANSCODE_SEGMENT_POLL_MS =
  positiveIntegerEnv('TRANSCODE_SEGMENT_POLL_MS', 120);

if (!fs.existsSync(TRANSCODE_CACHE_DIR)) {
  fs.mkdirSync(TRANSCODE_CACHE_DIR, { recursive: true });
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
  /** Session timings, overridable so tests need not wait on real intervals. */
  sessionIdleMs: number;
  segmentWaitMs: number;
  segmentPollMs: number;
  cacheDirectory: string;
}

const DEFAULT_ENGINE_DEPENDENCIES: TranscodingEngineDependencies = {
  execFileSync: (command, args, options) => String(execFileSync(command, args, options)),
  spawn: (command, args) => spawn(command, args),
  existsSync: (filePath) => fs.existsSync(filePath),
  readdirSync: (directoryPath) => fs.readdirSync(directoryPath, { encoding: 'utf8' }),
  platform: process.platform,
  scheduleMaintenance: true,
  warn: (...args) => console.warn(...args),
  sessionIdleMs: TRANSCODE_SESSION_IDLE_MS,
  segmentWaitMs: TRANSCODE_SEGMENT_WAIT_MS,
  segmentPollMs: TRANSCODE_SEGMENT_POLL_MS,
  cacheDirectory: TRANSCODE_CACHE_DIR
};

/** What the caller knows about the client and its connection. */
export interface StreamRequestOptions {
  capabilities?: ClientCapabilities | undefined;
  network?: NetworkClass | undefined;
  source?: {
    height?: number | undefined;
    bitRate?: number | undefined;
    frameRate?: number | undefined;
  } | undefined;
}

interface DescribedStream {
  key: string;
  profile: QualityProfile;
  audioPlan: AudioPlan;
  subtitlePlan: SubtitlePlan;
  codec: OutputCodec;
  packaging: SegmentPackaging;
  selection: QualitySelection | null;
}

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
  private readonly sessions = new Map<string, TranscodeSession>();
  /** Serialises concurrent requests for the same stream identity. */
  private readonly sessionLocks = new Map<string, Promise<void>>();
  private readonly dependencies: TranscodingEngineDependencies;
  private hardwareStatus: SystemHardwareStatus | null = null;
  private qsvDevicePath: string | undefined;
  private vaapiDevicePath: string | undefined;
  private nvidiaDevicePath: string | undefined;
  /** Which output codecs this FFmpeg build can produce, by codec. */
  private outputEncoders: EncoderAvailability = { h264: true, hevc: false, av1: false };
  /** Every encoder name FFmpeg listed, for exact per-path availability. */
  private encoderNames = new Set<string>();
  /** The subset of those that run on a GPU this machine actually has. */
  private hardwareEncoders: EncoderAvailability = { h264: false, hevc: false, av1: false };
  private cleanupTimer: any = null;
  private idleSweepTimer: any = null;

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

    // Sessions are swept far more often than the cache: an abandoned encoder
    // burns CPU for as long as it is left running.
    this.idleSweepTimer = setInterval(() => {
      try {
        this.sweepIdleSessions();
      } catch (err) {
        console.warn('Transcode session sweep error:', err);
      }
    }, Math.max(5000, Math.floor(this.dependencies.sessionIdleMs / 2)));
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
      this.encoderNames = encoderNamesFrom(encodersOut);
      this.outputEncoders = encodersFromFfmpegList(encodersOut);

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

      // Only encoders on the acceleration path that actually probed working
      // count as hardware. Everything else is a CPU encode wearing a GPU name.
      this.hardwareEncoders = accelType === 'none'
        ? { h264: false, hevc: false, av1: false }
        : {
            h264: this.encoderNames.has(encoderNameFor('h264', accelType)),
            hevc: this.encoderNames.has(encoderNameFor('hevc', accelType)),
            av1: this.encoderNames.has(encoderNameFor('av1', accelType))
          };
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
      activeTranscodes: this.sessions.size,
      maxConcurrentTranscodes: TRANSCODE_MAX_CONCURRENT,
      outputCodecs: { ...this.outputEncoders },
      hardwareCodecs: { ...this.hardwareEncoders }
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
    this.hardwareStatus.activeTranscodes = this.sessions.size;
    this.hardwareStatus.maxConcurrentTranscodes = TRANSCODE_MAX_CONCURRENT;
    return this.hardwareStatus;
  }

  public getTranscodeStatus(): TranscodeSessionStatus {
    return {
      activeTranscodes: this.sessions.size,
      maxConcurrentTranscodes: TRANSCODE_MAX_CONCURRENT,
      acceptingTranscodes: this.sessions.size < TRANSCODE_MAX_CONCURRENT,
      sessions: Array.from(this.sessions.values(), (session) => session.status)
    };
  }

  public killAllTranscodes(): number {
    const running = Array.from(this.sessions.entries());
    for (const [key, session] of running) {
      this.disposeSession(key, session);
    }
    return running.length;
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
    querySuffix: string = '',
    stream: StreamRequestOptions = {}
  ): string {
    const lines = ['#EXTM3U', '#EXT-X-VERSION:3'];

    const profiles: TranscodeQuality[] = ['1080p', '720p', '480p', '360p'];

    for (const quality of profiles) {
      const p = QUALITY_PROFILES[quality]!;
      // Only include qualities less than or equal to source resolution (or at least 360p)
      if (itemHeight && itemHeight < p.height && quality !== '360p') {
        continue;
      }

      // The advertised bandwidth is what a player uses to pick a rung, so it
      // has to be the rate this request would really be encoded at rather than
      // the shipped default.
      const selection = this.planQuality(quality, stream);
      const effective = selection ? profileForSelection(p, selection) : p;
      const bandwidth =
        parseInt(effective.maxBitrate, 10) * 1000 + parseInt(effective.audioBitrate, 10) * 1000;
      lines.push(
        `#EXT-X-STREAM-INF:BANDWIDTH=${bandwidth},RESOLUTION=${effective.width}x${effective.height},NAME="${quality}"`,
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
    querySuffix: string = '',
    packaging: SegmentPackaging = 'mpegts'
  ): string {
    const totalSegments = Math.ceil(duration / HLS_SEGMENT_DURATION);
    const extension = segmentExtension(packaging);
    const lines = [
      '#EXTM3U',
      // Fragmented MP4 and EXT-X-MAP both need version 7; MPEG-TS stays on 3,
      // so nothing has to understand a newer playlist than it needs to.
      `#EXT-X-VERSION:${packaging === 'fmp4' ? 7 : 3}`,
      `#EXT-X-TARGETDURATION:${HLS_SEGMENT_DURATION + 1}`,
      '#EXT-X-MEDIA-SEQUENCE:0',
      '#EXT-X-PLAYLIST-TYPE:VOD'
    ];

    if (packaging === 'fmp4') {
      // Fragmented segments carry no stream parameters of their own; the
      // player reads them from this file before anything else.
      lines.push(
        `#EXT-X-MAP:URI="/api/media/${mediaId}/hls/${quality}/${INIT_SEGMENT_NAME}${querySuffix}"`
      );
    }

    for (let i = 0; i < totalSegments; i++) {
      const segDuration = i === totalSegments - 1 ? (duration % HLS_SEGMENT_DURATION || HLS_SEGMENT_DURATION) : HLS_SEGMENT_DURATION;
      lines.push(
        `#EXTINF:${segDuration.toFixed(3)},`,
        `/api/media/${mediaId}/hls/${quality}/segment-${i}.${extension}${querySuffix}`
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
      // Segments now live inside per-session directories, with loose .ts files
      // only surviving from the previous per-segment engine.
      for (const name of fs.readdirSync(TRANSCODE_CACHE_DIR)) {
        const fullPath = path.join(TRANSCODE_CACHE_DIR, name);
        try {
          const stat = fs.statSync(fullPath);
          if (stat.isDirectory()) {
            for (const file of fs.readdirSync(fullPath)) {
              if (!isSegmentFile(file)) continue;
              fileCount++;
              totalSizeBytes += fs.statSync(path.join(fullPath, file)).size;
            }
          } else if (name.endsWith('.ts')) {
            fileCount++;
            totalSizeBytes += stat.size;
          }
        } catch {}
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

  /** Every session directory this engine still owns. */
  private liveSessionDirectories(): Set<string> {
    return new Set(Array.from(this.sessions.values(), (session) => session.directory));
  }

  private static directorySize(directory: string): number {
    let total = 0;
    for (const name of fs.readdirSync(directory)) {
      try {
        total += fs.statSync(path.join(directory, name)).size;
      } catch {
        // A file the encoder removed mid-walk simply contributes nothing.
      }
    }
    return total;
  }

  /**
   * Removes expired session directories and enforces the size budget.
   *
   * Sessions with a live encoder are never touched — evicting one would pull
   * the segments out from under somebody who is watching. Everything else is
   * evicted oldest-first once the budget is exceeded.
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

    const live = this.liveSessionDirectories();
    interface CacheEntry { fullPath: string; size: number; mtime: number; isDirectory: boolean; }
    const retained: CacheEntry[] = [];

    for (const name of fs.readdirSync(TRANSCODE_CACHE_DIR)) {
      const fullPath = path.join(TRANSCODE_CACHE_DIR, name);
      try {
        const stat = fs.statSync(fullPath);
        const isDirectory = stat.isDirectory();

        // Loose .ts files are leftovers from the per-segment engine.
        if (!isDirectory && !name.endsWith('.ts')) continue;

        const size = isDirectory ? TranscodingEngine.directorySize(fullPath) : stat.size;
        const entry = { fullPath, size, mtime: stat.mtimeMs, isDirectory };

        if (live.has(fullPath)) {
          retained.push(entry);
        } else if (now - stat.mtimeMs > maxAgeMs) {
          fs.rmSync(fullPath, { recursive: true, force: true });
          deletedCount++;
          bytesFreed += size;
        } else {
          retained.push(entry);
        }
      } catch (err) {
        this.dependencies.warn(`Failed to inspect transcode cache entry ${name}:`, err);
      }
    }

    let currentTotalBytes = retained.reduce((total, entry) => total + entry.size, 0);
    if (currentTotalBytes > maxSizeBytes) {
      retained.sort((left, right) => left.mtime - right.mtime);
      for (const entry of retained) {
        if (currentTotalBytes <= maxSizeBytes) break;
        if (live.has(entry.fullPath)) continue;
        try {
          fs.rmSync(entry.fullPath, { recursive: true, force: true });
          deletedCount++;
          bytesFreed += entry.size;
          currentTotalBytes -= entry.size;
        } catch (err) {
          this.dependencies.warn(`Failed to evict transcode cache entry ${entry.fullPath}:`, err);
        }
      }
    }

    let remainingCount = 0;
    let remainingBytes = 0;
    for (const name of fs.readdirSync(TRANSCODE_CACHE_DIR)) {
      const fullPath = path.join(TRANSCODE_CACHE_DIR, name);
      try {
        const stat = fs.statSync(fullPath);
        if (stat.isDirectory()) {
          const files = fs.readdirSync(fullPath).filter(isSegmentFile);
          remainingCount += files.length;
          remainingBytes += TranscodingEngine.directorySize(fullPath);
        } else if (name.endsWith('.ts')) {
          remainingCount += 1;
          remainingBytes += stat.size;
        }
      } catch {
        // Ignore entries that vanish between listing and stat.
      }
    }

    return { deletedCount, bytesFreed, remainingCount, remainingBytes };
  }

  /**
   * Clears all transcode cache files immediately
   */
  public clearAllCache(): CacheCleanResult {
    return this.cleanCache({ maxAgeHours: 0, maxSizeBytes: 0 });
  }

  /**
   * Returns one HLS segment, encoding through a long-running session.
   *
   * A session covers a whole run of playback rather than a single segment, so
   * ordinary viewing costs one FFmpeg process instead of one every six
   * seconds. Only a seek outside what the running session will reach starts a
   * new one.
   */
  public async getHlsSegment(
    filePath: string,
    mediaId: string,
    quality: TranscodeQuality,
    seq: number,
    audio: { source?: AudioSourceInfo; mode?: AudioMode } = {},
    subtitles: { streamIndex?: number; tracks?: readonly SubtitleTrackSummary[] } = {},
    plan?: PlaybackPlan,
    stream: StreamRequestOptions = {}
  ): Promise<Buffer> {
    const described = this.describeStream(mediaId, quality, audio, subtitles, plan, stream);

    return this.serialised(described.key, () => this.resolveSegment(
      described.key, filePath, mediaId, quality, described.profile, seq,
      described.audioPlan, described.subtitlePlan, described.codec, plan
    ));
  }

  /**
   * Returns the initialisation segment a fragmented-MP4 stream begins with.
   *
   * HEVC and AV1 are carried in fragmented MP4 rather than MPEG-TS, and a
   * player fetches this before any media segment. It belongs to a session, so
   * asking for it starts one if none is running.
   */
  public async getHlsInitSegment(
    filePath: string,
    mediaId: string,
    quality: TranscodeQuality,
    audio: { source?: AudioSourceInfo; mode?: AudioMode } = {},
    subtitles: { streamIndex?: number; tracks?: readonly SubtitleTrackSummary[] } = {},
    plan?: PlaybackPlan,
    stream: StreamRequestOptions = {}
  ): Promise<Buffer> {
    const described = this.describeStream(mediaId, quality, audio, subtitles, plan, stream);
    if (described.packaging !== 'fmp4') {
      throw new SegmentUnavailableError('This stream has no initialisation segment');
    }

    return this.serialised(described.key, async () => {
      const existing = this.sessions.get(described.key);
      if (existing && existing.packaging === 'fmp4') {
        try {
          return await existing.waitForInitSegment();
        } catch (error) {
          if (error instanceof SessionStoppedError) throw new TranscodeKilledError();
          this.disposeSession(described.key, existing);
        }
      }

      // Nothing running: start at the beginning, which is where a player
      // asking for the initialisation segment is about to begin anyway.
      await this.startSessionAndWait(
        described.key, filePath, mediaId, quality, described.profile, 0,
        described.audioPlan, described.subtitlePlan, described.codec, plan
      );
      const started = this.sessions.get(described.key);
      if (!started) throw new SegmentUnavailableError('The transcode session did not start');
      return started.waitForInitSegment();
    });
  }

  /**
   * Runs one operation at a time per stream identity.
   *
   * Two viewers arriving together on the same stream would otherwise each
   * decide there was no session and each start one.
   */
  private async serialised<T>(key: string, operation: () => Promise<T>): Promise<T> {
    const previous = this.sessionLocks.get(key) ?? Promise.resolve();
    const attempt = previous.catch(() => {}).then(operation);
    const barrier = attempt.then(() => {}, () => {});

    this.sessionLocks.set(key, barrier);
    try {
      return await attempt;
    } finally {
      // Only the last operation in the queue clears the entry: removing one
      // somebody behind us is still waiting on would let them run early.
      if (this.sessionLocks.get(key) === barrier) this.sessionLocks.delete(key);
    }
  }

  /**
   * Everything decided about a stream before an encoder runs: its identity,
   * its encode settings, and how its segments are packaged.
   */
  private describeStream(
    mediaId: string,
    quality: TranscodeQuality,
    audio: { source?: AudioSourceInfo; mode?: AudioMode },
    subtitles: { streamIndex?: number; tracks?: readonly SubtitleTrackSummary[] },
    plan: PlaybackPlan | undefined,
    stream: StreamRequestOptions
  ): DescribedStream {
    const base = QUALITY_PROFILES[quality] || QUALITY_PROFILES['720p']!;
    const subtitlePlan = planSubtitles({
      streamIndex: subtitles.streamIndex,
      tracks: subtitles.tracks ?? []
    });
    const copyingVideo = plan?.videoAction === 'copy' && subtitlePlan.action !== 'burn-in';
    const selection = copyingVideo ? null : this.planQuality(quality, stream);
    const profile = selection ? profileForSelection(base, selection) : base;

    const audioPlan = planAudioStream(audio.source ?? {}, {
      mode: audio.mode ?? 'stereo',
      stereoBitrate: profile.audioBitrate
    });

    const codec: OutputCodec = selection?.codec ?? 'h264';
    const packaging: SegmentPackaging = copyingVideo ? 'mpegts' : packagingFor(codec);

    // A burned-in stream is different bytes from a plain one, so it needs its
    // own session and its own place on disk.
    // A remuxed stream is different bytes from a re-encoded one, and a
    // tone-mapped stream different again, so both belong in the identity.
    const videoKey = plan?.videoAction === 'copy' ? 'vcopy' : plan?.toneMap ? 'vsdr' : 'venc';
    // The codec and the bitrate change the bytes too, so a viewer on the local
    // network and one over the internet must not be handed each other's
    // segments.
    const encodeKey = selection ? `${codec}${Math.round(selection.bitrate / 1000)}` : 'asis';
    const key = sessionKey(
      mediaId,
      quality,
      `${audioCacheKey(audioPlan)}_${subtitleCacheKey(subtitlePlan)}_${videoKey}_${encodeKey}`
    );

    return { key, profile, audioPlan, subtitlePlan, codec, packaging, selection };
  }

  /**
   * Codec and bitrate for a request.
   *
   * Returns null when the caller said nothing about the client or the
   * connection: the shipped profile is then used unchanged, rather than a
   * ladder position guessed from no information at all.
   */
  private planQuality(
    quality: TranscodeQuality,
    stream: StreamRequestOptions
  ): QualitySelection | null {
    if (quality === 'original') return null;
    if (!stream.capabilities && !stream.network) return null;

    return selectQuality({
      capabilities: stream.capabilities ?? profileByName(undefined),
      network: stream.network ?? 'lan',
      encoders: this.outputEncoders,
      hardwareEncoders: this.hardwareEncoders,
      source: stream.source ?? {},
      requestedTier: quality
    });
  }

  /**
   * The exact FFmpeg encoder for a codec, and the acceleration it implies.
   *
   * A GPU that encodes H.264 does not necessarily encode AV1. Rather than
   * spawning an encoder that does not exist, this drops to the CPU for that
   * codec alone.
   */
  private resolveEncoder(
    codec: OutputCodec,
    accel: HardwareAccelType
  ): { encoder: string; accel: HardwareAccelType } {
    if (accel !== 'none') {
      const hardware = encoderNameFor(codec, accel);
      if (this.encoderNames.size === 0 || this.encoderNames.has(hardware)) {
        return { encoder: hardware, accel };
      }
      this.dependencies.warn(
        `${accel} cannot encode ${codec} on this machine; using the CPU encoder instead.`
      );
    }
    return { encoder: encoderNameFor(codec, 'none'), accel: 'none' };
  }

  /**
   * What a playlist for this request will contain, before anything is encoded.
   *
   * A playlist has to name its segments with the right extension and, for
   * fragmented MP4, point at an initialisation segment — so the codec decision
   * has to be reachable without starting an encoder.
   */
  public describeStreamPackaging(
    quality: TranscodeQuality,
    plan: PlaybackPlan | undefined,
    stream: StreamRequestOptions = {},
    burnInSubtitle = false
  ): { codec: OutputCodec; packaging: SegmentPackaging; selection: QualitySelection | null } {
    const copyingVideo = plan?.videoAction === 'copy' && !burnInSubtitle;
    const selection = copyingVideo ? null : this.planQuality(quality, stream);
    const codec: OutputCodec = selection?.codec ?? 'h264';
    return { codec, packaging: copyingVideo ? 'mpegts' : packagingFor(codec), selection };
  }

  private async resolveSegment(
    key: string,
    filePath: string,
    mediaId: string,
    quality: TranscodeQuality,
    profile: QualityProfile,
    seq: number,
    audioPlan: AudioPlan,
    subtitlePlan: SubtitlePlan,
    codec: OutputCodec,
    plan?: PlaybackPlan
  ): Promise<Buffer> {
    const existing = this.sessions.get(key);
    const decision = existing
      ? existing.decide(seq, TRANSCODE_LOOKAHEAD_SEGMENTS)
      : decideSegmentSource(seq, null, { lookaheadLimit: TRANSCODE_LOOKAHEAD_SEGMENTS });

    if (decision.action === 'serve' && existing) {
      return existing.readSegment(seq);
    }

    if (decision.action === 'wait' && existing) {
      try {
        return await existing.waitForSegment(seq);
      } catch (error) {
        if (error instanceof SessionStoppedError) throw new TranscodeKilledError();
        // A hardware encoder that dies mid-session should not take playback
        // with it; fall back to CPU and re-seek to where the viewer is.
        if (error instanceof SegmentUnavailableError && this.disableFailedHardware()) {
          return this.startSessionAndWait(
            key, filePath, mediaId, quality, profile, seq, audioPlan, subtitlePlan, codec, plan
          );
        }
        throw error;
      }
    }

    if (existing) {
      this.disposeSession(key, existing);
    }

    return this.startSessionAndWait(
      key, filePath, mediaId, quality, profile, seq, audioPlan, subtitlePlan, codec, plan
    );
  }

  private async startSessionAndWait(
    key: string,
    filePath: string,
    mediaId: string,
    quality: TranscodeQuality,
    profile: QualityProfile,
    seq: number,
    audioPlan: AudioPlan,
    subtitlePlan: SubtitlePlan,
    codec: OutputCodec,
    plan?: PlaybackPlan
  ): Promise<Buffer> {
    // The concurrency limit now counts viewers, not segments: two simultaneous
    // streams, rather than two six-second chunks anywhere on the server.
    if (this.sessions.size >= TRANSCODE_MAX_CONCURRENT) {
      throw new TranscodeCapacityError(TRANSCODE_MAX_CONCURRENT);
    }

    const { encoder, accel } = this.resolveEncoder(
      codec,
      this.hardwareStatus?.accelType || 'none'
    );
    const session = new TranscodeSession({
      key,
      filePath,
      mediaId,
      quality,
      profile,
      accel,
      hardwareDevicePath: this.devicePathForAccel(accel),
      audioPlan,
      subtitlePlan,
      outputCodec: codec,
      videoEncoder: encoder,
      ...(plan ? { videoAction: plan.videoAction, toneMap: plan.toneMap } : {}),
      startSegment: seq,
      rootDirectory: this.dependencies.cacheDirectory,
      spawn: this.dependencies.spawn,
      idleTimeoutMs: this.dependencies.sessionIdleMs,
      segmentWaitTimeoutMs: this.dependencies.segmentWaitMs,
      pollIntervalMs: this.dependencies.segmentPollMs,
      warn: this.dependencies.warn
      // A finished session is deliberately left in place: its segments stay
      // servable, and the idle sweep reclaims it once nobody is watching.
    });

    this.sessions.set(key, session);
    session.start();

    try {
      return await session.waitForSegment(seq);
    } catch (error) {
      // A deliberate stop is not a transcode failure, so it must not trigger a
      // CPU retry of work an administrator just cancelled.
      if (error instanceof SessionStoppedError) throw new TranscodeKilledError();

      if (error instanceof SegmentUnavailableError && accel !== 'none' && this.disableFailedHardware()) {
        this.disposeSession(key, session);
        return this.startSessionAndWait(
          key, filePath, mediaId, quality, profile, seq, audioPlan, subtitlePlan, codec, plan
        );
      }
      this.disposeSession(key, session);
      throw error;
    }
  }

  /**
   * Marks the current hardware encoder unusable after a failure.
   *
   * Returns false when CPU encoding was already in use, so a caller can tell a
   * recoverable hardware fault from a genuine failure.
   */
  private disableFailedHardware(): boolean {
    const accel = this.hardwareStatus?.accelType;
    if (!accel || accel === 'none') return false;

    this.dependencies.warn(
      `Hardware acceleration (${accel}) failed during a transcode session; falling back to CPU.`
    );
    this.hardwareStatus!.accelType = 'none';
    this.hardwareStatus!.devicePath = undefined;
    return true;
  }

  private disposeSession(key: string, session: TranscodeSession): void {
    if (this.sessions.get(key) === session) this.sessions.delete(key);
    session.dispose();
  }

  /** Stops sessions nobody has asked anything of for a while. */
  private sweepIdleSessions(): void {
    for (const [key, session] of this.sessions) {
      if (session.status.idleForMs >= this.dependencies.sessionIdleMs) {
        this.disposeSession(key, session);
      }
    }
  }

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
