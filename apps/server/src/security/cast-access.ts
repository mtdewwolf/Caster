import crypto from 'crypto';
import fs from 'fs';
import path from 'path';

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

const CAST_SECRET_FILE_MODE = 0o600;
let cachedSecret: Buffer | null = null;
let warnedAboutEphemeralSecret = false;

export function castSecretFilePath(): string {
  const dataDir = process.env.MEDIA_DATA_DIR || path.join(process.cwd(), 'data');
  return path.join(dataDir, 'cast-secret.key');
}

function readPersistedSecret(filePath: string): Buffer | null {
  try {
    const stored = fs.readFileSync(filePath, 'utf8').trim();
    if (!stored) return null;
    const decoded = Buffer.from(stored, 'base64');
    return decoded.length === 32 ? decoded : null;
  } catch {
    return null;
  }
}

function persistSecret(filePath: string, secret: Buffer): boolean {
  try {
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    fs.writeFileSync(filePath, `${secret.toString('base64')}\n`, {
      encoding: 'utf8',
      mode: CAST_SECRET_FILE_MODE
    });
    try {
      fs.chmodSync(filePath, CAST_SECRET_FILE_MODE);
    } catch {
      // Windows and some network filesystems do not support POSIX modes.
    }
    return true;
  } catch {
    return false;
  }
}

/**
 * Resolves the HMAC key used to sign cast grants.
 *
 * A grant outlives the request that created it, so the key has to outlive the
 * process too: an ephemeral key silently invalidates every outstanding grant on
 * restart and cannot verify grants issued by a second instance. Preference
 * order is the explicit CASTER_CAST_SECRET, then a key persisted beside the
 * database, then a newly generated key that is written back to disk.
 */
function resolveDefaultSecret(): Buffer {
  if (cachedSecret) return cachedSecret;

  const configuredSecret = process.env.CASTER_CAST_SECRET?.trim();
  if (configuredSecret) {
    cachedSecret = crypto.createHash('sha256').update(configuredSecret).digest();
    return cachedSecret;
  }

  const filePath = castSecretFilePath();
  const persisted = readPersistedSecret(filePath);
  if (persisted) {
    cachedSecret = persisted;
    return cachedSecret;
  }

  const generated = crypto.randomBytes(32);
  if (!persistSecret(filePath, generated) && !warnedAboutEphemeralSecret) {
    warnedAboutEphemeralSecret = true;
    console.warn(
      `SECURITY NOTICE: Could not persist a cast signing key to ${filePath}. ` +
      'Cast grants will stop working after a restart. Set CASTER_CAST_SECRET to a fixed value.'
    );
  }
  cachedSecret = generated;
  return cachedSecret;
}

/** Test seam: forces the next signing operation to re-resolve the key. */
export function resetCastSecretCache(): void {
  cachedSecret = null;
  warnedAboutEphemeralSecret = false;
}

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
  const signed = signature(encoded, options.secret ?? resolveDefaultSecret()).toString('base64url');
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
    const expected = signature(pieces[0], options.secret ?? resolveDefaultSecret());
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

