# Choosing a codec and a bitrate

Design note for issue #29 work package F — **status: implemented**

## What it used to do

Every transcode produced H.264 at a bitrate from a fixed table: 1080p was
always 8 Mbps, 720p always 4 Mbps, whoever was watching and wherever they were.
That single number is wrong in both directions at once. It wastes bandwidth on
a phone across the internet, and it wastes picture quality on a television three
metres from the server on gigabit ethernet.

## What decides it now

Three inputs, in this order.

**What the client can decode.** A device that handles H.265 gets the same
picture in roughly 60% of the bitrate, and AV1 in about 50%. The client says
what it supports; the server never guesses upward, because a codec the player
cannot decode is a black screen rather than a slow stream.

**What the server can encode, and how.** This is the constraint that is easy to
forget. H.265 and AV1 both exist as software encoders, and both are slower than
H.264 — AV1 dramatically so. A server encoding AV1 in software runs well below
real time on ordinary hardware, and a stream the encoder cannot stay ahead of
stalls. That is a worse outcome for the viewer than the bandwidth it saves.

So the rule is:

| Situation | Codec |
| --- | --- |
| GPU can encode AV1, client decodes it | **AV1** |
| GPU can encode H.265, client decodes it | **H.265** |
| Software only, viewer is remote, client decodes H.265 | **H.265** — bandwidth is the binding constraint there |
| Software only, viewer is on the LAN | **H.264** — there is bandwidth to spare and no CPU to spare |
| Client declared nothing, or nothing better | **H.264** |

Software AV1 is never selected. If that changes it will be because a preset
faster than SVT-AV1's preset 8 turns out to be usable, not because a client
asked nicely.

**Where the viewer is.** Two ladders. The local one is generous, because the
limit there is the decoder rather than the link. The remote one is conservative,
and reaches further down.

| Rung | Local network | Over the internet |
| --- | --- | --- |
| 4K | 40 Mbps | 16 Mbps |
| 1080p | 12 Mbps | 6 Mbps |
| 720p | 6 Mbps | 3 Mbps |
| 480p | 2.5 Mbps | 1.5 Mbps |
| 360p | — | 0.8 Mbps |

Those are H.264 numbers; the codec multiplier is applied on top.

A client can say which it is with `?network=lan` or `?network=remote`. When it
does not, the server classifies the request's own network origin using the same
rules the security layer already uses, and treats an address it cannot place as
remote.

## The source is a ceiling throughout

Three separate caps, all pointing the same way:

- **Resolution.** A 720p file requested at the 1080p rung is sent at 720p.
  Upscaling spends bitrate inventing detail that is not in the file.
- **Bitrate when capped.** A stream capped to a smaller resolution gets a
  bitrate scaled by pixel count, not the full rung's number.
- **Source bitrate.** Re-encoding above what the original was encoded at cannot
  add quality, so it is clamped.

High frame rate material (above 45 fps) gets 1.4× — that is genuinely more
information, not padding. Anything the client declares as `maxBitrate` is a hard
ceiling above all of this, and there is a 200 kbps floor so a tiny declared
ceiling cannot produce something unwatchable.

## Packaging follows the codec

H.264 travels in MPEG-TS, as it always has. H.265 and AV1 cannot: HLS carries
them in fragmented MP4, where the player fetches a separate initialisation
segment before any media segment.

This is not configurable, because getting it wrong produces a playlist that
loads and then plays nothing. It shows up in three places:

- Segments are named `segment-N.m4s` rather than `segment-N.ts`.
- The variant playlist declares `#EXT-X-VERSION:7` and an `#EXT-X-MAP` pointing
  at `init.mp4`.
- A request for the wrong extension is answered 404 with "reload the playlist"
  rather than starting a second encoder for the same stream.

A directly copied stream stays in MPEG-TS whatever the client could have
decoded, because nothing is re-encoded and the bytes are what they are.

## Session identity

The codec and the chosen bitrate are part of a session's identity, alongside the
audio, subtitle and remux decisions that were already there. Two viewers on the
same file at the same rung share one encoder only if every one of those matches.
A viewer on the LAN and one over the internet do not, and must not be handed
each other's segments.

## What the browser sends

The web player probes the decoder that will actually play the stream, which is
not always the same thing as the one the `<video>` element reports. Safari plays
an HLS playlist natively; everything else goes through Media Source Extensions
via hls.js, and the two do not support the same codecs — Chrome will happily say
it plays H.265 from a file while MSE refuses it. Asking the wrong one produces a
stream the player accepts and then shows as a black screen, so the probe is
told which pipeline is about to be used.

## Measured

On a throttled container with no GPU, producing one 6-second 720p segment from a
1280×720 source:

| Codec | Encoder | Time | Bitrate |
| --- | --- | --- | --- |
| H.264 | libx264 veryfast | 3.1 s | 6 Mbps (LAN) |
| H.265 | libx265 veryfast | 8.1 s | 1.8 Mbps (remote) |
| AV1 | libsvtav1 preset 8 | 17.6 s | 3.0 Mbps |

The absolute numbers are not representative of a real server — even H.264 is
only twice real time here — but the ratios are, and they are why software AV1 is
off the table and software H.265 is reserved for remote viewers.

## Revisiting this

- Reconsider software AV1 if a faster preset proves usable in real time.
- The ladders are constants in `transcoder/quality.ts`. They are deliberately
  not settings: a per-library bitrate slider is a support burden that mostly
  gets set wrong.
