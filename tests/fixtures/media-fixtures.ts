import { spawnSync } from 'child_process';
import fs from 'fs';
import os from 'os';
import path from 'path';

const FIXTURE_DIRECTORY_PREFIX = 'caster-codec-fixtures-';
const FIXTURE_DURATION_SECONDS = 1.2;
const COMMAND_TIMEOUT_MS = 20_000;

export interface MediaToolCapabilities {
  ffmpegAvailable: boolean;
  ffprobeAvailable: boolean;
  ffmpegVersion?: string;
  ffprobeVersion?: string;
  encoders: Set<string>;
  muxers: Set<string>;
  demuxers: Set<string>;
  filters: Set<string>;
  diagnostics: string[];
}

export interface ExpectedFixtureStream {
  codecType: 'video' | 'audio' | 'subtitle';
  codecName: string;
  width?: number;
  height?: number;
  channels?: number;
  channelLayout?: string;
}

export interface MediaFixtureSpec {
  id: string;
  description: string;
  filename: string;
  expectedFormatName: string;
  expectedStreams: readonly ExpectedFixtureStream[];
}

export const MEDIA_FIXTURE_MATRIX = [
  {
    id: 'mp4-h264-aac-stereo',
    description: 'MP4 with H.264 video and stereo AAC audio',
    filename: 'Synthetic.Movie.2026.mp4',
    expectedFormatName: 'mp4',
    expectedStreams: [
      { codecType: 'video', codecName: 'h264', width: 96, height: 54 },
      { codecType: 'audio', codecName: 'aac', channels: 2, channelLayout: 'stereo' }
    ]
  },
  {
    id: 'matroska-mpeg4-ac3-surround-subs',
    description: 'Matroska with MPEG-4 video, 5.1 AC-3 audio, and embedded SubRip',
    filename: 'Synthetic.Surround.2026.mkv',
    expectedFormatName: 'matroska',
    expectedStreams: [
      { codecType: 'video', codecName: 'mpeg4', width: 96, height: 54 },
      { codecType: 'audio', codecName: 'ac3', channels: 6, channelLayout: '5.1' },
      { codecType: 'subtitle', codecName: 'subrip' }
    ]
  },
  {
    id: 'webm-vp8-opus-mono',
    description: 'WebM with VP8 video and mono Opus audio',
    filename: 'Synthetic.Clip.2026.webm',
    expectedFormatName: 'webm',
    expectedStreams: [
      { codecType: 'video', codecName: 'vp8', width: 96, height: 54 },
      { codecType: 'audio', codecName: 'opus', channels: 1, channelLayout: 'mono' }
    ]
  }
] as const satisfies readonly MediaFixtureSpec[];

export type MediaFixtureId = (typeof MEDIA_FIXTURE_MATRIX)[number]['id'];

export interface GeneratedMediaFixtures {
  root: string;
  files: Record<MediaFixtureId, string>;
  sidecarSubtitlePath: string;
}

export interface FfprobeStream {
  index: number;
  codec_name: string;
  codec_type: string;
  width?: number;
  height?: number;
  channels?: number;
  channel_layout?: string;
  sample_rate?: string;
  time_base?: string;
  avg_frame_rate?: string;
  duration_ts?: number;
  nb_frames?: string;
  disposition?: Record<string, number>;
  tags?: Record<string, string>;
}

export interface FfprobeResult {
  streams: FfprobeStream[];
  format: {
    filename: string;
    format_name: string;
    start_time?: string;
    duration?: string;
    size?: string;
    tags?: Record<string, string>;
  };
}

interface ToolResult {
  ok: boolean;
  stdout: string;
  stderr: string;
  error?: string;
}

function runTool(command: string, args: string[]): ToolResult {
  const result = spawnSync(command, args, {
    encoding: 'utf8',
    timeout: COMMAND_TIMEOUT_MS,
    windowsHide: true,
    maxBuffer: 4 * 1024 * 1024
  });

  return {
    ok: result.status === 0 && !result.error,
    stdout: result.stdout || '',
    stderr: result.stderr || '',
    error: result.error?.message
  };
}

function firstVersionLine(result: ToolResult, executable: string): string | undefined {
  return `${result.stdout}\n${result.stderr}`
    .split(/\r?\n/)
    .find((line) => line.toLowerCase().startsWith(`${executable} version `));
}

