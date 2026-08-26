import type { ClientCapabilities } from './capabilities';

/**
 * Choosing the output codec and bitrate for a transcode.
 *
 * The engine used to answer both questions with a constant: always H.264, and a
 * fixed resolution ladder regardless of where the viewer was. That wastes
 * bandwidth on a phone across the internet and wastes quality on a TV three
 * metres from the server on gigabit ethernet.
 *
 * Two inputs decide it. **What the client can decode** — a device that handles
 * HEVC gets a stream roughly 40% smaller at the same quality, and AV1 smaller
 * again. **Where the client is** — a LAN viewer can be given far more bitrate
 * than someone on a hotel connection. The source is a ceiling throughout:
 * upscaling a 720p file to 1080p spends bitrate inventing detail.
 */

export type NetworkClass = 'lan' | 'remote';
export type OutputCodec = 'h264' | 'hevc' | 'av1';

export const NETWORK_CLASSES: readonly NetworkClass[] = ['lan', 'remote'];

export function isNetworkClass(value: unknown): value is NetworkClass {
  return typeof value === 'string' && (NETWORK_CLASSES as readonly string[]).includes(value);
}

export interface QualityTier {
  name: string;
  height: number;
  /** Target video bitrate in bits per second, before codec adjustment. */
  bitrate: number;
}

/**
 * The resolution ladder, in bits per second for H.264.
 *
 * Deliberately generous on LAN — the constraint there is the decoder, not the
 * link — and conservative on remote, where the constraint is whatever the
 * viewer's upload and the server's connection can actually sustain.
 */
const LADDER: Record<NetworkClass, readonly QualityTier[]> = {
  lan: [
    { name: '4k', height: 2160, bitrate: 40_000_000 },
    { name: '1080p', height: 1080, bitrate: 12_000_000 },
    { name: '720p', height: 720, bitrate: 6_000_000 },
    { name: '480p', height: 480, bitrate: 2_500_000 }
  ],
  remote: [
    { name: '4k', height: 2160, bitrate: 16_000_000 },
    { name: '1080p', height: 1080, bitrate: 6_000_000 },
    { name: '720p', height: 720, bitrate: 3_000_000 },
    { name: '480p', height: 480, bitrate: 1_500_000 },
    { name: '360p', height: 360, bitrate: 800_000 }
  ]
};

/**
 * Bitrate multiplier per codec at equal perceived quality.
 *
 * Rough but well-established: HEVC needs about 60% of H.264's bitrate for the
 * same picture, AV1 about 50%. Being approximately right here is worth far more
 * than the constant that preceded it.
 */
const CODEC_EFFICIENCY: Record<OutputCodec, number> = {
  h264: 1,
  hevc: 0.6,
  av1: 0.5
};

export interface EncoderAvailability {
  h264: boolean;
  hevc: boolean;
  av1: boolean;
}

export type CodecReason =
  | 'client-supports-av1'
  | 'client-supports-hevc'
  | 'hevc-saves-remote-bandwidth'
  | 'h264-software-fallback'
  | 'h264-baseline';

export interface CodecOptions {
  /**
   * Codecs the machine can encode on a GPU.
   *
   * Left out, nothing counts as hardware — which is the safe reading, because
   * the cost of assuming a GPU that is not there is a stream that cannot keep
   * up with the person watching it.
   */
  hardware?: EncoderAvailability | undefined;
  network?: NetworkClass | undefined;
}

export interface QualitySelectionRequest {
  capabilities: ClientCapabilities;
  network: NetworkClass;
  /** Which output codecs this server can actually encode. */
  encoders: EncoderAvailability;
  /** Which of those run on a GPU. */
  hardwareEncoders?: EncoderAvailability | undefined;
  source: {
    height?: number | undefined;
    bitRate?: number | undefined;
    frameRate?: number | undefined;
  };
  /** Explicit tier name, when the viewer picked one by hand. */
  requestedTier?: string | undefined;
}

export interface QualitySelection {
  codec: OutputCodec;
  height: number;
  bitrate: number;
  tierName: string;
  /** Why this codec, for diagnostics. */
  codecReason: CodecReason;
  /** True when the source was already smaller than the tier. */
  cappedBySource: boolean;
}

/**
 * The most efficient codec both ends can handle *and this machine can keep up
 * with*.
 *
 * Two constraints, and the second is the one that is easy to forget. A client
 * that cannot decode the codec gets a black screen, so this only ever moves up
 * when the client has positively said it supports it. But a server encoding
 * AV1 in software runs well below real time on ordinary hardware, and a stream
 * the encoder cannot keep ahead of stalls — which is worse for the viewer than
 * the bandwidth it would have saved.
 *
 * So the newer codecs are used freely on a GPU, and in software only where the
 * bandwidth genuinely matters: a viewer coming in over the internet. On the
 * local network, where there is bandwidth to spare, H.264 is the right answer
 * even for a client that could decode better.
 */
