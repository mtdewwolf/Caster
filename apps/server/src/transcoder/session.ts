import crypto from 'crypto';
import fs from 'fs';
import path from 'path';
import type { ChildProcessWithoutNullStreams } from 'child_process';
import type { AudioPlan } from './audio';
import { audioArgsFor } from './audio';
import type { HardwareAccelType, QualityProfile, TranscodeQuality } from '../types';
import {
  decideSegmentSource,
  sessionDirectoryName,
  type SessionWindow
} from './session-planner';
import { subtitleBurnInFilter, type SubtitlePlan } from './subtitles';
import {
  encoderNameFor,
  encoderTuningArgs,
  INIT_SEGMENT_NAME,
  packagingFor,
  segmentExtension,
  type OutputCodec,
  type SegmentPackaging
} from './quality';

export const HLS_SEGMENT_DURATION = 6;

export interface SessionSpawn {
  (command: string, args: string[]): ChildProcessWithoutNullStreams;
}

export interface TranscodeSessionOptions {
  key: string;
  filePath: string;
  mediaId: string;
  quality: TranscodeQuality;
  profile: QualityProfile;
  accel: HardwareAccelType;
  hardwareDevicePath?: string | undefined;
  audioPlan: AudioPlan;
  subtitlePlan: SubtitlePlan;
  /** 'copy' repackages the original video stream instead of re-encoding it. */
  videoAction?: 'copy' | 'transcode' | undefined;
  /** Output video codec. Decides the encoder and the segment packaging. */
  outputCodec?: OutputCodec | undefined;
  /**
   * Exact FFmpeg encoder to use, when the caller has checked availability.
   * Without it the name is derived from the codec and acceleration path.
   */
  videoEncoder?: string | undefined;
  /** Flatten HDR for a screen that cannot display it. */
  toneMap?: boolean | undefined;
  startSegment: number;
  rootDirectory: string;
  spawn: SessionSpawn;
  /** Milliseconds of no segment requests before the encoder is stopped. */
  idleTimeoutMs: number;
  segmentWaitTimeoutMs: number;
  pollIntervalMs: number;
  warn: (...args: unknown[]) => void;
  onExit?: (session: TranscodeSession) => void;
}

export class SegmentUnavailableError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'SegmentUnavailableError';
  }
}

export class SessionStoppedError extends Error {
  constructor() {
    super('The transcode session was stopped');
    this.name = 'SessionStoppedError';
  }
}

/**
 * One continuously running FFmpeg process producing HLS segments.
 *
 * FFmpeg's own HLS muxer does the segmenting, so a viewer moving forward
 * through a file costs one process for the whole watch rather than one per six
 * seconds. Segments land in a session directory and are served straight off
 * disk; a request that runs ahead of the encoder waits for the file to appear.
 */
export class TranscodeSession {
  readonly id = crypto.randomUUID();
  readonly key: string;
  readonly mediaId: string;
  readonly quality: TranscodeQuality;
  readonly startSegment: number;
  readonly startedAt = new Date().toISOString();
  readonly directory: string;
  readonly outputCodec: OutputCodec;
  readonly packaging: SegmentPackaging;
  readonly videoEncoder: string;

  #process: ChildProcessWithoutNullStreams | null = null;
  #options: TranscodeSessionOptions;
  #highestReady: number;
  #running = false;
  #stopped = false;
  #exitCode: number | null = null;
  #stderr = '';
  #lastRequestedAt = Date.now();
  #idleTimer: ReturnType<typeof setInterval> | null = null;

