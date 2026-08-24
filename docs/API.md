# Caster HTTP API

This document describes the HTTP routes implemented by the current Caster
server. For deployment and network boundaries, see the
[TrueNAS operations guide](TRUENAS_SCALE_SETUP.md).

> Caster is designed for a trusted LAN or private overlay network. When any
> account credential is configured, protected mode requires an active account
> for catalog and playback routes. Filesystem, library/scan, account-access,
> cache, hardware, and transcode administration require an administrator.
> Direct public-Internet exposure is unsupported.

## Base URL and compatibility

The default origin is `http://HOST:3001`. API routes use the unversioned base:

```text
http://HOST:3001/api
```

`GET /health` is outside `/api`.

There is no `/api/v1` namespace, negotiated API version, formal stability
guarantee, or deprecation policy. The `version` value returned by
`GET /api/system/status` is an application value, not an API compatibility
version. Until versioning is implemented, clients should pin a tested Caster
release or commit and expect response or route changes to be potentially
breaking. A versioned API and compatibility policy remain follow-up work.

## Access and authentication

Protected mode is enabled whenever an active account has a password or API
token. Catalog, progress, series, thumbnail, subtitle, direct-stream, and HLS
routes then require an authenticated user. Per-user library allowlists are
deny-by-default for viewers. Administrative reads and mutations require an
administrator. Progress mutations are available to viewers for their own
history.

| Access label | Meaning |
| --- | --- |
| Public | No credential is required. This is limited to health and authentication entry points in protected mode. |
| User | Requires an active admin or viewer cookie/Bearer credential and applies that user's ACL and progress owner. |
| Login | No prior session is required; an active account credential is required in the JSON body. |
| Admin | Requires an active administrator cookie or Bearer credential. |

For a first boot, configure at least one of these server environment variables:

- `ADMIN_PASSWORD`: imported as a salted password hash for the initial admin.
- `ADMIN_TOKEN`: imported as a one-way API-token hash for the initial admin.

The raw values are not persisted. Additional named admin/viewer accounts can be
managed through the API. If no credential exists, Caster permits anonymous
catalog and playback reads only over a direct loopback connection; this keeps
local development usable without exposing a LAN listener. Administrative
routes return `503`. In protected mode, missing or invalid authentication returns `401` with
`WWW-Authenticate: Bearer`.

Environment credentials are first-run bootstrap inputs, not parallel runtime
credentials. Once imported, authentication checks only the stored hashes.
Changing an account password or rotating its API token therefore makes a stale
environment value invalid; update the environment secret as an operational
follow-up so a future empty-database bootstrap uses the intended credential.

Account-free network access is a deliberate deployment choice:

- Set `CASTER_OPEN_MODE=true` (the exact value `true`, case-insensitive).
- Set `CASTER_OPEN_NETWORKS` to the comma-separated exact client IPs and
  IPv4/IPv6 CIDRs that may browse and play media. If omitted, it defaults to
  loopback only (`127.0.0.0/8,::1/128`). A Tailscale-and-LAN example is
  `100.64.0.0/10,192.168.0.0/16`.

Open mode grants every matching anonymous client a synthetic catalog principal
that bypasses per-user library ACLs, so use the narrowest possible networks.
It never unlocks administrative routes. Requests with an unknown socket peer,
malformed proxy chain, or client outside the allowlist are denied. Startup logs
clearly warn when open mode is enabled.

Browser requests with an `Origin` header are accepted only from the request's
own origin or an exact comma-separated origin in `CASTER_TRUSTED_ORIGINS`.
Wildcard CORS is never emitted. Cookie-authenticated mutations additionally
require a trusted `Origin`/`Referer` (or same-origin Fetch Metadata); Bearer API
clients are not subject to that CSRF check.

