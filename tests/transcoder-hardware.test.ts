import { afterEach, describe, expect, it } from 'bun:test';
import { EventEmitter } from 'events';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { PassThrough } from 'stream';
import type { ChildProcessWithoutNullStreams } from 'child_process';
import {
  TranscodeCapacityError,
  TranscodeKilledError,
  TranscodingEngine,
  type TranscodingEngineDependencies
} from '../apps/server/src/transcoder/engine';

type ControlledChild = ChildProcessWithoutNullStreams & {
  emit(event: 'close', code: number | null, signal: NodeJS.Signals | null): boolean;
};

function createChild(onKill?: () => void): ControlledChild {
  const child = new EventEmitter() as ControlledChild;
  Object.assign(child, {
    stdout: new PassThrough(),
    stderr: new PassThrough(),
    stdin: new PassThrough(),
    exitCode: null,
    signalCode: null,
    kill: () => {
      onKill?.();
      return true;
    }
  });
  return child;
}

function baseDependencies(
  overrides: Partial<TranscodingEngineDependencies> = {}
): Partial<TranscodingEngineDependencies> {
  return {
    platform: 'linux',
    scheduleMaintenance: false,
    // Real poll intervals would make every fallback test wait on a timer.
    segmentPollMs: 1,
    segmentWaitMs: 1500,
    sessionIdleMs: 60_000,
    existsSync: () => false,
    readdirSync: () => [],
    warn: () => {},
    execFileSync: (_command, args) => {
      if (args[0] === '-version') return 'ffmpeg version fixture\n';
      if (args.includes('-encoders')) return '';
      return '';
    },
    ...overrides
  };
}

function nvencEngine(
  spawnImplementation: TranscodingEngineDependencies['spawn'],
  warnings: unknown[][] = [],
  cacheDirectory?: string
): TranscodingEngine {
  return new TranscodingEngine(baseDependencies({
    ...(cacheDirectory ? { cacheDirectory } : {}),
    existsSync: (filePath) => filePath === '/dev/nvidia0',
    execFileSync: (_command, args) => {
      if (args[0] === '-version') return 'ffmpeg version fixture\n';
      if (args.includes('-encoders')) return ' V..... h264_nvenc fixture encoder';
      if (args.includes('h264_nvenc')) return '';
      throw new Error(`Unexpected FFmpeg invocation: ${args.join(' ')}`);
    },
    spawn: spawnImplementation,
    warn: (...args) => warnings.push(args)
  }));
}

describe('hardware transcode detection', () => {
  it('does not treat listed encoders as usable when Linux exposes no GPU devices', () => {
    const commands: string[][] = [];
    const engine = new TranscodingEngine(baseDependencies({
      execFileSync: (_command, args) => {
        commands.push(args);
        if (args[0] === '-version') return 'ffmpeg version fixture\n';
        if (args.includes('-encoders')) {
          return 'h264_nvenc h264_qsv h264_vaapi';
        }
        throw new Error('A hardware probe must not run without a corresponding device');
      }
    }));

    const status = engine.getHardwareStatus();
    expect(status.accelType).toBe('none');
    expect(status.nvencSupported).toBe(false);
    expect(status.qsvSupported).toBe(false);
    expect(status.vaapiSupported).toBe(false);
    expect(status.devicePath).toBeUndefined();
    expect(commands).toHaveLength(2);
  });

  it('selects VAAPI instead of QSV when the QSV functional probe fails', () => {
    const probes: string[] = [];
    const engine = new TranscodingEngine(baseDependencies({
      readdirSync: () => ['card0', 'renderD128'],
      execFileSync: (_command, args) => {
        if (args[0] === '-version') return 'ffmpeg version fixture\n';
        if (args.includes('-encoders')) return 'h264_qsv h264_vaapi';
        if (args.includes('h264_qsv')) {
          probes.push('qsv');
          throw new Error('No Intel Media device');
        }
        if (args.includes('h264_vaapi')) {
          probes.push('vaapi');
          return '';
        }
        throw new Error(`Unexpected FFmpeg invocation: ${args.join(' ')}`);
      }
    }));

    const status = engine.getHardwareStatus();
    expect(probes).toEqual(['qsv', 'vaapi']);
    expect(status.qsvSupported).toBe(false);
    expect(status.vaapiSupported).toBe(true);
    expect(status.accelType).toBe('vaapi');
    expect(status.devicePath).toBe('/dev/dri/renderD128');
  });

  it('finds a usable QSV device when it is not the first DRM render node', () => {
    const probedDevices: string[] = [];
    const engine = new TranscodingEngine(baseDependencies({
      readdirSync: () => ['renderD129', 'renderD128'],
      execFileSync: (_command, args) => {
        if (args[0] === '-version') return 'ffmpeg version fixture\n';
        if (args.includes('-encoders')) return 'h264_qsv';
        if (args.includes('h264_qsv')) {
          const devicePath = args[args.indexOf('-qsv_device') + 1];
          probedDevices.push(devicePath);
          if (devicePath === '/dev/dri/renderD129') return '';
          throw new Error('Not an Intel render node');
        }
        throw new Error(`Unexpected FFmpeg invocation: ${args.join(' ')}`);
      }
    }));

    const status = engine.getHardwareStatus();
    expect(probedDevices).toEqual(['/dev/dri/renderD128', '/dev/dri/renderD129']);
    expect(status.qsvSupported).toBe(true);
    expect(status.accelType).toBe('qsv');
    expect(status.devicePath).toBe('/dev/dri/renderD129');
  });

  it('reports NVENC only after its device and functional probe both succeed', () => {
    const engine = nvencEngine(() => createChild());
    const status = engine.getHardwareStatus();

    expect(status.nvencSupported).toBe(true);
    expect(status.accelType).toBe('nvenc');
    expect(status.devicePath).toBe('/dev/nvidia0');

    engine.setPreferredAccel('none');
    expect(engine.getHardwareStatus().devicePath).toBeUndefined();
    engine.setPreferredAccel('nvenc');
    expect(engine.getHardwareStatus().devicePath).toBe('/dev/nvidia0');
  });
});