export function selectOutputCodec(
  capabilities: ClientCapabilities,
  encoders: EncoderAvailability,
  options: CodecOptions = {}
): { codec: OutputCodec; reason: CodecReason } {
  const clientCodecs = new Set(capabilities.videoCodecs.map((entry) => entry.codec));
  const hardware = options.hardware ?? { h264: false, hevc: false, av1: false };
  const remote = options.network === 'remote';

  if (hardware.av1 && encoders.av1 && clientCodecs.has('av1')) {
    return { codec: 'av1', reason: 'client-supports-av1' };
  }
  if (hardware.hevc && encoders.hevc && clientCodecs.has('hevc')) {
    return { codec: 'hevc', reason: 'client-supports-hevc' };
  }
  // Software HEVC is roughly as expensive as H.264 and halves the bitrate, so
  // it is worth it where bandwidth is the constraint. Software AV1 is not: it
  // is several times slower, and slower than real time is unwatchable.
  if (remote && encoders.hevc && clientCodecs.has('hevc')) {
    return { codec: 'hevc', reason: 'hevc-saves-remote-bandwidth' };
  }
  if (clientCodecs.has('av1') || clientCodecs.has('hevc')) {
    return { codec: 'h264', reason: 'h264-software-fallback' };
  }
  // H.264 is the floor: everything decodes it, and a client that somehow
  // cannot would not have got this far.
  return { codec: 'h264', reason: 'h264-baseline' };
}

export function tiersFor(network: NetworkClass): readonly QualityTier[] {
  return LADDER[network];
}

export function selectQuality(request: QualitySelectionRequest): QualitySelection {
  const { codec, reason } = selectOutputCodec(request.capabilities, request.encoders, {
    hardware: request.hardwareEncoders,
    network: request.network
  });
  const tiers = tiersFor(request.network);

  const named = request.requestedTier
    ? tiers.find((tier) => tier.name === request.requestedTier)
    : undefined;

  // Without an explicit choice, take the best tier both the client's screen and
  // the source can justify.
  const ceiling = Math.min(
    request.capabilities.maxHeight,
    request.source.height ?? Number.POSITIVE_INFINITY
  );
  const chosen = named
    ?? tiers.find((tier) => tier.height <= ceiling)
    ?? tiers[tiers.length - 1]!;

  const sourceHeight = request.source.height;
  const cappedBySource = sourceHeight !== undefined && sourceHeight < chosen.height;
  // Never upscale: spending bitrate to invent detail that is not in the file
  // makes the stream bigger and the picture no better.
  const height = cappedBySource ? sourceHeight! : chosen.height;

  let bitrate = Math.round(chosen.bitrate * CODEC_EFFICIENCY[codec]);

  // A tier's bitrate assumes its full resolution; a capped stream needs less,
  // scaled by pixel count.
  if (cappedBySource && chosen.height > 0) {
    bitrate = Math.round(bitrate * ((height * height) / (chosen.height * chosen.height)));
  }

  // Re-encoding above the source bitrate cannot add quality.
  if (request.source.bitRate !== undefined && request.source.bitRate > 0) {
    bitrate = Math.min(bitrate, request.source.bitRate);
  }

  // High frame rate carries genuinely more information.
  if (request.source.frameRate !== undefined && request.source.frameRate > 45) {
    bitrate = Math.round(bitrate * 1.4);
  }

  // Whatever the client says its connection can carry is the hard ceiling.
  if (request.capabilities.maxBitrate !== undefined && request.capabilities.maxBitrate > 0) {
    bitrate = Math.min(bitrate, request.capabilities.maxBitrate);
  }

  return {
    codec,
    height,
    bitrate: Math.max(200_000, bitrate),
    tierName: chosen.name,
    codecReason: reason,
    cappedBySource
  };
}

/** FFmpeg encoder name for a codec on a given acceleration path. */
export function encoderNameFor(
  codec: OutputCodec,
  accel: 'nvenc' | 'qsv' | 'vaapi' | 'none'
): string {
  if (accel === 'none') {
    // libsvtav1 is the AV1 encoder worth using; libaom is far too slow to
    // transcode with in real time.
    return codec === 'av1' ? 'libsvtav1' : codec === 'hevc' ? 'libx265' : 'libx264';
  }
  return `${codec === 'hevc' ? 'hevc' : codec}_${accel}`;
}

/** Encoder names to probe for, per codec and acceleration path. */
export function encoderCandidates(codec: OutputCodec): readonly string[] {
  return [
    encoderNameFor(codec, 'nvenc'),
    encoderNameFor(codec, 'qsv'),
    encoderNameFor(codec, 'vaapi'),
    encoderNameFor(codec, 'none')
  ];
}

/** Reads which output codecs an FFmpeg build can produce. */
export function encodersFromFfmpegList(encoderList: string): EncoderAvailability {
  const names = encoderNamesFrom(encoderList);
  const any = (codec: OutputCodec) =>
    encoderCandidates(codec).some((candidate) => names.has(candidate));
  return {
    h264: any('h264'),
    hevc: any('hevc'),
    av1: any('av1')
  };
}

