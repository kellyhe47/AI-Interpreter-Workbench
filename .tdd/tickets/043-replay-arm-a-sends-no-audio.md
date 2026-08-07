---
id: 043
title: Replay Arm A sends NO audio — realtime sendAudio is a no-op, so Arm A has never been measurable in Replay
status: pending
source: qa-live
depends_on: [040]
touches: [src/client/transport/realtime.ts, src/client/browserDeps.ts]
iterations: 0
test_files: [src/client/transport/realtime.test.ts, src/client/audio/outboundAudio.test.ts, src/client/replay/replayArmA.test.ts]
branch: ""
---

## Severity: HIGH — half the experiment cannot run in Replay

Operator report: a Realtime run against a freshly recorded 4-utterance corpus clip failed with

```
errors:   ['segmentation: expected 4 utterances, observed 0']
timings:  { speech_end: …, audio_queued: null }
```

## Root cause

`src/client/transport/realtime.ts:446`

```ts
sendAudio(_pcm: Int16Array): void {
  // NO-OP: realtime mic audio rides the WebRTC media track.
}
```

Correct for **Live**: the microphone's audio rides the WebRTC media track via
`pc.addTrack(mediaStream)`, so there is nothing to send by hand.

**Replay has no microphone.** `runOnce` fetches the Recording and paces it at 1× through the pacer,
calling `transport.sendAudio(frame)` per 480-sample frame (`src/client/replay/runner.ts:491`). For
Arm A every frame goes into the no-op, so OpenAI receives **silence**: VAD never fires, no response
is produced, zero `utterance.complete` events arrive, and ticket 031's idle deadline correctly fails
the run with the named reason above.

Compare `cascade.ts:239`, which genuinely writes the PCM to its WebSocket. Cascade is unaffected.

**So Replay Arm A has never worked**, contradicting PRD §7: *"Replay through Arm A goes
browser→OpenAI over WebRTC, so the client fetches the recording from `GET /recordings/:id/audio`
and paces it at 1× through the same capture path."* That "same capture path" was never built for
the paced case.

This is the exact mirror of ticket 040: there, inbound audio arrived on the media track and nothing
consumed it; here, outbound paced PCM has no track to ride. Same confusion, opposite direction.

## Note the second half of the bug

`connect()` currently does:

```ts
if (media && typeof pc.addTrack === 'function') { …mic tracks… }
else if (typeof pc.addTransceiver === 'function') { pc.addTransceiver('audio', { direction: 'recvonly' }); }
```

The `else` branch is exactly the Replay case — and **`recvonly` means the connection cannot send at
all**. Even a working `sendAudio` would have nowhere to put the samples. Both halves must change
together.

## Acceptance criteria

- [ ] With no mic MediaStream but a paced-audio source present, the offer negotiates **sendrecv**
      (or equivalent), not `recvonly`
- [ ] `sendAudio(pcm)` on the realtime transport delivers those samples to the peer connection's
      outbound audio track
- [ ] A Replay Arm A run over a 4-utterance corpus clip produces **4** `utterance.complete` events
      and a **non-null** `audio_queued`, i.e. a real latency sample
- [ ] **Pacing stays 1×** — the pacer still drives delivery; this ticket adds a sink, never a buffer
      that drains faster than real time (dumping the clip invalidates VAD and every latency figure,
      and it LOOKS like it worked)
- [ ] **24 kHz PCM16 throughout** — no resampling in the measured path, and never 16 kHz
      (AGENTS.md: OpenAI transcription rejects 16 kHz)
- [ ] **Live is unchanged**: with a real mic MediaStream the mic tracks are still what is added, and
      no synthesized track competes with them
- [ ] Test fakes that implement neither `addTrack` nor any audio API keep working — the existing
      realtime tests must not need a real peer connection or a real AudioContext
- [ ] Ticket 040's inbound path is untouched and still green

## Notes for the implementer

- The production sink is an injectable seam, exactly as 040's `remoteAudioSink` is — jsdom has no
  `AudioContext` and no `MediaStreamAudioDestinationNode`.
- Create the context at **24 000 Hz** so the paced PCM needs no resampling on the way out.
- 031's idle deadline is what turned this into a clean named failure rather than a hang. Do not
  weaken it while fixing the cause.
