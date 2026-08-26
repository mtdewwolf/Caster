import { beforeEach, describe, expect, it } from 'bun:test';
import { Database } from 'bun:sqlite';
import { runDatabaseMigrations } from '../apps/server/src/db/migrations';
import { RemoteAccessStore } from '../apps/server/src/db/remote-store';
import {
  describeChoice,
  isDirect,
  orderCandidates,
  selectEndpoint,
  type EndpointProbe
} from '../apps/server/src/remote/negotiation';
import type { EndpointCandidate } from '../apps/server/src/remote/endpoints';

const candidate = (
  kind: EndpointCandidate['kind'],
  url: string,
  priority: number
): EndpointCandidate => ({ kind, url, priority, tls: url.startsWith('https') });

const LAN = candidate('lan', 'http://192.168.1.10:3001', 10);
const LAN_ALT = candidate('lan', 'http://192.168.1.11:3001', 10);
const OVERLAY = candidate('overlay', 'http://server.ts.net:3001', 20);
const WAN = candidate('wan', 'https://caster.example.com', 30);
const RELAY = candidate('relay', 'https://relay.example.com', 40);

const ALL = [RELAY, WAN, OVERLAY, LAN];

const reachable = (url: string, latencyMs?: number): EndpointProbe =>
  ({ url, reachable: true, ...(latencyMs !== undefined ? { latencyMs } : {}) });
const unreachable = (url: string): EndpointProbe => ({ url, reachable: false });

describe('endpoint ordering', () => {
  it('puts the closest route first regardless of input order', () => {
    expect(orderCandidates(ALL).map((entry) => entry.kind))
      .toEqual(['lan', 'overlay', 'wan', 'relay']);
  });

  it('is stable for two candidates of the same kind', () => {
    const ordered = orderCandidates([LAN_ALT, LAN]);
    expect(ordered.map((entry) => entry.url))
      .toEqual([LAN.url, LAN_ALT.url]);
  });

  it('knows which kinds are direct', () => {
    expect(isDirect('lan')).toBe(true);
    expect(isDirect('overlay')).toBe(true);
    expect(isDirect('wan')).toBe(true);
    expect(isDirect('relay')).toBe(false);
  });
});

describe('endpoint selection', () => {
  it('prefers the local network when it answers', () => {
    const choice = selectEndpoint(ALL, [reachable(LAN.url, 4), reachable(WAN.url, 20)]);
    expect(choice).toMatchObject({ reason: 'direct-lan' });
    expect(choice!.candidate.url).toBe(LAN.url);
  });

  it('falls to the overlay when the LAN is unreachable', () => {
    const choice = selectEndpoint(ALL, [unreachable(LAN.url), reachable(OVERLAY.url, 30)]);
    expect(choice).toMatchObject({ reason: 'direct-overlay' });
  });

  it('uses the internet before a relay', () => {
    const choice = selectEndpoint(ALL, [reachable(WAN.url, 90), reachable(RELAY.url, 10)]);
    // The relay answered four times faster and still loses: a relay costs
    // bandwidth and puts a third party in the path.
    expect(choice).toMatchObject({ reason: 'direct-wan' });
  });

  it('uses a relay only when nothing direct works', () => {
    const choice = selectEndpoint(ALL, [
      unreachable(LAN.url), unreachable(OVERLAY.url), unreachable(WAN.url),
      reachable(RELAY.url, 60)
    ]);
    expect(choice).toMatchObject({ reason: 'relay-fallback' });
  });

  it('picks the quickest of several equally close routes', () => {
    const choice = selectEndpoint([LAN, LAN_ALT], [
      reachable(LAN.url, 40),
      reachable(LAN_ALT.url, 6)
    ]);
    expect(choice!.candidate.url).toBe(LAN_ALT.url);
    expect(choice!.latencyMs).toBe(6);
  });

  it('does not treat an unmeasured probe as instant', () => {
    const choice = selectEndpoint([LAN, LAN_ALT], [
      reachable(LAN.url),
      reachable(LAN_ALT.url, 25)
    ]);
    expect(choice!.candidate.url).toBe(LAN_ALT.url);
  });

  it('returns nothing when every route failed', () => {
    expect(selectEndpoint(ALL, ALL.map((entry) => unreachable(entry.url)))).toBeNull();
  });

  it('returns nothing when there was nothing to probe', () => {
    expect(selectEndpoint([], [])).toBeNull();
    expect(selectEndpoint(ALL, [])).toBeNull();
  });

  it('ignores probe results for endpoints no longer advertised', () => {
    const choice = selectEndpoint([WAN], [reachable(LAN.url, 2), reachable(WAN.url, 80)]);
    expect(choice!.candidate.url).toBe(WAN.url);
  });

  it('explains the choice in plain language', () => {
    expect(describeChoice(selectEndpoint(ALL, [reachable(LAN.url, 4)])))
      .toContain('local network');
    expect(describeChoice(selectEndpoint(ALL, [reachable(RELAY.url, 60)])))
      .toContain('relayed');
    expect(describeChoice(null)).toContain('No advertised endpoint');
  });
});