/** Plain-language note about the quality decision. */
export function describeQuality(selection: QualitySelection, network: NetworkClass): string {
  const resolution = `${selection.height}p`;
  const megabits = (selection.bitrate / 1_000_000).toFixed(1);
  const place = network === 'lan' ? 'on your local network' : 'over the internet';

  if (selection.cappedBySource) {
    return `Sending ${resolution} at ${megabits} Mbps ${place} — the original is not higher resolution than this.`;
  }
  return `Sending ${resolution} at ${megabits} Mbps ${place}.`;
}

/**
 * Which HLS packaging a codec needs.
 *
 * H.264 rides in MPEG-TS, which is what every HLS client has understood since
 * the beginning. HEVC and AV1 do not: the specification carries them in
 * fragmented MP4, with a separate initialisation segment the player fetches
 * first. Choosing the wrong container here produces a playlist that loads and
 * then plays nothing, so it follows the codec rather than being configurable.
 */
export type SegmentPackaging = 'mpegts' | 'fmp4';

export function packagingFor(codec: OutputCodec): SegmentPackaging {
  return codec === 'h264' ? 'mpegts' : 'fmp4';
}

export function segmentExtension(packaging: SegmentPackaging): string {
  return packaging === 'fmp4' ? 'm4s' : 'ts';
}

export const INIT_SEGMENT_NAME = 'init.mp4';

/** Content type for a segment of this packaging. */
export function segmentContentType(packaging: SegmentPackaging): string {
  return packaging === 'fmp4' ? 'video/mp4' : 'video/mp2t';
}

function even(value: number): number {
  const rounded = Math.max(2, Math.round(value));
  return rounded % 2 === 0 ? rounded : rounded + 1;
}

export interface EncodeProfile {
  name: string;
  width: number;
  height: number;
  videoBitrate: string;
  maxBitrate: string;
  audioBitrate: string;
  bufsize: string;
}

/**
 * Rewrites a fixed quality profile with the bitrate and size this selection
 * actually justifies.
 *
 * The profiles the engine ships with are one number per rung, chosen once and
 * applied to every viewer. This keeps their aspect ratio and audio settings and
 * replaces the video numbers with ones that account for the codec, the
 * connection and the source.
 */
export function profileForSelection<T extends EncodeProfile>(
  base: T,
  selection: QualitySelection
): T {
  const height = selection.height > 0 ? even(selection.height) : base.height;
  const width = base.height > 0 && base.width > 0
    ? even(base.width * (height / base.height))
    : base.width;
  const kbps = Math.max(1, Math.round(selection.bitrate / 1000));

  return {
    ...base,
    width,
    height,
    videoBitrate: `${kbps}k`,
    // Headroom for a busy scene, and a buffer of two seconds at that rate.
    maxBitrate: `${Math.round(kbps * 1.25)}k`,
    bufsize: `${kbps * 2}k`
  };
}

/**
 * FFmpeg arguments that are specific to one encoder.
 *
 * Presets are not a shared vocabulary: x264 and x265 take words, SVT-AV1 takes
 * a number, and the hardware encoders each have their own scale. Getting this
 * wrong makes FFmpeg exit immediately rather than degrade.
 */
export function encoderTuningArgs(encoder: string): string[] {
  if (encoder === 'libsvtav1') {
    // 8 of 13: the fastest preset that still looks like AV1 rather than a
    // smear, and fast enough to keep ahead of a viewer in real time.
    return ['-preset', '8'];
  }
  if (encoder === 'libx265') {
    return ['-preset', 'veryfast', '-tag:v', 'hvc1'];
  }
  if (encoder === 'libx264') {
    return ['-preset', 'veryfast'];
  }
  if (encoder.endsWith('_nvenc')) {
    const tag = encoder.startsWith('hevc') ? ['-tag:v', 'hvc1'] : [];
    return ['-preset', 'p4', ...tag];
  }
  if (encoder.endsWith('_qsv')) {
    const tag = encoder.startsWith('hevc') ? ['-tag:v', 'hvc1'] : [];
    return ['-preset', 'veryfast', ...tag];
  }
  if (encoder.endsWith('_vaapi')) {
    return encoder.startsWith('hevc') ? ['-tag:v', 'hvc1'] : [];
  }
  return [];
}

/** Every encoder name an FFmpeg build reported, for exact availability checks. */
export function encoderNamesFrom(encoderList: string): Set<string> {
  const names = new Set<string>();
  for (const line of encoderList.split('\n')) {
    // FFmpeg's -encoders table puts flags first, then the name, then a
    // description: " V....D h264_nvenc           NVIDIA NVENC H.264 encoder".
    const match = line.match(/^\s*[A-Z.]{6}\s+([A-Za-z0-9_]+)\s/);
    if (match?.[1]) names.add(match[1]);
  }
  return names;
}
