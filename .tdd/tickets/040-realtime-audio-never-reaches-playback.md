---
id: 040
title: Realtime returns audio on the WebRTC media track, which nothing consumes — Arm A is silent and unmeasurable
status: pending
source: qa-live
depends_on: []
touches: [src/client/transport/realtime.ts, src/client/views/useSessionController.ts]
iterations: 0
test_files: [src/client/transport/realtime.test.ts, src/client/replay/runner.test.ts, src/client/views/LiveView.flow.test.tsx]
branch: ""
---

## Severity: HIGH — Arm A produces no audio and therefore no latency sample

Operator report:

> Realtime mode works! Picks up my utterances and I see the translated Spanish. However the play
> button is not working — I don't hear any Spanish being spoken back to me.

## What was ruled out first

- `ArmPlayback` is **fine**. Driven directly in the operator's browser it started a real 440 Hz
  tone: `playing: true`, `startedCount: 1`, `bufferedRemaining: 0`, context `running`.
- The playback AudioContext is **not** suspended. A context created outside a user gesture in that
  browser reported `running` and its `currentTime` advanced. (This was my first hypothesis and it
  was wrong — recorded so it is not re-tried.)
- Live wires playback correctly: `autoplay: true`, `onAudio -> playback.enqueue`.

## Root cause

`src/client/transport/realtime.ts` negotiates INBOUND audio and then never consumes it. Its own
comment states the design:

> "attach the live mic track BEFORE createOffer so the offer carries a sendrecv audio m-line
> (mic up, **model audio down**). Without a stream, fall back to a recvonly transceiver so the
> model's audio track could still flow — **playback itself stays on the data-channel PCM path by
> design**."

Playback depends on `response.output_audio.delta` events decoded from base64 on the data channel
(`realtime.ts:308`). **There is no `ontrack` handler, no `srcObject`, and no
`createMediaStreamSource` anywhere in the client** for the peer connection — a repo-wide grep
returns only the *microphone* source in `browserDeps.ts`. So the model's audio track arrives and is
dropped.

This fits the symptom exactly: data-channel text events work (transcripts and the Spanish
translation appear), and the media track — where WebRTC actually carries the audio — goes nowhere.

### OPEN QUESTION — SETTLED EMPIRICALLY (2026-08-06), do not re-litigate

Instrumented a real Realtime session in the operator's Chrome: patched `RTCPeerConnection` to
capture the peer connection, every `ontrack`, and every data-channel event type, then drove the
model to speak WITHOUT a microphone by sending `conversation.item.create` + `response.create` over
the data channel. Result:

```
inbound audio RTP        42,153 bytes / 748 packets     <- audio IS on the media track
ontrack fired            kind: 'audio'
response.output_audio.delta       NOT PRESENT           <- the event the client listens for
response.output_audio_transcript.delta   9 (TEXT)
output_audio_buffer.started / .stopped   1 / 1
```

**Over WebRTC, OpenAI sends audio on the MEDIA TRACK only.** There is no
`response.output_audio.delta`. The nine "audio delta" events are *transcript* deltas — text, which
is exactly why the operator sees the Spanish and hears nothing. `realtime.ts:308` listens for an
event that never arrives, so `onAudio` never fires, playback never gets a sample, and
`timings.audio_queued` is never stamped.

**Two consequences for the fix:**

1. The inbound media track must be consumed — an `ontrack` handler routing the remote stream to an
   output sink. The data-channel PCM path cannot be made to work; it does not exist over WebRTC.
2. **`output_audio_buffer.started` is the natural `audio_queued` stamp** — it is the WebRTC signal
   that the model's audio has begun on the track, which is the same instant the cascade path calls
   "first audio queued". Using it keeps Experiment 1 comparing the same quantity across arms.

(Superseded original text follows.)

**OPEN QUESTION as originally written:** whether OpenAI's Realtime *WebRTC* transport emits
`response.output_audio.delta` on the data channel at all, or sends audio solely over the media
track. Over the WebSocket transport those deltas are the audio path; over WebRTC the media track
normally is. Confirm by instrumenting a real session — count `output_audio.delta` events and check
`pc.getReceivers()` inbound audio bytes — before choosing the fix. Do not implement on assumption.

## The measurement consequence, which is worse than the silence

`timings.audio_queued` is stamped at the first audio (`playback.audioQueuedAt` in Live,
`firstAudioAt` in `runOnce`). If no audio ever arrives:

- Live Arm A reports no perceived-latency figure at all
- **Replay Arm A runs get `audio_queued: null`**, so they count toward `n` and cost but are
  excluded from every percentile — Arm A silently contributes no latency sample to Experiment 1

So this is not merely "no sound": Arm A is currently **unmeasurable**, which is half of the
project's headline comparison.

## Acceptance criteria

- [ ] Settle the open question above with evidence from a real session; record the finding
- [ ] The model's audio is audible in Live under autoplay, without pressing anything
- [ ] `timings.audio_queued` is stamped from the FIRST audible sample of the utterance, by whichever
      path actually carries it, so Arm A latency is comparable with cascade's
- [ ] The play/pause control reflects and controls real audio
- [ ] Replay Arm A produces a non-null `audio_queued` and therefore a real latency sample
- [ ] Test fakes that implement neither `ontrack` nor media APIs keep working — the existing
      realtime tests must not need a real peer connection

## Notes

If audio arrives on the media track, `audio_queued` cannot come from a PCM enqueue. Decide and
document how it is stamped (first inbound RTP? first non-silent output sample?) — and make sure the
definition stays comparable with cascade's, or Experiment 1 compares two different quantities.
