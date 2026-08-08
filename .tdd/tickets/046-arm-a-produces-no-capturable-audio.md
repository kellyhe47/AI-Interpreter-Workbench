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

## CONTEXT A SUB-AGENT NEEDS — everything below was established empirically, do not re-derive

### 1. Why Arm A has no audio (settled in ticket 040, do not re-investigate)

A real Realtime session was instrumented in the operator's Chrome: `RTCPeerConnection` patched to
capture every `ontrack` and every data-channel event type, then the model was driven to speak with
NO microphone via `conversation.item.create` + `response.create`. Result:

```
inbound audio RTP                        42,153 bytes / 748 packets   <- audio IS on the media track
ontrack fired                            kind: 'audio'
response.output_audio.delta              NOT PRESENT
response.output_audio_transcript.delta   9   (TEXT, not audio)
output_audio_buffer.started / .stopped   1 / 1
```

**Over WebRTC, OpenAI sends audio on the MEDIA TRACK only.** `onAudio` in
`src/client/transport/realtime.ts:468` fires ONLY from `response.output_audio.delta`, which does not
exist on this transport — so `audioChunks` is always empty for Arm A and `outputAudio.length === 0`.

### 2. What already exists — build on these, do not rebuild

- **`RemoteAudioSink`** (ticket 040, `src/client/transport/realtime.ts`) —
  `{ attach(stream), play(), pause() }`, injected via `RealtimeDeps.remoteAudioSink`. `connect()`
  installs `pc.ontrack` BEFORE `setRemoteDescription` and calls `attach(ev.streams[0])` for an
  audio track. **This seam already receives exactly the stream the tap needs.**
- **`OutboundAudioSink`** (ticket 043, `src/client/audio/outboundAudio.ts`) — the OUTBOUND mirror,
  a factory building an `AudioContext` at 24 000 Hz + `MediaStreamAudioDestinationNode`. Its shape
  and its 24 kHz discipline are the pattern to copy for the inbound tap.
- **The upload path** (ticket 045, green): `RunsClient.uploadAudio(id, wavBytes)` ->
  `POST /api/runs/:id/audio`. `runOnce` uploads **BEFORE** POSTing the Run and stamps the
  server-reported `outputAudioPath`. A run with zero samples uploads nothing — which is why Arm A
  currently stores nothing. **Once the tap produces samples, the existing path uploads them with no
  further change.**
- **The play gate** (ticket 045): `[data-run-play]` renders iff
  `run.outputAudioPath !== undefined`, else `[data-run-no-audio]` ("no output audio stored"). So an
  Arm A run gains its play button automatically once audio is captured.

### 3. Where the wiring goes — and where it must NOT

`browserDeps.ts` has two transport factories. Ticket 043 learned this the hard way:

- **DO** wire the tap into **`buildReplayDeps`'s `createTransport` realtime branch** — Replay is
  where a Run is produced and where output audio must be stored.
- **DO NOT** wire it into `buildBrowserDeps`'s Live `transportFactory`. Live persists no audio at
  all (§17 19h), and Live's controller already drives the same inbound stream through
  `remoteAudioSink` for playback. A tap there would start Live storing artifacts the design
  deliberately excludes.

### 4. Test discipline

- jsdom has **no `AudioContext`, no `MediaStream`, no `MediaRecorder`** — the tap MUST be an
  injectable seam, exactly like `remoteAudioSink` and `createOutboundAudioSink`.
- The existing realtime fakes (`FakePc`, `FakeTrackPc`, `makeHarness`, `trackDuringAnswer` in
  `src/client/transport/realtime.test.ts`) must keep working untouched — extend that harness rather
  than inventing a second one.
- `src/client/replay/replayArmA.test.ts` is the end-to-end Arm A shape from 043; extend it rather
  than starting fresh.
- **Include a falsifiability control**, as 043 did: a test proving the fake produces audio only
  because the tap captured it, not because a timer fired. Without one, the positive tests are
  satisfiable by a stopwatch.

### 5. The measurement must not move

`audio_queued` for Arm A comes from `output_audio_buffer.started` (ticket 040), NOT from audio
bytes. Attaching a tap must not delay, reorder or buffer the inbound path in a way that shifts it.
**Assert the timing is unchanged with the tap attached** — this is the one way this ticket could
silently corrupt a figure that currently works.

## Notes

- 040's `remoteAudioSink` already receives the inbound stream for Live playback. The Replay tap is
  the same stream consumed for a different purpose — consider whether one seam can serve both
  rather than attaching two consumers to one track.
- Do not reintroduce a PCM-delta expectation; it does not exist on this transport.
- Do not run `prettier` — this repo has no config and it reformats unrelated regions.
