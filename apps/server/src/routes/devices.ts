import { Hono, type Context } from 'hono';
import { getConnInfo } from 'hono/bun';
import { db } from '../db';
import { SqliteDeviceStore, type StoredDevice } from '../db/device-store';
import {
  DevicePairingService,
  PairingError,
  normalizePairingCode
} from '../security/device-pairing';
import { resolvePrincipal, type AuthPrincipal } from '../auth';

export interface DevicesRouterDependencies {
  deviceStore: SqliteDeviceStore;
  pairing: DevicePairingService;
  resolvePrincipal: (context: Context) => AuthPrincipal | null;
}

export const REDEEM_WINDOW_MS = 15 * 60 * 1000;
export const MAX_REDEEM_ATTEMPTS_PER_WINDOW = 10;

interface RedeemWindow {
  attempts: number;
  resetAt: number;
}

const redeemWindows = new Map<string, RedeemWindow>();

function redeemKey(c: Context): string {
  try {
    const remoteAddress = getConnInfo(c).remote.address;
    if (remoteAddress) return remoteAddress;
  } catch {
    // Unit tests and non-Bun adapters do not expose Bun's connection info.
  }
  return c.req.header('cf-connecting-ip') || c.req.header('x-real-ip') ||
    c.req.header('x-forwarded-for')?.split(',')[0].trim() || 'unknown';
}

function currentRedeemWindow(key: string): RedeemWindow | undefined {
  const window = redeemWindows.get(key);
  if (window && window.resetAt <= Date.now()) {
    redeemWindows.delete(key);
    return undefined;
  }
  return window;
}

function recordRedeemAttempt(key: string): void {
  const existing = currentRedeemWindow(key);
  redeemWindows.set(key, {
    attempts: (existing?.attempts ?? 0) + 1,
    resetAt: existing?.resetAt ?? Date.now() + REDEEM_WINDOW_MS
  });
}

function publicDevice(device: StoredDevice): Record<string, unknown> {
  let capabilities: unknown = {};
  try {
    const parsed = JSON.parse(device.capabilities);
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) capabilities = parsed;
  } catch {
    capabilities = {};
  }
  return {
    id: device.id,
    name: device.name,
    platform: device.platform,
    capabilities,
    createdAt: device.created_at,
    lastUsedAt: device.last_used_at,
    lastSeenAt: device.last_seen_at,
    revokedAt: device.revoked_at,
    status: device.status
  };
}

function validName(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const name = value.trim();
  return name.length >= 1 && name.length <= 120 ? name : null;
}

function validPlatform(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const platform = value.trim();
  return /^[a-z0-9-]{1,64}$/.test(platform) ? platform : null;
}

async function readJsonObject(c: Context): Promise<Record<string, unknown>> {
  try {
    const value = await c.req.json<unknown>();
    return value && typeof value === 'object' && !Array.isArray(value)
      ? value as Record<string, unknown>
      : {};
  } catch {
    return {};
  }
}

export function createDevicesRouter(dependencies: DevicesRouterDependencies): Hono {
  const router = new Hono();

  function principalFor(c: Context): AuthPrincipal | null {
    return dependencies.resolvePrincipal(c);
  }

  /** Resolves the device owner a request may act on, or null when forbidden. */
  function targetUserId(principal: AuthPrincipal, requested: string | undefined): string | null {
    if (!requested || requested === principal.id) return principal.id;
    return principal.role === 'admin' ? requested : null;
  }

  router.get('/', (c) => {
    const principal = principalFor(c);
    if (!principal) return c.json({ error: 'Authentication required' }, 401);
    const owner = targetUserId(principal, c.req.query('userId'));
    if (!owner) return c.json({ error: 'Administrator access required' }, 403);
    return c.json({
      devices: dependencies.deviceStore.listDevicesForUser(owner).map(publicDevice)
    });
  });

  router.post('/', async (c) => {
    const principal = principalFor(c);
    if (!principal) return c.json({ error: 'Authentication required' }, 401);
    const body = await readJsonObject(c);
    const name = body.name === undefined ? undefined : validName(body.name);
    if (body.name !== undefined && !name) {
      return c.json({ error: 'A device name between 1 and 120 characters is required' }, 400);
    }
    const platform = body.platform === undefined ? undefined : validPlatform(body.platform);
    if (body.platform !== undefined && !platform) {
      return c.json({ error: 'A platform of at most 64 lowercase letters, digits, or dashes is required' }, 400);
    }
    const pairing = dependencies.pairing.generatePairingCode(principal.id, {
      ...(name ? { deviceName: name } : {}),
      ...(platform ? { platform } : {})
    });
    c.header('Cache-Control', 'no-store');
    return c.json({ pairingCode: pairing.code, expiresAt: pairing.expiresAt }, 201);
  });

  router.patch('/:id', async (c) => {
    const principal = principalFor(c);
    if (!principal) return c.json({ error: 'Authentication required' }, 401);
    const device = dependencies.deviceStore.findById(c.req.param('id'));
    if (!device || !targetUserId(principal, device.user_id)) {
      return c.json({ error: 'Device not found' }, 404);
    }
    const body = await readJsonObject(c);
    const name = validName(body.name);
    if (!name) return c.json({ error: 'A device name between 1 and 120 characters is required' }, 400);
    if (!dependencies.deviceStore.renameDevice(device.id, device.user_id, name)) {
      return c.json({ error: 'Device not found' }, 404);
    }
    return c.json({ device: publicDevice(dependencies.deviceStore.findById(device.id)!) });
  });

  router.delete('/:id', (c) => {
    const principal = principalFor(c);
    if (!principal) return c.json({ error: 'Authentication required' }, 401);
    const device = dependencies.deviceStore.findById(c.req.param('id'));
    if (!device || !targetUserId(principal, device.user_id)) {
      return c.json({ error: 'Device not found' }, 404);
    }
    dependencies.deviceStore.revokeDevice(device.id, device.user_id);
    return c.json({ revoked: true });
  });

  router.post('/redeem', async (c) => {
    const key = redeemKey(c);
    const window = currentRedeemWindow(key);
    if (window && window.attempts >= MAX_REDEEM_ATTEMPTS_PER_WINDOW) {
      const retryAfter = Math.max(1, Math.ceil((window.resetAt - Date.now()) / 1000));
      c.header('Retry-After', retryAfter.toString());
      return c.json({ error: 'Too many pairing attempts. Try again later.' }, 429);
    }

    const body = await readJsonObject(c);
    const code = normalizePairingCode(body.code);
    const name = validName(body.name);
    const platform = validPlatform(body.platform);
    if (!code || !name || !platform) {
      return c.json({
        error: 'A pairing code, device name, and platform are required'
      }, 400);
    }

    recordRedeemAttempt(key);
    try {
      const redeemed = dependencies.pairing.redeemCode(code, { name, platform });
      redeemWindows.delete(key);
      c.header('Cache-Control', 'no-store');
      return c.json(redeemed);
    } catch (error) {
      if (!(error instanceof PairingError)) throw error;
      const status = error.reason === 'PAIRING_CODE_CONSUMED' ? 409 : 400;
      return c.json({ error: error.message }, status);
    }
  });

  return router;
}

const defaultDeviceStore = new SqliteDeviceStore(db);
const defaultPairingService = new DevicePairingService(db, defaultDeviceStore);

export const devicesRouter = createDevicesRouter({
  deviceStore: defaultDeviceStore,
  pairing: defaultPairingService,
  resolvePrincipal: (c) => resolvePrincipal(c)
});
