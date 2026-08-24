import type { Context, MiddlewareHandler } from 'hono';
import { getConnInfo } from 'hono/bun';
import {
  isAuthConfigured,
  isProtectedModeEnabled,
  resolvePrincipal,
  type AuthPrincipal
} from '../auth';
import {
  addressMatchesNetworks,
  effectiveClientAddress,
  type ClientNetworkInput
} from './client-network';

const MUTATION_METHODS = new Set(['POST', 'PUT', 'PATCH', 'DELETE']);
const CORS_METHODS = 'GET, POST, PUT, PATCH, DELETE, OPTIONS';
const CORS_HEADERS = 'Content-Type, Authorization, Range, X-Caster-Confirm-Delete';
const CORS_EXPOSE_HEADERS = 'Content-Range, Accept-Ranges, Content-Length, Content-Type';
const DEFAULT_OPEN_NETWORKS = '127.0.0.0/8,::1/128';

export interface RequestSecurityDependencies {
  isAuthConfigured: () => boolean;
  isProtectedModeEnabled: () => boolean;
  resolvePrincipal: (context: Context) => AuthPrincipal | null;
  anonymousOpenAccessAllowed?: (context: Context) => boolean;
}

const defaultDependencies: RequestSecurityDependencies = {
  isAuthConfigured,
  isProtectedModeEnabled,
  resolvePrincipal
};

function enabledEnvironmentFlag(value: string | undefined): boolean {
  return value?.trim().toLowerCase() === 'true';
}

export function openModeIsExplicitlyEnabled(): boolean {
  return enabledEnvironmentFlag(process.env.CASTER_OPEN_MODE);
}

export interface OpenAccessPolicy {
  enabled?: boolean;
  networks?: string;
}

export function openAccessAllowedForClient(
  input: ClientNetworkInput,
  policy: OpenAccessPolicy = {}
): boolean {
  const address = effectiveClientAddress(input);
  if (!address) return false;
  if (addressMatchesNetworks(address, DEFAULT_OPEN_NETWORKS)) return true;
  if (!(policy.enabled ?? openModeIsExplicitlyEnabled())) return false;
  return addressMatchesNetworks(
    address,
    policy.networks ?? process.env.CASTER_OPEN_NETWORKS ?? DEFAULT_OPEN_NETWORKS
  );
}

/** Build network input from the actual socket peer; request host is never used as a client identity. */
export function requestClientNetworkInput(context: Context): ClientNetworkInput {
  let peerAddress: string | undefined;
  try {
    peerAddress = getConnInfo(context).remote.address;
  } catch {
    // Non-Bun adapters do not expose a peer. Missing peer data is denied by
    // the network classifier instead of falling back to the spoofable Host.
  }
  return {
    peerAddress,
    forwardedFor: context.req.header('x-forwarded-for'),
    realIp: context.req.header('x-real-ip'),
    forwarded: context.req.header('forwarded'),
    trustedProxies: process.env.CASTER_TRUSTED_PROXIES
  };
}

/**
 * Development remains account-free on a direct loopback socket. All other
 * anonymous reads require an explicit open-mode flag and network allowlist.
 */
export function anonymousOpenAccessAllowed(context: Context): boolean {
  return openAccessAllowedForClient(requestClientNetworkInput(context));
}

function configuredTrustedOrigins(): Set<string> {
  const configured =
    process.env.CASTER_TRUSTED_ORIGINS ??
    process.env.TRUSTED_ORIGINS ??
    process.env.CORS_ORIGINS ??
    '';

  return new Set(
    configured
      .split(',')
      .map((origin) => origin.trim())
      .filter((origin) => origin.length > 0 && origin !== '*')
      .map((origin) => {
        try {
          return new URL(origin).origin;
        } catch {
          return '';
        }
      })
      .filter(Boolean)
  );
}

function requestOrigins(context: Context): Set<string> {
  const origins = new Set<string>();
  try {
    origins.add(new URL(context.req.url).origin);
  } catch {
    // Hono normally supplies an absolute request URL. Invalid URLs are simply
    // unable to establish same-origin status.
  }

  return origins;
}

function normalizedHeaderOrigin(value: string | undefined): string | null {
  if (!value || value === 'null') return null;
  try {
    return new URL(value).origin;
  } catch {
    return null;
  }
}

function originIsTrusted(context: Context, origin: string): boolean {
  return requestOrigins(context).has(origin) || configuredTrustedOrigins().has(origin);
}

function addVary(context: Context, value: string): void {
  const vary = context.res.headers.get('Vary');
  if (!vary) {
    context.header('Vary', value);
    return;
  }
  if (!vary.split(',').some((existing) => existing.trim().toLowerCase() === value.toLowerCase())) {
    context.header('Vary', `${vary}, ${value}`);
  }
}

function setCorsHeaders(context: Context, origin: string | null, protectedMode: boolean): void {
  addVary(context, 'Origin');
  if (origin) context.header('Access-Control-Allow-Origin', origin);
  if (protectedMode && origin) {
    context.header('Access-Control-Allow-Credentials', 'true');
  }
  context.header('Access-Control-Allow-Methods', CORS_METHODS);
  context.header('Access-Control-Allow-Headers', CORS_HEADERS);
  context.header('Access-Control-Expose-Headers', CORS_EXPOSE_HEADERS);
}

