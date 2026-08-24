import crypto from 'crypto';
import type { Context, MiddlewareHandler } from 'hono';
import { deleteCookie, getCookie, setCookie } from 'hono/cookie';
import { Hono } from 'hono';
import { getConnInfo } from 'hono/bun';
import { db } from './db';
import { AccessControlStore } from './db/access-control';
import { AccountProvisioningStore } from './db/account-provisioning';
import { SqliteSessionStore, type SessionStore } from './db/session-store';
import { SqliteUserStore, type UserRecord, type UserRole } from './db/user-store';
import { ADMIN_USER_ID, PUBLIC_USER_ID } from './identity';
import {
  addressIsLocal,
  addressMatchesNetworks,
  effectiveClientAddress
} from './security/client-network';
import { verifyCastAccessToken } from './security/cast-access';

const SESSION_COOKIE = 'caster_admin_session';
const SESSION_TTL_SECONDS = 12 * 60 * 60;
const LOGIN_WINDOW_MS = 15 * 60 * 1000;
const MAX_LOGIN_FAILURES = 5;
const PROFILE_SWITCH_WINDOW_MS = 15 * 60 * 1000;
const MAX_PROFILE_SWITCH_FAILURES = 5;
const MAX_PROFILE_SWITCH_ATTEMPTS = 10_000;
const SESSION_PRUNE_INTERVAL_MS = 15 * 60 * 1000;
const SESSION_PRUNE_BATCH_SIZE = 100;
const MUTATION_METHODS = new Set(['POST', 'PUT', 'PATCH', 'DELETE']);
const PUBLIC_AUTH_MUTATIONS = new Set([
  '/api/auth/login',
  '/api/auth/logout',
  '/api/auth/profile/switch',
  '/api/auth/setup',
  '/api/auth/invites/inspect',
  '/api/auth/signup'
]);

export { ADMIN_USER_ID, PUBLIC_USER_ID } from './identity';
export type { UserRole } from './db/user-store';

export interface AuthPrincipal {
  id: string;
  username: string;
  role: UserRole;
  credential: 'cookie' | 'bearer' | 'cast';
}

interface LoginAttempt {
  failures: number;
  resetAt: number;
}

interface PublicUser {
  id: string;
  username: string;
  role: UserRole;
}

const loginAttempts = new Map<string, LoginAttempt>();
const profileSwitchAttempts = new Map<string, LoginAttempt>();
const defaultSessionStore = new SqliteSessionStore(db);
const defaultUserStore = new SqliteUserStore(db);
const defaultAccessControlStore = new AccessControlStore(db);
const defaultProvisioningStore = new AccountProvisioningStore(db);
const lastSessionPruneAt = new WeakMap<SessionStore, number>();
const bootstrappedEnvironment = new WeakMap<SqliteUserStore, string>();

function configuredEnvironmentFingerprint(): string {
  return crypto.createHash('sha256').update(JSON.stringify([
    process.env.ADMIN_PASSWORD ?? null,
    process.env.ADMIN_TOKEN ?? null
  ])).digest('hex');
}

/** Import legacy environment credentials without ever persisting their raw values. */
export function bootstrapLegacyAdmin(userStore: SqliteUserStore = defaultUserStore): void {
  const fingerprint = configuredEnvironmentFingerprint();
  if (bootstrappedEnvironment.get(userStore) === fingerprint) return;

  let admin = userStore.findById(ADMIN_USER_ID);
  if (!admin) admin = userStore.create(ADMIN_USER_ID, 'admin', 'admin');
  // Existing hashes win, so a password changed through account management is
  // not undone by a stale environment variable on the next restart.
  if (process.env.ADMIN_PASSWORD && !userStore.getCredentialHash(admin.id, 'password')) {
    userStore.setCredential(admin.id, 'password', process.env.ADMIN_PASSWORD);
  }
  if (process.env.ADMIN_TOKEN && !userStore.getCredentialHash(admin.id, 'api_token')) {
    userStore.setCredential(admin.id, 'api_token', process.env.ADMIN_TOKEN);
  }
  new AccountProvisioningStore(userStore.database).claimLegacyOwnerIfConfigured();
  bootstrappedEnvironment.set(userStore, fingerprint);
}

