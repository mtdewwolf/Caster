import { afterEach, describe, expect, it } from 'bun:test';
import { Hono } from 'hono';
import { createApiRequestSecurity } from '../apps/server/src/security/request-security';

describe('API request security', () => {
  const originalTrustedOrigins = process.env.CASTER_TRUSTED_ORIGINS;

  afterEach(() => {
    if (originalTrustedOrigins === undefined) delete process.env.CASTER_TRUSTED_ORIGINS;
    else process.env.CASTER_TRUSTED_ORIGINS = originalTrustedOrigins;
  });

  function createApp() {
    const app = new Hono();
    app.use('/api/*', createApiRequestSecurity());
    app.all('/api/*', (context) => context.json({ ok: true }));
    return app;
  }

  it('allows account-free API requests without credentials', async () => {
    const response = await createApp().request('/api/media');
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ ok: true });
  });

  it('rejects untrusted origins and reflects configured origins', async () => {
    process.env.CASTER_TRUSTED_ORIGINS = 'https://player.example';
    const app = createApp();

    const rejected = await app.request('/api/media', {
      headers: { Origin: 'https://evil.example' }
    });
    expect(rejected.status).toBe(403);

    const trusted = await app.request('/api/media', {
      headers: { Origin: 'https://player.example' }
    });
    expect(trusted.status).toBe(200);
    expect(trusted.headers.get('Access-Control-Allow-Origin')).toBe('https://player.example');
    expect(trusted.headers.get('Access-Control-Allow-Credentials')).toBeNull();
  });

  it('answers trusted preflight requests without requiring authentication', async () => {
    process.env.CASTER_TRUSTED_ORIGINS = 'https://player.example';
    const response = await createApp().request('/api/media', {
      method: 'OPTIONS',
      headers: {
        Origin: 'https://player.example',
        'Access-Control-Request-Method': 'DELETE'
      }
    });
    expect(response.status).toBe(204);
    expect(response.headers.get('Access-Control-Allow-Methods')).toContain('DELETE');
  });
});