function parseEncoders(output: string): Set<string> {
  const encoders = new Set<string>();

  for (const line of output.split(/\r?\n/)) {
    const match = line.match(/^\s*[VAS][A-Z.]{5}\s+(\S+)/);
    if (match) encoders.add(match[1]);
  }

  return encoders;
}

function parseFilters(output: string): Set<string> {
  const filters = new Set<string>();

  for (const line of output.split(/\r?\n/)) {
    const match = line.match(/^\s*[T.][S.]\s+(\S+)/);
    if (match) filters.add(match[1]);
  }

  return filters;
}

function parseFormats(output: string, flag: 'D' | 'E'): Set<string> {
  const formats = new Set<string>();

  for (const line of output.split(/\r?\n/)) {
    const fields = line.trim().split(/\s+/);
    if (!fields[0]?.includes(flag)) continue;

    const nameField = fields[1] === 'd' ? fields[2] : fields[1];
    for (const name of nameField?.split(',') || []) {
      formats.add(name);
    }
  }

  return formats;
}

export function detectMediaToolCapabilities(): MediaToolCapabilities {
  const ffmpegVersionResult = runTool('ffmpeg', ['-version']);
  const ffprobeVersionResult = runTool('ffprobe', ['-version']);
  const diagnostics: string[] = [];

  if (!ffmpegVersionResult.ok) {
    diagnostics.push(`ffmpeg is unavailable${ffmpegVersionResult.error ? `: ${ffmpegVersionResult.error}` : ''}`);
  }
  if (!ffprobeVersionResult.ok) {
    diagnostics.push(`ffprobe is unavailable${ffprobeVersionResult.error ? `: ${ffprobeVersionResult.error}` : ''}`);
  }

  const encodersResult = ffmpegVersionResult.ok
    ? runTool('ffmpeg', ['-hide_banner', '-encoders'])
    : { ok: false, stdout: '', stderr: '' };
  const muxersResult = ffmpegVersionResult.ok
    ? runTool('ffmpeg', ['-hide_banner', '-muxers'])
    : { ok: false, stdout: '', stderr: '' };
  const demuxersResult = ffmpegVersionResult.ok
    ? runTool('ffmpeg', ['-hide_banner', '-demuxers'])
    : { ok: false, stdout: '', stderr: '' };
  const filtersResult = ffmpegVersionResult.ok
    ? runTool('ffmpeg', ['-hide_banner', '-filters'])
    : { ok: false, stdout: '', stderr: '' };

  for (const [label, result] of [
    ['encoder list', encodersResult],
    ['muxer list', muxersResult],
    ['demuxer list', demuxersResult],
    ['filter list', filtersResult]
  ] as const) {
    if (ffmpegVersionResult.ok && !result.ok) {
      diagnostics.push(`ffmpeg ${label} could not be queried${result.error ? `: ${result.error}` : ''}`);
    }
  }

  return {
    ffmpegAvailable: ffmpegVersionResult.ok,
    ffprobeAvailable: ffprobeVersionResult.ok,
    ffmpegVersion: firstVersionLine(ffmpegVersionResult, 'ffmpeg'),
    ffprobeVersion: firstVersionLine(ffprobeVersionResult, 'ffprobe'),
    encoders: parseEncoders(`${encodersResult.stdout}\n${encodersResult.stderr}`),
    muxers: parseFormats(`${muxersResult.stdout}\n${muxersResult.stderr}`, 'E'),
    demuxers: parseFormats(`${demuxersResult.stdout}\n${demuxersResult.stderr}`, 'D'),
    filters: parseFilters(`${filtersResult.stdout}\n${filtersResult.stderr}`),
    diagnostics
  };
}

export function getMissingMediaFixtureCapabilities(capabilities: MediaToolCapabilities): string[] {
  const missing = [...capabilities.diagnostics];

  for (const encoder of ['libx264', 'aac', 'mpeg4', 'ac3', 'libvpx', 'libopus']) {
    if (!capabilities.encoders.has(encoder)) missing.push(`encoder: ${encoder}`);
  }
  if (!capabilities.encoders.has('srt') && !capabilities.encoders.has('subrip')) {
    missing.push('encoder: srt or subrip');
  }
  for (const muxer of ['mp4', 'matroska', 'webm']) {
    if (!capabilities.muxers.has(muxer)) missing.push(`muxer: ${muxer}`);
  }
  for (const demuxer of ['lavfi', 'srt']) {
    if (!capabilities.demuxers.has(demuxer)) missing.push(`demuxer: ${demuxer}`);
  }
  for (const filter of ['color', 'sine', 'anullsrc']) {
    if (!capabilities.filters.has(filter)) missing.push(`filter: ${filter}`);
  }

  return missing;
}

