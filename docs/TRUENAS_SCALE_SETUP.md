# Deploying NovaStream Media Server on TrueNAS SCALE

This guide walks you through deploying **NovaStream** on **TrueNAS SCALE** (supporting TrueNAS SCALE 24.10+ *Electric Eel* with native Docker Compose, and 24.04 *Dragonfish*).

---

## 1. Prerequisites & ZFS Dataset Setup

Before launching the container, create persistent datasets for your media and server data on your TrueNAS ZFS pool:

1. In TrueNAS SCALE UI, navigate to **Datasets**.
2. Select your pool (e.g. `tank` or `pool1`) and click **Add Dataset**:
   - **Media Dataset**: Name it `media` (e.g., `/mnt/tank/media`)
     - Subfolders: `/mnt/tank/media/movies`, `/mnt/tank/media/tv`, `/mnt/tank/media/music`
   - **AppData Dataset**: Name it `appdata/novastream` (e.g., `/mnt/tank/appdata/novastream/data`)
3. Set appropriate permissions on the dataset (Read/Write for AppData, Read for Media).

---

## 2. Hardware Acceleration Configuration (Intel / AMD / NVIDIA)

### For Intel QuickSync (iGPU) & AMD VAAPI (Recommended)
TrueNAS SCALE includes Intel and AMD GPU drivers in the base kernel. Ensure your user/container has access to the render group:

1. In TrueNAS SCALE shell, check that `/dev/dri` exists:
   ```bash
   ls -l /dev/dri
   # You should see 'card0' and 'renderD128'
   ```
2. Note the group ID for `render` (usually `107` or `44` on Debian):
   ```bash
   getent group render
   ```

### For NVIDIA Discrete GPUs
If your TrueNAS SCALE server has an NVIDIA GPU:
1. In TrueNAS SCALE UI, go to **Apps** > **Configuration** > **Settings** and ensure NVIDIA GPU support is enabled.
2. In `docker-compose.yml`, uncomment the NVIDIA reservation block.

---

## 3. Deploying via TrueNAS SCALE 24.10 (Electric Eel / Native Docker Compose)

TrueNAS SCALE 24.10 (*Electric Eel*) supports native Docker Compose:

1. SSH into your TrueNAS SCALE server or open the Web Shell.
2. Create a project directory:
   ```bash
   mkdir -p /mnt/tank/appdata/novastream
   cd /mnt/tank/appdata/novastream
   ```
3. Copy the `docker-compose.yml` file to `/mnt/tank/appdata/novastream/docker-compose.yml`.
4. Adjust volume mount paths to match your ZFS pool name (e.g., replace `/mnt/tank/` with your pool path).
5. Start the media server:
   ```bash
   docker compose up -d
   ```
6. Access the Web Player in your browser:
   ```text
   http://<YOUR-TRUENAS-IP>:3001
   ```

---

## 4. Deploying via TrueNAS SCALE 24.04 (Dragonfish Custom App / Portainer)

If you are using TrueNAS SCALE 24.04 (*Dragonfish*):

1. Open **Apps** > **Discover Apps** > **Custom App** (or use **Dockge** / **Portainer**).
2. Set **Application Name**: `novastream`
3. Set **Image repository**: `novastream` or your custom registry image.
4. **Port Forwarding**:
   - Container Port: `3001`
   - Node Port: `3001` (or desired host port)
5. **Storage / Host Path Volumes**:
   - Mount 1: Host Path `/mnt/tank/appdata/novastream/data` -> Container Path `/app/data`
   - Mount 2: Host Path `/mnt/tank/media` -> Container Path `/media` (Read-Only)
6. **GPU Configuration**:
   - Check **GPU Resource (Intel / NVIDIA)** or pass `/dev/dri` device.
7. Click **Install**.

---

## 5. Initial Server Setup & First Scan

1. Open `http://<TRUENAS-IP>:3001` in your browser.
2. Click the ⚙️ **Settings** icon in the top navigation bar.
3. Under **Media Libraries**, click **Add TrueNAS Media Folder**:
   - **Name**: e.g., `Movies 4K`
   - **Path**: `/media/movies`
   - **Type**: `Movies`
4. Click **Add Library**. NovaStream will automatically scan the folder, extract metadata, generate posters, and index video streams.
5. Under **Hardware Transcoding**, verify that your hardware accelerator (Intel QSV, VAAPI, or NVENC) is active.
