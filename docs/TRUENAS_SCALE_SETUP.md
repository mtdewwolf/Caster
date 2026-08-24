# TrueNAS SCALE / Community Edition operations guide

This guide deploys Caster as a TrueNAS-managed custom application on a trusted
LAN. It covers installation, storage permissions, GPU access, validation,
updates, rollback, and recovery handoffs.

Caster does not require Tailscale, TrueNAS Connect, a hosted database, or any
other hosted service while it is running. The browser connects directly to the
TrueNAS LAN address. Internet access is needed only when downloading source and
building the container image. Remote access is optional; see
[TAILSCALE_SETUP.md](TAILSCALE_SETUP.md).

> Caster read endpoints, including browsing and streaming, are intentionally
> available without a login. Administrative changes require the configured
> password or token. Keep port `3001` on a trusted LAN or VLAN and do not expose
> it directly to the public internet.

## Supported TrueNAS deployment path

This guide was last checked against the TrueNAS documentation on 2026-08-23.
TrueNAS 25.10 is the current stable documentation line; TrueNAS 26 is still an
early-release line and is not the production target for this guide.

| TrueNAS release | Applications backend | Caster deployment path |
| --- | --- | --- |
| 25.10, 25.04, and 24.10 | Native Docker-based Apps | Use **Apps > Discover > three-dot menu > Install via YAML** as described below. |
| 24.04 and earlier | Legacy Kubernetes-based Apps | Docker Compose YAML is not a native Apps deployment. Upgrade along a supported TrueNAS upgrade path, then redeploy Caster on 24.10 or later. |

"Native" in this table describes the Apps backend, not the release's current
security-support status. Operate on a production TrueNAS release that is still
in its supported lifecycle; do not remain on 24.10 merely because it can parse
this Compose file.

TrueNAS 24.10 introduced the Docker-based Apps backend and the Compose YAML
editor. Do not manually install Docker on 24.04 or earlier; TrueNAS documents
that a manual Docker installation can conflict with the native Apps service
after an upgrade. Systems that remained on 24.04 past the automatic migration
window must redeploy custom applications after upgrading.

Use the TrueNAS web UI (or its documented API) to create and manage the app.
Running `docker compose up` directly in the TrueNAS shell creates a second,
out-of-band management path and is not the supported procedure in this guide.
Shell commands below are read-only diagnostics unless explicitly stated.

## Example storage layout

Replace `tank` with the actual pool name everywhere in this guide.

| Purpose | TrueNAS path | Container path | Required access |
| --- | --- | --- | --- |
| Versioned Caster source | `/mnt/tank/appdata/caster/source/RELEASE_ID` | Build context only | Administrator write; Docker build read |
| Database, thumbnails, and transcode cache | `/mnt/tank/appdata/caster/data` | `/app/data` | Caster read/write |
| Existing media library | `/mnt/tank/media` | `/media` | Caster read-only |

Create separate datasets before installing Caster:

1. In **Apps > Configuration**, choose an Apps pool if one is not already set.
2. In **Datasets**, create `tank/appdata/caster/data` with the **Apps** preset.
3. Create `tank/appdata/caster/source` with the **Generic** preset when it is not
   shared over SMB. If SMB is the approved transfer method, use the **SMB**
   preset and configure its NFSv4 ACL instead; TrueNAS does not recommend POSIX
   ACLs for SMB. Store each release in a separate directory below it so an
   older build remains reproducible.
4. Use an existing media dataset or create `tank/media`. Media can remain an SMB
   dataset; do not change its ACL type merely for Caster.

Do not use the pool root as an application host path. Separate datasets make
snapshots, replication, quotas, and recovery boundaries explicit.

Keep the source dataset readable/traversable by the TrueNAS Apps build service
and writable by the administrator who stages releases. The runtime `caster`
identity does not need source-dataset write access.

## Create the runtime identity and ACLs

Caster supports Compose's numeric `user` setting. It does **not** interpret
`PUID` or `PGID` environment variables.

1. Go to **Credentials > Users > Add** and create a service account named
   `caster`.
2. Use a UID of `3000` or greater that is unused on this system. Allow TrueNAS
   to create its primary group and record both the UID and GID. The examples
   below use `3000:3000`; replace both numbers if TrueNAS assigned different
   values.
3. Disable password login, use `/var/empty` as the home directory, and select a
   non-login shell. Caster does not need a TrueNAS login.
4. In the **Permissions** editor for the data dataset, add the `caster` user (or
   its primary group) with **Modify** access and inheritance. Caster must create,
   rename, and delete its SQLite sidecars, thumbnails, backups, and cache files.
5. On the media dataset, add `caster` with **Read** plus traverse/execute access
   and inheritance. Do not grant Modify, Delete, or Full Control solely for
   Caster.
