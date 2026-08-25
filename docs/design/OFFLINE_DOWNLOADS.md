# Offline downloads (WP-H)

Design for issue #34 [EPIC] Remote Access, Device Pairing & Native Clients — status: draft

This document defines authorized, resumable downloads for offline playback on
native clients. It uses the device model from Device Registry & Pairing
(issue #34 WP-D: scoped device tokens, revocation, last-used tracking) and the
signed-grant pattern already proven by cast access
(`apps/server/src/security/cast-access.ts`). The client-facing surface is the
v1 contract in [CLIENT_API_CONTRACT.md](CLIENT_API_CONTRACT.md); connectivity
assumptions come from [REMOTE_ACCESS_CONTROL_PLANE.md](REMOTE_ACCESS_CONTROL_PLANE.md).

## Goals

- Per-user, per-device download jobs with resumable transfer.
- License-free offline playback: downloaded files play locally without any
  server contact or DRM.
- Strict security: no filesystem paths or broad credentials ever reach the
  client.

## Non-goals

- Encrypted/DRM offline containers (files are ordinary media files playable by
  the platform player).
- Server-to-server replication or library-wide sync.
- Sharing downloaded files between devices.

## Authorization model

| Rule | Detail |
| --- | --- |
| Who | Authenticated user via session, API token, or scoped device token; viewer accounts additionally require `canDownload` (existing capability). |
| What | One media item per authorization; series/season "download all" is a client-side loop of per-item jobs. |
| Which device | Device-token callers authorize implicitly for their own `deviceId`; browser/API-token callers may name a target device for later pickup. |
| Remote restriction | Downloads over remote paths additionally respect `can_stream_remote` policy — same classification as streaming (`clientIsRemote`), so an operator who disables remote streaming disables remote downloads too. |
| Revocation | Revoking a device (WP-D) invalidates its tokens and any unexpired download grants immediately; already-downloaded local files remain but the app removes them and blocks playback on next launch (best-effort, documented as such). |

## Job lifecycle

```text
POST /api/v1/downloads            create job        -> {job}
GET  /api/v1/downloads/:id        poll status       -> {job}
GET  /api/v1/downloads/:id/manifest   fetch manifest -> {manifest}
GET  /api/v1/downloads/:id/chunk?offset=...&length=...
                                   signed chunk fetch (Range-capable)
DELETE /api/v1/downloads/:id      cancel/remove job
GET  /api/v1/downloads            list jobs for caller+device
```

Job states: `queued → preparing → ready → transferring → complete`, plus
`failed`, `cancelled`. `preparing` covers optional optimization transcode (see
below) and can take longer than the transfer itself.

Job object:

```json
{
  "id": "dl_...",
  "mediaId": "...",
  "deviceId": "dev_...",
  "quality": "original",
  "state": "ready",
  "bytesTotal": 4831838208,
  "bytesTransferred": 104857600,
  "error": null,
  "createdAt": "2026-08-24T12:00:00Z"
}
```

## Resumable transfer protocol

The manifest is the source of truth for resume:

```json
{
  "jobId": "dl_...",
  "fileName": "Movie (2024).mkv",
  "sizeBytes": 4831838208,
  "sha256": "<hex digest of full file>",
  "chunks": [
    { "index": 0, "offset": 0,        "length": 8388608 },
    { "index": 1, "offset": 8388608,  "length": 8388608 }
  ],
  "chunkSizeBytes": 8388608,
  "sidecarFiles": [
    { "kind": "subtitle", "url": "/api/v1/media/:id/subtitles/2", "name": "en.vtt" }
  ],
  "grantUrl": "/api/v1/downloads/dl_.../chunk?grant=..."
}
```

Transfer rules:

1. Client fetches the manifest once per job (re-fetchable after reconnect).
2. Chunks are fetched with plain ranged GETs against the signed chunk URL;
   standard HTTP `Range` semantics apply (`206` partial, `416` unsatisfiable),
   consistent with existing direct-stream behavior in [API.md](../API.md).
   A single request may also stream multiple contiguous chunks.
3. The client records completed chunk indexes locally; after interruption it
   re-fetches the manifest and resumes from the first incomplete index. No
   server-side per-client progress state is required for resume correctness —
   the server tracks only aggregate `bytesTransferred` for display/quota.
4. Integrity: the client verifies each chunk length matches the manifest and
   verifies the final assembled file against `sha256`. Mismatch ⇒ discard and
   restart that chunk; repeated mismatch ⇒ job `failed`.
5. Sidecar files (subtitles, thumbnails) are small separate GETs listed in
   the manifest so offline playback has everything it needs.
6. Progress reporting: clients POST `{bytesTransferred}` periodically
   (throttled to ≥ 5 s intervals) purely to keep the owner's cross-device UI
   honest; reconciliation after reconnect is driven by the manifest + local
   state, never by trusting the server's counter blindly.

### Signed chunk URLs

Chunk URLs carry a grant parameter with the same HMAC-SHA256 construction as
cast-access grants: short-lived expiry (default 1 h, renewable while the job
is active), bound to `jobId + deviceId + mediaId`, verified against the
server secret (`CASTER_CAST_SECRET`-style shared value across replicas).
Grants authorize read-only byte ranges of exactly one prepared file — nothing
else.

```sh
curl -sS -H 'Range: bytes=0-8388607' \
  -o ./chunk-0.bin \
  "$CASTER_URL/api/v1/downloads/dl_.../chunk?grant=..."
```

## Original vs optimized quality

| Option | Behavior | Trade-off |
| --- | --- | --- |
| `original` | Stream/remux the source file into the job; fastest start, exact bytes. | Largest storage; may be unplayable codec-wise on some devices. |
| `optimized` | Server transcodes through the existing HLS quality pipeline names (`1080p`, `720p`, `480p`, `360p`) but writes a single progressive MP4/MKV instead of segments, reusing `QUALITY_PROFILES` parameters from `apps/server/src/transcoder/engine.ts`. | Smaller files guaranteed-compatible codecs; consumes transcode slots (subject to existing 429 concurrency behavior). |

Clients pick at job creation; default follows the same bandwidth-class table
as [REMOTE_ACCESS_CONTROL_PLANE.md](REMOTE_ACCESS_CONTROL_PLANE.md)
(e.g., mobile defaults to `720p` optimized). Optimized jobs occupy a transcode
slot during `preparing`; when slots are saturated the job stays `queued` with
a visible reason rather than failing.

## Storage quotas and limits

| Limit | Default | Configurable |
| --- | --- | --- |
| Per-device total stored | 64 GB | Admin setting |
| Per-job max size | 25 GB | Admin setting |
| Jobs per device (active) | 10 | Fixed |
| Server-side prepared-file retention | Deleted when job marked delivered + 24 h grace | Admin setting |

Rules:

- Quota checks happen at job creation (`409 quota_exceeded`) and before
  serving each chunk beyond the running total.
- Devices report freed space via `DELETE /api/v1/downloads/:id/local` ("I
  removed this locally") which lets the server reclaim quota accounting
  without deleting the server-side prepared file inside the grace window.
- Administrators see aggregate download storage in system diagnostics;
  individual users' jobs are private to them.

## Offline playback model

There is deliberately **no license server and no DRM**:

- Downloaded files are standard containers written by ffmpeg; they play in the
  platform's local player even if Caster is deleted. This is accepted
  explicitly: authorization happens at download time; possession of the file
  afterward is treated like any file the user could have copied over USB.
- The client keeps its own offline catalog (manifest metadata: title, poster
  cached copy, subtitles) and plays from local storage with zero network.
- Watch progress made offline is queued locally and synced to
  `POST /api/v1/media/:id/progress` on reconnect; conflicts resolve
  last-writer-wins on position, with watched flags OR-ed.

## Reconnection and reconciliation

After connectivity returns (or the device returns to LAN):

1. Client enumerates local manifests and compares against
   `GET /api/v1/downloads`.
2. Interrupted transfers resume from first missing chunk (protocol above).
3. Completed-but-unreported jobs are reported once so server-side counters
   converge.
4. If the server no longer knows a job (retention elapsed, admin purge), the
   client keeps playing the local file but drops it from sync surfaces.
5. If the device was revoked while offline, the client detects this on first
   authenticated request (`device_token_invalid`) and wipes its offline store
   after user confirmation.

## Security rules

- Never expose server filesystem paths: manifests use logical names only;
  prepared files live outside any route-served directory and are reachable
  exclusively through grant-checked chunk endpoints.
- Never expose broad credentials: grants are per job/per device/expiring;
  device tokens never appear in URLs; grants are useless without the pairing
  that produced them.
- All download routes enforce the same ACL boundary as playback: denied and
  missing media share one 404; content-rating restrictions apply to viewers.
- Rate limits mirror login/streaming patterns (per-address 429 with
  `Retry-After`), plus per-device concurrent-chunk caps to prevent a single
  TV from saturating the uplink.
- Chunk responses are `Cache-Control: no-store` and never logged with grant
  values.

## Open questions

1. Should `optimized` jobs bypass the interactive transcode-slot limit via a
   dedicated background queue with lower priority?
2. Verify-per-chunk (hash list in manifest) vs verify-only-at-end — trade-off
   in corruption detection latency vs manifest size.
3. Do we need delta/re-download for corrected subtitle sidecars, or is
   re-fetch-on-version-bump sufficient?
4. Pause/resume across server restarts: persist prepared-file offsets so an
   interrupted optimization doesn't restart from zero?
