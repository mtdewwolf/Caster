# Remote access control plane (WP-A/B/C)

> **Superseded.** Caster uses Tailscale for remote access; there is no hosted
> control plane and no Caster-operated relay. See
> [REMOTE_ACCESS_DECISION.md](REMOTE_ACCESS_DECISION.md) for the decision and
> what survived from this document. Kept for its reasoning, not as a plan.

Design for issue #34 [EPIC] Remote Access, Device Pairing & Native Clients — status: superseded

This document covers three work packages of the epic:

- **WP-A** — server identity and registration with a hosted control plane.
- **WP-B** — direct connection negotiation between clients and servers.
- **WP-C** — encrypted relay fallback when direct connection fails.

Related documents:

- [CLIENT_API_CONTRACT.md](CLIENT_API_CONTRACT.md) — versioned API surface used by all clients.
- [NATIVE_CLIENTS_ROADMAP.md](NATIVE_CLIENTS_ROADMAP.md) — how native clients consume this.
- [OFFLINE_DOWNLOADS.md](OFFLINE_DOWNLOADS.md) — downloads authorized through this plane.
- Device pairing itself is designed in "Device Registry & Pairing" (issue #34 WP-D); this document only assumes paired devices hold scoped device tokens.
- Existing Tailscale operation remains fully supported and unchanged ([TAILSCALE_SETUP.md](../TAILSCALE_SETUP.md)).

## Goals and non-goals

Goals:

1. Reach Caster from anywhere without Tailscale or manual port forwarding.
2. Keep LAN operation completely independent of any cloud component.
3. Ensure the control plane can broker connections but never read media traffic.
4. Prefer direct paths; use the relay only as a last resort.

Non-goals:

- Self-hosting the control plane in v1 (the protocol is documented so a
  compatible implementation is possible later).
- Mesh/peer-to-peer between multiple Caster servers.
- Replacing the existing network classification (`clientIsRemote`,
  `can_stream_remote`); it continues to govern what a connected client may do.

## Architecture overview

```text
+--------+   outbound HTTPS/WSS    +---------------+
| Caster |------------------------>| Control plane |
| server |  register, heartbeat    | (hosted)      |
+--------+                         +---------------+
     | ^                                |  ^
     | | 1. direct LAN/WAN TLS          |  2. relay (only if 1 fails,
     | |    to candidate endpoints      |     ciphertext only, E2E-encrypted)
     v |                                v  |
+-----------+                       +----------+
| Client    |                       | Relay    |
| (paired)  |<--------------------->| nodes    |
+-----------+                       +----------+
```

Key properties:

- The Caster server makes **outbound-only** connections to the control plane.
  No inbound ports must be opened on the home router for control traffic.
- Clients talk to the control plane only to look up servers and obtain
  connection grants; media always flows client→server directly or via relay.
- The relay carries only end-to-end encrypted application traffic (see
  [Relay fallback](#relay-fallback-wp-c)).

## Server registration and identity (WP-A)

### Identity

On first enrollment the server generates an Ed25519 keypair. The public half
is the stable **server ID** (`caster_<base32-pubkey>`). The private key never
leaves the server's data directory and is included in the backup scope of
[BACKUP_RESTORE.md](../BACKUP_RESTORE.md). Losing it means losing the
registered identity; re-enrollment issues a new ID and old registrations are
orphaned (see recovery below).

Enrollment is performed by the owner interactively from the LAN web UI:
Caster opens a short-lived outbound enrollment session, the owner approves the
device code shown on screen, and the control plane binds `server_id` to the
owner's control-plane account. This mirrors the QR/code pairing UX defined in
Device Registry & Pairing (issue #34 WP-D).

### Heartbeat and presence

The server maintains one persistent outbound WebSocket (with reconnect +
exponential backoff + jitter) and falls back to periodic HTTPS POSTs if WSS is
unavailable.

Heartbeat payload (signed with the server key):

```json
{
  "serverId": "caster_...",
  "seq": 4821,
  "time": "2026-08-24T12:00:00Z",
  "version": "app-version",
  "endpoints": [
    { "kind": "lan",     "value": "192.168.1.20:3001" },
    { "kind": "wan",     "value": "203.0.113.7:41021", "tls": true },
    { "kind": "overlay", "value": "100.x.y.z:3001" }
  ],
  "relayRegion": "eu-central",
  "status": "online"
}
```

Rules:

- Heartbeat interval: 30 s over WSS; 120 s polling fallback. The control plane
  marks a server `stale` after 90 s and `offline` after 5 min.
- Endpoint advertisements are refreshed opportunistically; LAN endpoints are
  advertised so co-located clients can short-circuit to local addresses (see
  negotiation).
- A server that cannot reach the control plane keeps serving normally
  (see [Critical invariant](#critical-invariant-lan-first-offline-first)).

### Authenticated lookup

A paired client that knows a server's **join name** (for example
`home.caster.app`) resolves it like this:

```sh
curl -sS \
  -H "Authorization: Bearer $CASTER_DEVICE_TOKEN" \
  "https://controlplane.example/api/v1/servers/home.caster.app/connect"
```

Response:

```json
{
  "serverId": "caster_...",
  "status": "online",
  "candidates": [
    { "kind": "lan",  "url": "http://192.168.1.20:3001", "ttl": 60 },
    { "kind": "wan",  "url": "https://203-0-113-7.example-relay.net:41021", "tls": true, "ttl": 300 },
    { "kind": "relay","region": "eu-central", "grant": "<one-time relay grant>", "ttl": 120 }
  ]
}
```

- Lookup requires a valid device token issued by Device Registry & Pairing
  (WP-D); the control plane validates it against the device registry mirror
  published by the owning server, not against raw user credentials.
- Responses carry short TTLs; candidates are hints, not guarantees.
- Every connect response includes a fresh nonce-bound **connection grant**
  (HMAC-SHA256, same pattern as `apps/server/src/security/cast-access.ts`)
  that the client presents to the server endpoint. The server rejects grants
  older than their expiry and bound to another device ID.

### Ownership recovery and revocation

| Event | Mechanism |
| --- | --- |
| Owner loses access to control-plane account | Recovery via the server itself: while on the LAN, the owner can re-assert ownership locally (proof-of-possession of an admin credential), which re-binds or unbinds the control-plane registration. |
| Server key compromised / hardware retired | Owner revokes the server registration from the control plane web UI; heartbeats are rejected and lookups stop resolving within one heartbeat interval. |
| Individual device lost/stolen | Revoked per-device in the server admin UI (WP-D revocation); the server stops accepting its tokens immediately and informs the control plane on next heartbeat so its grants fail closed. |
| Control-plane outage | Servers keep running; remote clients fall back to cached last-known WAN endpoints (best-effort, honor TTL) and LAN discovery. |

## Direct connection negotiation (WP-B)

### Candidate discovery

The client gathers candidates in parallel and races them:

1. **LAN mDNS**: browse `_caster._tcp.local.`; match against the resolved
   `serverId`. mDNS TXT records include `id=caster_...`.
2. **Local probe**: for endpoints advertised as `kind: "lan"` in the connect
   response, issue a cheap authenticated `GET /health` plus grant check.
   This covers networks where mDNS is blocked (guest Wi-Fi, some routers).
3. **WAN direct**: the server, at registration time, attempts automatic NAT
   traversal (PCP/UPnP IGD port mapping where the router allows it) and
   advertises the resulting public endpoint over TLS. Where no mapping is
   possible, WAN-direct is simply absent from candidates.
4. **Overlay**: if Tailscale is configured, its address appears as an overlay
   candidate and behaves like a direct candidate.

### Preference order and fallback

```text
prefer: lan > overlay > wan-direct > relay
```

- Candidates are raced concurrently with a 1.5 s head start for higher tiers;
  the first candidate that completes a full handshake (TLS + grant validation
  + `/health`) wins.
- On failure of a tier, the client retries the next tier automatically. A
  downgrade to relay shows a subtle indicator in the client UI ("relayed"),
  never an error.
- Once connected, the client periodically re-runs LAN discovery (every 5 min
  while active) and upgrades silently from relay/wan to lan when the device
  joins the home network.

### Bandwidth measurement and quality selection

After handshake, the client performs a lightweight throughput probe (a few
hundred KB sampled from a real segment request) and classifies the path:

| Measured sustained throughput | Playback policy |
| --- | --- |
| ≥ 25 Mbit/s | `original` / highest HLS variant |
| 8–25 Mbit/s | `1080p` |
| 4–8 Mbit/s | `720p` |
| 1.5–4 Mbit/s | `480p` |
| < 1.5 Mbit/s | `360p`, disable auto-advance previews |

These map onto the existing quality names in
`apps/server/src/transcoder/engine.ts` `QUALITY_PROFILES` and the accepted HLS
qualities in [API.md](../API.md) (`original`, `1080p`, `720p`, `480p`, `360p`),
so no new transcode profile is introduced. The measured class is sent as
`GET /api/media/:id/hls/master.m3u8?maxHeight=...` style hint (exact parameter
defined in [CLIENT_API_CONTRACT.md](CLIENT_API_CONTRACT.md)), and users can
always override manually. Probes repeat on network-change events only, not
continuously.

## Relay fallback (WP-C)

The relay exists only because some homes have symmetric NAT or CGNAT with no
mapping capability. It is never the preferred path.

### Data path and encryption

- The client and server derive a shared session key via X25519 ephemeral
  exchange over the control-plane-brokered introduction; both sides then open
  outbound TCP/TLS to the assigned relay node and speak an AEAD-encrypted
  (XChaCha20-Poly1305) framed protocol. The relay sees two opaque encrypted
  streams and multiplexes them by session ID.
- Inside the tunnel runs the ordinary HTTP API and media traffic. Because the
  inner traffic is HTTP-over-TLS-equivalent, the server still applies its
  normal auth, ACLs, `clientIsRemote` classification, and
  `can_stream_remote` checks — the relay session maps to a fixed synthetic
  remote peer address, classified remote by definition.

### Caps and abuse limits

| Limit | Default |
| --- | --- |
| Per-session bandwidth | 15 Mbit/s sustained, burstable to 25 Mbit/s for 10 s |
| Concurrent relay sessions per server | 3 |
| Concurrent relay sessions per user | 2 |
| Per-user relay minutes | 600 min/day soft cap; exceeding degrades to 5 Mbit/s rather than hard-cutting active playback |
| Session idle timeout | 60 s without traffic |
| Session max lifetime | 12 h, renegotiated |

Additional safeguards:

- Relays enforce per-source-IP connection rate limits and reject sessions
  whose one-time grant has been seen before (replay protection).
- The control plane exposes per-server relay usage diagnostics in the owner
  dashboard (minutes, bytes, peak concurrent sessions) so operators can see
  cost drivers.
- Global kill switch: `CASTER_RELAY_ENABLED=false` on the server disables the
  relay leg entirely; direct/LAN behavior is unaffected.
- Cost safeguard: relay capacity is provisioned per region; when a region is
  saturated, new sessions get a clear `relay_unavailable` outcome and clients
  surface "direct connection required right now" instead of queueing.

## What the control plane and relay can and cannot observe

| Aspect | Control plane | Relay node |
| --- | --- | --- |
| Server identity, online/offline status, version | Yes | No |
| Advertised endpoint addresses (LAN/WAN) | Yes | No |
| Which devices looked up which server, when | Yes | No |
| Usernames, passwords, tokens | No | No |
| Media titles, catalog, progress | No | No |
| Streamed content (video/audio/subtitles) | No | No — sees only AEAD ciphertext |
| Connection metadata (bytes, duration, IPs) for billing/abuse | Aggregate counts only | Per-session byte/time counters only |
| Ability to inject or alter traffic | No (traffic is AEAD-authenticated; tampering fails closed) | Same |

Both components are deliberately stateless with respect to content: they
cannot decrypt, cache, or replay application payloads.

## Critical invariant: LAN-first, offline-first

**LAN playback must remain fully functional when the control plane and relays
are unreachable.** Concretely:

1. No code path in media serving, auth, transcoding, or downloads may block on
   control-plane availability. Control-plane clients run detached with bounded
   queues and hard timeouts.
2. Local clients authenticate exactly as today (sessions/API tokens/device
   tokens against the server's own database). The control plane is never in
   the local authentication path.
3. If the server has never enrolled, or enrollment is disabled
   (`CASTER_REMOTE_ACCESS_ENABLED=false`), every other feature works
   unchanged.
4. Offline behavior matrix:

| Component unreachable | Effect |
| --- | --- |
| Control plane down | New remote lookups fail; existing direct sessions continue; LAN unaffected. |
| Relay down | Remote clients that can't go direct show a clear error; direct and LAN unaffected. |
| Both down, client at home | Nothing changes: mDNS/local probe finds the server; playback uses LAN candidates. |

CI/release gates should include a test that exercises login, browsing, and HLS
playback with all outbound control-plane networking blackholed (see
[RELEASE_GATES.md](../RELEASE_GATES.md) conventions).

## Open questions

1. Hosted control plane operator model: single vendor-run instance vs
   federated regional instances; data-retention window for lookup logs.
2. Should join names (`home.caster.app`) be user-chosen subdomains or opaque
   random handles with optional friendly aliases?
3. NAT traversal: rely solely on PCP/UPnP mapping, or also add UDP hole
   punching (e.g., a WebRTC-ICE-style exchange) before falling back to relay?
4. QUIC/Multipath-TCP for the relay tunnel to improve lossy-network playback?
5. Do we need multi-server accounts (one control-plane account owning several
   Caster servers) at launch, or is one-to-one sufficient?
6. Relay accounting granularity vs privacy: can we report only coarse buckets
   (GB/day) instead of per-session records?
