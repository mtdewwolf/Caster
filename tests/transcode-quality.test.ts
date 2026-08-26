import { describe, expect, it } from 'bun:test';
import { EventEmitter } from 'events';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { PassThrough } from 'stream';
import type { ChildProcessWithoutNullStreams } from 'child_process';
import {
  describeQuality,
  encoderCandidates,
  encoderNameFor,
  encoderNamesFrom,
  encodersFromFfmpegList,
  encoderTuningArgs,
  INIT_SEGMENT_NAME,
  isNetworkClass,
  packagingFor,
  profileForSelection,
  segmentContentType,
  segmentExtension,
  selectOutputCodec,
  selectQuality,
  tiersFor,
  type EncoderAvailability
} from '../apps/server/src/transcoder/quality';
import { CLIENT_PROFILES, type ClientCapabilities } from '../apps/server/src/transcoder/capabilities';
import { planAudioStream } from '../apps/server/src/transcoder/audio';
import { planSubtitles } from '../apps/server/src/transcoder/subtitles';
import { TranscodeSession } from '../apps/server/src/transcoder/session';
import { QUALITY_PROFILES, TranscodingEngine } from '../apps/server/src/transcoder/engine';

const ALL: EncoderAvailability = { h264: true, hevc: true, av1: true };
const H264_ONLY: EncoderAvailability = { h264: true, hevc: false, av1: false };

function client(overrides: Partial<ClientCapabilities> = {}): ClientCapabilities {
  return { ...CLIENT_PROFILES['chrome']!, ...overrides };
}

describe('output codec selection', () => {
  it('prefers AV1 when the client decodes it and a GPU can encode it', () => {
    const result = selectOutputCodec(client(), ALL, { hardware: ALL });
    expect(result.codec).toBe('av1');
    expect(result.reason).toBe('client-supports-av1');
  });

  it('falls back to HEVC when the client has no AV1', () => {
    const result = selectOutputCodec(CLIENT_PROFILES['tv-generic']!, ALL, { hardware: ALL });
    expect(result.codec).toBe('hevc');
  });

  it('never picks a codec this FFmpeg build cannot produce', () => {
    // A client that decodes everything is irrelevant if the server can only
    // make H.264 — the alternative is an encoder that does not exist.
    expect(selectOutputCodec(client(), H264_ONLY, { hardware: ALL }).codec).toBe('h264');
  });

  it('never picks a codec the client has not declared', () => {
    const firefox = CLIENT_PROFILES['firefox']!;
    const result = selectOutputCodec(firefox, ALL, { hardware: ALL });
    expect(result.codec).toBe('h264');
    expect(result.reason).toBe('h264-baseline');
  });

  it('leaves an undescribed device on H.264', () => {
    expect(selectOutputCodec(CLIENT_PROFILES['unknown']!, ALL, { hardware: ALL }).codec)
      .toBe('h264');
  });

  it('will not encode AV1 in software, however capable the client is', () => {
    // Software AV1 runs well below real time; a stream the encoder cannot keep
    // ahead of stalls, which is worse than the bandwidth it would have saved.
    const result = selectOutputCodec(client(), ALL, { network: 'remote' });
    expect(result.codec).not.toBe('av1');
  });

  it('accepts software HEVC for a remote viewer, where bandwidth is the constraint', () => {
    const result = selectOutputCodec(CLIENT_PROFILES['tv-generic']!, ALL, { network: 'remote' });
    expect(result.codec).toBe('hevc');
    expect(result.reason).toBe('hevc-saves-remote-bandwidth');
  });

  it('does not spend CPU on a better codec for a viewer on the local network', () => {
    // There is bandwidth to spare on a LAN; there is not CPU to spare.
    const result = selectOutputCodec(CLIENT_PROFILES['tv-generic']!, ALL, { network: 'lan' });
    expect(result.codec).toBe('h264');
    expect(result.reason).toBe('h264-software-fallback');
  });

  it('treats an unstated GPU as no GPU', () => {
    expect(selectOutputCodec(client(), ALL).codec).toBe('h264');
  });
});

