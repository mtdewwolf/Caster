import { Hono, type MiddlewareHandler } from 'hono';

import { requireAdmin } from '../auth';
import type { EndpointCandidate } from '../remote/endpoints';
import { collectEndpointCandidates } from '../remote/endpoints';
import { HeartbeatClient } from '../remote/control-plane-client';
import { getServerIdentity, type ServerIdentity } from '../remote/identity';

export interface RemoteAccessRouterDependencies {
  requireAdmin?: MiddlewareHandler;
  heartbeat?: HeartbeatClient;
  collectEndpoints?: () => EndpointCandidate[];
  dataDir?: string;
}

export function createRemoteAccessRouter(dependencies: RemoteAccessRouterDependencies = {}): Hono {
  const adminGate = dependencies.requireAdmin ?? requireAdmin;
  const identityOptions = dependencies.dataDir !== undefined ? { dataDir: dependencies.dataDir } : {};
  const endpointProvider = dependencies.collectEndpoints ?? (() => collectEndpointCandidates());
  const heartbeat = dependencies.heartbeat ??
    new HeartbeatClient({ getEndpoints: endpointProvider, ...(dependencies.dataDir !== undefined ? { dataDir: dependencies.dataDir } : {}) });

  const router = new Hono();

  router.use('*', (c, next) => adminGate(c, next));

  router.get('/status', (c) => {
    c.header('Cache-Control', 'no-store');
    let identity: ServerIdentity | null = null;
    let identityError: string | null = null;
    try {
      identity = getServerIdentity(identityOptions);
    } catch (error) {
      identityError = error instanceof Error ? error.message : 'Server identity is unavailable';
    }
    const state = heartbeat.getState();
    return c.json({
      enabled: state.enabled,
      controlPlaneConfigured: heartbeat.enabled,
      controlPlaneUrl: state.controlPlaneUrl,
      configError: state.configError,
      heartbeatIntervalSeconds: state.intervalSeconds,
      serverId: identity?.serverId ?? null,
      identityCreatedAt: identity?.createdAt ?? null,
      identityError,
      lastHeartbeatAt: state.lastHeartbeatAt,
      lastHeartbeatResult: state.lastHeartbeatResult,
      advertisedEndpoints: endpointProvider().map(({ kind, url, priority, tls }) => ({
        kind, url, priority, tls
      }))
    });
  });

  router.post('/disable', (c) => {
    heartbeat.stop();
    c.header('Cache-Control', 'no-store');
    return c.json({ enabled: false });
  });

  router.post('/enable', (c) => {
    heartbeat.resume();
    c.header('Cache-Control', 'no-store');
    return c.json({ enabled: heartbeat.getState().enabled });
  });

  return router;
}