export function assertMediaFixtureCapabilities(capabilities: MediaToolCapabilities): void {
  const missing = getMissingMediaFixtureCapabilities(capabilities);
  if (missing.length > 0) {
    throw new Error(`Cannot generate the codec fixture matrix. Missing FFmpeg capabilities:\n- ${missing.join('\n- ')}`);
  }
}

function runFfmpeg(label: string, args: string[]): void {
  const result = runTool('ffmpeg', [
    '-nostdin',
    '-hide_banner',
    '-loglevel', 'error',
    '-y',
    ...args
  ]);

  if (!result.ok) {
    const details = result.error || result.stderr.trim() || 'unknown ffmpeg error';
    throw new Error(`Failed to generate ${label}: ${details}`);
  }
}

function isOwnedFixtureDirectory(directory: string): boolean {
  const resolvedDirectory = path.resolve(directory);
  const resolvedTempDirectory = path.resolve(os.tmpdir());

  return resolvedDirectory.startsWith(`${resolvedTempDirectory}${path.sep}`) &&
    path.basename(resolvedDirectory).startsWith(FIXTURE_DIRECTORY_PREFIX);
}

export function removeRuntimeMediaFixtures(fixtures: GeneratedMediaFixtures | string): void {
  const root = typeof fixtures === 'string' ? fixtures : fixtures.root;
  if (!isOwnedFixtureDirectory(root)) {
    throw new Error(`Refusing to remove media fixture directory outside the owned OS temp path: ${root}`);
  }

  fs.rmSync(root, {
    recursive: true,
    force: true,
    maxRetries: 5,
    retryDelay: 50
  });
}