Viewer remote-stream restrictions and open-network decisions start with the
actual socket peer. Behind a trusted reverse proxy, set
`CASTER_TRUSTED_PROXIES` to a comma-separated list of exact proxy IPs or
IPv4/IPv6 CIDRs (for example `172.20.0.0/16,fd00:1234::/64`). Only
`X-Forwarded-For` or `X-Real-IP` from a matching immediate peer is honored. A
multi-proxy `X-Forwarded-For` chain is walked from right to left through trusted
proxy hops; an attacker-prepended value is never selected past the first
untrusted hop. Forwarding headers from an unconfigured peer, unsupported
`Forwarded`-only topology, missing peer information, and malformed addresses
are conservatively classified as remote. Configure proxies to overwrite or
append the standard client chain, and never trust a broad client network merely
because it contains the proxy.

### Cookie sessions

`POST /api/auth/login` accepts `{"username":"...","password":"..."}` and
creates the HTTP-only `caster_admin_session` cookie. Omitting `username` keeps
the initial-admin login compatible. The cookie uses `SameSite=Strict`, lasts up
to 12 hours, and is marked `Secure` for HTTPS. Only a SHA-256 session-token
digest is stored in SQLite, so sessions survive server restarts without storing
the bearer secret.

After five failed logins from the same observed address, subsequent attempts in
the 15-minute window return `429` with `Retry-After`. Auth responses use
`Cache-Control: no-store`.

`POST /api/auth/logout` clears an absent, stale, or valid cookie. A valid cookie
session is subject to the trusted-source CSRF check.

Example with a placeholder credential and a local cookie jar:

```sh
CASTER_URL='http://192.0.2.10:3001'

curl -sS -c ./caster.cookies \
  -H 'Content-Type: application/json' \
  --data '{"password":"REPLACE_WITH_ADMIN_CREDENTIAL"}' \
  "$CASTER_URL/api/auth/login"

curl -sS -b ./caster.cookies "$CASTER_URL/api/auth/session"
```

The cookie jar contains that user's session. Restrict access to it and remove
it when the session is no longer needed.

### Bearer authentication

API clients should send the configured `ADMIN_TOKEN` without first calling the
login route:

```sh
curl -sS \
  -H "Authorization: Bearer $CASTER_ADMIN_TOKEN" \
  "$CASTER_URL/api/auth/session"
```

Bearer authentication accepts per-user API tokens, not account passwords.

Do not put a real token in documentation, URLs, logs, or shell history. Direct
HTTP does not encrypt cookies or Authorization headers; use a trusted private
network or HTTPS.

### Progress owners

Every authenticated account is its own progress owner. Media, series,
continue-watching, and progress responses use the resolved principal; clients
cannot select another user ID through a request parameter.

## Request and error conventions

JSON request bodies should use `Content-Type: application/json`. Control-plane
responses are generally JSON, and most JSON errors use:

```json
{"error":"Human-readable message"}
```

The error format is not universal. Unknown `/api/*` routes return
`{"error":"API route not found"}`, but direct streams, playlists, thumbnails,
and subtitle routes can return plain text, binary data, JPEG, MPEG-TS, M3U8, or
WebVTT. There is no formal machine-readable error-code schema, so clients must
check the HTTP status and `Content-Type`.

Common statuses include:

| Status | Meaning in the current API |
| --- | --- |
| `200` | Successful read, update, delete, or control request. |
| `201` | A playlist, playlist item, or watch room was created. |
| `206` | Valid single-range direct-stream response. |
| `400` | Malformed JSON, invalid query, path parameter, or body value. |
| `401` | Authentication required or login credential invalid. |
| `403` | Authenticated role/ACL/capability denied, untrusted origin, or failed CSRF source check. |
| `404` | Requested catalog item, path, source file, generated asset, or API route not found. |
| `409` | A library scan is already running. |
| `416` | Invalid or unsatisfiable direct-stream byte range. |
| `429` | Login rate limit or transcode concurrency limit; inspect `Retry-After`. |
| `500` | Thumbnail, HLS, or subtitle processing failure, or another unhandled server failure. |
| `503` | Authentication is not configured, or an HLS transcode was killed. |

## Health and authentication endpoints

