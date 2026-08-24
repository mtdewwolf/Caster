# Caster for Android

Native Android client for the Caster personal media server. The app uses
Jetpack Compose, Material 3, Media3/ExoPlayer, and Caster's existing HTTP API.

## Remote access through Tailscale

1. Install and connect the official Tailscale Android app to the same tailnet
   as the Caster server.
2. Open Caster for Android and enter one of:
   - `100.x.y.z:3001`
   - `caster-nas:3001` (MagicDNS)
   - `https://caster-nas.your-tailnet.ts.net` (Tailscale Serve)
3. Optionally enter the server's `ADMIN_TOKEN`. Browsing and playback are
   public on Caster's trusted-network API, while progress sync and server
   controls require admin authentication.

The app does not embed Tailscale or handle Tailscale auth keys. Android routes
Caster traffic through the device-level WireGuard tunnel established by the
official Tailscale app. The admin token is encrypted with Android Keystore and
excluded from backups.

## Features

- Connection test and read-only/admin mode detection
- Home, libraries, recently added media, continue watching, and series
- Debounced catalog search
- Media details and technical metadata
- Native Media3 HLS/direct playback with selectable WebVTT subtitles
- Resume playback and periodic progress sync
- Watch history and watched/unwatched actions
- Server health, scan progress, library totals, and hardware acceleration
- Adaptive bottom navigation/navigation rail for phones, tablets, and foldables

## Build

Requirements: JDK 17 and Android SDK 36.

```powershell
cd apps/android
.\gradlew.bat assembleDebug
```

The debug APK is written to `app/build/outputs/apk/debug/app-debug.apk`.
Run unit tests with `.\gradlew.bat testDebugUnitTest`.
