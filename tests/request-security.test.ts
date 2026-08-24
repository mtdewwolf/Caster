import { afterEach, describe, expect, it } from 'bun:test';
import { Hono, type Context } from 'hono';
import type { AuthPrincipal } from '../apps/server/src/auth';
import {
  createApiRequestSecurity,
  openAccessAllowedForClient,
  requestRequiresAdmin
} from '../apps/server/src/security/request-security';

describe('API request security', () => {
  const originalTrustedOrigins = process.env.CASTER_TRUSTED_ORIGINS;

  afterEach(() => {
    if (originalTrustedOrigins === undefined) delete process.env.CASTER_TRUSTED_ORIGINS;
    else process.env.CASTER_TRUSTED_ORIGINS = originalTrustedOrigins;
  });

  function createApp(options: {
    protectedMode: boolean;
    configured?: boolean;
    openAccessAllowed?: boolean;
  }) {
    const app = new Hono();
    app.use('/api/*', createApiRequestSecurity({
      isProtectedModeEnabled: () => options.protectedMode,
      isAuthConfigured: () => options.configured ?? options.protectedMode,
      anonymousOpenAccessAllowed: () => options.openAccessAllowed ?? true,
      resolvePrincipal: (context: Context): AuthPrincipal | null => {
        const role = context.req.header('x-test-principal');
        if (role !== 'admin' && role !== 'viewer') return null;
        return {
          id: `${role}-id`,
          username: role,
          role,
          credential: context.req.header('x-test-credential') === 'cookie'
            ? 'cookie'
            : 'bearer'
        };
      }
    }));

    app.all('/api/*', (context) => context.json({ ok: true, path: context.req.path }));
    return app;
  }

  it('protects library, media, progress, and playback reads in protected mode', async () => {
    const app = createApp({ protectedMode: true });
    const paths = [
      '/api/libraries',
      '/api/media',
      '/api/media/continue-watching',
      '/api/media/item/stream',
      '/api/media/item/hls/master.m3u8',
      '/api/media/item/thumbnail',
      '/api/media/item/subtitles/0'
    ];

    for (const path of paths) {
      const anonymous = await app.request(path);
      expect(anonymous.status).toBe(401);
      expect(anonymous.headers.get('WWW-Authenticate')).toBe('Bearer');

      const viewer = await app.request(path, {
        headers: { 'X-Test-Principal': 'viewer' }
      });
      expect(viewer.status).toBe(200);
    }
  });

  it('keeps filesystem, scan, access, and system administration admin-only', async () => {
    const app = createApp({ protectedMode: true });
    const requests = [
      ['/api/fs/browse', 'GET'],
      ['/api/libraries/scan/status', 'GET'],
      ['/api/libraries/library/scan', 'POST'],
      ['/api/access/users/viewer/libraries', 'GET'],
      ['/api/system/status', 'GET'],
      ['/api/system/cache/status', 'GET'],
      ['/api/media/item/thumbnail', 'POST']
    ] as const;

    for (const [path, method] of requests) {
      const viewer = await app.request(path, {
        method,
        headers: { 'X-Test-Principal': 'viewer' }
      });
      expect(viewer.status).toBe(403);

      const admin = await app.request(path, {
        method,
        headers: { 'X-Test-Principal': 'admin' }
      });
      expect(admin.status).toBe(200);
    }

    const progress = await app.request('/api/media/item/progress', {
      method: 'POST',
      headers: { 'X-Test-Principal': 'viewer' }
    });
    expect(progress.status).toBe(200);
  });

  it('rejects untrusted cross-origin requests and reflects only trusted origins', async () => {
    process.env.CASTER_TRUSTED_ORIGINS = 'https://player.example';
    const app = createApp({ protectedMode: true });

    const rejected = await app.request('/api/media', {
      headers: {
        Origin: 'https://evil.example',
        'X-Test-Principal': 'viewer'
      }
    });
    expect(rejected.status).toBe(403);
    expect(rejected.headers.get('Access-Control-Allow-Origin')).toBeNull();

    const trusted = await app.request('/api/media', {
      headers: {
        Origin: 'https://player.example',
        'X-Test-Principal': 'viewer'
      }
    });
    expect(trusted.status).toBe(200);
    expect(trusted.headers.get('Access-Control-Allow-Origin')).toBe('https://player.example');
    expect(trusted.headers.get('Access-Control-Allow-Credentials')).toBe('true');

    const preflight = await app.request('/api/media', {
      method: 'OPTIONS',
      headers: { Origin: 'https://player.example' }
    });
    expect(preflight.status).toBe(204);
    expect(preflight.headers.get('Access-Control-Allow-Origin')).toBe('https://player.example');
  });

  it('requires a trusted source for cookie-authenticated mutations', async () => {
    const app = createApp({ protectedMode: true });
    const sessionHeaders = {
      'X-Test-Principal': 'viewer',
      'X-Test-Credential': 'cookie'
    };

    const missingSource = await app.request('/api/media/item/progress', {
      method: 'POST',
      headers: sessionHeaders
    });
    expect(missingSource.status).toBe(403);

    const sameOrigin = await app.request('/api/media/item/progress', {
      method: 'POST',
      headers: { ...sessionHeaders, Origin: 'http://localhost' }
    });
    expect(sameOrigin.status).toBe(200);

    const bearer = await app.request('/api/media/item/progress', {
      method: 'POST',
      headers: { 'X-Test-Principal': 'viewer' }
    });
    expect(bearer.status).toBe(200);
  });

  it('preserves explicit open-mode reads without enabling administration', async () => {
    const app = createApp({ protectedMode: false, configured: false });

    const read = await app.request('/api/media');
    expect(read.status).toBe(200);
    expect(read.headers.get('Access-Control-Allow-Origin')).toBeNull();

    const sameOrigin = await app.request('/api/media', {
      headers: { Origin: 'http://localhost' }
    });
    expect(sameOrigin.status).toBe(200);
    expect(sameOrigin.headers.get('Access-Control-Allow-Origin')).toBe('http://localhost');

    const crossOrigin = await app.request('/api/media', {
      headers: { Origin: 'https://untrusted.example' }
    });
    expect(crossOrigin.status).toBe(403);

    const adminRead = await app.request('/api/fs/browse');
    expect(adminRead.status).toBe(503);

    const progressWrite = await app.request('/api/media/item/progress', { method: 'POST' });
    expect(progressWrite.status).toBe(503);
  });

  it('denies anonymous catalog reads when the client is outside the open network policy', async () => {
    const app = createApp({
      protectedMode: false,
      configured: false,
      openAccessAllowed: false
    });

    const response = await app.request('/api/media');
    expect(response.status).toBe(403);
    expect(await response.json()).toEqual({
      error: 'Anonymous access is not allowed from this network'
    });
  });

  it('keeps implicit development access on loopback and requires an allowlist elsewhere', () => {
    expect(openAccessAllowedForClient({ peerAddress: '127.0.0.1' }, {
      enabled: false
    })).toBe(true);
    expect(openAccessAllowedForClient({ peerAddress: '192.168.1.25' }, {
      enabled: false,
      networks: '192.168.0.0/16'
    })).toBe(false);
    expect(openAccessAllowedForClient({ peerAddress: '192.168.1.25' }, {
      enabled: true,
      networks: '192.168.0.0/16'
    })).toBe(true);
    expect(openAccessAllowedForClient({ peerAddress: '100.64.12.8' }, {
      enabled: true,
      networks: '100.64.0.0/10'
    })).toBe(true);
  });

  it('does not grant open access through an untrusted local reverse proxy', () => {
    const proxyRequest = {
      peerAddress: '127.0.0.1',
      forwardedFor: '192.168.1.25'
    };
    expect(openAccessAllowedForClient(proxyRequest, {
      enabled: true,
      networks: '192.168.0.0/16'
    })).toBe(false);
    expect(openAccessAllowedForClient({
      ...proxyRequest,
      trustedProxies: '127.0.0.1'
    }, {
      enabled: true,
      networks: '192.168.0.0/16'
    })).toBe(true);
  });

  it('defaults new mutations to admin while allowing viewer-owned progress', () => {
    expect(requestRequiresAdmin('POST', '/api/future-feature')).toBe(true);
    expect(requestRequiresAdmin('POST', '/api/media/item/progress')).toBe(false);
    expect(requestRequiresAdmin('DELETE', '/api/media/item/progress')).toBe(false);
    expect(requestRequiresAdmin('DELETE', '/api/media/item/file')).toBe(false);
    expect(requestRequiresAdmin('POST', '/api/playlists')).toBe(false);
    expect(requestRequiresAdmin('PUT', '/api/playlists/owned/items/order')).toBe(false);
    expect(requestRequiresAdmin('POST', '/api/watch-rooms/room/join')).toBe(false);
    expect(requestRequiresAdmin('PUT', '/api/media/item/markers/intro')).toBe(true);
    expect(requestRequiresAdmin('DELETE', '/api/media/item')).toBe(true);
    expect(requestRequiresAdmin('POST', '/api/auth/login')).toBe(false);
  });
});
