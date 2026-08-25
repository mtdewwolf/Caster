# Native clients roadmap (WP-F/G)

Design for issue #34 [EPIC] Remote Access, Device Pairing & Native Clients — status: draft

This document defines the 10-foot (TV) UX requirements for Android TV and Fire
TV, then the rollout order for other native platforms. It consumes the
contract in [CLIENT_API_CONTRACT.md](CLIENT_API_CONTRACT.md), device pairing
from Device Registry & Pairing (issue #34 WP-D), remote connectivity from
[REMOTE_ACCESS_CONTROL_PLANE.md](REMOTE_ACCESS_CONTROL_PLANE.md), and offline
playback from [OFFLINE_DOWNLOADS.md](OFFLINE_DOWNLOADS.md).

## Goals

- Every primary flow on TV reachable with a D-pad only — no touch, mouse, or
  keyboard required at any point.
- One shared client core (API, auth, playback engine glue) across platforms;
  platform teams own only shell, navigation chrome, and store integration.

## Non-goals for v1

- Casting from TV, live TV/DVR, keyboard-driven desktop-class settings
  editing, multi-user simultaneous streams beyond current server limits.

## Android TV / Fire TV 10-foot requirements (WP-F)

### Platform constraints

- Target Android TV (API level per current leanback guidance) and Fire TV
  (which is a leanback-compatible fork; one APK where feasible).
- Leanback-style layouts: oversized text/tiles, safe-area margins for
  overscanned panels, focus states always visible.
- No assumption of a touch screen; remote buttons are: D-pad (4 directions +
  select), Back, Home, Play/Pause, and optionally media skip +/- keys.

### D-pad / focus navigation rules

1. Focus is always visible: every interactive element has a distinct focused
   state (scale + border), minimum contrast per 10-foot guidelines.
2. Directional navigation must be deterministic: pressing the same direction
   twice in the same context always lands on the same element.
3. Back never exits the app from Home; Back moves up one hierarchy level,
   dismissing overlays first, then dialogs, then screens.
4. Long horizontal rows wrap focus to adjacent rows on up/down; rows scroll
   so the focused item is always fully visible (no partial occlusion).
5. Select activates; long-press select opens the item context menu (Play,
   Mark watched, Download, Details).
6. Text entry uses the system leanback keyboard via voice search where the
   platform provides it; manual entry must still be possible without voice.
7. Playback screen: D-pad left/right = seek ±10 s, up/down = open quick
   settings row (quality, audio track, subtitle track), select = play/pause.

### Primary flows

| Flow | Requirements |
| --- | --- |
| First-run pairing | Show QR/code (WP-D) full-screen; poll until approved; no keyboard needed unless fallback manual code entry is chosen. |
| Profile selection | Grid of profile cards on launch when multiple profiles exist; PIN entry via on-screen number pad; "remember last" default. |
| Home | Continue-watching row, recently added row, library shortcuts; all content above the fold reachable within ≤ 3 D-pad presses from app open. |
| Libraries | Poster grid per library with pagination by continuous scrolling; details screen shows metadata, resume position, play button pre-focused. |
| Search | Voice-first where available, leanback text entry otherwise; results across libraries in one list; searching respects the active user's ACLs. |
| Playback controls | Play/pause, seek bar with chapter markers (intro/credits from existing marker data), next/previous episode where applicable. |
| Audio/subtitle tracks | Track pickers list entries from `streams_json` indexes used by `/api/media/:id/subtitles/:index`; selections persist per profile (same preference model as watch-together preferences). |
| Settings | Server switcher (multi-server), quality override (ties to bandwidth classes in REMOTE_ACCESS_CONTROL_PLANE.md), autoplay toggles, sign-out, device info (ID + paired name). |

### Acceptance checklist

- [ ] Complete pairing→browse→play→resume→finish flow using only a remote.
- [ ] All screens operable after disabling touch synthesis entirely.
- [ ] Focus survives rotation-free configuration changes and process restore.
- [ ] Back stack behaves per rules above from every screen, including deep
      links into an episode.
- [ ] PIN-protected profiles cannot be bypassed by pressing Back during entry.
- [ ] Works over LAN-only (control plane unreachable) with zero degraded core
      flows — invariant from REMOTE_ACCESS_CONTROL_PLANE.md.
- [ ] Works over relayed connection with visible "relayed" indicator.
- [ ] Quality override persists and maps to accepted HLS qualities
      (`original`…`360p`).
- [ ] Subtitle/audio selection matches `streams_json` indexes and renders
      WebVTT subtitles correctly.
- [ ] App passes platform store prerequisites (target API level, leanback
      banner, D-pad declaration).
- [ ] Cold start to poster grid < 5 s on a mid-range TV stick.

## Mobile/native rollout order (WP-G)

Order is driven by install base of likely Caster operators and reuse of the
shared client core:

1. **Android mobile** — same codebase/toolchain as Android TV (largest shared
   surface: network layer, pairing, playback via ExoPlayer/Media3, downloads
   per OFFLINE_DOWNLOADS.md). Ships first.
2. **iPhone/iPad** — second: AVFoundation player, SwiftUI shell; shares API
   contract, design language tokens, and pairing protocol but not runtime
   code.
3. **Apple TV** — reuses the iOS core with a tvOS focus-engine shell; follows
   the same acceptance checklist adapted to the Apple TV remote (touchpad
   swipe = D-pad equivalent).
4. **Demand-driven others** (Roku, webOS/Tizen, desktop apps) — evaluated
   after the above; they consume only the public contract, so no server work
   should be required.

### Shared vs platform-specific

| Shared (one definition, all clients) | Platform-specific |
| --- | --- |
| API contract & capability gating ([CLIENT_API_CONTRACT.md](CLIENT_API_CONTRACT.md)) | UI framework and navigation shell |
| Connection/negotiation logic spec (candidate racing, preference order — implemented natively per platform against the same spec) | Media player integration and DRM-free local playback handling |
| Pairing protocol (QR/code payload format, token storage guidance) | Secure credential storage (Keystore vs Keychain) |
| Error-code → user-message mapping table | Background download scheduling (WorkManager vs background URL sessions) |
| Design language: color/type/spacing tokens, iconography, poster aspect rules | Store packaging, analytics opt-in compliance |
| Offline manifest format ([OFFLINE_DOWNLOADS.md](OFFLINE_DOWNLOADS.md)) | Voice search integration |

Rule of thumb: anything observable on the wire is shared; anything rendered
or scheduled locally may differ, but interaction patterns (focus order, back
stack, controls) follow the checklist above on all 10-foot targets.

## Open questions

1. Single APK for Android mobile + TV vs separate flavors (store listing and
   input-set differences suggest flavors)?
2. Do we commit to Jetpack Compose for both form factors, or leanback
   XML layouts for TV?
3. Fire TV app-store vs sideload/APK distribution for v1?
4. Should the TV app support offline downloads at all (USB storage policies
   vary widely), or remain streaming-only?
5. Multi-server UX on TV: server picker at launch vs automatic single-server?