describe('quality ladders', () => {
  const source = { height: 2160, bitRate: 80_000_000, frameRate: 24 };

  it('spends far more bitrate on the local network than over the internet', () => {
    const base = { capabilities: client(), encoders: H264_ONLY, source, requestedTier: '1080p' };
    const lan = selectQuality({ ...base, network: 'lan' });
    const remote = selectQuality({ ...base, network: 'remote' });

    expect(lan.height).toBe(1080);
    expect(remote.height).toBe(1080);
    expect(lan.bitrate).toBeGreaterThan(remote.bitrate * 1.5);
  });

  it('asks for less bitrate from a more efficient codec at the same rung', () => {
    const base = {
      capabilities: client(),
      network: 'lan' as const,
      source,
      requestedTier: '1080p'
    };
    const h264 = selectQuality({ ...base, encoders: H264_ONLY });
    const av1 = selectQuality({ ...base, encoders: ALL, hardwareEncoders: ALL });

    expect(av1.codec).toBe('av1');
    expect(av1.bitrate).toBeLessThan(h264.bitrate);
  });

  it('offers a lower rung to remote viewers than it does on the LAN', () => {
    expect(tiersFor('remote').some((tier) => tier.name === '360p')).toBe(true);
    expect(tiersFor('lan').some((tier) => tier.name === '360p')).toBe(false);
  });

  it('caps at the source resolution rather than upscaling', () => {
    const selection = selectQuality({
      capabilities: client(),
      network: 'lan',
      encoders: H264_ONLY,
      source: { height: 720 },
      requestedTier: '1080p'
    });

    expect(selection.height).toBe(720);
    expect(selection.cappedBySource).toBe(true);
  });

  it('spends less on a capped stream, in proportion to the pixels', () => {
    const full = selectQuality({
      capabilities: client(), network: 'lan', encoders: H264_ONLY,
      source: { height: 1080 }, requestedTier: '1080p'
    });
    const capped = selectQuality({
      capabilities: client(), network: 'lan', encoders: H264_ONLY,
      source: { height: 720 }, requestedTier: '1080p'
    });

    // 720 of 1080 is four ninths of the pixels, so roughly four ninths the rate.
    expect(capped.bitrate).toBeLessThan(full.bitrate * 0.5);
    expect(capped.bitrate).toBeGreaterThan(full.bitrate * 0.4);
  });

  it('never re-encodes above the source bitrate', () => {
    const selection = selectQuality({
      capabilities: client(), network: 'lan', encoders: H264_ONLY,
      source: { height: 1080, bitRate: 2_000_000 }, requestedTier: '1080p'
    });
    expect(selection.bitrate).toBeLessThanOrEqual(2_000_000);
  });

  it('gives high frame rate material more to work with', () => {
    const base = {
      capabilities: client(), network: 'lan' as const, encoders: H264_ONLY,
      requestedTier: '1080p'
    };
    const standard = selectQuality({ ...base, source: { height: 1080, frameRate: 24 } });
    const high = selectQuality({ ...base, source: { height: 1080, frameRate: 60 } });
    expect(high.bitrate).toBeGreaterThan(standard.bitrate);
  });

  it('obeys a connection speed the client measured', () => {
    const selection = selectQuality({
      capabilities: client({ maxBitrate: 1_500_000 }),
      network: 'lan', encoders: H264_ONLY,
      source: { height: 1080 }, requestedTier: '1080p'
    });
    expect(selection.bitrate).toBe(1_500_000);
  });

  it('keeps a floor so a tiny ceiling cannot produce an unwatchable stream', () => {
    const selection = selectQuality({
      capabilities: client({ maxBitrate: 1 }),
      network: 'remote', encoders: H264_ONLY,
      source: { height: 360 }, requestedTier: '360p'
    });
    expect(selection.bitrate).toBe(200_000);
  });

  it('picks the best rung the screen justifies when no tier is named', () => {
    const selection = selectQuality({
      capabilities: client({ maxHeight: 720 }),
      network: 'lan', encoders: H264_ONLY,
      source: { height: 2160 }
    });
    expect(selection.height).toBe(720);
    expect(selection.tierName).toBe('720p');
  });

  it('describes the decision in words a viewer could read', () => {
    const selection = selectQuality({
      capabilities: client(), network: 'remote', encoders: H264_ONLY,
      source: { height: 720 }, requestedTier: '1080p'
    });
    const text = describeQuality(selection, 'remote');
    expect(text).toContain('720p');
    expect(text).toContain('over the internet');
    expect(text).toContain('not higher resolution');
  });

  it('recognises only the two network classes it knows', () => {
    expect(isNetworkClass('lan')).toBe(true);
    expect(isNetworkClass('remote')).toBe(true);
    expect(isNetworkClass('wifi')).toBe(false);
    expect(isNetworkClass(undefined)).toBe(false);
  });
});

