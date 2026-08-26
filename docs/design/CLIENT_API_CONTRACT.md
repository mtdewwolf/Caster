# Versioned client API contract (WP-E)

> **Superseded.** Caster uses Tailscale for remote access; there is no hosted
> control plane and no Caster-operated relay. See
> [REMOTE_ACCESS_DECISION.md](REMOTE_ACCESS_DECISION.md) for the decision and
> what survived from this document. Kept for its reasoning, not as a plan.

Design for issue #34 [EPIC] Remote Access, Device Pairing & Native Clients — status: superseded

This document defines the stable, versioned contract that native clients
(see [NATIVE_CLIENTS_ROADMAP.md](NATIVE_CLIENTS_ROADMAP.md)) and the web UI
consume. It builds on the current unversioned surface documented in
[API.md](../API.md) and on Device Registry & Pairing (issue #34 WP-D), which
provides devices with scoped device tokens, revocation, and last-used
tracking.

## Goals

1. Give native clients a compatibility guarantee that today's unversioned
   `/api/*` surface does not offer (acknowledged in [API.md](../API.md),
   "Base URL and compatibility").
2. Keep one contract for web and native clients — no forked behavior.
3. Introduce device authentication without breaking existing cookie/Bearer
   clients.

## Non-goals

- Rewriting or re-shaping every existing route in v1. v1 mounts the current
  semantics under a versioned prefix; reshaping is incremental.
- Per-client negotiated content types beyond JSON + existing binary routes.

## Versioning strategy: `/api/v1` mount plus shim

New code registers routes under `/api/v1`. The existing unversioned `/api/*`
routes remain and are treated as a **compatibility alias** of v1:

```text
/api/auth/login          -> unchanged legacy alias (frozen, bug-fix only)
/api/v1/auth/login       -> canonical v1 route
```

Implementation approach:

1. Define each v1 route handler once and register it at both prefixes during
   the migration window. The Hono app already groups middleware per subtree;
   v1 gets its own middleware stack (device auth support, error envelope,
   request ID).
2. Unversioned aliases are marked frozen in [API.md](../API.md): no new
   fields, no new routes, only fixes. New features land exclusively under
   `/api/v1`.
3. When telemetry shows unversioned usage has dropped below a threshold
   (target: two minor releases after native clients ship), aliases begin to
   emit `Deprecation`/`Sunset` headers before eventual removal.

Version selection rules:

- The version is a **prefix, not a header**. Clients pin by URL; this keeps
  proxies, curl debugging, and signed playback URLs simple.
- `GET /api/v1/capabilities` reports `apiVersions: ["v1"]` so clients can
  feature-detect rather than hard-fail.
- Breaking changes require `/api/v2`; additive changes (new optional fields,
  new routes, new enum values flagged in capabilities) do not.

## Capability discovery

Every client starts with:

```sh
curl -sS "https://caster.example/api/v1/capabilities"
```

```json
{
  "apiVersions": ["v1"],
  "server": { "id": "caster_...", "name": "home", "appVersion": "1.x.y" },
  "auth": {
    "protectedMode": true,
    "setupRequired": false,
    "supportsDeviceTokens": true,
    "pairingRequired": true
  },
  "features": {
    "hls": true,
    "qualities": ["original", "1080p", "720p", "480p", "360p"],
    "downloads": true,
    "offlineDownloads": true,
    "watchTogether": true,
    "remoteAccess": true,
    "relayAvailable": true,
    "transcodingHardware": ["qsv"]
  },
  "user": {
    "authenticated": false,
    "permissions": null,
    "profiles": []
  }
}
```

Rules:

- The endpoint is public and cheap; it must never include secrets or absolute
  filesystem paths.
- Unknown capability keys may appear; clients must ignore unrecognized keys
  and treat missing keys as `false`/absent.
- After authentication the same endpoint reflects the caller's `permissions`
  (`can_download`, `can_stream_remote`, etc.), letting clients hide UI instead
  of probing endpoints and handling 403s.

## Error envelope

The existing convention is `{"error":"Human-readable message"}` (see
[API.md](../API.md)). v1 formalizes it without breaking it:

```json
{
  "error": "Human-readable message",
  "code": "device_revoked",
  "requestId": "01J..."
}
```

| Field | Required | Meaning |
| --- | --- | --- |
| `error` | yes | Stable human-readable string, identical to today. |
| `code` | no | Machine-readable snake_case code; clients switch on codes, never on message text. |
| `requestId` | no | Correlates to server logs; echoed from the `X-Caster-Request-Id` response header. |

Initial error-code registry (extensible, additive-only):

| HTTP | `code` | Meaning |
| --- | --- | --- |
| 400 | `invalid_request` | Malformed body/query parameter. |
| 401 | `auth_required` | No/invalid credential. |
| 401 | `device_token_invalid` | Device token unknown, expired, or revoked (WP-D). |
| 403 | `forbidden` | Role/ACL/capability denied, incl. `can_stream_remote` denial. |
| 404 | `not_found` | Missing or access-denied resource (same boundary as today). |
| 409 | `conflict` | Optimistic-concurrency or duplicate operation. |
| 429 | `rate_limited` | Inspect `Retry-After`. |
| 503 | `unavailable` | Setup incomplete, transcoder saturated, or HLS killed. |

Binary/streaming routes (segments, thumbnails, subtitles, downloads) keep
plain-text/binary error bodies exactly as today; the envelope applies to JSON
control-plane responses only.

## Pagination convention

Existing list responses use `{items,total}` (e.g., `GET /api/media`). v1
standardizes on top of it:

- Query parameters: `limit` (route-specific max, default as documented per
  route) and `offset` (default `0`). Cursor pagination is deliberately not
  introduced in v1; offsets match the current implementation.
- Response shape stays `{items,total}`; v1 adds an optional read-only `page`
  object when a route paginates:

```json
{
  "items": [],
  "total": 237,
  "page": { "limit": 50, "offset": 100 }
}
```

- Clients should rely on `total` for scroll-end detection, not on item count.
- `total` counts ACL-scoped rows, consistent with current behavior.

## Device authentication

WP-D issues each paired device a scoped token (sha256-hashed server-side like
existing API tokens). v1 carries both credentials in one header scheme:

```sh
curl -sS \
  -H "Authorization: Bearer $CASTER_DEVICE_TOKEN" \
  -H "X-Caster-Device-Id: dev_..." \
  "https://caster.example/api/v1/media"
```

Semantics:

| Credential | Header | Scope | Revocation |
| --- | --- | --- | --- |
| User session cookie | `caster_admin_session` | Browser, one profile context | Logout / password change |
| User API token | `Authorization: Bearer` | Full user account | Rotation via admin/user settings |
| Device token (WP-D) | `Authorization: Bearer` + `X-Caster-Device-Id` | One device bound to one user; narrower default capabilities | Device revocation list |

Rules:

- If `X-Caster-Device-Id` is present, the bearer token must be that device's
  token; mismatch is a `401 device_token_invalid`.
- Device tokens resolve to their owning user's identity and ACLs; all
  authorization (libraries, ratings, `can_download`, `can_stream_remote`)
  applies unchanged.
- Devices get a reduced default capability set (no admin routes ever); extra
  grants are explicit owner decisions recorded by WP-D.
- Every authenticated request updates device `last_seen` opportunistically
  (batched/throttled writes to avoid hot-row churn).
- Playback derivative URLs (HLS segments, subtitles, download chunks) accept
  short-lived signed grants — same HMAC pattern as cast-access grants — so TV
  players that cannot attach headers still work. Grants are media-scoped,
  device-scoped, expiring, and revoke-checkable.

### Session and profile integration

- `POST /api/v1/auth/login` accepts optional `{deviceId}`; when the caller
  authenticates with a device token this is implicit.
- Profile switching mirrors `POST /api/auth/profile/switch` semantics
  (PIN-gated viewer profiles). For device-token callers the active profile is
  returned in `/api/v1/session` and switched with the same endpoint shape as
  today, scoped to the calling device so two devices on one account can hold
  different profiles.
- Progress ownership continues to derive from the resolved principal +
  active profile; clients can never pass another user/profile ID.

## Deprecation policy for native clients

| Change class | Policy |
| --- | --- |
| Additive (new fields/routes/capability flags) | Any release. Clients must tolerate unknown fields. |
| Behavior-preserving internal changes | Any release. |
| Field/route deprecation | Marked in capabilities + docs for ≥ 2 minor releases before removal; deprecated responses add `Deprecation` and `Sunset` headers. |
| Breaking change | Requires `/api/v2`; `/api/v1` remains supported for at least 12 months after v2 GA. |
| Security-mandated change | May ship immediately; affected routes return a specific error `code` so clients can explain it in UI. |

Native clients ship with a minimum-supported-API check at startup: if the
server's major version is older than the client supports, the client blocks
with an upgrade-server prompt instead of failing mysteriously mid-flow.

## Open questions

1. Should `GET /api/v1/capabilities` be cacheable (`ETag`) given TVs poll it
   on wake?
2. Exact mechanism for pushing "server upgraded, please refresh contract"
   signals to long-lived TV sessions (WebSocket notice vs next-request
   header)?
3. Do watch-together WebSockets move to `/api/v1/ws/...` in lockstep, or stay
   path-stable across versions?
