/**
 * Choosing which of the server's advertised addresses to connect through.
 *
 * The server lists every way it can be reached; this measures which of them
 * actually answer and picks one. A direct route always beats a relayed one,
 * even a slower direct route — a relay costs the server bandwidth and puts a
 * third party in the path. Among direct routes, closest wins: local network,
 * then a private network like Tailscale, then the public internet.
 *
 * The policy mirrors the server's own. A cross-check test keeps the two in
 * step, because a disagreement would mean the two ends explain the same
 * connection differently.
 */

export type EndpointKind = 'lan' | 'overlay' | 'wan' | 'relay';

export interface ServerEndpoint {
  kind: EndpointKind;
  url: string;
  priority: number;
  tls: boolean;
}

export interface EndpointProbe {
  url: string;
  reachable: boolean;
  latencyMs?: number | undefined;
}

export interface EndpointChoice {
  endpoint: ServerEndpoint;
  latencyMs?: number | undefined;
  reason: 'direct-lan' | 'direct-overlay' | 'direct-wan' | 'relay-fallback';
}

const KIND_RANK: Record<EndpointKind, number> = { lan: 0, overlay: 1, wan: 2, relay: 3 };

const REASON_BY_KIND: Record<EndpointKind, EndpointChoice['reason']> = {
  lan: 'direct-lan',
  overlay: 'direct-overlay',
  wan: 'direct-wan',
  relay: 'relay-fallback'
};

export function isDirect(kind: EndpointKind): boolean {
  return kind !== 'relay';
}

export function orderEndpoints(endpoints: readonly ServerEndpoint[]): ServerEndpoint[] {
  return [...endpoints].sort((left, right) =>
    KIND_RANK[left.kind] - KIND_RANK[right.kind] ||
    left.priority - right.priority ||
    left.url.localeCompare(right.url));
}

export function selectEndpoint(
  endpoints: readonly ServerEndpoint[],
  probes: readonly EndpointProbe[]
): EndpointChoice | null {
  const reachable = new Map(
    probes.filter((probe) => probe.reachable).map((probe) => [probe.url, probe])
  );

  const usable = orderEndpoints(endpoints).filter((endpoint) => reachable.has(endpoint.url));
  if (usable.length === 0) return null;

  const direct = usable.filter((endpoint) => isDirect(endpoint.kind));
  const pool = direct.length > 0 ? direct : usable;

  const bestKind = pool[0]!.kind;
  const tier = pool.filter((endpoint) => endpoint.kind === bestKind);
  const chosen = tier.reduce((best, endpoint) => {
    const bestLatency = reachable.get(best.url)?.latencyMs ?? Number.POSITIVE_INFINITY;
    const candidateLatency = reachable.get(endpoint.url)?.latencyMs ?? Number.POSITIVE_INFINITY;
    return candidateLatency < bestLatency ? endpoint : best;
  });

  return {
    endpoint: chosen,
    latencyMs: reachable.get(chosen.url)?.latencyMs,
    reason: REASON_BY_KIND[chosen.kind]
  };
}

export function describeChoice(choice: EndpointChoice | null): string {
  if (!choice) return 'No advertised address responded.';

  const latency = choice.latencyMs !== undefined ? ` (${Math.round(choice.latencyMs)} ms)` : '';
  switch (choice.reason) {
    case 'direct-lan':
      return `Connected directly over your local network${latency}.`;
    case 'direct-overlay':
      return `Connected directly over your private network${latency}.`;
    case 'direct-wan':
      return `Connected directly over the internet${latency}.`;
    case 'relay-fallback':
      return `No direct route was available, so this connection is relayed${latency}.`;
  }
}

export interface ProbeOptions {
  timeoutMs?: number;
  fetchImpl?: typeof fetch;
  now?: () => number;
}

/**
 * Times how long each address takes to answer its health check.
 *
 * Every address is probed at once and a failure is just an unreachable result,
 * so one dead route cannot hold up the others or throw.
 */
export async function probeEndpoints(
  endpoints: readonly ServerEndpoint[],
  options: ProbeOptions = {}
): Promise<EndpointProbe[]> {
  const timeoutMs = options.timeoutMs ?? 2500;
  const fetchImpl = options.fetchImpl ?? fetch;
  const now = options.now ?? (() => performance.now());

  return Promise.all(endpoints.map(async (endpoint): Promise<EndpointProbe> => {
    const started = now();
    const controller = typeof AbortController !== 'undefined' ? new AbortController() : null;
    const timer = controller
      ? setTimeout(() => controller.abort(), timeoutMs)
      : null;

    try {
      const response = await fetchImpl(`${endpoint.url}/health`, {
        method: 'GET',
        cache: 'no-store',
        ...(controller ? { signal: controller.signal } : {})
      });
      return response.ok
        ? { url: endpoint.url, reachable: true, latencyMs: now() - started }
        : { url: endpoint.url, reachable: false };
    } catch {
      return { url: endpoint.url, reachable: false };
    } finally {
      if (timer) clearTimeout(timer);
    }
  }));
}