describe('segment packaging', () => {
  it('keeps H.264 in MPEG-TS and puts the newer codecs in fragmented MP4', () => {
    expect(packagingFor('h264')).toBe('mpegts');
    expect(packagingFor('hevc')).toBe('fmp4');
    expect(packagingFor('av1')).toBe('fmp4');
  });

  it('names segments to match their packaging', () => {
    expect(segmentExtension('mpegts')).toBe('ts');
    expect(segmentExtension('fmp4')).toBe('m4s');
    expect(segmentContentType('mpegts')).toBe('video/mp2t');
    expect(segmentContentType('fmp4')).toBe('video/mp4');
  });
});

describe('encoder names', () => {
  it('uses the software encoder worth using for each codec', () => {
    expect(encoderNameFor('h264', 'none')).toBe('libx264');
    expect(encoderNameFor('hevc', 'none')).toBe('libx265');
    // libaom is correct AV1 and far too slow to transcode with in real time.
    expect(encoderNameFor('av1', 'none')).toBe('libsvtav1');
  });

  it('names the hardware encoders FFmpeg actually ships', () => {
    expect(encoderNameFor('hevc', 'nvenc')).toBe('hevc_nvenc');
    expect(encoderNameFor('av1', 'qsv')).toBe('av1_qsv');
    expect(encoderCandidates('hevc')).toContain('hevc_vaapi');
    expect(encoderCandidates('hevc')).toContain('libx265');
  });

  it('reads a real FFmpeg encoder table', () => {
    const table = [
      'Encoders:',
      ' V..... libsvtav1            SVT-AV1 encoder (codec av1)',
      ' V....D libx264              libx264 H.264 (codec h264)',
      ' V....D libx264rgb           libx264 H.264 RGB (codec h264)',
      ' A....D aac                  AAC (Advanced Audio Coding)'
    ].join('\n');

    const names = encoderNamesFrom(table);
    expect(names.has('libx264')).toBe(true);
    expect(names.has('libsvtav1')).toBe(true);
    expect(names.has('aac')).toBe(true);
    expect(names.has('libx265')).toBe(false);

    const available = encodersFromFfmpegList(table);
    expect(available).toEqual({ h264: true, hevc: false, av1: true });
  });

  it('does not report a codec from a build that lacks it', () => {
    const available = encodersFromFfmpegList(' V....D libx264   libx264 H.264 (codec h264)');
    expect(available.hevc).toBe(false);
    expect(available.av1).toBe(false);
  });

  it('gives each encoder the preset vocabulary it understands', () => {
    // SVT-AV1 takes a number where x264 takes a word; the wrong one is a
    // startup failure, not a slower encode.
    expect(encoderTuningArgs('libsvtav1')).toEqual(['-preset', '8']);
    expect(encoderTuningArgs('libx264')).toEqual(['-preset', 'veryfast']);
    expect(encoderTuningArgs('libx265')).toContain('hvc1');
    expect(encoderTuningArgs('hevc_nvenc')).toEqual(['-preset', 'p4', '-tag:v', 'hvc1']);
    expect(encoderTuningArgs('h264_nvenc')).toEqual(['-preset', 'p4']);
    expect(encoderTuningArgs('h264_vaapi')).toEqual([]);
  });
});

describe('applying a selection to a quality profile', () => {
  it('keeps the aspect ratio and rewrites the video numbers', () => {
    const selection = selectQuality({
      capabilities: client(), network: 'lan', encoders: H264_ONLY,
      source: { height: 720 }, requestedTier: '1080p'
    });
    const profile = profileForSelection(QUALITY_PROFILES['1080p']!, selection);

    expect(profile.height).toBe(720);
    expect(profile.width).toBe(1280);
    expect(profile.videoBitrate).toBe(`${Math.round(selection.bitrate / 1000)}k`);
    // Audio is not this decision's business.
    expect(profile.audioBitrate).toBe(QUALITY_PROFILES['1080p']!.audioBitrate);
  });

  it('only ever produces even dimensions, which is all an encoder accepts', () => {
    const profile = profileForSelection(QUALITY_PROFILES['1080p']!, {
      codec: 'h264', height: 719, bitrate: 3_000_000, tierName: '1080p',
      codecReason: 'h264-baseline', cappedBySource: true
    });
    expect(profile.height % 2).toBe(0);
    expect(profile.width % 2).toBe(0);
  });
});