| Method and path | Access | Input | Response |
| --- | --- | --- | --- |
| `GET /health` | Public | None | `{status, service, time}`. |
| `GET /api/auth/session` | Public | Optional cookie or Bearer header | `{authenticated,configured,protectedMode,user?}`. |
| `POST /api/auth/login` | Login | `{"username?":"...","password":"..."}` | Sets the session cookie and returns the authenticated public user. |
| `POST /api/auth/logout` | Logout | Optional session cookie | Invalidates and clears the cookie, including a stale cookie, and returns `{authenticated:false}`. |
| `GET /api/auth/users` | Admin | None | Lists public account records and active states. |
| `POST /api/auth/users` | Admin | `{username,password,role?}` | Creates a named admin or viewer. |
| `PATCH /api/auth/users/:id` | Admin | Optional `{username,password,apiToken,role,active}` fields | Updates an account. Password changes invalidate that user's sessions; API-token rotation immediately invalidates the old token. |
| `DELETE /api/auth/users/:id` | Admin | User ID | Soft-disables the account. |
| `POST /api/auth/profile/switch` | Cookie admin or permitted viewer | `{username,pin}` | Enters an active viewer profile, rate-limits failures per source session and target, and rotates the shared-browser session. Viewers require `canManageProfiles`; profile PINs never grant administrator access. |

## Library grants, permissions, and profile PINs

These routes are admin-only. Viewer library access is an explicit allowlist;
an empty list grants no catalog or playback access.

| Method and path | Input | Response |
| --- | --- | --- |
| `GET /api/access/users/:id/libraries` | User ID | `{libraryIds}`. |
| `PUT /api/access/users/:id/libraries` | `{libraryIds:string[]}` | Atomically replaces the user's grants. |
| `GET /api/access/users/:id/permissions` | User ID | `{permissions}`. |
| `PATCH /api/access/users/:id/permissions` | Any of `maxContentRating`, `allowUnrated`, `canDownload`, `canStreamRemote`, `canDeleteMedia`, `canManageProfiles` | `{permissions}`. |
| `PATCH /api/access/users/:id/pin` | `{pin:"4-12 digits"}` or `{pin:null}` | Sets or clears the salted profile-PIN hash and returns permissions with `hasProfilePin`. |

PIN and credential hashes are never returned. Disabled accounts immediately
lose access, and password reset/disable operations invalidate their sessions.

## Filesystem and libraries

Filesystem and scan routes are admin-only because they expose absolute host
paths and process-visible directories. Viewers can list only libraries granted
to them, and viewer library payloads omit the absolute host path.

| Method and path | Access | Input | Response and behavior |
| --- | --- | --- | --- |
| `GET /api/fs/browse` | Admin | Optional URL-encoded `path` query | `{isRoot,current,parent,entries}`; each entry has `{name,path,hasMedia}`. Omitting `path` returns available roots. |
| `GET /api/fs/suggest` | Admin | None | `{suggestions}` with absolute path, inferred library type, media count, and `alreadyAdded`. Performs a bounded filesystem scan. |
| `GET /api/libraries` | User | None | `{libraries}` scoped by ACL; viewer objects omit absolute host paths. |
| `POST /api/libraries` | Admin | `{name,path,type}` | Creates a library and attempts a background scan; returns `{library}`. |
| `DELETE /api/libraries/:id` | Admin | Library ID in path | Returns `{success:true}` even if the ID did not exist. |
| `POST /api/libraries/:id/scan` | Admin | Library ID in path | Starts a background scan; returns `{status:"started",libraryId}`. |
| `POST /api/libraries/scan-all` | Admin | None | Starts a background scan of all libraries; returns `{status:"started"}`. |
| `GET /api/libraries/scan/status` | Admin | None | `{isScanning,libraryId,totalFiles,processedFiles,currentFile,errors}`. Errors can contain absolute paths. |

Allowed library `type` values are `movies`, `tv`, `music`, and `home_videos`.
The create route requires an existing directory accessible to the server.