export function createRuntimeMediaFixtures(
  capabilities: MediaToolCapabilities = detectMediaToolCapabilities()
): GeneratedMediaFixtures {
  assertMediaFixtureCapabilities(capabilities);

  const root = fs.mkdtempSync(path.join(os.tmpdir(), FIXTURE_DIRECTORY_PREFIX));
  const files = {} as Record<MediaFixtureId, string>;
  const sidecarSubtitlePath = path.join(root, 'Synthetic.Movie.2026.en.srt');
  const subtitleText = [
    '1',
    '00:00:00,100 --> 00:00:00,500',
    'Synthetic fixture caption.',
    '',
    '2',
    '00:00:00,650 --> 00:00:01,050',
    'Seek target caption.',
    ''
  ].join('\n');

  try {
    fs.writeFileSync(sidecarSubtitlePath, subtitleText, 'utf8');

    files['mp4-h264-aac-stereo'] = path.join(root, 'Synthetic.Movie.2026.mp4');
    runFfmpeg('MP4/H.264/AAC fixture', [
      '-f', 'lavfi',
      '-i', `color=c=0x315c8c:s=96x54:r=10:d=${FIXTURE_DURATION_SECONDS}`,
      '-f', 'lavfi',
      '-i', `sine=frequency=440:sample_rate=48000:duration=${FIXTURE_DURATION_SECONDS}`,
      '-map', '0:v:0',
      '-map', '1:a:0',
      '-t', FIXTURE_DURATION_SECONDS.toString(),
      '-map_metadata', '-1',
      '-metadata', 'title=Caster synthetic MP4 fixture',
      '-metadata:s:a:0', 'language=eng',
      '-c:v', 'libx264',
      '-preset', 'ultrafast',
      '-crf', '35',
      '-g', '1',
      '-threads', '1',
      '-pix_fmt', 'yuv420p',
      '-c:a', 'aac',
      '-b:a', '64k',
      '-ac', '2',
      '-movflags', '+faststart',
      files['mp4-h264-aac-stereo']
    ]);

    files['matroska-mpeg4-ac3-surround-subs'] = path.join(root, 'Synthetic.Surround.2026.mkv');
    const subtitleEncoder = capabilities.encoders.has('srt') ? 'srt' : 'subrip';
    runFfmpeg('Matroska/MPEG-4/AC-3/SubRip fixture', [
      '-f', 'lavfi',
      '-i', `color=c=0x477a46:s=96x54:r=10:d=${FIXTURE_DURATION_SECONDS}`,
      '-f', 'lavfi',
      '-i', `anullsrc=channel_layout=5.1:sample_rate=48000:d=${FIXTURE_DURATION_SECONDS}`,
      '-i', sidecarSubtitlePath,
      '-map', '0:v:0',
      '-map', '1:a:0',
      '-map', '2:s:0',
      '-t', FIXTURE_DURATION_SECONDS.toString(),
      '-map_metadata', '-1',
      '-metadata', 'title=Caster synthetic Matroska fixture',
      '-metadata:s:a:0', 'language=eng',
      '-metadata:s:s:0', 'language=eng',
      '-metadata:s:s:0', 'title=Synthetic captions',
      '-disposition:s:0', 'default',
      '-c:v', 'mpeg4',
      '-q:v', '8',
      '-g', '1',
      '-threads', '1',
      '-pix_fmt', 'yuv420p',
      '-c:a', 'ac3',
      '-b:a', '192k',
      '-ac', '6',
      '-c:s', subtitleEncoder,
      files['matroska-mpeg4-ac3-surround-subs']
    ]);

    files['webm-vp8-opus-mono'] = path.join(root, 'Synthetic.Clip.2026.webm');
    runFfmpeg('WebM/VP8/Opus fixture', [
      '-f', 'lavfi',
      '-i', `color=c=0x704a82:s=96x54:r=10:d=${FIXTURE_DURATION_SECONDS}`,
      '-f', 'lavfi',
      '-i', `sine=frequency=660:sample_rate=48000:duration=${FIXTURE_DURATION_SECONDS}`,
      '-map', '0:v:0',
      '-map', '1:a:0',
      '-t', FIXTURE_DURATION_SECONDS.toString(),
      '-map_metadata', '-1',
      '-metadata', 'title=Caster synthetic WebM fixture',
      '-metadata:s:a:0', 'language=eng',
      '-c:v', 'libvpx',
      '-deadline', 'realtime',
      '-cpu-used', '8',
      '-crf', '35',
      '-b:v', '100k',
      '-g', '10',
      '-threads', '1',
      '-pix_fmt', 'yuv420p',
      '-c:a', 'libopus',
      '-b:a', '48k',
      '-ac', '1',
      files['webm-vp8-opus-mono']
    ]);

    return { root, files, sidecarSubtitlePath };
  } catch (error) {
    removeRuntimeMediaFixtures(root);
    throw error;
  }
}

export function probeMediaFile(filePath: string): FfprobeResult {
  const result = runTool('ffprobe', [
    '-v', 'error',
    '-print_format', 'json',
    '-show_format',
    '-show_streams',
    filePath
  ]);

  if (!result.ok) {
    throw new Error(`ffprobe failed for ${filePath}: ${result.error || result.stderr.trim() || 'unknown error'}`);
  }

  try {
    return JSON.parse(result.stdout) as FfprobeResult;
  } catch (error) {
    throw new Error(`ffprobe returned invalid JSON for ${filePath}: ${String(error)}`);
  }
}

export function probeVideoPacketTimes(
  filePath: string,
  startSeconds: number,
  intervalSeconds: number
): number[] {
  const result = runTool('ffprobe', [
    '-v', 'error',
    '-select_streams', 'v:0',
    '-read_intervals', `${startSeconds}%+${intervalSeconds}`,
    '-show_packets',
    '-show_entries', 'packet=pts_time',
    '-of', 'json',
    filePath
  ]);

  if (!result.ok) {
    throw new Error(`ffprobe seek failed for ${filePath}: ${result.error || result.stderr.trim() || 'unknown error'}`);
  }

  try {
    const parsed = JSON.parse(result.stdout) as { packets?: Array<{ pts_time?: string }> };
    return (parsed.packets || [])
      .map((packet) => Number(packet.pts_time))
      .filter(Number.isFinite);
  } catch (error) {
    throw new Error(`ffprobe seek returned invalid JSON for ${filePath}: ${String(error)}`);
  }
}
