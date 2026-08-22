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
# Start backend API & streaming engine (Port 3001)
bun run dev:server

# Start frontend web player (Port 3000)
bun run dev:web
```

### 3. Run Tests
```bash
bun test
```

### 4. Build Production Assets
```bash
bun run build
```

---

## 🐳 TrueNAS SCALE & Tailscale Deployment

See the detailed setup guides in `docs/`:
- [TrueNAS SCALE Deployment Guide](docs/TRUENAS_SCALE_SETUP.md)
- [Tailscale Remote Streaming Guide](docs/TAILSCALE_SETUP.md)

### Deploy with Docker Compose
```bash
cd docker
docker compose up -d
```