Deleting a library removes its cataloged media and dependent progress/subtitle
records through database cascades. It does not delete source media files. A scan
can remove catalog entries for files no longer found, but also leaves source
files untouched.

Example creation and scan-status requests:

```sh
curl -sS \
  -H "Authorization: Bearer $CASTER_ADMIN_TOKEN" \
  -H 'Content-Type: application/json' \
  --data '{"name":"Movies","path":"/media/movies","type":"movies"}' \
  "$CASTER_URL/api/libraries"

curl -sS "$CASTER_URL/api/libraries/scan/status"
```

## Catalog, series, and progress reads

| Method and path | Access | Input | Response |
| --- | --- | --- | --- |
| `GET /api/media` | User | Filters described below | ACL-scoped `{items,total}`. |
| `GET /api/media/continue-watching` | User | None | `{items}` with at most 12 incomplete items for the current progress owner. |
| `GET /api/media/progress` | User | Optional `status` and `limit` | `{items}` ordered by most recently watched for the current owner. |
| `GET /api/media/:id` | User | Media ID | `{item}` or the same 404 used for missing/denied media. |
| `PATCH /api/media/:id/content-rating` | Admin | `{"contentRating":"PG-13"}` or `{"contentRating":null}` | Sets or clears the normalized rating used by viewer content restrictions. |
| `GET /api/series` | User | Optional `libraryId`, `search` | ACL-scoped series rollups for the current owner. |
| `GET /api/series/:id` | User | Series ID | `{series,seasons}` or 404. |
| `GET /api/series/:id/episodes` | User | Series ID | `{series,items}` ordered by season and episode. |

`GET /api/media` accepts:

- `libraryId`: exact library ID.
- `type`: exact stored media type, normally `movie`, `episode`, `track`, or
  `video`.
- `search`: title or series-title search.
- `resolution`: substring match against the stored resolution label.
- `sort`: `title`, `year`, or `duration`; other values use newest-created order.
- `limit`: integer from 1 through 500, default 50.
- `offset`: non-negative integer, default 0.

`GET /api/media/progress` accepts `status=in_progress` or `status=completed` and
`limit` from 1 through 1000, default 200.

Media objects include media metadata, `relative_path`, a serialized
`streams_json` string, optional `content_rating` and `content_rating_level`
fields, and optional owner-specific progress. Admin responses also include
`full_path`; viewer responses omit absolute filesystem paths.

Supported content ratings, from least to most restrictive, are `TV-Y`,
`TV-Y7`/`G`/`TV-G`, `PG`/`TV-PG`, `PG-13`/`TV-14`, `R`/`TV-MA`, and `NC-17`.
Scans import a recognized rating from common media-container rating tags, while
the admin endpoint can correct or clear it. Viewer maximum-rating and
`allowUnrated` policies are applied in SQL before counts, pagination, progress,
and series rollups; an unknown or absent rating is treated as unrated.

Example filtered query:

```sh
curl -sS --get \
  --data-urlencode 'search=Example title' \
  --data-urlencode 'sort=year' \
  --data-urlencode 'limit=25' \
  "$CASTER_URL/api/media"
```

## Music library and playlists

Music scans import common container tags (`title`, `artist`, `album_artist`,
`album`, track/disc number, genre, and year) with deterministic folder and
filename fallbacks. Album tracks are ordered by disc, track, relative path,
then stable media ID. All reads apply the current user's library and content
rating scope before grouping or counting.

