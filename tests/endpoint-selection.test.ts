import { describe, expect, it } from 'bun:test';
import {
  describeChoice as serverDescribe,
  orderCandidates,
  selectEndpoint as serverSelect
} from '../apps/server/src/remote/negotiation';
import {
  describeChoice as clientDescribe,
  orderEndpoints,
  probeEndpoints,
  selectEndpoint as clientSelect,
  type ServerEndpoint
} from '../apps/web/src/features/connection/endpoint-selection';

const endpoint = (kind: ServerEndpoint['kind'], url: string, priority: number): ServerEndpoint =>
  ({ kind, url, priority, tls: url.startsWith('https') });

const LAN = endpoint('lan', 'http://192.168.1.10:3001', 10);
const OVERLAY = endpoint('overlay', 'http://server.ts.net:3001', 20);
const WAN = endpoint('wan', 'https://caster.example.com', 30);
const RELAY = endpoint('relay', 'https://relay.example.com', 40);
const ALL = [RELAY, WAN, OVERLAY, LAN];

const SCENARIOS = [
  [{ url: LAN.url, reachable: true, latencyMs: 4 }, { url: WAN.url, reachable: true, latencyMs: 20 }],
  [{ url: LAN.url, reachable: false }, { url: OVERLAY.url, reachable: true, latencyMs: 30 }],
  [{ url: WAN.url, reachable: true, latencyMs: 90 }, { url: RELAY.url, reachable: true, latencyMs: 10 }],
  [{ url: RELAY.url, reachable: true, latencyMs: 60 }],
  [],
  ALL.map((entry) => ({ url: entry.url, reachable: false }))
];

describe('client endpoint selection', () => {
  it('orders addresses the same way the server does', () => {
    expect(orderEndpoints(ALL).map((entry) => entry.url))
      .toEqual(orderCandidates(ALL).map((entry) => entry.url));
  });

  it('reaches the same verdict as the server in every scenario', () => {
    // The two ends must agree, or they would describe the same connection
    // differently — or worse, connect through different routes.
    for (const probes of SCENARIOS) {
      const client = clientSelect(ALL, probes);
      const server = serverSelect(ALL, probes);

      expect(client?.endpoint.url ?? null).toBe(server?.candidate.url ?? null);
      expect(client?.reason ?? null).toBe(server?.reason ?? null);
    }
  });

  it('explains a relayed connection the same way', () => {
    const probes = [{ url: RELAY.url, reachable: true, latencyMs: 60 }];
    expect(clientDescribe(clientSelect(ALL, probes)))
      .toBe(serverDescribe(serverSelect(ALL, probes)));
  });
});

describe('endpoint probing', () => {
  it('measures the addresses that answer', async () => {
    let clock = 0;
    const probes = await probeEndpoints([LAN, WAN], {
      now: () => (clock += 5),
      fetchImpl: (async (input: any) => {
        const url = typeof input === 'string' ? input : input.url;
        return new Response('ok', { status: url.startsWith(LAN.url) ? 200 : 502 });
      }) as typeof fetch
    });

    expect(probes.find((probe) => probe.url === LAN.url)).toMatchObject({ reachable: true });
    expect(probes.find((probe) => probe.url === WAN.url)).toMatchObject({ reachable: false });
  });

  it('treats a thrown request as unreachable rather than failing', async () => {
    const probes = await probeEndpoints([LAN], {
      fetchImpl: (async () => { throw new Error('connection refused'); }) as typeof fetch
    });
    expect(probes).toEqual([{ url: LAN.url, reachable: false }]);
  });

  it('probes every address even when one hangs up', async () => {
    const probes = await probeEndpoints(ALL, {
      fetchImpl: (async (input: any) => {
        const url = typeof input === 'string' ? input : input.url;
        if (url.startsWith(OVERLAY.url)) throw new Error('no route');
        return new Response('ok', { status: 200 });
      }) as typeof fetch
    });

    expect(probes).toHaveLength(ALL.length);
    expect(probes.filter((probe) => probe.reachable)).toHaveLength(ALL.length - 1);
  });

  it('asks each address for its health check', async () => {
    const asked: string[] = [];
    await probeEndpoints([LAN], {
      fetchImpl: (async (input: any) => {
        asked.push(typeof input === 'string' ? input : input.url);
        return new Response('ok', { status: 200 });
      }) as typeof fetch
    });
    expect(asked).toEqual([`${LAN.url}/health`]);
  });
});
