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

Open `http://localhost:3000` and complete the one-time owner setup. The chosen
username and salted password hash are stored in the server's local
`data/media.db`; the setup endpoint closes permanently after the first success.
When setup is complete, browsing and streaming require an account;
filesystem, library, scan, and system administration require an admin. API
tokens can be assigned to an existing account through the authenticated account
API. Cross-origin web clients must also list their exact origin in
`CASTER_TRUSTED_ORIGINS`.

With no account credential, only a client connected directly from loopback can
browse or play media. To deliberately run account-free on a private network,
set both `CASTER_OPEN_MODE=true` and an exact IP/CIDR allowlist such as
`CASTER_OPEN_NETWORKS=192.168.0.0/16,100.64.0.0/10`. This exposes the catalog
and playback content to every allowed client; administrative routes remain
locked. Caster prints a prominent startup warning while this mode is active.

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
docker compose up -d
```

Open `http://SERVER_IP:3001` from the host's LAN and claim the server. Accounts
created afterward use owner-issued, expiring, one-use invite links. The data
volume must remain persistent because it contains the database, credential
hashes, invite records, and watch history.