function isAuthRoute(pathname: string): boolean {
  return pathname === '/api/auth' || pathname.startsWith('/api/auth/');
}

function isViewerProgressMutation(pathname: string): boolean {
  return /^\/api\/media\/[^/]+\/progress(?:\/(?:watched|unwatched))?$/.test(pathname);
}

function isViewerMediaFileDeletion(method: string, pathname: string): boolean {
  return method === 'DELETE' && /^\/api\/media\/[^/]+\/file$/.test(pathname);
}

/**
 * Mutations default to admin-only. Viewer-owned progress and the separately
 * capability-gated source-file deletion are the only viewer mutation
 * namespaces. Sensitive read-only administration endpoints are also kept out
 * of viewer sessions.
 */
export function requestRequiresAdmin(method: string, pathname: string): boolean {
  if (pathname.startsWith('/api/fs/') || pathname === '/api/fs') return true;
  if (pathname.startsWith('/api/system/') || pathname === '/api/system') return true;
  if (pathname.startsWith('/api/access/') || pathname === '/api/access') return true;
  if (pathname === '/api/libraries/scan/status') return true;
  if (/^\/api\/libraries\/(?:scan-all|[^/]+\/scan)$/.test(pathname)) return true;

  if (!MUTATION_METHODS.has(method)) return false;
  if (isAuthRoute(pathname)) return false;
  return !isViewerProgressMutation(pathname) && !isViewerMediaFileDeletion(method, pathname);
}

function csrfSourceIsTrusted(context: Context): boolean {
  const origin = normalizedHeaderOrigin(context.req.header('origin'));
  if (origin) return originIsTrusted(context, origin);

  const referer = context.req.header('referer');
  if (referer) {
    try {
      return originIsTrusted(context, new URL(referer).origin);
    } catch {
      return false;
    }
  }

  return context.req.header('sec-fetch-site')?.toLowerCase() === 'same-origin';
}

function authenticationFailure(context: Context, configured: boolean): Response {
  if (!configured) {
    return context.json(
      { error: 'Authentication is not configured on this server' },
      503
    );
  }
  context.header('WWW-Authenticate', 'Bearer');
  return context.json({ error: 'Authentication required' }, 401);
}

export function createApiRequestSecurity(
  dependencies: RequestSecurityDependencies = defaultDependencies
): MiddlewareHandler {
  return async (context, next) => {
    const protectedMode = dependencies.isProtectedModeEnabled();
    const suppliedOrigin = context.req.header('origin');
    const origin = normalizedHeaderOrigin(suppliedOrigin);

    if (suppliedOrigin && (!origin || !originIsTrusted(context, origin))) {
      return context.json({ error: 'Origin is not trusted' }, 403);
    }

    if (context.req.method === 'OPTIONS') {
      if (!origin) {
        return context.json({ error: 'Origin is not trusted' }, 403);
      }
      setCorsHeaders(context, origin, protectedMode);
      return context.body(null, 204);
    }

    const pathname = context.req.path;
    const principal = dependencies.resolvePrincipal(context);
    const authRoute = isAuthRoute(pathname);
    const requiresAdmin = requestRequiresAdmin(context.req.method, pathname);
    const openAccessAllowed = dependencies.anonymousOpenAccessAllowed?.(context)
      ?? anonymousOpenAccessAllowed(context);

    if (requiresAdmin && principal?.role !== 'admin') {
      if (!principal) {
        setCorsHeaders(context, origin, protectedMode);
        return authenticationFailure(context, dependencies.isAuthConfigured());
      }
      setCorsHeaders(context, origin, protectedMode);
      return context.json({ error: 'Administrator access required' }, 403);
    }

    if (!principal && !authRoute && (
      protectedMode || MUTATION_METHODS.has(context.req.method) || !openAccessAllowed
    )) {
      setCorsHeaders(context, origin, protectedMode);
      if (!protectedMode && !MUTATION_METHODS.has(context.req.method)) {
        return context.json({ error: 'Anonymous access is not allowed from this network' }, 403);
      }
      return authenticationFailure(context, dependencies.isAuthConfigured());
    }

    if (
      MUTATION_METHODS.has(context.req.method) &&
      principal?.credential === 'cookie' &&
      !csrfSourceIsTrusted(context)
    ) {
      setCorsHeaders(context, origin, protectedMode);
      return context.json({ error: 'A trusted request origin is required' }, 403);
    }

    await next();
    if (protectedMode && !authRoute) {
      addVary(context, 'Cookie');
      addVary(context, 'Authorization');
      const cacheControl = context.res.headers.get('Cache-Control');
      if (cacheControl?.toLowerCase().includes('public')) {
        context.header('Cache-Control', cacheControl.replace(/public/i, 'private'));
      }
    }
    setCorsHeaders(context, origin, protectedMode);
  };
}

export const apiRequestSecurity = createApiRequestSecurity();
