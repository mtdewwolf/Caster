import crypto from 'crypto';
import type { Context, MiddlewareHandler } from 'hono';
import { deleteCookie, getCookie, setCookie } from 'hono/cookie';
import { Hono } from 'hono';
import { getConnInfo } from 'hono/bun';

const SESSION_COOKIE = 'caster_admin_session';
const SESSION_TTL_SECONDS = 12 * 60 * 60;
const LOGIN_WINDOW_MS = 15 * 60 * 1000;
const MAX_LOGIN_FAILURES = 5;
const MUTATION_METHODS = new Set(['POST', 'PUT', 'PATCH', 'DELETE']);
const PUBLIC_AUTH_MUTATIONS = new Set(['/api/auth/login', '/api/auth/logout']);

export const ADMIN_USER_ID = 'admin';
export const PUBLIC_USER_ID = 'public';

interface LoginAttempt {
  failures: number;
  resetAt: number;
}

const sessions = new Map<string, number>();
const loginAttempts = new Map<string, LoginAttempt>();

function configuredCredentials(): string[] {
  return [process.env.ADMIN_PASSWORD, process.env.ADMIN_TOKEN].filter(
    (value): value is string => typeof value === 'string' && value.length > 0
  );
}

export function isAuthConfigured(): boolean {
  return configuredCredentials().length > 0;
}

function digest(value: string): Buffer {
  return crypto.createHash('sha256').update(value).digest();
}

function credentialMatches(candidate: string): boolean {
  const candidateDigest = digest(candidate);
  let matches = false;

  for (const configured of configuredCredentials()) {
    matches = crypto.timingSafeEqual(candidateDigest, digest(configured)) || matches;
  }

  return matches;
}

function pruneExpiredSessions(now = Date.now()): void {
  for (const [token, expiresAt] of sessions) {
    if (expiresAt <= now) sessions.delete(token);
  }
}

function createSession(): string {
  pruneExpiredSessions();
  const token = crypto.randomBytes(32).toString('base64url');
  sessions.set(token, Date.now() + SESSION_TTL_SECONDS * 1000);
  return token;
}

function isValidSession(token: string | undefined): boolean {
  if (!token) return false;
  const expiresAt = sessions.get(token);
  if (!expiresAt) return false;
  if (expiresAt <= Date.now()) {
    sessions.delete(token);
    return false;
  }
  return true;
}

function bearerToken(c: Context): string | undefined {
  const authorization = c.req.header('authorization');
  if (!authorization?.startsWith('Bearer ')) return undefined;
  return authorization.slice('Bearer '.length).trim();
}

function hasAdminAccess(c: Context): boolean {
  const bearer = bearerToken(c);
  if (bearer && credentialMatches(bearer)) return true;
  return isValidSession(getCookie(c, SESSION_COOKIE));
}

/**
 * Resolve the progress owner for this request. The current authentication
 * implementation has one authenticated principal; keeping this mapping here
 * lets a future multi-user auth layer replace it without changing media and
 * progress routes again.
 */
export function getCurrentUserId(c: Context): string {
  return hasAdminAccess(c) ? ADMIN_USER_ID : PUBLIC_USER_ID;
}

function requestIsSecure(c: Context): boolean {
  const forwardedProtocol = c.req.header('x-forwarded-proto')?.split(',')[0].trim();
  return forwardedProtocol === 'https' || new URL(c.req.url).protocol === 'https:';
}

function loginKey(c: Context): string {
  try {
    const remoteAddress = getConnInfo(c).remote.address;
    if (remoteAddress) return remoteAddress;
  } catch {
    // Unit tests and non-Bun adapters do not expose Bun's server connection info.
  }

  return (
    c.req.header('cf-connecting-ip') ||
    c.req.header('x-real-ip') ||
    c.req.header('x-forwarded-for')?.split(',')[0].trim() ||
    'unknown'
  );
}

function currentLoginAttempt(key: string): LoginAttempt | undefined {
  const attempt = loginAttempts.get(key);
  if (attempt && attempt.resetAt <= Date.now()) {
    loginAttempts.delete(key);
    return undefined;
  }
  return attempt;
}

function recordLoginFailure(key: string): void {
  const existing = currentLoginAttempt(key);
  loginAttempts.set(key, {
    failures: (existing?.failures ?? 0) + 1,
    resetAt: existing?.resetAt ?? Date.now() + LOGIN_WINDOW_MS
  });
}

export const requireAdminForMutations: MiddlewareHandler = async (c, next) => {
  if (!MUTATION_METHODS.has(c.req.method) || PUBLIC_AUTH_MUTATIONS.has(c.req.path)) {
    await next();
    return;
  }

  if (!isAuthConfigured()) {
    return c.json(
      { error: 'Admin authentication is not configured on this server' },
      503
    );
  }

  if (!hasAdminAccess(c)) {
    c.header('WWW-Authenticate', 'Bearer');
    return c.json({ error: 'Admin authentication required' }, 401);
  }

  await next();
};

export const authRouter = new Hono();

authRouter.get('/session', (c) => {
  c.header('Cache-Control', 'no-store');
  return c.json({
    authenticated: isAuthConfigured() && hasAdminAccess(c),
    configured: isAuthConfigured()
  });
});

authRouter.post('/login', async (c) => {
  c.header('Cache-Control', 'no-store');

  if (!isAuthConfigured()) {
    return c.json(
      { error: 'Set ADMIN_PASSWORD or ADMIN_TOKEN on the server before signing in' },
      503
    );
  }

  const key = loginKey(c);
  const attempt = currentLoginAttempt(key);
  if (attempt && attempt.failures >= MAX_LOGIN_FAILURES) {
    const retryAfter = Math.max(1, Math.ceil((attempt.resetAt - Date.now()) / 1000));
    c.header('Retry-After', retryAfter.toString());
    return c.json({ error: 'Too many sign-in attempts. Try again later.' }, 429);
  }

  let credential = '';
  try {
    const body = await c.req.json<{ password?: unknown }>();
    credential = typeof body.password === 'string' ? body.password : '';
  } catch {
    return c.json({ error: 'A password or token is required' }, 400);
  }

  if (credential.length > 4096 || !credentialMatches(credential)) {
    recordLoginFailure(key);
    return c.json({ error: 'Invalid admin credential' }, 401);
  }

  loginAttempts.delete(key);
  const token = createSession();
  setCookie(c, SESSION_COOKIE, token, {
    httpOnly: true,
    sameSite: 'Strict',
    secure: requestIsSecure(c),
    path: '/',
    maxAge: SESSION_TTL_SECONDS
  });

  return c.json({ authenticated: true });
});

authRouter.post('/logout', (c) => {
  const token = getCookie(c, SESSION_COOKIE);
  if (token) sessions.delete(token);
  deleteCookie(c, SESSION_COOKIE, { path: '/' });
  c.header('Cache-Control', 'no-store');
  return c.json({ authenticated: false });
});
