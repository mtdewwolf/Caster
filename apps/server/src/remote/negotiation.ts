import type { EndpointCandidate, EndpointKind } from './endpoints';

/**
 * Choosing how a client reaches this server.
 *
 * The server advertises every way it can be reached; the client measures which
 * of them actually work and picks one. Two rules shape the choice. A direct
 * path always beats a relayed one, because a relay costs bandwidth and adds a
 * third party to the connection — so relay is only ever a fallback, never a
 * winner on speed. Among direct paths, the closest wins: LAN, then an overlay
 * network like Tailscale, then the public internet.
 *
 * All of this is pure so the policy can be tested without opening a socket.
 */

/** Lower sorts first. Mirrors the priorities the server advertises. */
const KIND_RANK: Record<EndpointKind, number> = {
  lan: 0,
  overlay: 1,
  wan: 2,
  relay: 3
};

export interface EndpointProbe {
  url: string;
  reachable: boolean;
  /** Round-trip time in milliseconds, when the probe succeeded. */
  latencyMs?: number | undefined;
}

export interface EndpointChoice {
  candidate: EndpointCandidate;
  latencyMs?: number | undefined;
  reason: 'direct-lan' | 'direct-overlay' | 'direct-wan' | 'relay-fallback';
}

const REASON_BY_KIND: Record<EndpointKind, EndpointChoice['reason']> = {
  lan: 'direct-lan',
  overlay: 'direct-overlay',
  wan: 'direct-wan',
  relay: 'relay-fallback'
};

export function isDirect(kind: EndpointKind): boolean {
  return kind !== 'relay';
}

/**
 * Candidates in the order a client should try them.
 *
 * Ordering by closeness first means the fastest probe usually finishes first,
 * and a client that gives up early still ends up on a sensible path.
 */
export function orderCandidates(
  candidates: readonly EndpointCandidate[]
): EndpointCandidate[] {
  return [...candidates].sort((left, right) =>
    KIND_RANK[left.kind] - KIND_RANK[right.kind] ||
    left.priority - right.priority ||
    left.url.localeCompare(right.url));
}

/**
 * Picks the endpoint to connect through.
 *
 * Returns null when nothing was reachable, which is a real answer: the caller
 * should say the server cannot be reached rather than silently trying a path
 * that already failed.
 */
export function selectEndpoint(
  candidates: readonly EndpointCandidate[],
  probes: readonly EndpointProbe[]
): EndpointChoice | null {
  const reachable = new Map(
    probes.filter((probe) => probe.reachable).map((probe) => [probe.url, probe])
  );

  const usable = orderCandidates(candidates)
    .filter((candidate) => reachable.has(candidate.url));
  if (usable.length === 0) return null;

  const direct = usable.filter((candidate) => isDirect(candidate.kind));
  const pool = direct.length > 0 ? direct : usable;

  // Within the closest available tier, the quickest to answer wins. An
  // unmeasured probe sorts last rather than being treated as instant.
  const bestKind = pool[0]!.kind;
  const tier = pool.filter((candidate) => candidate.kind === bestKind);
  const chosen = tier.reduce((best, candidate) => {
    const bestLatency = reachable.get(best.url)?.latencyMs ?? Number.POSITIVE_INFINITY;
    const candidateLatency = reachable.get(candidate.url)?.latencyMs ?? Number.POSITIVE_INFINITY;
    return candidateLatency < bestLatency ? candidate : best;
  });

  return {
    candidate: chosen,
    latencyMs: reachable.get(chosen.url)?.latencyMs,
    reason: REASON_BY_KIND[chosen.kind]
  };
}

/** Human-readable explanation of a choice, for diagnostics and support. */
export function describeChoice(choice: EndpointChoice | null): string {
  if (!choice) return 'No advertised endpoint responded.';

  const latency = choice.latencyMs !== undefined
    ? ` (${Math.round(choice.latencyMs)} ms)`
    : '';

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