export function isAuthConfigured(userStore: SqliteUserStore = defaultUserStore): boolean {
  try {
    bootstrapLegacyAdmin(userStore);
    const provisioningStore = new AccountProvisioningStore(userStore.database);
    return !provisioningStore.isSetupRequired() && userStore.hasAnyCredential();
  } catch {
    // This is queried during startup before migrations in some consumers.
    return Boolean(process.env.ADMIN_PASSWORD || process.env.ADMIN_TOKEN);
  }
}

export function isProtectedModeEnabled(userStore: SqliteUserStore = defaultUserStore): boolean {
  return isAuthConfigured(userStore);
}

export function hashSessionToken(token: string): string {
  return crypto.createHash('sha256').update(token).digest('hex');
}

function pruneExpiredSessionBatch(sessionStore: SessionStore, now: number): void {
  lastSessionPruneAt.set(sessionStore, now);
  sessionStore.pruneExpired(now, SESSION_PRUNE_BATCH_SIZE);
}

function maybePruneExpiredSessions(sessionStore: SessionStore, now: number): void {
  const lastPrunedAt = lastSessionPruneAt.get(sessionStore) ?? 0;
  if (now - lastPrunedAt < SESSION_PRUNE_INTERVAL_MS) return;
  pruneExpiredSessionBatch(sessionStore, now);
}

export function startSessionPruner(
  sessionStore: SessionStore = defaultSessionStore
): () => void {
  pruneExpiredSessionBatch(sessionStore, Date.now());
  const timer = setInterval(() => {
    pruneExpiredSessionBatch(sessionStore, Date.now());
  }, SESSION_PRUNE_INTERVAL_MS);
  timer.unref();
  return () => clearInterval(timer);
}

function createSession(sessionStore: SessionStore, userId: string): string {
  const now = Date.now();
  maybePruneExpiredSessions(sessionStore, now);
  const token = crypto.randomBytes(32).toString('base64url');
  sessionStore.create(hashSessionToken(token), userId, now, now + SESSION_TTL_SECONDS * 1000);
  return token;
}

function setSessionCookie(c: Context, token: string): void {
  setCookie(c, SESSION_COOKIE, token, {
    httpOnly: true,
    sameSite: 'Strict',
    secure: requestIsSecure(c),
    path: '/',
    maxAge: SESSION_TTL_SECONDS
  });
}

function bearerToken(c: Context): string | undefined {
  const authorization = c.req.header('authorization');
  if (!authorization?.startsWith('Bearer ')) return undefined;
  return authorization.slice('Bearer '.length).trim();
}

function asPrincipal(user: UserRecord, credential: AuthPrincipal['credential']): AuthPrincipal {
  return { id: user.id, username: user.username, role: user.role, credential };
}

/** Resolves only active users. Disabled-user sessions are invalidated immediately. */
export function resolvePrincipal(
  c: Context,
  sessionStore: SessionStore = defaultSessionStore,
  userStore: SqliteUserStore = defaultUserStore
): AuthPrincipal | null {
  bootstrapLegacyAdmin(userStore);
  const bearer = bearerToken(c);
  if (bearer) {
    const user = userStore.findActiveByApiToken(bearer);
    if (user) return asPrincipal(user, 'bearer');
  }

  const token = getCookie(c, SESSION_COOKIE);
  if (token) {
    const now = Date.now();
    maybePruneExpiredSessions(sessionStore, now);
    const tokenHash = hashSessionToken(token);
    const session = sessionStore.findValid(tokenHash, now);
    if (session) {
      const user = userStore.findById(session.user_id);
      if (!user?.active) {
        sessionStore.invalidate(tokenHash);
        return null;
      }
      return asPrincipal(user, 'cookie');
    }
  }

  // Cast receivers cannot inherit the browser's cookie or Authorization
  // header. A signed query grant is accepted only on playback derivatives for
  // its single media item, and the owning account must still be active.
  const castToken = c.req.query('cast');
  const castAccess = castToken
    ? verifyCastAccessToken(castToken, c.req.path)
    : null;
  if (!castAccess) return null;
  const castUser = userStore.findById(castAccess.userId);
  return castUser?.active ? asPrincipal(castUser, 'cast') : null;
}

