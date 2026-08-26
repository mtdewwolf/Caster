# Caster HTTP API

Caster currently exposes an account-free API. There are no Caster login,
password, cookie-session, bearer-token, profile, invite, or device-pairing
endpoints. Every request uses one shared public household identity.

Keep the service on a trusted private network while authentication is being
designed. `CASTER_TRUSTED_ORIGINS` may contain a comma-separated list of exact
browser origins; this controls CORS only and is not user authentication.

## Conventions

JSON request bodies should use `Content-Type: application/json`. JSON errors
normally have the form:

```json
{"error":"Human-readable message"}
```

`GET /health` is outside `/api` and returns a lightweight health response.
Unknown `/api/*` routes return a JSON 404. Media streams, HLS playlists,
thumbnails, subtitles, and downloads return their respective binary or media
content types.

## Endpoint groups

| Group | Examples | Purpose |
| --- | --- | --- |
| Libraries | `GET /api/libraries`, `POST /api/libraries`, `DELETE /api/libraries/:id` | Manage libraries and scan them. |
| Media | `GET /api/media`, `GET /api/media/:id` | Browse, search, filter, and inspect indexed media. |
| Playback | `GET /api/media/:id/stream`, `/hls/...`, `/subtitles/...` | Direct play and adaptive playback. |
| Progress | `/api/media/:id/progress`, `/api/media/progress` | Read and update the shared household watch history. |
| Metadata | `/api/media/:id/metadata...`, `/api/metadata/providers` | Inspect and manage provider metadata. |
| Markers | `/api/media/:id/markers...` | Read, edit, and analyze intro/credit markers. |
| Playlists | `/api/playlists...` | Create and edit shared playlists. |
| Watch Together | `/api/watch-rooms...` | Create rooms and coordinate playback with an invite fragment. |
| System | `/api/system/status`, `/api/system/transcodes` | Inspect server, hardware, cache, and transcode state. |
| Remote access | `/api/remote-access/status` | Inspect the optional remote-access control plane. |

All API routes are available immediately without account setup. The browser
client sends no Caster credentials. Progress and playlists intentionally use
the shared `public` identity until per-user accounts are implemented again.

## Playback URLs

The media stream and HLS endpoints can be used directly by a compatible client.
The cast helper at `GET /api/media/:id/cast` returns direct public playback
paths for receivers that cannot reuse the browser page. It does not issue or
validate a temporary Caster access token.

Playback selection can use `client`, `connection`, `quality`, `audio`, and
subtitle/capability query parameters. The server chooses direct play, remux,
or transcoding based on the source and the client's declared capabilities.

## Compatibility note

There is no `/api/v1` namespace or formal compatibility guarantee. The
`version` returned by system status is an application version, not an API
version. Clients should pin a tested Caster release or commit until versioning
and a compatibility policy are added.
