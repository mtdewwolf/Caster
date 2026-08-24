import crypto from 'crypto';

const CAST_ACCESS_VERSION = 1;
export const CAST_ACCESS_TTL_MS = 12 * 60 * 60 * 1000;

interface CastAccessPayload {
  v: number;
  userId: string;
  mediaId: string;
  expiresAt: number;
}

export interface CastAccessGrant {
  token: string;
  expiresAt: string;
}

const configuredSecret = process.env.CASTER_CAST_SECRET?.trim();
const defaultSecret = configuredSecret
  ? crypto.createHash('sha256').update(configuredSecret).digest()
  : crypto.randomBytes(32);

function signature(payload: string, secret: Uint8Array): Buffer {
  return crypto.createHmac('sha256', secret).update(payload).digest();
}

function castMediaIdForPath(pathname: string): string | null {
  const match = pathname.match(
    /^\/api\/media\/([^/]+)\/(?:stream|thumbnail|subtitles\/\d+|hls\/(?:master\.m3u8|[^/]+\/(?:index\.m3u8|segment-\d+\.ts)))$/
  );
  if (!match) return null;
  try {
    return decodeURIComponent(match[1]);
  } catch {
    return null;
  }
}

export function createCastAccessToken(
  userId: string,
  mediaId: string,
  options: { now?: number; ttlMs?: number; secret?: Uint8Array } = {}
): CastAccessGrant {
  const now = options.now ?? Date.now();
  const payload: CastAccessPayload = {
    v: CAST_ACCESS_VERSION,
    userId,
    mediaId,
    expiresAt: now + (options.ttlMs ?? CAST_ACCESS_TTL_MS)
  };
  const encoded = Buffer.from(JSON.stringify(payload)).toString('base64url');
  const signed = signature(encoded, options.secret ?? defaultSecret).toString('base64url');
  return {
    token: `${encoded}.${signed}`,
    expiresAt: new Date(payload.expiresAt).toISOString()
  };
}

export function verifyCastAccessToken(
  token: string,
  pathname: string,
  options: { now?: number; secret?: Uint8Array } = {}
): { userId: string; mediaId: string; expiresAt: number } | null {
  if (!token || token.length > 4096) return null;
  const pieces = token.split('.');
  if (pieces.length !== 2 || !pieces[0] || !pieces[1]) return null;

  try {
    const expected = signature(pieces[0], options.secret ?? defaultSecret);
    const supplied = Buffer.from(pieces[1], 'base64url');
    if (expected.length !== supplied.length || !crypto.timingSafeEqual(expected, supplied)) return null;

    const payload = JSON.parse(Buffer.from(pieces[0], 'base64url').toString('utf8')) as Partial<CastAccessPayload>;
    if (
      payload.v !== CAST_ACCESS_VERSION ||
      typeof payload.userId !== 'string' || !payload.userId ||
      typeof payload.mediaId !== 'string' || !payload.mediaId ||
      typeof payload.expiresAt !== 'number' || !Number.isSafeInteger(payload.expiresAt) ||
      payload.expiresAt <= (options.now ?? Date.now())
    ) return null;

    const requestedMediaId = castMediaIdForPath(pathname);
    if (requestedMediaId !== payload.mediaId) return null;
    return {
      userId: payload.userId,
      mediaId: payload.mediaId,
      expiresAt: payload.expiresAt
    };
  } catch {
    return null;
  }
}

