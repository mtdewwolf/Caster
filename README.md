# Caster - Personal Media Server for TrueNAS SCALE & Tailscale

A high-performance, self-hosted personal media streaming platform to replace Plex on **TrueNAS SCALE**, accessible from any device over **Tailscale** with **GPU Hardware Acceleration** (Intel QuickSync, Linux VAAPI, NVIDIA NVENC).

---

## ⚡ Quick Start

### 1. Install Dependencies

```bash
bun install
```

### 2. Local Development

```bash
# Required for admin mutations and the login UI
export ADMIN_PASSWORD='replace-with-a-long-password'

# Start backend API & streaming engine (Port 3001)
bun run dev:server

# Start frontend web player (Port 3000)
bun run dev:web
```

On PowerShell, set the password with `$env:ADMIN_PASSWORD = 'replace-with-a-long-password'`.
Browsing and streaming remain available without signing in; all API mutations require an admin session. API clients may instead set `ADMIN_TOKEN` and send it as a Bearer token.

### 3. Run Tests

```bash
bun test
```

### 4. Build Production Assets

```bash
bun run build
```

### Native Android app

The full Jetpack Compose client lives in [`apps/android`](apps/android). It
connects to Caster through the Android device's Tailscale tunnel and includes
native browsing, search, Media3 playback, subtitles, progress sync, and server
controls. See [`apps/android/README.md`](apps/android/README.md) for setup and
build instructions.

---

## 🐳 TrueNAS SCALE & Tailscale Deployment

See the detailed setup guides in `docs/`:

- [TrueNAS SCALE Deployment Guide](docs/TRUENAS_SCALE_SETUP.md)
- [Tailscale Remote Streaming Guide](docs/TAILSCALE_SETUP.md)
- [SQLite Backup and Restore Guide](docs/BACKUP_RESTORE.md)
- [Merge and Release Gates](docs/RELEASE_GATES.md)
- [HTTP API and Diagnostics Reference](docs/API.md)

### Deploy with Docker Compose

```bash
cd docker
export ADMIN_PASSWORD="replace-with-a-long-unique-password"
docker compose up -d
```

In PowerShell, set the same value with
`$env:ADMIN_PASSWORD = "replace-with-a-long-unique-password"` before running
Compose. The deployment intentionally refuses to start without admin
credentials.