| Method and path | Access | Input | Response |
| --- | --- | --- | --- |
| `GET /api/music/artists` | User | Optional `libraryId`, `search` | `{items}` with artist rollups. |
| `GET /api/music/artists/:id` | User | Artist ID | `{artist,albums}` or 404. |
| `GET /api/music/albums` | User | Optional `libraryId`, `artistId`, `search` | `{items}` with album rollups. |
| `GET /api/music/albums/:id` | User | Album ID | `{album,tracks}` in stable playback order. |
| `GET /api/playlists` | User | None | Current user's playlists. |
| `POST /api/playlists` | User | `{name}` | Creates a user-owned playlist. |
| `GET /api/playlists/:id` | User | Playlist ID | Playlist plus currently accessible entries. |
| `PATCH /api/playlists/:id` | User | `{name,revision}` | Renames using optimistic concurrency. |
| `DELETE /api/playlists/:id` | User | Playlist ID | Deletes the owned playlist. |
| `POST /api/playlists/:id/items` | User | `{mediaId,position?}` | Adds an accessible track; duplicates are allowed. |
| `PUT /api/playlists/:id/items/order` | User | `{itemIds,revision}` | Reorders every entry atomically. |
| `DELETE /api/playlists/:id/items/:itemId` | User | IDs in path | Removes one exact playlist entry. |

Playlist ownership always comes from the authenticated principal; clients
cannot submit a user ID. Cross-user IDs return 404. A stale revision returns
409, and inaccessible entries remain stored but are omitted until access is
restored.

## Playback markers and Watch Together

| Method and path | Access | Input | Response |
| --- | --- | --- | --- |
| `GET /api/media/:id/playback` | User | Media ID | Active intro/credit markers and the next authorized episode. |
| `PUT /api/media/:id/markers/:type` | Admin | `{enabled,startSeconds?,endSeconds?}` | Creates/corrects or disables `intro`/`credits`. |
| `GET /api/media/:id/markers` | Admin | Media ID | Returns all active/disabled markers and current analysis status for the manual editor. |
| `POST /api/media/:id/markers/analysis` | Admin | Media ID | Queues bounded local chapter analysis, or reports that the item is already queued/running. |
| `GET /api/media/:id/markers/analysis` | Admin | Media ID | Returns queued, running, completed, failed, timed-out, cancelled, or idle status. |
| `POST /api/watch-rooms` | User | `{mediaId,positionSeconds?}` | Creates an ephemeral room and returns its invitation secret. |
| `POST /api/watch-rooms/:id/join` | User | `{inviteToken}` | Joins after independently authorizing the room media. |
| `GET /api/watch-rooms/:id` | Member | None | Reconnect/status snapshot. |
| `GET /api/watch-rooms/:id/ws` | Member | WebSocket upgrade | Streams snapshots, presence, host commands/reports, periodic timeline sync, per-user preferences, and ping/pong. |
| `POST /api/watch-rooms/:id/commands` | Host | `{action,positionSeconds}` | Applies server-authoritative play/pause/seek state. |
| `POST /api/watch-rooms/:id/host-report` | Host | `{revision,positionSeconds,paused}` | Reanchors the current timeline. |
| `PATCH /api/watch-rooms/:id/preferences` | Member | Per-user audio/subtitle indexes | Updates only the caller's track preferences. |
| `POST /api/watch-rooms/:id/leave` | Member | None | Leaves the room. |
| `DELETE /api/watch-rooms/:id` | Host | None | Closes the room. |

Markers are stored against the media ID. Scans compute a bounded,
path-independent content fingerprint and retain that ID across a rename or move
when exactly one missing catalog row matches. Ambiguous duplicate matches are
never guessed. This preserves dependent progress, markers, playlist entries,
and subtitles across unambiguous path changes. Disabled markers are tombstones,
so future detector passes cannot silently recreate an administrator-disabled
range. Watch rooms are intentionally process-local and expire; watch progress
continues to be written separately by each authenticated client.

The default detector reads embedded chapter titles with local `ffprobe`. Scanner
analysis is best-effort and runs through a bounded background queue, so it does
not block or fail a library scan. Configure it with
`CASTER_MARKER_ANALYSIS_CONCURRENCY` (default `1`, maximum `4`),
`CASTER_MARKER_ANALYSIS_QUEUE_CAPACITY` (default `2048`), and
`CASTER_MARKER_ANALYSIS_TIMEOUT_MS` (default `120000`). Manual and disabled
markers take precedence over detector output.

## Direct streaming, HLS, thumbnails, and subtitles