export function getCurrentUserId(c: Context): string {
  return resolvePrincipal(c)?.id ?? PUBLIC_USER_ID;
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
    // Unit tests and non-Bun adapters do not expose Bun's connection info.
  }
  return c.req.header('cf-connecting-ip') || c.req.header('x-real-ip') ||
    c.req.header('x-forwarded-for')?.split(',')[0].trim() || 'unknown';
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

function profileSwitchKey(sessionToken: string, username: string): string {
  return crypto.createHash('sha256')
    .update(sessionToken)
    .update('\0')
    .update(username.toLocaleLowerCase('en-US'))
    .digest('hex');
}

function currentProfileSwitchAttempt(key: string, now = Date.now()): LoginAttempt | undefined {
  const attempt = profileSwitchAttempts.get(key);
  if (attempt && attempt.resetAt <= now) {
    profileSwitchAttempts.delete(key);
    return undefined;
  }
  return attempt;
}

function pruneProfileSwitchAttempts(now: number): void {
  for (const [key, attempt] of profileSwitchAttempts) {
    if (attempt.resetAt <= now) profileSwitchAttempts.delete(key);
  }
  while (profileSwitchAttempts.size >= MAX_PROFILE_SWITCH_ATTEMPTS) {
    const oldestKey = profileSwitchAttempts.keys().next().value as string | undefined;
    if (!oldestKey) break;
    profileSwitchAttempts.delete(oldestKey);
  }
}

function recordProfileSwitchFailure(key: string, now = Date.now()): void {
  const existing = currentProfileSwitchAttempt(key, now);
  if (!existing) pruneProfileSwitchAttempts(now);
  profileSwitchAttempts.delete(key);
  profileSwitchAttempts.set(key, {
    failures: (existing?.failures ?? 0) + 1,
    resetAt: existing?.resetAt ?? now + PROFILE_SWITCH_WINDOW_MS
  });
}

function invalidProfileOrPin(c: Context) {
  return c.json({ error: 'Invalid profile or PIN' }, 401);
}

function unauthorized(c: Context) {
  c.header('WWW-Authenticate', 'Bearer');
  return c.json({ error: 'Authentication required' }, 401);
}

export const requireAuthenticated: MiddlewareHandler = async (c, next) => {
  if (!isAuthConfigured()) {
    return c.json({ error: 'Authentication is not configured on this server' }, 503);
  }
  if (!resolvePrincipal(c)) return unauthorized(c);
  await next();
};

export const requireAdmin: MiddlewareHandler = async (c, next) => {
  if (!isAuthConfigured()) {
    return c.json({ error: 'Admin authentication is not configured on this server' }, 503);
  }
  const principal = resolvePrincipal(c);
  if (!principal) return unauthorized(c);
  if (principal.role !== 'admin') return c.json({ error: 'Administrator access required' }, 403);
  await next();
};

export const requireAdminForMutations: MiddlewareHandler = async (c, next) => {
  if (!MUTATION_METHODS.has(c.req.method) || PUBLIC_AUTH_MUTATIONS.has(c.req.path)) {
    await next();
    return;
  }
  return requireAdmin(c, next);
};

function publicUser(user: UserRecord | AuthPrincipal): PublicUser {
  return { id: user.id, username: user.username, role: user.role };
}

function validUsername(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const username = value.trim();
  return username.length >= 1 && username.length <= 64 ? username : null;
}