function fakeSpawn(recorded: string[][]) {
  return (_command: string, args: string[]) => {
    recorded.push(args);
    const child = new EventEmitter() as ChildProcessWithoutNullStreams;
    Object.assign(child, {
      stdout: new PassThrough(),
      stderr: new PassThrough(),
      stdin: new PassThrough(),
      exitCode: null,
      signalCode: null,
      kill: () => true
    });
    return child;
  };
}

function buildSession(overrides: Record<string, unknown>) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'caster-quality-'));
  const recorded: string[][] = [];
  const session = new TranscodeSession({
    key: 'k',
    filePath: '/media/film.mkv',
    mediaId: 'm1',
    quality: '1080p',
    profile: QUALITY_PROFILES['1080p']!,
    accel: 'none',
    audioPlan: planAudioStream({ codec: 'aac', channels: 2 }, { mode: 'stereo', stereoBitrate: '256k' }),
    subtitlePlan: planSubtitles({ tracks: [] }),
    startSegment: 0,
    rootDirectory: root,
    spawn: fakeSpawn(recorded),
    idleTimeoutMs: 60_000,
    segmentWaitTimeoutMs: 1000,
    pollIntervalMs: 1,
    warn: () => {},
    ...overrides
  } as any);

  session.start();
  session.stop();
  fs.rmSync(root, { recursive: true, force: true });
  return { session, args: recorded[0] ?? [] };
}

describe('encoder arguments for a session', () => {
  it('encodes H.264 into MPEG-TS segments, as it always has', () => {
    const { session, args } = buildSession({ outputCodec: 'h264' });
    expect(session.packaging).toBe('mpegts');
    expect(args).toContain('libx264');
    expect(args.join(' ')).toContain('-hls_segment_type mpegts');
    expect(args.join(' ')).toContain('segment-%d.ts');
    expect(args).not.toContain('-hls_fmp4_init_filename');
  });

  it('encodes HEVC into fragmented MP4 with an initialisation segment', () => {
    const { session, args } = buildSession({ outputCodec: 'hevc' });
    const line = args.join(' ');

    expect(session.packaging).toBe('fmp4');
    expect(session.videoEncoder).toBe('libx265');
    expect(line).toContain('-c:v libx265');
    // HEVC in MP4 needs the hvc1 tag or players refuse the track.
    expect(line).toContain('-tag:v hvc1');
    expect(line).toContain('-hls_segment_type fmp4');
    expect(line).toContain(`-hls_fmp4_init_filename ${INIT_SEGMENT_NAME}`);
    expect(line).toContain('segment-%d.m4s');
    expect(session.segmentPath(3).endsWith('segment-3.m4s')).toBe(true);
  });

  it('encodes AV1 with the preset scale SVT-AV1 understands', () => {
    const { args } = buildSession({ outputCodec: 'av1' });
    const line = args.join(' ');
    expect(line).toContain('-c:v libsvtav1');
    expect(line).toContain('-preset 8');
    expect(line).toContain('-hls_segment_type fmp4');
  });

  it('uses the exact encoder the caller verified rather than guessing', () => {
    const { session, args } = buildSession({
      outputCodec: 'hevc',
      accel: 'nvenc',
      videoEncoder: 'hevc_nvenc'
    });
    expect(session.videoEncoder).toBe('hevc_nvenc');
    expect(args.join(' ')).toContain('-c:v hevc_nvenc');
  });

  it('keeps a copied stream in MPEG-TS whatever the client could decode', () => {
    // Nothing is re-encoded, so the bytes are H.264 in TS regardless.
    const { session, args } = buildSession({ outputCodec: 'hevc', videoAction: 'copy' });
    expect(session.packaging).toBe('mpegts');
    expect(args.join(' ')).toContain('-c:v copy');
  });

  it('scales through VAAPI on the GPU rather than in a normal filter chain', () => {
    const { args } = buildSession({
      outputCodec: 'hevc',
      accel: 'vaapi',
      videoEncoder: 'hevc_vaapi',
      hardwareDevicePath: '/dev/dri/renderD128'
    });
    const line = args.join(' ');
    expect(line).toContain('scale_vaapi');
    expect(line).toContain('-c:v hevc_vaapi');
  });
});

const ENCODER_TABLE = [
  'Encoders:',
  ' V....D libx264              libx264 H.264 (codec h264)',
  ' V....D libx265              libx265 H.265 / HEVC (codec hevc)'
].join('\n');

function engineWith(encoderTable: string) {
  return new TranscodingEngine({
    platform: 'linux',
    scheduleMaintenance: false,
    existsSync: () => false,
    readdirSync: () => [],
    warn: () => {},
    execFileSync: (_command, args) => {
      if (args[0] === '-version') return 'ffmpeg version fixture\n';
      if (args.includes('-encoders')) return encoderTable;
      return '';
    }
  });
}