All playback GETs require access to the media's library in protected mode.
Denied and missing IDs share a 404 boundary. Viewer remote streaming can also
be disabled by account permissions.

| Method and path | Input | Response and behavior |
| --- | --- | --- |
| `GET /api/media/:id/download` | Media ID; viewer requires `canDownload` | Downloads the source as an attachment. Denied and missing media both return 404. |
| `DELETE /api/media/:id/file` | `X-Caster-Confirm-Delete: MEDIA_ID`; viewer requires `canDeleteMedia` | Permanently deletes a source only after resolving it inside its configured library root, then removes its catalog row. Missing/denied returns 404 and missing confirmation returns 409. |
| `GET /api/media/:id/stream` | Optional single `Range: bytes=...` header | Full file with 200, or inclusive range with 206. Invalid ranges return 416 and `Content-Range: bytes */SIZE`. |
| `GET /api/media/:id/hls/master.m3u8` | Media ID | Adaptive M3U8 master playlist selected from source height. |
| `GET /api/media/:id/hls/:quality/index.m3u8` | Quality | Six-second-segment variant playlist. |
| `GET /api/media/:id/hls/:quality/:segment` | Exact `segment-N.ts` name | Generates or reads a cached MPEG-TS segment. Can return 429, 500, or 503. |
| `GET /api/media/:id/thumbnail` | Media ID | Generated JPEG or plain-text 404. |
| `GET /api/media/:id/subtitles/:index` | Non-negative stream index | WebVTT from an external SRT or embedded subtitle track. |
| `GET /api/media/:id/cast` | Media ID | Short-lived, media-scoped playback URLs for Cast/AirPlay receivers. |

The web player uses the browser's native remote-playback picker to discover
compatible devices on the local network. In protected mode, the cast endpoint
adds a signed grant to direct, HLS, and subtitle URLs because the receiver does
not inherit the browser login cookie. Grants expire after 12 hours, authorize
only one media item's playback derivatives, and continue to enforce the user's
current account and media access rules. Set `CASTER_CAST_SECRET` to the same
high-entropy value on every replica when Caster runs behind multiple servers.
Read-only requests carrying a valid cast grant may use the receiver runtime's
own HTTP origin; this exception does not apply to any other API resource.

Accepted HLS qualities are `original`, `1080p`, `720p`, `480p`, and `360p`.
The master playlist advertises transcoded resolutions, not `original`.

Direct streaming supports one standard closed, open-ended, or suffix byte range,
for example `bytes=0-1048575`, `bytes=1048576-`, or `bytes=-65536`. Multiple
ranges are not implemented.

Source-file deletion is intentionally a separate, high-risk operation from
catalog/library administration. It requires an authenticated account, media
ACL/content-rating access, the `canDeleteMedia` capability for viewers, CSRF
source validation for cookie sessions, and the exact confirmation header. It
will not follow a catalog path outside the library root.

HLS segment GETs have side effects: they can start FFmpeg, consume a transcode
slot, and write the transcode cache. Protected responses are marked private by
the request-security middleware. The route returns `429` with `Retry-After: 2`
when all transcode slots are occupied.

Use the track indexes from the media item's `streams_json`. A missing media or
external subtitle file returns 404. An external subtitle read failure or an
embedded subtitle extraction failure returns plain-text 500.

Examples:

```sh
curl -sS \
  -H 'Range: bytes=0-1048575' \
  -o ./first-megabyte.bin \
  "$CASTER_URL/api/media/MEDIA_ID/stream"

curl -sS -o ./master.m3u8 \
  "$CASTER_URL/api/media/MEDIA_ID/hls/master.m3u8"

curl -sS -o ./subtitle.vtt \
  "$CASTER_URL/api/media/MEDIA_ID/subtitles/STREAM_INDEX"
```

## Progress mutations

Progress mutations are available to authenticated viewers and administrators
and write only to the current principal's progress owner.

