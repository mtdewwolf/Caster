# Caster - Personal Media Server for TrueNAS SCALE & Tailscale

A high-performance, self-hosted personal media streaming platform to replace Plex on **TrueNAS SCALE**, accessible from any device over **Tailscale** with **GPU Hardware Acceleration** (Intel QuickSync, Linux VAAPI, NVIDIA NVENC).

The web player can hand video to compatible network playback targets through
the browser's native Cast/Remote Playback or AirPlay picker. The receiver must
be able to reach the same Caster URL used in the browser; protected servers use
short-lived, media-scoped playback grants automatically.

---

## ⚡ Quick Start

### 1. Install Dependencies

```bash
bun install
```

### 2. Local Development

```bash
# Start backend API & streaming engine (Port 3001)
bun run dev:server

# Start frontend web player (Port 3000)
bun run dev:web
```

Open `http://localhost:3000`. Caster currently runs account-free: there is no
login, setup wizard, password, session, profile, or API-token requirement.
Every client uses the shared public household identity, so catalog, playback,
progress, scanning, and server controls are available immediately. Keep the
server on a trusted private network while authentication is being designed.

Cross-origin web clients must list their exact origin in
`CASTER_TRUSTED_ORIGINS`. This is an origin policy for browser requests, not a
user authentication system.

Reverse-proxy forwarding headers are ignored unless the immediate proxy is in
`CASTER_TRUSTED_PROXIES` (exact IP or IPv4/IPv6 CIDR). For example, use
`CASTER_TRUSTED_PROXIES=172.20.0.0/16` for a dedicated container proxy network.
Do not add client networks or broad catch-all CIDRs to the trusted-proxy list.

### 3. Run Tests

```bash
bun test
```

### 4. Build Production Assets

```bash
bun run build
```

### Native Android app

The Jetpack Compose client is maintained in the standalone
[Caster-Android repository](https://github.com/mtdewwolf/Caster-Android). It
connects to Caster through the Android device's Tailscale tunnel and includes
native browsing, search, Media3 playback, subtitles, progress sync, and server
controls. See the Android repository for setup and build instructions.

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
docker compose up -d
```

Open `http://SERVER_IP:3001` from the host's LAN. No account claim or credential
setup is required. The data volume must remain persistent because it contains
the database and watch history.
