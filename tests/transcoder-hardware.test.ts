import { describe, expect, it } from 'bun:test';
import { EventEmitter } from 'events';
import { PassThrough } from 'stream';
import type { ChildProcessWithoutNullStreams } from 'child_process';
import {
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
  warnings: unknown[][] = []
): TranscodingEngine {
  return new TranscodingEngine(baseDependencies({
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

describe('hardware transcode fallback', () => {
  it('retries one failed hardware segment on CPU and demotes later segments to CPU', async () => {
    const spawnArgs: string[][] = [];
    const warnings: unknown[][] = [];
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
          child.stdout.write(Buffer.from('cpu-segment'));
          child.exitCode = 0;
          child.emit('close', 0, null);
        }
      });
      return child;
    }, warnings);

    const first = await engine.getHlsSegment('/fixture.mp4', `fallback-${crypto.randomUUID()}`, '360p', 0);
    const second = await engine.getHlsSegment('/fixture.mp4', `demoted-${crypto.randomUUID()}`, '360p', 1);

    expect(first.toString()).toBe('cpu-segment');
    expect(second.toString()).toBe('cpu-segment');
    expect(spawnArgs).toHaveLength(3);
    expect(spawnArgs[0]).toContain('h264_nvenc');
    expect(spawnArgs[1]).toContain('libx264');
    expect(spawnArgs[2]).toContain('libx264');
    expect(engine.getHardwareStatus().accelType).toBe('none');
    expect(engine.getHardwareStatus().nvencSupported).toBe(true);
    expect(warnings).toHaveLength(1);
  });

  it('tries CPU only once and surfaces the CPU failure', async () => {
    const spawnArgs: string[][] = [];
    const engine = nvencEngine((_command, args) => {
      spawnArgs.push([...args]);
      const child = createChild();
      queueMicrotask(() => {
        child.stderr.write('fixture encoding failure');
        child.exitCode = 1;
        child.emit('close', 1, null);
      });
      return child;
    });

    const result = await engine
      .getHlsSegment('/fixture.mp4', `double-failure-${crypto.randomUUID()}`, '360p', 0)
      .catch((error) => error);

    expect(result).toBeInstanceOf(Error);
    expect(result.message).toContain('FFmpeg transcoding failed');
    expect(spawnArgs).toHaveLength(2);
    expect(spawnArgs[0]).toContain('h264_nvenc');
    expect(spawnArgs[1]).toContain('libx264');
  });

  it('does not start a CPU fallback after an administrator kills the hardware job', async () => {
    const children: ControlledChild[] = [];
    const engine = nvencEngine((_command, _args) => {
      const child = createChild();
      children.push(child);
      return child;
    });

    const request = engine
      .getHlsSegment('/fixture.mp4', `killed-${crypto.randomUUID()}`, '360p', 0)
      .catch((error) => error);
    expect(engine.killAllTranscodes()).toBe(1);
    children[0].signalCode = 'SIGKILL';
    children[0].emit('close', null, 'SIGKILL');

    const result = await request;
    expect(result).toBeInstanceOf(TranscodeKilledError);
    expect(children).toHaveLength(1);
    expect(engine.getHardwareStatus().accelType).toBe('nvenc');
  });
});
