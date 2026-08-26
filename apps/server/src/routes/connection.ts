import { Hono, type Context } from 'hono';
import type { EndpointCandidate } from '../remote/endpoints';
import { orderCandidates } from '../remote/negotiation';

type MaybePromise<T> = T | Promise<T>;

export interface ConnectionRouterDependencies {
  collectEndpoints: () => EndpointCandidate[];
  /** Must return false unless the caller is an authenticated principal. */
  isAuthenticated: (context: Context) => MaybePromise<boolean>;
}

/**
 * Tells a signed-in client every way it could reach this server.
 *
 * This is the half of connection negotiation the server owns: it advertises,
 * the client measures and chooses. The list is ordered closest-first so a
 * client that simply takes the first working entry still lands on a sensible
 * path without implementing any policy of its own.
 */
export function createConnectionRouter(dependencies: ConnectionRouterDependencies): Hono {
  const router = new Hono();

  router.get('/endpoints', async (context) => {
    if (!await dependencies.isAuthenticated(context)) {
      return context.json({ error: 'Authentication required' }, 401);
    }

    context.header('Cache-Control', 'no-store');
    return context.json({
      // Addresses only. Nothing here reveals the filesystem, the control plane
      // credentials, or anything an unauthenticated caller could act on.
      endpoints: orderCandidates(dependencies.collectEndpoints())
        .map(({ kind, url, priority, tls }) => ({ kind, url, priority, tls }))
    });
  });

  return router;
}