describe('remote access store', () => {
  let database: Database;
  let store: RemoteAccessStore;

  beforeEach(() => {
    database = new Database(':memory:');
    runDatabaseMigrations(database);
    store = new RemoteAccessStore(database);
  });

  it('starts with no registration', () => {
    expect(store.getRegistration()).toBeNull();
  });

  it('keeps one identity across writes', () => {
    store.saveRegistration({ serverId: 'srv_abc', controlPlaneUrl: 'https://cp.test' });
    store.saveRegistration({ serverId: 'srv_abc', joinName: 'living-room' });

    const registration = store.getRegistration()!;
    expect(registration.serverId).toBe('srv_abc');
    // Fields not being changed are preserved rather than blanked.
    expect(registration.controlPlaneUrl).toBe('https://cp.test');
    expect(registration.joinName).toBe('living-room');
  });

  it('keeps the identity when enrolment is revoked', () => {
    store.saveRegistration({
      serverId: 'srv_abc',
      enrolledAt: '2026-01-01T00:00:00.000Z',
      joinName: 'living-room'
    });

    expect(store.revokeRegistration('2026-02-01T00:00:00.000Z')).toBe(true);

    const registration = store.getRegistration()!;
    expect(registration.serverId).toBe('srv_abc');
    expect(registration.enrolledAt).toBeNull();
    expect(registration.joinName).toBeNull();
    expect(registration.disabledAt).toBe('2026-02-01T00:00:00.000Z');
  });

  it('reports nothing to revoke on an unregistered server', () => {
    expect(store.revokeRegistration()).toBe(false);
  });

  it('keeps a heartbeat trail, newest first', () => {
    store.recordHeartbeat({ seq: 1, attemptedAt: '2026-01-01T00:00:00.000Z', ok: true, statusCode: 200, error: null });
    store.recordHeartbeat({ seq: 2, attemptedAt: '2026-01-01T00:01:00.000Z', ok: false, statusCode: 503, error: 'unavailable' });

    const recent = store.recentHeartbeats();
    expect(recent.map((entry) => entry.seq)).toEqual([2, 1]);
    expect(recent[0]).toMatchObject({ ok: false, statusCode: 503, error: 'unavailable' });
  });

  it('trims the heartbeat log so it cannot grow without bound', () => {
    for (let seq = 0; seq < 40; seq += 1) {
      store.recordHeartbeat({
        seq,
        attemptedAt: `2026-01-01T00:${String(seq).padStart(2, '0')}:00.000Z`,
        ok: true, statusCode: 200, error: null
      });
    }

    expect(store.pruneHeartbeats(10)).toBe(30);
    expect(store.recentHeartbeats(100)).toHaveLength(10);
    expect(store.recentHeartbeats(1)[0]!.seq).toBe(39);
  });
});
