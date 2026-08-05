---
id: 011
title: Client transports — InterpreterTransport, Realtime WebRTC, Cascade WS, fixture, ArmRouter
status: pending
depends_on: [008, 010]
touches: [src/client/transport/*]
test_files: []
iterations: 0
---

## Scope
`src/client/transport/` per PRD §6 mode level:
- `types.ts`: `InterpreterTransport` = {start(), stop(), sendAudio(pcm: Int16Array), events:
  onSourceText(partial/final), onTargetText(delta/final), onAudio(Int16Array), onStageTiming,
  onError(architecture-differentiated copy), onStateChange(connected/reconnecting/disconnected)}.
  Arm descriptor {id, kind:'realtime'|'cascade', label, costPerMin}.
- `realtime.ts` Arm A: fetch /api/realtime-token → RTCPeerConnection with mic track + oai-events
  data channel → POST SDP to https://api.openai.com/v1/realtime/calls (Authorization: Bearer
  ephemeral, Content-Type: application/sdp). session.update: interpreter instructions from
  language pair, audio.input.turn_detection {type:'server_vad', silence_duration_ms:500},
  input_audio_transcription enabled (sidecar transcript — PRD §9). Event mapping (GA names):
  `conversation.item.input_audio_transcription.delta/.completed`→onSourceText,
  `response.output_audio_transcript.delta/.done`→onTargetText,
  `input_audio_buffer.speech_stopped`→timing server_speech_stopped,
  `response.output_audio.delta` (base64)→onAudio + first-delta timing; `response.done`→
  utterance settle + usage/cost units; error events→onError with OPAQUE copy
  ("opaque failure — no stage attribution · session still running"). Audio OUT: remote media
  track is muted/ignored; playback goes through our queue from output_audio.delta for the
  audio_queued timestamp. RTCPeerConnection/fetch/DataChannel all injectable (fakes in tests).
  Reconnect: on unexpected close → attempt loop with backoff (max 5) surfacing onStateChange.
- `cascade.ts` Arm B: WebSocket /ws/cascade speaking core protocol; sendAudio → binary frames;
  JSON events mapped to the same transport events; stage errors pass through cascade copy
  verbatim; reconnect loop same policy.
- `fixture.ts`: fixture transport for dev/tests/soak (canned events on timers, fault
  injection).
- `router.ts` ArmRouter: fan-OUT (PRD §6): one sendAudio() → every active arm; add/remove arm
  starts/stops that transport only; per-arm event demux keyed by arm id; UI never sees
  transport classes, only descriptors + event streams.

## Acceptance criteria
1. ArmRouter fan-out: one sendAudio call reaches N active transports with the same chunk;
   removing an arm stops (only) it; events tagged with arm id.
2. Realtime event mapping (fake data channel replaying the preflight GA event sequence):
   produces source partial+final (sidecar), target deltas+final, onAudio chunks, timing marks
   server_speech_stopped & first_audio_delta, settle on response.done.
3. Realtime error → onError copy exactly "opaque failure — no stage attribution · session
   still running" (PRD §11).
4. Cascade transport (fake WS): protocol events → transport events incl. 5 stage timings;
   binary framing of sendAudio verified byte-exact; stage error copy passes through verbatim.
5. Token fetch failure → onError, no throw to caller; start() idempotent-safe.
6. Unexpected close → reconnecting state changes with attempt numbers, then connected on
   success or disconnected after 5.
7. stop() closes peer connection/socket and detaches callbacks (no events after stop).
