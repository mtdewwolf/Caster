# Tailscale Remote Access Guide for Caster on TrueNAS SCALE

This guide explains how to stream your media securely from anywhere in the world over **Tailscale** with **zero port forwarding**, zero exposure to the public internet, and end-to-end WireGuard encryption.

---

## 1. How Tailscale Works with Caster

Instead of opening ports (like port 32400 in Plex) on your home router and risking security vulnerabilities, Tailscale creates a private peer-to-peer mesh network (Tailnet).

Your TrueNAS SCALE media server and your client devices (phone, laptop, TV) connect directly using authenticated WireGuard tunnels:

```
[Phone / Laptop / Apple TV]  <--- Tailscale WireGuard --->  [TrueNAS SCALE : 3001]
```

---

## 2. Choosing Your Tailscale Setup Method

### Method A: Host-Level Tailscale on TrueNAS (Recommended & Simplest)

If you already have Tailscale running directly on your TrueNAS SCALE host:

1. Verify Tailscale is running on TrueNAS:
   ```bash
   tailscale status
   ```
2. Note your TrueNAS Tailscale IP (e.g. `100.x.y.z`) or MagicDNS name (e.g. `truenas-nas`).
3. Deploy Caster through the supported TrueNAS Apps procedure in
   [TRUENAS_SCALE_SETUP.md](TRUENAS_SCALE_SETUP.md). Tailscale remains a
   separate host service; Caster itself still runs on the LAN.
4. Any device connected to your Tailscale network can immediately stream by opening:
   ```text
   http://100.x.y.z:3001
   or
   http://truenas-nas:3001
   ```

For a first Docker test on a host where Tailscale is already active, publish
Caster normally on the host network:

```bash
cd docker
CASTER_MEDIA_PATH=/mnt/tank/media docker compose -f docker-compose.test.yml up -d --build
curl -fsS http://127.0.0.1:3001/health
```

Then verify `http://<truenas-tailscale-ip>:3001/health` from a second tailnet
device. Do not run the sidecar configuration at the same time as host-level
Tailscale.

---

### Method B: Tailscale Container Sidecar (`docker-compose.tailscale.yml`)

If you want an isolated Tailscale container dedicated to Caster on a
standalone Docker host, use this method. Do not use shell-managed Compose as a
second application manager on TrueNAS; use the TrueNAS Apps workflow above.

1. Create a Tailscale Auth Key at [Tailscale Admin Console](https://login.tailscale.com/admin/settings/keys):
   - Check **Reusable** and **Ephemeral** (optional, recommended for containers).
2. On the Docker host, set the Tailscale auth key and run:
   ```bash
   export TS_AUTHKEY="tskey-auth-xxxxxx-xxxxxxxx"
   docker compose -f docker-compose.tailscale.yml up -d
   ```
3. The server will appear on your Tailscale admin console as `caster-nas`.
4. Access the server from any tailnet device at:
   ```text
   http://caster-nas:3001
   ```
5. Open Caster and add libraries using their container paths. Caster currently
   runs account-free, so keep access restricted to trusted LAN and tailnet
   devices.

---

### Method C: Enabling HTTPS with Tailscale Serve

Tailscale Serve automatically generates valid Let's Encrypt TLS certificates for your tailnet machine name:

1. In TrueNAS shell (or inside the tailscale container), run:
   ```bash
   tailscale serve --bg 3001
   ```
2. You can now stream with full HTTPS encryption:
   ```text
   https://truenas-nas.your-tailnet.ts.net
   ```

---

## 3. Streaming on Client Devices

### 📱 iOS & Android (iPhone, iPad, Android Phones)
1. Install the **Tailscale** app from the App Store / Google Play Store and sign in.
2. Open Safari / Chrome and visit `http://<tailscale-name>:3001`.
3. *(Optional)* Tap **Share** > **Add to Home Screen** on iOS to install Caster as a standalone Fullscreen App (PWA).

### 📺 Apple TV (tvOS)
1. Install the official **Tailscale** app on your Apple TV from the tvOS App Store.
2. Sign in and connect to your tailnet.
3. Use a web browser app or cast from your iPhone/iPad directly to the Apple TV.

### 📺 Android TV / Google TV / Fire TV
1. Install the **Tailscale** app from the Google Play Store (or sideload on Fire TV).
2. Enable Tailscale connection.
3. Open the browser or TV client and connect to `http://<tailscale-ip>:3001`.

### 💻 Mac, Windows, Linux
1. Run the Tailscale desktop client.
2. Open any browser to `http://<tailscale-name>:3001` or your Tailscale Serve HTTPS URL.