6. Ensure every parent dataset in both paths allows the identity to traverse it.

The Compose configuration also marks `/media` read-only. This bind-mount flag is
the final enforcement boundary even if a shared-media ACL is later broadened.

> Take a ZFS snapshot before applying a new ACL recursively to an existing media
> tree. TrueNAS warns that recursive ACL changes can be destructive. Preserve
> the existing SMB/NFS ACL design and add the minimum Caster entry instead of
> replacing the ACL preset.

You can confirm the IDs from the TrueNAS shell without changing the system:

```sh
id caster
```

## Stage an immutable source release

On an administrator workstation, check out a tag or commit and record the full
commit ID:

```sh
git clone https://github.com/mtdewwolf/Caster.git
git -C Caster fetch --tags
git -C Caster checkout --detach TAG_OR_COMMIT
git -C Caster rev-parse HEAD
```

Copy that checkout through an authenticated share configured for the source
dataset, SFTP, or another approved file-transfer method to a versioned directory
such as:

```text
/mnt/tank/appdata/caster/source/r42-a1b2c3d
```

Do not replace a working release directory in place. The source checkout is
needed only to build the image and can be replicated with the app configuration.
Do not store the administrator password in the checkout.

## Install through the TrueNAS Compose editor

In **Apps > Discover**, open the overflow menu beside **Custom App**, select
**Install via YAML**, and use `caster` as the application name. TrueNAS performs
basic YAML validation but does not validate every Compose option, path, or
permission before deployment.

Paste the following configuration after making all of these replacements:

- Replace both occurrences of `REPLACE_WITH_RELEASE_ID` with the versioned
  source directory name.
- Replace `3000:3000` with the recorded Caster UID and GID.
- Replace all `/mnt/tank/...` paths with this system's dataset paths.
- Replace the password and timezone. Keep the password out of source control.

```yaml
services:
  caster:
    build:
      context: /mnt/tank/appdata/caster/source/REPLACE_WITH_RELEASE_ID
      dockerfile: /mnt/tank/appdata/caster/source/REPLACE_WITH_RELEASE_ID/docker/Dockerfile
    image: caster-local:REPLACE_WITH_RELEASE_ID
    user: "3000:3000"
    restart: unless-stopped
    ports:
      - "3001:3001"
    environment:
      PORT: "3001"
      HOST: "0.0.0.0"
      MEDIA_DATA_DIR: /app/data
      THUMBNAILS_DIR: /app/data/thumbnails
      TRANSCODE_CACHE_DIR: /app/data/transcode_cache
      TRANSCODE_MAX_CONCURRENT: "2"
      TRANSCODE_CACHE_MAX_AGE_HOURS: "24"
      TRANSCODE_CACHE_MAX_SIZE_MB: "10000"
      ADMIN_PASSWORD: "REPLACE_WITH_A_LONG_UNIQUE_PASSWORD"
      TZ: America/Denver
    volumes:
      - type: bind
        source: /mnt/tank/appdata/caster/data
        target: /app/data
      - type: bind
        source: /mnt/tank/media
        target: /media
        read_only: true
```

This CPU-only configuration is the safest first deployment. Add exactly the GPU
configuration required by the hardware after the health and permission checks
pass.

Click **Save** and follow deployment progress under **Apps > Installed**. The
first build downloads base images and packages and can take several minutes.
Use **Workloads > View Logs** if deployment fails.

## Validate the base deployment

From a LAN client or the TrueNAS shell:

```sh
curl -fsS http://TRUENAS_LAN_IP:3001/health
curl -fsS http://TRUENAS_LAN_IP:3001/api/system/status
```

The health response should contain `"status":"ok"`. Then open:

```text
http://TRUENAS_LAN_IP:3001
```

In the TrueNAS Caster workload shell, verify the runtime identity and mounts:

```sh
id
test -w /app/data && echo "app data is writable" || echo "ERROR: app data is not writable"
test -r /media && echo "media is readable" || echo "ERROR: media is not readable"
test ! -w /media && echo "media is read-only" || echo "ERROR: media appears writable"
```

Also open the TrueNAS **Volume Mounts** view and confirm `/media` is marked
read-only. If the service repeatedly restarts, check data-dataset ACLs and the
numeric `user` value before granting broader permissions or using privileged
mode.

Sign in with `ADMIN_PASSWORD`, open **Settings**, and add libraries by their
container paths, for example `/media/movies`, `/media/tv`, or `/media/music`.
Never enter the host path `/mnt/tank/media` in Caster.

## Intel and AMD GPU access

Intel Quick Sync and AMD VAAPI use Linux DRM devices under `/dev/dri`. First
confirm that TrueNAS detects character devices and record their actual numeric
group IDs:

```sh
ls -ln /dev/dri
find /dev/dri -maxdepth 1 -type c -exec stat -c '%n uid=%u gid=%g mode=%a' {} \;
```

Edit the Caster YAML in TrueNAS and add the following at the same indentation as
`volumes`. Replace the group placeholders with the GIDs shown for the render and
card devices. If both devices use one group, include it only once.

```yaml
    devices:
      - /dev/dri:/dev/dri
    group_add:
      - "RENDER_GID"
      - "VIDEO_GID"
```

Save the app, then use its workload shell to verify access:

```sh
id
ls -ln /dev/dri
vainfo --display drm --device /dev/dri/renderD128
ffmpeg -hide_banner -encoders | grep -E 'qsv|vaapi'
```

In Caster **Settings > Hardware Transcoding**, select:

- **Intel QSV** for a supported Intel GPU; use VAAPI as a fallback if the Intel
  driver does not expose QSV correctly.
- **VAAPI** for AMD.

An encoder appearing in `ffmpeg -encoders` only proves that FFmpeg was compiled
with that encoder. Caster performs a functional encode probe before reporting a
hardware mode as available. Still validate the complete path by forcing a short
transcoded playback and checking the Caster logs for errors.

## NVIDIA GPU access

On TrueNAS 25.10, open **Apps > Configuration > Settings** and enable
**Install NVIDIA Drivers**. Follow the UI prompts, then verify on the TrueNAS
host:

```sh
nvidia-smi
```

TrueNAS 25.10 uses NVIDIA open kernel modules and supports Turing-generation and
newer GPUs for Apps. Pascal, Maxwell, and Volta devices are not compatible with
that 25.10 driver path; do not upgrade a working older installation until GPU
compatibility and a fallback plan are confirmed.

Add these two variables inside the existing `environment` mapping. YAML must
not contain a second `environment` key.

```yaml
      NVIDIA_VISIBLE_DEVICES: all
      NVIDIA_DRIVER_CAPABILITIES: compute,video,utility
```

Then add the reservation at the same indentation as `environment` and
`volumes`:

```yaml
    deploy:
      resources:
        reservations:
          devices:
            - driver: nvidia
              count: all
              capabilities: [gpu]
```

Save the app and verify in its workload shell:

```sh
nvidia-smi
ffmpeg -hide_banner -encoders | grep nvenc
```

Select **NVIDIA NVENC** in Caster and validate a transcoded playback. If the GPU
is missing, confirm the TrueNAS driver is installed, the GPU is not isolated or
assigned exclusively to a VM, and the Compose block is nested under the Caster
service. Do not enable privileged mode merely to obtain GPU access.

## Backups and restore

Follow [BACKUP_RESTORE.md](BACKUP_RESTORE.md) for consistent SQLite backup,
integrity validation, retention, and restore commands. In addition:

From the running Caster workload shell, the TrueNAS paths corresponding to the
guide's generic backup example are:

```sh
cd /app/apps/server
bun run src/db/backup.ts backup \
  --database /app/data/media.db \
  --destination /app/data/backups \
  --retention 7
```

The backup command can run while Caster is serving clients. The final restore
promotion still requires stopping the Caster app as described in the restore
guide.

- Replicate Caster database backups off the TrueNAS system. A snapshot on the
  same pool is useful for rollback but is not an independent backup.
- Snapshot and replicate `tank/appdata/caster/data` according to the site's
  recovery objectives. Create the Caster SQLite backup first, or stop Caster
  before taking a filesystem-only snapshot of the live database.
- Keep the Compose YAML, release/commit ID, UID/GID, GPU GIDs, and password or
  token in the administrator's protected configuration records.
- Export the TrueNAS system configuration, including the password secret seed,
  to protected external storage. This configuration export does not contain the
  Caster host-path dataset.
- Back up source only if keeping the exact checkout is operationally useful;
  source can otherwise be recovered from the recorded immutable commit.

## Update and rollback Caster

Use immutable source directories and image tags so an update never destroys the
known-good deployment.

1. Create and validate a Caster database backup as described in
   [BACKUP_RESTORE.md](BACKUP_RESTORE.md). Optionally snapshot the app-data
   dataset after the consistent backup exists.
2. Stage the new tag or commit in a new source directory and record its full
   commit ID.
3. In **Apps > Installed > Caster > Edit**, change both build paths and the
   `image` tag to the new release ID. Do not use `latest`.
4. Save and wait for Caster to return to the Running state.
5. Verify `/health`, admin login, a library scan, direct playback, a forced
   transcode, subtitles, and write progress before removing any prior image or
   source directory.

To roll back application code, edit the YAML back to the prior build paths and
image tag. If the failed release migrated or changed the database, follow the
database restore procedure before starting the older version.

