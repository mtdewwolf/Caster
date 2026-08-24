# Runtime media fixtures

The codec matrix tests create all media under an owned `caster-codec-fixtures-*` directory in the operating system's temporary directory. No binary media is stored in or written beneath the repository.

The inputs are fixed FFmpeg `lavfi` colors, sine waves, silence, and two original test captions. They are deterministic synthetic test material and contain no third-party audio, video, artwork, or subtitles. Encoded bytes can differ between FFmpeg versions, so the tests assert media structure and metadata rather than file hashes.

The small matrix covers combinations commonly available in Debian and full Windows FFmpeg builds:

- MP4: H.264 (`libx264`) video plus stereo AAC audio.
- Matroska: MPEG-4 Part 2 video, 5.1 AC-3 audio, and embedded SubRip subtitles.
- WebM: VP8 (`libvpx`) video plus mono Opus (`libopus`) audio.
- Sidecar/seek cases: a language-tagged `.srt` sibling and an all-intra MP4 with duration, time-base, frame-count, and packet-timestamp checks.

Before generating anything, the helper queries `ffmpeg` and `ffprobe` and verifies the required encoders, muxers, demuxers, and source filters. A missing capability produces a named test failure; there are no hardware encoder or accelerator requirements.

Run only this matrix with:

```sh
bun test tests/codec-fixtures.test.ts
```

Each fixture is 1.2 seconds at 96x54 pixels and must remain below 512 KiB. Cleanup resolves and validates the owned OS-temp path before recursively removing it, including after a partial generation failure.