| Method and path | Body | Response |
| --- | --- | --- |
| `POST /api/media/:id/progress` | `{position,duration}` | `{progress}`; position is clamped to duration. |
| `POST /api/media/:id/progress/watched` | None | Marks complete and returns `{progress}`. |
| `POST /api/media/:id/progress/unwatched` | None | Removes progress and returns `{success:true}`. |
| `DELETE /api/media/:id/progress` | None | Removes progress and returns `{success:true}`. |

`position` must be non-negative and `duration` must be greater than zero. JSON
numbers are recommended; finite numeric strings are also currently accepted.

```sh
curl -sS \
  -H "Authorization: Bearer $CASTER_ADMIN_TOKEN" \
  -H 'Content-Type: application/json' \
  --data '{"position":123.5,"duration":7200}' \
  "$CASTER_URL/api/media/MEDIA_ID/progress"
```

## Operator diagnostics and controls

| Method and path | Access | Input | Response and operational effect |
| --- | --- | --- | --- |
| `GET /api/system/status` | Admin | None | `{server,version,platform,arch,uptime,hardware}`. Hardware includes active/max transcode counts and functional QSV, NVENC, and VAAPI support flags. |
| `GET /api/system/transcodes` | Admin | None | `{activeTranscodes,maxConcurrentTranscodes,acceptingTranscodes,sessions}`. Each active session has `{id,mediaId,quality,sequence,startedAt}`. |
| `POST /api/system/hardware/accel` | Admin | `{accel}` | Selects `qsv`, `nvenc`, `vaapi`, or `none` in memory and returns `{success,hardware}`. Consult the functional support flags before selecting a mode. |
| `POST /api/system/transcodes/kill` | Admin | None | Force-kills every active transcode and returns `{success,killed,transcodes}`. |
| `GET /api/system/cache/status` | Admin | None | `{cacheDir,fileCount,totalSizeBytes,totalSizeMb,maxAgeHours,maxSizeMb}`; `cacheDir` is an absolute path. |
| `POST /api/system/cache/clear` | Admin | Optional cleanup thresholds | Runs cache eviction and returns `{success,result}`. |
| `POST /api/media/:id/thumbnail` | Admin | None | Force-regenerates the thumbnail and returns `{success,thumbnailUrl}`. |

The hardware selection is not persisted and is redetected after restart. The
status route exposes aggregate active-transcode counts; the transcodes route
adds current session details. The kill-all response includes the same status
shape after signaling all current sessions. Selecting a named accelerator does
not reject a mode whose support flag is false. If hardware encoding later
fails, Caster demotes the active mode to `none` and retries that segment once on
the CPU.

Cache cleanup accepts an empty body to use configured retention, or a JSON body
with non-negative `maxAgeHours` and/or `maxSizeMb`. Zero can remove all eligible
inactive cache segments. It deletes generated `.ts` cache files, not source
media.

Diagnostic examples:

```sh
curl -sS "$CASTER_URL/health"
curl -sS "$CASTER_URL/api/libraries/scan/status"
curl -sS "$CASTER_URL/api/system/status"
curl -sS "$CASTER_URL/api/system/transcodes"
curl -sS "$CASTER_URL/api/system/cache/status"
```

## Dangerous or disruptive admin operations

Review the target before sending these requests:

- `DELETE /api/libraries/:id` removes the library's catalog records and their
  dependent progress/subtitle records. It does not remove source media.
- Library scan routes can be CPU/I/O intensive and update or remove catalog
  records based on the current filesystem.
- `POST /api/system/transcodes/kill` interrupts every current HLS transcode and
  can cause client playback failures.
- `POST /api/system/cache/clear` deletes eligible generated HLS segments;
  clients can regenerate them later.
- `POST /api/media/:id/thumbnail` overwrites the generated thumbnail.
- `POST /api/system/hardware/accel` changes the active transcoding mode until
  restart or another selection.
- Progress endpoints change or remove admin watch history.

Example kill-all request, intentionally using only placeholders:

```sh
curl -sS -X POST \
  -H "Authorization: Bearer $CASTER_ADMIN_TOKEN" \
  "$CASTER_URL/api/system/transcodes/kill"
```
