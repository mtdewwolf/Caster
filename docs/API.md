# Caster HTTP API

This document describes the HTTP routes implemented by the current Caster
server. For deployment and network boundaries, see the
[TrueNAS operations guide](TRUENAS_SCALE_SETUP.md).

> Caster is designed for a trusted LAN or private overlay network. Public GET
> routes expose media, library and filesystem paths, scan errors, platform
> details, and streaming content. Some public GETs can also start expensive
> transcoding work. `ADMIN_PASSWORD` and `ADMIN_TOKEN` protect mutations only;
> they do not make reads private. Direct public-Internet exposure is unsupported.

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

All current GET routes are public. The server middleware protects every POST,
PUT, PATCH, and DELETE route under `/api`, except the login and logout routes.

| Access label | Meaning |
| --- | --- |
| Public | No credential is required. Supplying a valid credential can select the admin progress owner. |
| Login | No prior session is required; a configured admin credential is required in the JSON body. |
| Logout | No credential is required; an optional session cookie is invalidated and cleared. |
| Admin | Requires a valid session cookie or Bearer credential. |

Configure at least one of these server environment variables:

- `ADMIN_PASSWORD`: used by the browser login flow.
- `ADMIN_TOKEN`: recommended for API clients.

If neither is configured, admin mutations return `503`. If credentials are
configured but missing or invalid, mutations return `401` with
`WWW-Authenticate: Bearer`.

The server currently sends permissive CORS headers with `*` as the allowed
origin. Treat this as transport compatibility, not authorization or a privacy
boundary. Browser origin policy does not protect Caster's public reads.

### Cookie sessions

`POST /api/auth/login` accepts either configured credential in a JSON field
named `password` and creates the HTTP-only `caster_admin_session` cookie. The
cookie uses `SameSite=Strict`, lasts up to 12 hours, and is marked `Secure` when
the request URL or first `X-Forwarded-Proto` value is HTTPS. Sessions are held
in server memory, so a server restart invalidates them.

After five failed logins from the same observed address, subsequent attempts in
the 15-minute window return `429` with `Retry-After`. Auth responses use
`Cache-Control: no-store`.

`POST /api/auth/logout` is intentionally callable without a valid credential,
so a browser can clear an expired or otherwise stale session cookie. It does
not create or grant access.

Example with a placeholder credential and a local cookie jar:

```sh
CASTER_URL='http://192.0.2.10:3001'

curl -sS -c ./caster.cookies \
  -H 'Content-Type: application/json' \
  --data '{"password":"REPLACE_WITH_ADMIN_CREDENTIAL"}' \
  "$CASTER_URL/api/auth/login"

curl -sS -b ./caster.cookies "$CASTER_URL/api/auth/session"
```

The cookie jar contains an admin session. Restrict access to it and remove it
when the session is no longer needed.

### Bearer authentication

API clients should send the configured `ADMIN_TOKEN` without first calling the
login route:

```sh
curl -sS \
  -H "Authorization: Bearer $CASTER_ADMIN_TOKEN" \
  "$CASTER_URL/api/auth/session"
```

The current credential matcher also accepts `ADMIN_PASSWORD` as a Bearer
credential, but API clients should use the separately configured token.

Do not put a real token in documentation, URLs, logs, or shell history. Direct
HTTP does not encrypt cookies or Authorization headers; use a trusted private
network or HTTPS.

### Progress owners

Caster currently has two internal progress owners: `admin` and `public`. A
valid cookie or Bearer credential selects `admin`; an anonymous GET selects
`public`. There is no user ID request parameter and no multi-user account API.

Because all progress writes are admin mutations, current authenticated writes
belong to `admin`. Media, series, continue-watching, and progress GET responses
can therefore differ depending on whether the request includes a valid
credential.

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
| `200` | Successful request; create operations also currently use 200. |
| `206` | Valid single-range direct-stream response. |
| `400` | Malformed JSON, invalid query, path parameter, or body value. |
| `401` | Admin credential required or login credential invalid. |
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
| `GET /api/auth/session` | Public | Optional cookie or Bearer header | `{authenticated, configured}`. |
| `POST /api/auth/login` | Login | `{"password":"..."}` | Sets the session cookie and returns `{authenticated:true}`. |
| `POST /api/auth/logout` | Logout | Optional session cookie | Invalidates and clears the cookie, including a stale cookie, and returns `{authenticated:false}`. |

## Filesystem and libraries

These public reads expose absolute server paths. The filesystem browser is not
restricted to configured media roots; it can enumerate directories readable by
the Caster process.

