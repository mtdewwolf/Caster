import { getConnInfo } from 'hono/bun';
import type { Context, MiddlewareHandler } from 'hono';
import type { ClientNetworkInput } from './client-network';

/** Build network input from the actual socket peer for playback decisions. */
export function requestClientNetworkInput(context: Context): ClientNetworkInput {
  let peerAddress: string | undefined;
  try {
    peerAddress = getConnInfo(context).remote.address;
  } catch {
    // Test adapters may not expose a socket peer; client-network treats this as remote.
  }
  return {
    peerAddress,
    forwardedFor: context.req.header('x-forwarded-for'),
    realIp: context.req.header('x-real-ip'),
    forwarded: context.req.header('forwarded'),
    trustedProxies: process.env.CASTER_TRUSTED_PROXIES
  };
}

const CORS_METHODS = 'GET, POST, PUT, PATCH, DELETE, OPTIONS';
const CORS_HEADERS = 'Content-Type, Range, X-Caster-Confirm-Delete';
const CORS_EXPOSE_HEADERS = 'Content-Range, Accept-Ranges, Content-Length, Content-Type';

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
    // Hono normally supplies an absolute request URL.
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

function setCorsHeaders(context: Context, origin: string | null): void {
  addVary(context, 'Origin');
  if (origin) context.header('Access-Control-Allow-Origin', origin);
  context.header('Access-Control-Allow-Methods', CORS_METHODS);
  context.header('Access-Control-Allow-Headers', CORS_HEADERS);
  context.header('Access-Control-Expose-Headers', CORS_EXPOSE_HEADERS);
}

/**
 * The API is intentionally account-free. This middleware only handles exact
 * origin reflection and preflight responses; it does not authenticate or
 * authorize requests.
 */
export function createApiRequestSecurity(): MiddlewareHandler {
  return async (context, next) => {
    const suppliedOrigin = context.req.header('origin');
    const origin = normalizedHeaderOrigin(suppliedOrigin);

    if (suppliedOrigin && (!origin || !originIsTrusted(context, origin))) {
      return context.json({ error: 'Origin is not trusted' }, 403);
    }

    if (context.req.method === 'OPTIONS') {
      if (!origin) return context.json({ error: 'Origin is not trusted' }, 403);
      setCorsHeaders(context, origin);
      return context.body(null, 204);
    }

    await next();
    setCorsHeaders(context, origin);
  };
}

export const apiRequestSecurity = createApiRequestSecurity();
