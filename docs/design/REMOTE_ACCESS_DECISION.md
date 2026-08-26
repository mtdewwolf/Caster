# Remote access: Tailscale, not a hosted control plane

Decision for issue #34 [EPIC] Remote Access, Device Pairing & Native Clients — **status: accepted**

## The decision

Caster reaches remote devices through **Tailscale**. It does not run a hosted
control plane, and it does not relay traffic.

The three design documents that assumed otherwise —
[REMOTE_ACCESS_CONTROL_PLANE.md](REMOTE_ACCESS_CONTROL_PLANE.md),
[CLIENT_API_CONTRACT.md](CLIENT_API_CONTRACT.md) and
[OFFLINE_DOWNLOADS.md](OFFLINE_DOWNLOADS.md) — are superseded by this one. They
are kept for the reasoning they contain, not as a plan.

## Why

The hosted design was sound engineering resting on an unexamined premise: that
someone would run the hosted half. Nobody was going to.

**A control plane is a service, not a feature.** Servers registering, heartbeats
arriving, lookups being answered — that has to be online whenever anyone wants
to watch something remotely. It needs a host, a domain, certificates,
monitoring, and somebody on the hook when it breaks at 11pm. Caster is
self-hosted software for one household. Making it depend on a service its author
has to keep alive turns a personal media server into an operational commitment
that outlives anyone's enthusiasm for it.

**A relay is a bandwidth bill and an abuse surface.** Relaying video means
paying for every byte two strangers' devices push through it, and building the
rate limiting, quotas and abuse handling that any open relay immediately needs.
The draft acknowledged this and specified caps. Caps do not make the bill or the
abuse go away; they bound them.

**Tailscale already solves this, better.** It does NAT traversal properly,
prefers direct connections and falls back to its own relays, handles identity
and device revocation, is audited, and is free at household scale. The remaining
work becomes documentation rather than distributed systems.

**The cost of the alternative was already visible.** The control-plane code sat
unmounted and unmigrated for months with `enrol`, `revoke` and `lookup` as
`NOT_IMPLEMENTED` stubs. Unfinished work that nobody is finishing is not a plan;
it is a maintenance liability that makes the epic read as nearly done.

## What this changes

| Work package | Was | Now |
| --- | --- | --- |
| A — Control plane | Hosted registration, heartbeat, lookup, revocation | **Dropped.** Tailscale provides reachability and identity. |
| B — Direct connection | Custom endpoint negotiation | **Kept and shipped.** Clients discover and probe advertised addresses, preferring the closest direct route. Works for LAN and Tailscale alike. |
| C — Relay fallback | Caster-operated relay | **Dropped.** Tailscale's DERP relays cover this. |
| D — Secure pairing | Short codes, scoped device tokens | **Kept and shipped.** Useful regardless of transport. |
| E — Versioned client API | v1 contract for native clients | **Deferred**, not dropped — a real native client is what should force its shape. |
| F — Android TV / Fire TV | 10-foot client | **Still wanted.** Connects over Tailscale like everything else. |
| G — Mobile clients | Roadmap | **Unchanged.** |
| H — Offline downloads | Resumable download jobs | **Still wanted**, and simpler now: no relay, no bandwidth accounting. |

The endpoint negotiation built for B is not wasted. Tailscale gives a server a
stable address, but a device on the same LAN should still connect directly over
the LAN rather than through the tunnel — which is exactly the closest-route-wins
choice already implemented.

## What stays in the code

- Endpoint advertisement and client-side probing (`remote/negotiation.ts`,
  `routes/connection.ts`) — actively used.
- Device pairing and scoped device tokens (`security/device-pairing.ts`) —
  actively used.
- Server identity signing (`remote/identity.ts`) — kept; a stable server
  identity is useful for pairing and for any future client contract.
- `HeartbeatClient` and the `remote_registration` table — kept but inert. They
  cost nothing, and removing them would be the third rewrite of this area.
  **They should not be described as almost-working.** There is nothing for them
  to talk to, and that is deliberate.

## What replaces the dropped work

Setup documentation, which is where the value actually was:

- [TAILSCALE_SETUP.md](../TAILSCALE_SETUP.md) — the supported path for remote access.
- Pairing a TV or phone happens over Tailscale using the existing short-code flow.

## Revisiting this

Reopen the question if a household of Caster users cannot install Tailscale on
the devices they care about — an older TV with no sideloading, for instance.
That is a concrete, testable trigger. "Someone might prefer not to install
Tailscale" is not.