function validRole(value: unknown): value is UserRole {
  return value === 'admin' || value === 'viewer';
}

function accountError(error: unknown): { message: string; status: 400 | 409 } {
  if (error instanceof Error && error.message.includes('UNIQUE constraint failed')) {
    return { message: 'That username is already in use', status: 409 };
  }
  return { message: 'The account could not be updated', status: 400 };
}

function defaultOwnerSetupAllowed(c: Context): boolean {
  let peerAddress: string | undefined;
  try {
    peerAddress = getConnInfo(c).remote.address;
  } catch {
    return false;
  }
  const address = effectiveClientAddress({
    peerAddress,
    forwardedFor: c.req.header('x-forwarded-for'),
    realIp: c.req.header('x-real-ip'),
    forwarded: c.req.header('forwarded'),
    trustedProxies: process.env.CASTER_TRUSTED_PROXIES
  });
  if (!address) return false;
  return addressIsLocal(address) || addressMatchesNetworks(
    address,
    process.env.CASTER_SETUP_NETWORKS ?? ''
  );
}

export interface AuthRouterOptions {
  ownerSetupAllowed?: (context: Context) => boolean;
}

export function createAuthRouter(
  sessionStore: SessionStore = defaultSessionStore,
  userStore: SqliteUserStore = defaultUserStore,
  accessControlStore: Pick<AccessControlStore, 'verifyProfilePin' | 'canUseCapability'> =
    defaultAccessControlStore,
  provisioningStore: AccountProvisioningStore = defaultProvisioningStore,
  options: AuthRouterOptions = {}
): Hono {
  const router = new Hono();
  const ownerSetupAllowed = options.ownerSetupAllowed ?? defaultOwnerSetupAllowed;

  function adminForRequest(c: Context): AuthPrincipal | Response {
    const principal = resolvePrincipal(c, sessionStore, userStore);
    if (!principal) return unauthorized(c);
    if (principal.role !== 'admin') return c.json({ error: 'Administrator access required' }, 403);
    return principal;
  }

  router.get('/session', (c) => {
    c.header('Cache-Control', 'no-store');
    const configured = isAuthConfigured(userStore);
    const principal = configured ? resolvePrincipal(c, sessionStore, userStore) : null;
    return c.json({
      authenticated: principal !== null,
      configured,
      protectedMode: configured,
      setupRequired: provisioningStore.isSetupRequired(),
      ...(principal ? { user: publicUser(principal) } : {})
    });
  });

  router.post('/setup', async (c) => {
    c.header('Cache-Control', 'no-store');
    if (!provisioningStore.isSetupRequired()) {
      return c.json({ error: 'Owner setup has already been completed' }, 409);
    }
    if (!ownerSetupAllowed(c)) {
      return c.json({
        error: 'Owner setup is only allowed from the server host\'s local or configured setup network'
      }, 403);
    }

    let body: { username?: unknown; password?: unknown };
    try {
      body = await c.req.json();
    } catch {
      return c.json({ error: 'A username and password are required' }, 400);
    }
    const username = validUsername(body.username);
    const password = typeof body.password === 'string' ? body.password : '';
    if (!username || password.length < 8 || password.length > 4096) {
      return c.json({ error: 'Username and a password of at least 8 characters are required' }, 400);
    }

    try {
      const user = provisioningStore.completeOwnerSetup(username, password);
      const token = createSession(sessionStore, user.id);
      setSessionCookie(c, token);
      return c.json({ authenticated: true, user: publicUser(user) }, 201);
    } catch (error) {
      if (error instanceof Error && error.message === 'SETUP_ALREADY_COMPLETED') {
        return c.json({ error: 'Owner setup has already been completed' }, 409);
      }
      const response = accountError(error);
      return c.json({ error: response.message }, response.status);
    }
  });

  router.post('/login', async (c) => {
    c.header('Cache-Control', 'no-store');
    if (!isAuthConfigured(userStore)) {
      return c.json({ error: 'The server owner must complete setup before anyone can sign in' }, 503);
    }

    const key = loginKey(c);
    const attempt = currentLoginAttempt(key);
    if (attempt && attempt.failures >= MAX_LOGIN_FAILURES) {
      const retryAfter = Math.max(1, Math.ceil((attempt.resetAt - Date.now()) / 1000));
      c.header('Retry-After', retryAfter.toString());
      return c.json({ error: 'Too many sign-in attempts. Try again later.' }, 429);
    }

    let body: { username?: unknown; password?: unknown };
    try {
      body = await c.req.json();
    } catch {
      return c.json({ error: 'A password or token is required' }, 400);
    }
    const password = typeof body.password === 'string' ? body.password : '';
    const username = validUsername(body.username);
    const user = username ? userStore.findByUsername(username) : null;
    const passwordMatches = Boolean(user?.active && password.length <= 4096 &&
      userStore.credentialMatches(user.id, 'password', password));
    if (!user || !passwordMatches) {
      recordLoginFailure(key);
      return c.json({ error: 'Invalid username or credential' }, 401);
    }

    loginAttempts.delete(key);
    const token = createSession(sessionStore, user.id);
    setSessionCookie(c, token);
    return c.json({ authenticated: true, user: publicUser(user) });
  });

  router.post('/invites/inspect', async (c) => {
    c.header('Cache-Control', 'no-store');
    let body: { token?: unknown };
    try {
      body = await c.req.json();
    } catch {
      return c.json({ error: 'A valid invite token is required' }, 400);
    }
    const token = typeof body.token === 'string' && body.token.length <= 256 ? body.token : '';
    const invite = token ? provisioningStore.inspectInvite(token) : null;
    if (!invite) return c.json({ error: 'This invite is invalid, expired, or already used' }, 404);
    return c.json({ invite });
  });

  router.post('/signup', async (c) => {
    c.header('Cache-Control', 'no-store');
    if (provisioningStore.isSetupRequired()) {
      return c.json({ error: 'The server owner must complete setup first' }, 409);
    }
    let body: { token?: unknown; username?: unknown; password?: unknown };
    try {
      body = await c.req.json();
    } catch {
      return c.json({ error: 'A valid invite, username, and password are required' }, 400);
    }
    const token = typeof body.token === 'string' && body.token.length <= 256 ? body.token : '';
    const username = validUsername(body.username);
    const password = typeof body.password === 'string' ? body.password : '';
    if (!token || !username || password.length < 8 || password.length > 4096) {
      return c.json({ error: 'A valid invite, username, and password of at least 8 characters are required' }, 400);
    }
    try {
      const user = provisioningStore.acceptInvite(token, username, password);
      const sessionToken = createSession(sessionStore, user.id);
      setSessionCookie(c, sessionToken);
      return c.json({ authenticated: true, user: publicUser(user) }, 201);
    } catch (error) {
      if (error instanceof Error && error.message === 'INVITE_INVALID') {
        return c.json({ error: 'This invite is invalid, expired, or already used' }, 404);
      }
      const response = accountError(error);
      return c.json({ error: response.message }, response.status);
    }
  });

  router.post('/logout', (c) => {
    const token = getCookie(c, SESSION_COOKIE);
    if (token) sessionStore.invalidate(hashSessionToken(token));
    deleteCookie(c, SESSION_COOKIE, { path: '/' });
    c.header('Cache-Control', 'no-store');
    return c.json({ authenticated: false });
  });

  router.post('/profile/switch', async (c) => {
    const current = resolvePrincipal(c, sessionStore, userStore);
    if (!current) return unauthorized(c);
    if (current.credential !== 'cookie') {
      return c.json({ error: 'A browser session is required to switch profiles' }, 403);
    }
    if (current.role !== 'admin' && !accessControlStore.canUseCapability({
      userId: current.id,
      role: current.role,
      active: true
    }, 'manage_profiles')) {
      return c.json({ error: 'Profile switching is not permitted' }, 403);
    }

    let body: { username?: unknown; pin?: unknown };
    try {
      body = await c.req.json();
    } catch {
      return invalidProfileOrPin(c);
    }
    const username = validUsername(body.username);
    const pin = typeof body.pin === 'string' ? body.pin : '';
    if (!username || !/^\d{4,12}$/.test(pin)) {
      return invalidProfileOrPin(c);
    }

    const currentToken = getCookie(c, SESSION_COOKIE)!;
    const attemptKey = profileSwitchKey(currentToken, username);
    const attempt = currentProfileSwitchAttempt(attemptKey);
    if (attempt && attempt.failures >= MAX_PROFILE_SWITCH_FAILURES) {
      const retryAfter = Math.max(1, Math.ceil((attempt.resetAt - Date.now()) / 1000));
      c.header('Retry-After', retryAfter.toString());
      return c.json({ error: 'Too many profile switch attempts. Try again later.' }, 429);
    }

    const target = userStore.findByUsername(username);
    // Profile PINs can only enter viewer accounts. In particular, a viewer
    // session can never use a PIN to escalate into an administrator account.
    const pinMatches = Boolean(target?.active && accessControlStore.verifyProfilePin(target.id, pin));
    if (!target?.active || target.role !== 'viewer' || !pinMatches) {
      recordProfileSwitchFailure(attemptKey);
      return invalidProfileOrPin(c);
    }

    profileSwitchAttempts.delete(attemptKey);
    const replacementToken = createSession(sessionStore, target.id);
    sessionStore.invalidate(hashSessionToken(currentToken));
    setSessionCookie(c, replacementToken);
    c.header('Cache-Control', 'no-store');
    return c.json({ authenticated: true, user: publicUser(target) });
  });

  router.get('/users', (c) => {
    const principal = adminForRequest(c);
    if (principal instanceof Response) return principal;
    return c.json({ users: userStore.list().map((user) => ({
      ...publicUser(user), active: user.active
    })) });
  });

  router.get('/invites', (c) => {
    const principal = adminForRequest(c);
    if (principal instanceof Response) return principal;
    return c.json({ invites: provisioningStore.listInvites() });
  });

  router.post('/invites', async (c) => {
    const principal = adminForRequest(c);
    if (principal instanceof Response) return principal;
    let body: { role?: unknown; expiresInHours?: unknown };
    try {
      body = await c.req.json();
    } catch {
      return c.json({ error: 'A valid invite body is required' }, 400);
    }
    const role = body.role ?? 'viewer';
    const expiresInHours = body.expiresInHours ?? 168;
    if (!validRole(role) || !Number.isInteger(expiresInHours) ||
      (expiresInHours as number) < 1 || (expiresInHours as number) > 720) {
      return c.json({ error: 'Role and an expiration between 1 and 720 hours are required' }, 400);
    }
    const invite = provisioningStore.createInvite(
      principal.id,
      role,
      Date.now() + (expiresInHours as number) * 60 * 60 * 1000
    );
    return c.json({ invite }, 201);
  });

  router.delete('/invites/:id', (c) => {
    const principal = adminForRequest(c);
    if (principal instanceof Response) return principal;
    if (!provisioningStore.revokeInvite(c.req.param('id'))) {
      return c.json({ error: 'Pending invite not found' }, 404);
    }
    return c.json({ revoked: true });
  });

  router.post('/users', async (c) => {
    const principal = adminForRequest(c);
    if (principal instanceof Response) return principal;
    let body: { username?: unknown; password?: unknown; role?: unknown };
    try {
      body = await c.req.json();
    } catch {
      return c.json({ error: 'A valid account body is required' }, 400);
    }
    const username = validUsername(body.username);
    const password = typeof body.password === 'string' ? body.password : '';
    const role = body.role ?? 'viewer';
    if (!username || password.length < 8 || password.length > 4096 || !validRole(role)) {
      return c.json({ error: 'Username, role, and a password of at least 8 characters are required' }, 400);
    }
    try {
      const user = userStore.create(crypto.randomUUID(), username, role);
      userStore.setCredential(user.id, 'password', password);
      return c.json({ user: { ...publicUser(user), active: user.active } }, 201);
    } catch (error) {
      const response = accountError(error);
      return c.json({ error: response.message }, response.status);
    }
  });

  router.patch('/users/:id', async (c) => {
    const principal = adminForRequest(c);
    if (principal instanceof Response) return principal;
    const target = userStore.findById(c.req.param('id'));
    if (!target) return c.json({ error: 'User not found' }, 404);

    let body: {
      username?: unknown;
      password?: unknown;
      apiToken?: unknown;
      role?: unknown;
      active?: unknown;
    };
    try {
      body = await c.req.json();
    } catch {
      return c.json({ error: 'A valid account body is required' }, 400);
    }
    const username = body.username === undefined ? undefined : validUsername(body.username);
    const role = body.role === undefined ? undefined : body.role;
    const active = body.active === undefined ? undefined : body.active;
    const password = body.password === undefined ? undefined : body.password;
    const apiToken = body.apiToken === undefined ? undefined : body.apiToken;
    if (body.username !== undefined && !username) return c.json({ error: 'Invalid username' }, 400);
    if (role !== undefined && !validRole(role)) return c.json({ error: 'Invalid role' }, 400);
    if (active !== undefined && typeof active !== 'boolean') return c.json({ error: 'Invalid active state' }, 400);
    if (password !== undefined && (typeof password !== 'string' || password.length < 8 || password.length > 4096)) {
      return c.json({ error: 'Passwords must be between 8 and 4096 characters' }, 400);
    }
    if (apiToken !== undefined &&
      (typeof apiToken !== 'string' || apiToken.length < 16 || apiToken.length > 4096)) {
      return c.json({ error: 'API tokens must be between 16 and 4096 characters' }, 400);
    }
    const removesAdmin = target.active && target.role === 'admin' &&
      (active === false || role === 'viewer');
    if (removesAdmin && userStore.countActiveAdmins() <= 1) {
      return c.json({ error: 'At least one active administrator is required' }, 409);
    }
    if (target.id === principal.id && (active === false || role === 'viewer')) {
      return c.json({ error: 'You cannot disable or demote your current account' }, 409);
    }
    try {
      const user = userStore.update(target.id, {
        ...(username ? { username } : {}),
        ...(role ? { role } : {}),
        ...(typeof active === 'boolean' ? { active } : {})
      })!;
      if (typeof password === 'string') {
        userStore.setCredential(user.id, 'password', password);
        sessionStore.invalidateUser(user.id);
      }
      if (typeof apiToken === 'string') {
        userStore.setCredential(user.id, 'api_token', apiToken);
      }
      if (active === false) sessionStore.invalidateUser(user.id);
      return c.json({ user: { ...publicUser(user), active: user.active } });
    } catch (error) {
      const response = accountError(error);
      return c.json({ error: response.message }, response.status);
    }
  });

  // Deletion is intentionally a reversible soft-disable so user-owned history
  // and ACL configuration are not accidentally destroyed.
  router.delete('/users/:id', (c) => {
    const principal = adminForRequest(c);
    if (principal instanceof Response) return principal;
    const target = userStore.findById(c.req.param('id'));
    if (!target) return c.json({ error: 'User not found' }, 404);
    if (target.id === principal.id) return c.json({ error: 'You cannot disable your current account' }, 409);
    if (target.active && target.role === 'admin' && userStore.countActiveAdmins() <= 1) {
      return c.json({ error: 'At least one active administrator is required' }, 409);
    }
    const user = userStore.update(target.id, { active: false })!;
    sessionStore.invalidateUser(user.id);
    return c.json({ user: { ...publicUser(user), active: false } });
  });

  return router;
}

export const authRouter = createAuthRouter();