  constructor(options: TranscodeSessionOptions) {
    this.#options = options;
    this.#highestReady = options.startSegment - 1;
    this.key = options.key;
    this.mediaId = options.mediaId;
    this.quality = options.quality;
    this.startSegment = options.startSegment;
    this.outputCodec = options.outputCodec ?? 'h264';
    // A copied stream is not re-encoded, so it stays in MPEG-TS whatever the
    // client could have decoded — the packaging has to match the bytes.
    this.packaging = options.videoAction === 'copy' && options.subtitlePlan.action !== 'burn-in'
      ? 'mpegts'
      : packagingFor(this.outputCodec);
    this.videoEncoder = options.videoEncoder
      ?? encoderNameFor(this.outputCodec, options.accel);
    this.directory = path.join(
      options.rootDirectory,
      sessionDirectoryName(options.key, this.id)
    );
  }

  get running(): boolean {
    return this.#running;
  }

  get highestReady(): number {
    return this.#highestReady;
  }

  get window(): SessionWindow {
    return {
      startSegment: this.startSegment,
      highestReady: this.#highestReady,
      running: this.#running
    };
  }

  /** Snapshot for the admin transcode status view. */
  get status() {
    return {
      id: this.id,
      mediaId: this.mediaId,
      quality: this.quality,
      startedAt: this.startedAt,
      startSegment: this.startSegment,
      highestReadySegment: this.#highestReady,
      segmentsProduced: Math.max(0, this.#highestReady - this.startSegment + 1),
      running: this.#running,
      idleForMs: Date.now() - this.#lastRequestedAt
    };
  }

  start(): void {
    if (this.#running || this.#stopped) return;

    fs.mkdirSync(this.directory, { recursive: true });
    const args = this.#buildArgs();

    const ffmpeg = this.#options.spawn('ffmpeg', args);
    this.#process = ffmpeg;
    this.#running = true;

    ffmpeg.stdout?.on('data', () => {});
    ffmpeg.stderr?.on('data', (chunk: Buffer) => {
      // Keep only the tail; a long session would otherwise grow this forever.
      this.#stderr = `${this.#stderr}${chunk.toString()}`.slice(-4000);
    });

    ffmpeg.on('error', (error) => {
      this.#running = false;
      this.#options.warn(`Transcode session ${this.id} failed to start:`, error);
      this.#options.onExit?.(this);
    });

    ffmpeg.on('close', (code) => {
      this.#running = false;
      this.#exitCode = code;
      if (code !== 0 && !this.#stopped) {
        this.#options.warn(
          `Transcode session ${this.id} exited with code ${code}: ${this.#stderr}`
        );
      }
      this.#options.onExit?.(this);
    });

    this.#idleTimer = setInterval(() => {
      if (Date.now() - this.#lastRequestedAt >= this.#options.idleTimeoutMs) {
        this.stop();
      }
    }, Math.max(1000, Math.floor(this.#options.idleTimeoutMs / 2)));
  }

  #buildArgs(): string[] {
    const { profile, audioPlan, subtitlePlan, hardwareDevicePath, filePath } = this.#options;
    const burningIn = subtitlePlan.action === 'burn-in';
    // Copying the video stream is a remux: no encoder runs, so hardware
    // acceleration and scaling are both irrelevant. Burning in a subtitle means
    // compositing in software, so that path drops to CPU too.
    const copyingVideo = this.#options.videoAction === 'copy' && !burningIn;
    const accel = burningIn || copyingVideo ? 'none' : this.#options.accel;
    const args = ['-hide_banner', '-loglevel', 'error'];

    // Seeking before the input is what makes starting mid-file cheap.
    args.push('-ss', String(this.startSegment * HLS_SEGMENT_DURATION));

    if (accel === 'nvenc') {
      args.push('-hwaccel', 'cuda');
    } else if (accel === 'vaapi' && hardwareDevicePath) {
      args.push('-hwaccel', 'vaapi', '-vaapi_device', hardwareDevicePath);
    } else if (accel === 'qsv') {
      args.push('-hwaccel', 'qsv');
      if (hardwareDevicePath) args.push('-qsv_device', hardwareDevicePath);
    }

    args.push('-i', filePath);

    if (burningIn) {
      const scale = `scale=${profile.width}:${profile.height}:force_original_aspect_ratio=decrease`;
      args.push(
        '-filter_complex', subtitleBurnInFilter(subtitlePlan.streamIndex, scale),
        '-map', '[vout]',
        '-map', audioPlan.sourceStreamIndex !== undefined
          ? `0:${audioPlan.sourceStreamIndex}`
          : '0:a:0?'
      );
    } else if (audioPlan.sourceStreamIndex !== undefined) {
      args.push('-map', '0:v:0', '-map', `0:${audioPlan.sourceStreamIndex}`);
    }

    if (copyingVideo) {
      // The original stream, repackaged. Nothing about the picture changes.
      args.push('-c:v', 'copy');
    } else {
      // The encoder name carries both the codec and the acceleration path, so
      // there is one branch here instead of one per combination.
      const encoder = accel === this.#options.accel
        ? this.videoEncoder
        : encoderNameFor(this.outputCodec, accel);
      const boxed =
        `scale=${profile.width}:${profile.height}:force_original_aspect_ratio=decrease`
        + `,pad=${profile.width}:${profile.height}:(ow-iw)/2:(oh-ih)/2`;

      if (accel === 'vaapi') {
        // VAAPI encodes from a surface already on the GPU, so the scale has to
        // happen there rather than in an ordinary filter chain.
        args.push(
          '-vf',
          `format=nv12|vaapi,hwupload,scale_vaapi=w=${profile.width}:h=${profile.height}`
        );
      }

      args.push(
        '-c:v', encoder,
        ...encoderTuningArgs(encoder),
        '-b:v', profile.videoBitrate,
        '-maxrate', profile.maxBitrate,
        '-bufsize', profile.bufsize
      );

      if (accel === 'nvenc') {
        args.push('-vf', boxed);
      } else if (accel === 'qsv') {
        args.push(
          '-vf',
          `scale=${profile.width}:${profile.height}:force_original_aspect_ratio=decrease`
        );
      } else if (accel === 'none' && !burningIn) {
        // filter_complex already carries the scale, and the two cannot coexist.
        args.push('-vf', this.#options.toneMap
          // Convert HDR to something a standard screen shows correctly, rather
          // than the washed-out picture a naive downconvert produces.
          ? `zscale=t=linear:npl=100,tonemap=hable:desat=0,zscale=p=bt709:t=bt709:m=bt709:r=tv,format=yuv420p,${boxed}`
          : boxed);
      }
    }

    args.push(...audioArgsFor(audioPlan));

    // Let FFmpeg's HLS muxer do the segmenting. Keyframes are forced onto
    // segment boundaries so every segment can be decoded independently.
    args.push(
      '-force_key_frames', `expr:gte(t,n_forced*${HLS_SEGMENT_DURATION})`,
      '-f', 'hls',
      '-hls_time', String(HLS_SEGMENT_DURATION),
      '-hls_list_size', '0',
      '-hls_flags', 'independent_segments+temp_file',
      '-hls_segment_type', this.packaging
    );

    if (this.packaging === 'fmp4') {
      // Fragmented MP4 segments are useless on their own: the player reads the
      // stream's parameters from this initialisation segment first.
      args.push('-hls_fmp4_init_filename', INIT_SEGMENT_NAME);
    }

    args.push(
      '-start_number', String(this.startSegment),
      '-hls_segment_filename',
      path.join(this.directory, `segment-%d.${segmentExtension(this.packaging)}`),
      path.join(this.directory, 'index.m3u8')
    );

    return args;
  }

  segmentPath(segment: number): string {
    return path.join(this.directory, `segment-${segment}.${segmentExtension(this.packaging)}`);
  }

  get initSegmentPath(): string {
    return path.join(this.directory, INIT_SEGMENT_NAME);
  }

  /**
   * Waits for the initialisation segment fragmented-MP4 playback needs.
   *
   * FFmpeg writes it as soon as the first frame is encoded, so this normally
   * returns almost immediately; it still has to wait, because the player asks
   * for it before anything else.
   */
  async waitForInitSegment(): Promise<Buffer> {
    if (this.packaging !== 'fmp4') {
      throw new SegmentUnavailableError('This stream has no initialisation segment');
    }
    this.#lastRequestedAt = Date.now();
    const deadline = Date.now() + this.#options.segmentWaitTimeoutMs;

    for (;;) {
      if (this.#stopped) throw new SessionStoppedError();
      if (fs.existsSync(this.initSegmentPath)) {
        return fs.promises.readFile(this.initSegmentPath);
      }
      if (!this.#running) {
        throw new SegmentUnavailableError(
          'The transcode session ended before it wrote an initialisation segment'
        );
      }
      if (Date.now() >= deadline) {
        throw new SegmentUnavailableError('Timed out waiting for the initialisation segment');
      }
      await new Promise((resolve) => setTimeout(resolve, this.#options.pollIntervalMs));
    }
  }

  /**
   * A segment is safe to serve once the *next* one exists, or once the encoder
   * has exited — until then FFmpeg may still be appending to it.
   */
  #segmentIsComplete(segment: number): boolean {
    if (!fs.existsSync(this.segmentPath(segment))) return false;
    if (fs.existsSync(this.segmentPath(segment + 1))) return true;
    return !this.#running;
  }

  #refreshHighestReady(): void {
    let candidate = this.#highestReady;
    while (this.#segmentIsComplete(candidate + 1)) {
      candidate += 1;
    }
    if (candidate > this.#highestReady) this.#highestReady = candidate;
  }

  /** Poll for a segment the encoder has not reached yet. */
  async waitForSegment(segment: number): Promise<Buffer> {
    this.#lastRequestedAt = Date.now();
    const deadline = Date.now() + this.#options.segmentWaitTimeoutMs;

    for (;;) {
      if (this.#stopped) throw new SessionStoppedError();
      this.#refreshHighestReady();

      if (segment <= this.#highestReady) {
        return fs.promises.readFile(this.segmentPath(segment));
      }

      if (!this.#running) {
        // The encoder finished. Either this segment is past the end of the
        // file, or it died — both are unavailable rather than "wait longer".
        throw new SegmentUnavailableError(
          this.#exitCode === 0
            ? `Segment ${segment} is past the end of the stream`
            : `The transcode session ended before segment ${segment}`
        );
      }

      if (Date.now() >= deadline) {
        throw new SegmentUnavailableError(`Timed out waiting for segment ${segment}`);
      }

      await new Promise((resolve) => setTimeout(resolve, this.#options.pollIntervalMs));
    }
  }

  /** Decides how to satisfy a request against this session's current window. */
  decide(segment: number, lookaheadLimit: number) {
    this.#lastRequestedAt = Date.now();
    this.#refreshHighestReady();
    return decideSegmentSource(segment, this.window, { lookaheadLimit });
  }

  readSegment(segment: number): Promise<Buffer> {
    this.#lastRequestedAt = Date.now();
    return fs.promises.readFile(this.segmentPath(segment));
  }

  stop(): void {
    if (this.#stopped) return;
    this.#stopped = true;

    if (this.#idleTimer) {
      clearInterval(this.#idleTimer);
      this.#idleTimer = null;
    }

    const child = this.#process;
    if (child && child.exitCode === null && child.signalCode === null) {
      try {
        child.kill('SIGKILL');
      } catch (error) {
        this.#options.warn(`Failed to stop transcode session ${this.id}:`, error);
      }
    }
    this.#running = false;
  }

  /** Stops the encoder and removes everything it wrote. */
  dispose(): void {
    this.stop();
    try {
      fs.rmSync(this.directory, { recursive: true, force: true });
    } catch (error) {
      this.#options.warn(`Failed to clean transcode session ${this.id}:`, error);
    }
  }
}