describe('what the engine reports it can encode', () => {
  it('reads the output codecs out of the FFmpeg build', () => {
    const status = engineWith(ENCODER_TABLE).getHardwareStatus();
    expect(status.outputCodecs).toEqual({ h264: true, hevc: true, av1: false });
  });

  it('reports no HEVC when the build has none', () => {
    const status = engineWith(' V....D libx264   libx264 H.264 (codec h264)').getHardwareStatus();
    expect(status.outputCodecs?.hevc).toBe(false);
  });

  it('reports no hardware codecs on a machine with no working GPU', () => {
    const status = engineWith(ENCODER_TABLE).getHardwareStatus();
    expect(status.hardwareCodecs).toEqual({ h264: false, hevc: false, av1: false });
  });
});

describe('playlists follow the codec decision', () => {
  const engine = engineWith(ENCODER_TABLE);

  it('gives a remote TV that decodes HEVC a fragmented-MP4 stream', () => {
    const decision = engine.describeStreamPackaging('1080p', undefined, {
      capabilities: CLIENT_PROFILES['tv-generic']!,
      network: 'remote'
    });
    expect(decision.codec).toBe('hevc');
    expect(decision.packaging).toBe('fmp4');
  });

  it('leaves the same TV on H.264 at home, where the CPU matters more', () => {
    const decision = engine.describeStreamPackaging('1080p', undefined, {
      capabilities: CLIENT_PROFILES['tv-generic']!,
      network: 'lan'
    });
    expect(decision.codec).toBe('h264');
    expect(decision.packaging).toBe('mpegts');
  });

  it('leaves a device that described nothing on plain H.264', () => {
    const decision = engine.describeStreamPackaging('1080p', undefined, {
      capabilities: CLIENT_PROFILES['unknown']!,
      network: 'lan'
    });
    expect(decision.codec).toBe('h264');
    expect(decision.packaging).toBe('mpegts');
  });

  it('keeps a directly copied stream in MPEG-TS', () => {
    const decision = engine.describeStreamPackaging(
      '1080p',
      { videoAction: 'copy' } as any,
      { capabilities: CLIENT_PROFILES['tv-generic']!, network: 'remote' }
    );
    expect(decision.packaging).toBe('mpegts');
  });

  it('points a fragmented playlist at its initialisation segment', () => {
    const playlist = engine.generateVariantPlaylist('m1', 30, '1080p', '?client=tv', 'fmp4');

    expect(playlist).toContain('#EXT-X-VERSION:7');
    expect(playlist).toContain(
      `#EXT-X-MAP:URI="/api/media/m1/hls/1080p/${INIT_SEGMENT_NAME}?client=tv"`
    );
    expect(playlist).toContain('/api/media/m1/hls/1080p/segment-0.m4s?client=tv');
    expect(playlist).not.toContain('.ts');
  });

  it('leaves an MPEG-TS playlist exactly as it was', () => {
    const playlist = engine.generateVariantPlaylist('m1', 30, '1080p', '', 'mpegts');
    expect(playlist).toContain('#EXT-X-VERSION:3');
    expect(playlist).not.toContain('EXT-X-MAP');
    expect(playlist).toContain('/api/media/m1/hls/1080p/segment-0.ts');
  });

  it('advertises less bandwidth to a remote viewer than to one on the LAN', () => {
    const capabilities = CLIENT_PROFILES['chrome']!;
    const source = { height: 2160 };
    const bandwidthOf = (playlist: string) =>
      Number(playlist.match(/BANDWIDTH=(\d+)/)?.[1] ?? 0);

    const lan = engine.generateMasterPlaylist('m1', 3840, 2160, '', {
      capabilities, network: 'lan', source
    });
    const remote = engine.generateMasterPlaylist('m1', 3840, 2160, '', {
      capabilities, network: 'remote', source
    });

    expect(bandwidthOf(lan)).toBeGreaterThan(bandwidthOf(remote));
  });

  it('leaves the shipped ladder alone when the caller knows nothing', () => {
    const playlist = engine.generateMasterPlaylist('m1', 1920, 1080);
    const shipped = QUALITY_PROFILES['1080p']!;
    const expected =
      parseInt(shipped.maxBitrate, 10) * 1000 + parseInt(shipped.audioBitrate, 10) * 1000;
    expect(playlist).toContain(`BANDWIDTH=${expected}`);
  });
});
