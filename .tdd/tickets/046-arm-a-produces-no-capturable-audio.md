---
id: 046
title: Arm A produces no capturable output audio — its audio is a live media track, so nothing can be saved or replayed
status: pending
source: qa-live
depends_on: [045]
touches: [src/client/transport/realtime.ts, src/client/replay/runner.ts, src/client/browserDeps.ts]
iterations: 0
test_files: []
branch: ""
---

## Why

Ticket 045 gives runs an upload path, which fixes **cascade** playback. It cannot fix Arm A.

Confirmed empirically in ticket 040: over WebRTC, OpenAI sends audio on the **media track only** —
`response.output_audio.delta` does not exist. `onAudio` in `src/client/transport/realtime.ts:468`
fires only from that event, so for Arm A `audioChunks` is empty and `outputAudio.length === 0`.
There is nothing to upload, and `blind compare` — which is playback-only by design (PRD §10) — has
nothing to play for any pair involving Arm A.

**This is a playback and evaluation gap, not a measurement gap.** Arm A's `audio_queued` comes from
`output_audio_buffer.started`, so every latency and cost figure is already correct.

## Scope

Tap the INBOUND remote stream so Arm A's output audio can be captured to the same 24 kHz PCM16 the
cascade path produces — a Web Audio tap on the remote `MediaStream`, or an equivalent seam.

## Acceptance criteria

- [ ] An Arm A Replay run produces non-empty output audio, uploaded by 045's path, and
      `GET /api/runs/:id/audio` returns it
- [ ] The captured audio is **24 kHz PCM16 mono**, matching cascade's, so the two arms are
      comparable and blind compare cannot be told apart by format
- [ ] **Capturing must not perturb the measurement.** `audio_queued` still comes from
      `output_audio_buffer.started` and does not shift; adding a tap must not delay or reorder the
      inbound path.
- [ ] Live is unaffected — it already plays through the `remoteAudioSink` (040) and persists no audio
      at all (§17 19h). A tap must not cause Live to start storing audio.
- [ ] The tap is an **injectable seam**; jsdom has no `AudioContext` and no `MediaStream`, and the
      existing realtime fakes must keep working untouched
- [ ] Blind compare can play an Arm A sample, so an A-vs-B pair is judgeable
- [ ] Nothing autoplays in Replay

## Notes

- 040's `remoteAudioSink` already receives the inbound stream for Live playback. The Replay tap is
  the same stream consumed for a different purpose — consider whether one seam can serve both
  rather than attaching two consumers to one track.
- Do not reintroduce a PCM-delta expectation; it does not exist on this transport.