describe('transcode sessions', () => {
  const roots: string[] = [];

  afterEach(() => {
    for (const root of roots.splice(0)) {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  function cacheRoot(): string {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'caster-session-'));
    roots.push(root);
    return root;
  }

  /** Reads the output directory FFmpeg was told to write segments into. */
  function segmentDirectory(args: string[]): string {
    const pattern = args[args.indexOf('-hls_segment_filename') + 1];
    return path.dirname(pattern!);
  }

  function startNumber(args: string[]): number {
    return Number(args[args.indexOf('-start_number') + 1]);
  }

  /**
   * Stands in for FFmpeg's HLS muxer: writes the segments a real encoder would
   * produce, then exits.
   */
  function writingChild(args: string[], count: number, body = 'segment'): ControlledChild {
    const child = createChild();
    const directory = segmentDirectory(args);
    const first = startNumber(args);

    queueMicrotask(() => {
      fs.mkdirSync(directory, { recursive: true });
      for (let offset = 0; offset < count; offset += 1) {
        fs.writeFileSync(path.join(directory, `segment-${first + offset}.ts`), `${body}-${first + offset}`);
      }
      child.exitCode = 0;
      child.emit('close', 0, null);
    });
    return child;
  }

  function failingChild(message: string): ControlledChild {
    const child = createChild();
    queueMicrotask(() => {
      child.stderr.write(message);
      child.exitCode = 1;
      child.emit('close', 1, null);
    });
    return child;
  }

  it('encodes many segments from a single process', async () => {
    const spawns: string[][] = [];
    const root = cacheRoot();
    const engine = new TranscodingEngine(baseDependencies({
      cacheDirectory: root,
      spawn: (_command, args) => {
        spawns.push([...args]);
        return writingChild(args, 5);
      }
    }));

    const mediaId = `session-${crypto.randomUUID()}`;
    for (let segment = 0; segment < 5; segment += 1) {
      const chunk = await engine.getHlsSegment('/fixture.mp4', mediaId, '360p', segment);
      expect(chunk.toString()).toBe(`segment-${segment}`);
    }

    // The whole point of the epic: one encoder for a run of playback, not one
    // process per six-second segment.
    expect(spawns).toHaveLength(1);
  });

  it('uses FFmpeg\'s own HLS muxer rather than piping single segments', async () => {
    const spawns: string[][] = [];
    const root = cacheRoot();
    const engine = new TranscodingEngine(baseDependencies({
      cacheDirectory: root,
      spawn: (_command, args) => {
        spawns.push([...args]);
        return writingChild(args, 2);
      }
    }));

    await engine.getHlsSegment('/fixture.mp4', `hls-${crypto.randomUUID()}`, '360p', 0);

    expect(spawns[0]).toContain('-f');
    expect(spawns[0]).toContain('hls');
    expect(spawns[0]).not.toContain('pipe:1');
  });

  it('re-seeks with a new session when the viewer jumps far ahead', async () => {
    const spawns: string[][] = [];
    const root = cacheRoot();
    const engine = new TranscodingEngine(baseDependencies({
      cacheDirectory: root,
      spawn: (_command, args) => {
        spawns.push([...args]);
        return writingChild(args, 2);
      }
    }));

    const mediaId = `seek-${crypto.randomUUID()}`;
    await engine.getHlsSegment('/fixture.mp4', mediaId, '360p', 0);
    await engine.getHlsSegment('/fixture.mp4', mediaId, '360p', 400);

    expect(spawns).toHaveLength(2);
    expect(startNumber(spawns[1]!)).toBe(400);
    expect(spawns[1]).toContain(String(400 * 6));
  });

  it('re-seeks when the viewer scrubs backwards past the session start', async () => {
    const spawns: string[][] = [];
    const root = cacheRoot();
    const engine = new TranscodingEngine(baseDependencies({
      cacheDirectory: root,
      spawn: (_command, args) => {
        spawns.push([...args]);
        return writingChild(args, 2);
      }
    }));

    const mediaId = `rewind-${crypto.randomUUID()}`;
    await engine.getHlsSegment('/fixture.mp4', mediaId, '360p', 100);
    await engine.getHlsSegment('/fixture.mp4', mediaId, '360p', 4);

    expect(spawns).toHaveLength(2);
    expect(startNumber(spawns[1]!)).toBe(4);
  });

  it('counts concurrent viewers rather than segments', async () => {
    const root = cacheRoot();
    const engine = new TranscodingEngine(baseDependencies({
      cacheDirectory: root,
      spawn: (_command, args) => writingChild(args, 4)
    }));

    const mediaId = `status-${crypto.randomUUID()}`;
    await engine.getHlsSegment('/fixture.mp4', mediaId, '360p', 0);
    await engine.getHlsSegment('/fixture.mp4', mediaId, '360p', 1);
    await engine.getHlsSegment('/fixture.mp4', mediaId, '360p', 2);

    const status = engine.getTranscodeStatus();
    expect(status.activeTranscodes).toBe(1);
    expect(status.sessions).toHaveLength(1);
    expect(status.sessions[0]!.mediaId).toBe(mediaId);
    expect(status.sessions[0]!.segmentsProduced).toBeGreaterThanOrEqual(3);
  });

  it('keeps stereo and surround on separate sessions', async () => {
    const spawns: string[][] = [];
    const root = cacheRoot();
    const engine = new TranscodingEngine(baseDependencies({
      cacheDirectory: root,
      spawn: (_command, args) => {
        spawns.push([...args]);
        return writingChild(args, 2);
      }
    }));

    const mediaId = `audio-${crypto.randomUUID()}`;
    const source = { codec: 'ac3', channels: 6 };
    await engine.getHlsSegment('/fixture.mp4', mediaId, '360p', 0, { source, mode: 'stereo' });
    await engine.getHlsSegment('/fixture.mp4', mediaId, '360p', 0, { source, mode: 'surround' });

    expect(spawns).toHaveLength(2);
    expect(engine.getTranscodeStatus().activeTranscodes).toBe(2);
  });

  it('refuses a new viewer past the concurrency limit', async () => {
    const root = cacheRoot();
    const engine = new TranscodingEngine(baseDependencies({
      cacheDirectory: root,
      spawn: (_command, args) => writingChild(args, 2)
    }));

    const limit = engine.getTranscodeStatus().maxConcurrentTranscodes;
    for (let index = 0; index < limit; index += 1) {
      await engine.getHlsSegment('/fixture.mp4', `limit-${index}-${crypto.randomUUID()}`, '360p', 0);
    }

    const overflow = await engine
      .getHlsSegment('/fixture.mp4', `overflow-${crypto.randomUUID()}`, '360p', 0)
      .catch((error) => error);

    expect(overflow).toBeInstanceOf(TranscodeCapacityError);
  });

  it('frees capacity when sessions are stopped', async () => {
    const root = cacheRoot();
    const engine = new TranscodingEngine(baseDependencies({
      cacheDirectory: root,
      spawn: (_command, args) => writingChild(args, 2)
    }));

    await engine.getHlsSegment('/fixture.mp4', `freed-${crypto.randomUUID()}`, '360p', 0);
    expect(engine.getTranscodeStatus().activeTranscodes).toBe(1);

    expect(engine.killAllTranscodes()).toBe(1);
    expect(engine.getTranscodeStatus().activeTranscodes).toBe(0);
  });

  it('removes a stopped session\'s files from disk', async () => {
    const root = cacheRoot();
    const engine = new TranscodingEngine(baseDependencies({
      cacheDirectory: root,
      spawn: (_command, args) => writingChild(args, 2)
    }));

    await engine.getHlsSegment('/fixture.mp4', `cleanup-${crypto.randomUUID()}`, '360p', 0);
    expect(fs.readdirSync(root)).toHaveLength(1);

    engine.killAllTranscodes();
    expect(fs.readdirSync(root)).toHaveLength(0);
  });

  it('burns in an image subtitle on its own session', async () => {
    const spawns: string[][] = [];
    const root = cacheRoot();
    const engine = new TranscodingEngine(baseDependencies({
      cacheDirectory: root,
      spawn: (_command, args) => {
        spawns.push([...args]);
        return writingChild(args, 2);
      }
    }));

    const mediaId = `subs-${crypto.randomUUID()}`;
    const tracks = [
      { index: 2, codecName: 'subrip', kind: 'text' as const, isExternal: false, requiresBurnIn: false },
      { index: 3, codecName: 'hdmv_pgs_subtitle', kind: 'image' as const, isExternal: false, requiresBurnIn: true }
    ];

    await engine.getHlsSegment('/fixture.mp4', mediaId, '360p', 0, {}, { tracks });
    await engine.getHlsSegment('/fixture.mp4', mediaId, '360p', 0, {}, { streamIndex: 3, tracks });

    // A burned-in stream is different bytes, so it must not reuse the plain
    // session or its cached segments.
    expect(spawns).toHaveLength(2);
    expect(spawns[0]).not.toContain('-filter_complex');
    expect(spawns[1]).toContain('-filter_complex');
    expect(spawns[1]!.join(' ')).toContain('[0:3]overlay[vout]');
    expect(engine.getTranscodeStatus().activeTranscodes).toBe(2);
  });

  it('reuses the plain session for a text subtitle the player renders itself', async () => {
    const spawns: string[][] = [];
    const root = cacheRoot();
    const engine = new TranscodingEngine(baseDependencies({
      cacheDirectory: root,
      spawn: (_command, args) => {
        spawns.push([...args]);
        return writingChild(args, 3);
      }
    }));

    const mediaId = `textsubs-${crypto.randomUUID()}`;
    const tracks = [
      { index: 2, codecName: 'subrip', kind: 'text' as const, isExternal: false, requiresBurnIn: false }
    ];

    await engine.getHlsSegment('/fixture.mp4', mediaId, '360p', 0, {}, { tracks });
    await engine.getHlsSegment('/fixture.mp4', mediaId, '360p', 1, {}, { streamIndex: 2, tracks });

    expect(spawns).toHaveLength(1);
  });

  it('encodes a burn-in on CPU even when hardware is available', async () => {
    const spawns: string[][] = [];
    const root = cacheRoot();
    const engine = nvencEngine((_command, args) => {
      spawns.push([...args]);
      return writingChild(args, 2);
    }, [], root);

    const tracks = [
      { index: 3, codecName: 'dvd_subtitle', kind: 'image' as const, isExternal: false, requiresBurnIn: true }
    ];
    await engine.getHlsSegment('/fixture.mp4', `hwsub-${crypto.randomUUID()}`, '360p', 0, {}, {
      streamIndex: 3, tracks
    });

    // Compositing happens in software, so the hardware pipeline is skipped.
    expect(spawns[0]).toContain('libx264');
    expect(spawns[0]).not.toContain('h264_nvenc');
    expect(spawns[0]).not.toContain('-hwaccel');
  });

  it('reports an unavailable segment when the encoder produces nothing', async () => {
    const root = cacheRoot();
    const engine = new TranscodingEngine(baseDependencies({
      cacheDirectory: root,
      // An encoder that exits cleanly having written no segment means the
      // request is past the end of the stream.
      spawn: (_command, args) => writingChild(args, 0)
    }));

    const result = await engine
      .getHlsSegment('/fixture.mp4', `short-${crypto.randomUUID()}`, '360p', 9)
      .catch((error) => error);

    expect(result).toBeInstanceOf(Error);
    expect(result.message).toContain('9');
  });
});

describe('hardware transcode fallback', () => {
  const roots: string[] = [];

  afterEach(() => {
    for (const root of roots.splice(0)) {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  function cacheRoot(): string {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'caster-session-fb-'));
    roots.push(root);
    return root;
  }

  function writeSegments(args: string[], count: number): void {
    const pattern = args[args.indexOf('-hls_segment_filename') + 1]!;
    const directory = path.dirname(pattern);
    const first = Number(args[args.indexOf('-start_number') + 1]);
    fs.mkdirSync(directory, { recursive: true });
    for (let offset = 0; offset < count; offset += 1) {
      fs.writeFileSync(path.join(directory, `segment-${first + offset}.ts`), 'cpu-segment');
    }
  }

  it('falls back to CPU when the hardware encoder fails, and stays there', async () => {
    const spawnArgs: string[][] = [];
    const warnings: unknown[][] = [];
    const root = cacheRoot();

    const engine = nvencEngine((_command, args) => {
      spawnArgs.push([...args]);
      const child = createChild();
      const isHardwareAttempt = args.includes('h264_nvenc');

      queueMicrotask(() => {
        if (isHardwareAttempt) {
          child.stderr.write('fixture NVENC initialization failure');
          child.exitCode = 1;
          child.emit('close', 1, null);
        } else {
          writeSegments(args, 2);
          child.exitCode = 0;
          child.emit('close', 0, null);
        }
      });
      return child;
    }, warnings, root);

    const first = await engine.getHlsSegment('/fixture.mp4', `fallback-${crypto.randomUUID()}`, '360p', 0);
    const second = await engine.getHlsSegment('/fixture.mp4', `demoted-${crypto.randomUUID()}`, '360p', 0);

    expect(first.toString()).toBe('cpu-segment');
    expect(second.toString()).toBe('cpu-segment');

    // One failed hardware attempt, its CPU retry, then a second viewer that
    // goes straight to CPU without paying the hardware penalty again.
    expect(spawnArgs).toHaveLength(3);
    expect(spawnArgs[0]).toContain('h264_nvenc');
    expect(spawnArgs[1]).toContain('libx264');
    expect(spawnArgs[2]).toContain('libx264');
    expect(engine.getHardwareStatus().accelType).toBe('none');
    // Capability stays visible so an operator can retry after fixing the device.
    expect(engine.getHardwareStatus().nvencSupported).toBe(true);
    expect(warnings.flat().join(' ')).toContain('falling back to CPU');
  });

  it('tries CPU only once and surfaces the CPU failure', async () => {
    const spawnArgs: string[][] = [];
    const root = cacheRoot();
    const engine = nvencEngine((_command, args) => {
      spawnArgs.push([...args]);
      const child = createChild();
      queueMicrotask(() => {
        child.stderr.write('fixture encoding failure');
        child.exitCode = 1;
        child.emit('close', 1, null);
      });
      return child;
    }, [], root);

    const result = await engine
      .getHlsSegment('/fixture.mp4', `double-failure-${crypto.randomUUID()}`, '360p', 0)
      .catch((error) => error);

    expect(result).toBeInstanceOf(Error);
    expect(spawnArgs).toHaveLength(2);
    expect(spawnArgs[0]).toContain('h264_nvenc');
    expect(spawnArgs[1]).toContain('libx264');
  });

  it('does not start a CPU fallback after an administrator stops the session', async () => {
    const children: ControlledChild[] = [];
    const root = cacheRoot();
    const engine = nvencEngine((_command, _args) => {
      const child = createChild();
      children.push(child);
      return child;
    }, [], root);

    const request = engine
      .getHlsSegment('/fixture.mp4', `killed-${crypto.randomUUID()}`, '360p', 0)
      .catch((error) => error);

    // Let the session register before stopping it.
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(engine.killAllTranscodes()).toBe(1);

    const result = await request;
    expect(result).toBeInstanceOf(TranscodeKilledError);
    expect(children).toHaveLength(1);
    // A cancellation is not an encoder fault, so hardware stays selected.
    expect(engine.getHardwareStatus().accelType).toBe('nvenc');
  });
});