| Method and path | Access | Input | Response and behavior |
| --- | --- | --- | --- |
| `GET /api/fs/browse` | Public | Optional URL-encoded `path` query | `{isRoot,current,parent,entries}`; each entry has `{name,path,hasMedia}`. Omitting `path` returns available roots. |
| `GET /api/fs/suggest` | Public | None | `{suggestions}` with absolute path, inferred library type, media count, and `alreadyAdded`. Performs a bounded filesystem scan. |
| `GET /api/libraries` | Public | None | `{libraries}`; library objects include their absolute host path and item count. |
| `POST /api/libraries` | Admin | `{name,path,type}` | Creates a library and attempts a background scan; returns `{library}`. |
| `DELETE /api/libraries/:id` | Admin | Library ID in path | Returns `{success:true}` even if the ID did not exist. |
| `POST /api/libraries/:id/scan` | Admin | Library ID in path | Starts a background scan; returns `{status:"started",libraryId}`. |
| `POST /api/libraries/scan-all` | Admin | None | Starts a background scan of all libraries; returns `{status:"started"}`. |
| `GET /api/libraries/scan/status` | Public | None | `{isScanning,libraryId,totalFiles,processedFiles,currentFile,errors}`. Errors can contain absolute paths. |

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
| `GET /api/media` | Public | Filters described below | `{items,total}`. |
| `GET /api/media/continue-watching` | Public | None | `{items}` with at most 12 incomplete items for the current progress owner. |
| `GET /api/media/progress` | Public | Optional `status` and `limit` | `{items}` ordered by most recently watched for the current owner. |
| `GET /api/media/:id` | Public | Media ID | `{item}` or 404. |
| `GET /api/series` | Public | Optional `libraryId`, `search` | `{items}` containing series rollups for the current owner. |
| `GET /api/series/:id` | Public | Series ID | `{series,seasons}` or 404. |
| `GET /api/series/:id/episodes` | Public | Series ID | `{series,items}` ordered by season and episode. |

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

Media objects include media metadata, `full_path`, `relative_path`, a serialized
`streams_json` string, and optional owner-specific progress. Treat the response
as sensitive even when source media is mounted read-only.

Example filtered query:

```sh
curl -sS --get \
  --data-urlencode 'search=Example title' \
  --data-urlencode 'sort=year' \
  --data-urlencode 'limit=25' \
  "$CASTER_URL/api/media"
```

## Direct streaming, HLS, thumbnails, and subtitles

All playback GETs are public.

| Method and path | Input | Response and behavior |
| --- | --- | --- |
| `GET /api/media/:id/stream` | Optional single `Range: bytes=...` header | Full file with 200, or inclusive range with 206. Invalid ranges return 416 and `Content-Range: bytes */SIZE`. |
| `GET /api/media/:id/hls/master.m3u8` | Media ID | Adaptive M3U8 master playlist selected from source height. |
| `GET /api/media/:id/hls/:quality/index.m3u8` | Quality | Six-second-segment variant playlist. |
| `GET /api/media/:id/hls/:quality/:segment` | Exact `segment-N.ts` name | Generates or reads a cached MPEG-TS segment. Can return 429, 500, or 503. |
| `GET /api/media/:id/thumbnail` | Media ID | Generated JPEG or plain-text 404. |
| `GET /api/media/:id/subtitles/:index` | Non-negative stream index | WebVTT from an external SRT or embedded subtitle track. |

Accepted HLS qualities are `original`, `1080p`, `720p`, `480p`, and `360p`.
The master playlist advertises transcoded resolutions, not `original`.

Direct streaming supports one standard closed, open-ended, or suffix byte range,
for example `bytes=0-1048575`, `bytes=1048576-`, or `bytes=-65536`. Multiple
ranges are not implemented.

HLS segment GETs have side effects: they can start FFmpeg, consume a transcode
slot, and write the transcode cache. Cached segments use a one-day public cache
header. The route returns `429` with `Retry-After: 2` when all transcode slots
are occupied.

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

All progress mutations are admin-only and write to the `admin` progress owner.

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
| `GET /api/system/status` | Public | None | `{server,version,platform,arch,uptime,hardware}`. Hardware includes active/max transcode counts and functional QSV, NVENC, and VAAPI support flags. |
| `GET /api/system/transcodes` | Public | None | `{activeTranscodes,maxConcurrentTranscodes,acceptingTranscodes,sessions}`. Each active session has `{id,mediaId,quality,sequence,startedAt}`. |
| `POST /api/system/hardware/accel` | Admin | `{accel}` | Selects `qsv`, `nvenc`, `vaapi`, or `none` in memory and returns `{success,hardware}`. Consult the functional support flags before selecting a mode. |
| `POST /api/system/transcodes/kill` | Admin | None | Force-kills every active transcode and returns `{success,killed,transcodes}`. |
| `GET /api/system/cache/status` | Public | None | `{cacheDir,fileCount,totalSizeBytes,totalSizeMb,maxAgeHours,maxSizeMb}`; `cacheDir` is an absolute path. |
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