TrueNAS can offer an app **Roll Back** action, but TrueNAS explicitly states
that app rollback snapshots do not roll back mounted host paths. Caster stores
its database in the `/app/data` host path, so the Caster backup is the database
rollback authority.

## Update and roll back TrueNAS

Before a TrueNAS update:

1. Read the release notes and supported upgrade path, especially GPU driver and
   Apps migration notes.
2. Create and copy off a Caster backup, snapshot/replicate the app-data dataset,
   and export the TrueNAS configuration with its password secret seed.
3. Record the current TrueNAS version, Caster release ID, Compose YAML, and GPU
   configuration.
4. Update from the TrueNAS **System > Update** UI during a maintenance window.
   Do not use `apt` or modify the TrueNAS base operating system.
5. After reboot, validate storage health, Caster health, permissions, direct
   playback, and hardware transcoding.

TrueNAS creates a boot environment during an operating-system update. If the
new OS fails, go to **System > Boot**, activate the prior boot environment, and
reboot. A boot environment restores the TrueNAS boot pool only; it does not
restore application host-path data or reverse a Caster database migration. Use
the Caster backup and ZFS dataset snapshots for those layers.

Delay optional ZFS pool feature upgrades until the new TrueNAS release has been
accepted. A pool feature upgrade can prevent an older TrueNAS boot environment
from importing the pool.

## Diagnostics checklist

Use this order before changing permissions or redeploying:

1. **App state:** Apps > Installed must show Caster as Running.
2. **Logs:** Open **Workloads > View Logs** and capture the first error, not only
   the final restart message.
3. **Health:** `curl -fsS http://TRUENAS_LAN_IP:3001/health`.
4. **Identity:** In the workload shell, `id` must show the UID/GID from YAML.
5. **Storage:** `/app/data` must be writable; `/media` must be readable and not
   writable. Confirm the host paths in **Volume Mounts**.
6. **Capacity:** Check pool free space and dataset quotas. SQLite, thumbnails,
   and the transcode cache all use the app-data dataset.
7. **GPU:** Check the device inside the workload, then perform a real transcode.
   Caster probes an actual encode at startup. If a later hardware operation
   fails, it logs the failure, demotes the active mode to CPU, and retries that
   segment once; use that log to distinguish fallback from a playback failure.
8. **LAN:** Confirm another LAN client can reach the TrueNAS address and that no
   other service owns host port `3001`.

Common failure patterns:

| Symptom | First checks |
| --- | --- |
| Deployment fails during build | Source and Dockerfile absolute paths, internet/DNS access, pool free space, first build error in logs |
| Restart loop with SQLite or `EACCES` error | Numeric `user`, data ACL inheritance, parent-dataset traverse access, data-dataset capacity |
| Library is empty or scan reports permission errors | Use `/media/...` inside Caster, media Read/traverse ACL, correct host bind path |
| Media can be changed from the workload | Stop Caster and restore `read_only: true` before resuming service |
| GPU appears supported but transcoding fails | Device/driver visibility, numeric supplementary GIDs, selected accelerator, real transcode log |
| App rollback did not restore the database | Host paths are excluded from TrueNAS app rollback; use the Caster restore guide |

## Official TrueNAS references

- [TrueNAS 25.10 stable documentation](https://www.truenas.com/docs/scale/25.10/)
- [Installing custom applications](https://apps.truenas.com/managing-apps/installing-custom-apps/)
- [TrueNAS 25.10 Custom App screens](https://www.truenas.com/docs/scale/25.10/scaleuireference/apps/installcustomappscreens/)
- [TrueNAS 25.10 Apps management, GPU drivers, logs, and app rollback](https://www.truenas.com/docs/scale/25.10/scaleuireference/apps/)
- [Managing TrueNAS users](https://www.truenas.com/docs/scale/25.10/scaletutorials/credentials/manageusers/)
- [Configuring dataset ACL permissions](https://www.truenas.com/docs/scale/25.10/scaletutorials/datasets/permissionsscale/)
- [Updating TrueNAS](https://www.truenas.com/docs/scale/25.10/scaletutorials/systemsettings/updatescale/)
- [Managing boot environments](https://www.truenas.com/docs/scale/25.10/scaletutorials/systemsettings/managebootenvironscale/)
- [TrueNAS shell support boundary](https://www.truenas.com/docs/scale/25.10/scaletutorials/systemsettings/usescaleshell/)
- [TrueNAS 24.10 Apps migration notes](https://www.truenas.com/docs/scale/24.10/printview/)
- [TrueNAS 25.10 NVIDIA GPU support notes](https://www.truenas.com/docs/scale/25.10/gettingstarted/scalereleasenotes/)
