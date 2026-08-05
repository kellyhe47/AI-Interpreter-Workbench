---
id: 004
title: Cascade orchestrator (server core pipeline)
status: green
depends_on: [001, 002, 003]
touches: [src/server/cascade/*]
test_files: [src/server/cascade/orchestrator.test.ts]
iterations: 0
---

## Scope
`src/server/cascade/orchestrator.ts`: per-session pipeline consuming an audio chunk source
(AsyncIterable<Int16Array>) and a provider set {stt, mt, tts}, emitting events (callback or
async iterator): source partials/finals, target deltas/finals, per-stage timing marks
(vad_fired≈stt final signal arrival, stt_final, mt_first_token, tts_first_byte), audio chunks
out, utterance-complete with full timing record, stage-attributed errors. Behavior:
- Translate on TURN-FINAL only (PRD §7): one MT call per final.
- Streaming throughout: MT tokens stream into TTS via AsyncIterable bridge (no waiting for MT
  completion — PRD §12 #2), TTS audio chunks emitted as they arrive.
- Utterance failure isolates: a stage error fails that utterance with
  `{stage, message}` (copy: "<stage> stage <reason> for this utterance — session still running"),
  pipeline keeps consuming subsequent audio/turns (PRD §11).
- AbortSignal tears down the whole utterance cleanly mid-any-stage.
- Providers arrive pre-decorated (withTiming/etc. applied by a `buildPipeline(config)` helper
  using the registry + decorators).

## Acceptance criteria
1. With all-fixture providers: feeding audio that produces 2 STT turn-finals yields exactly 2
   complete utterances, each with sourceFinal, targetFinal, ≥1 audio chunk, and a timing record
   containing stt_final ≤ mt_first_token ≤ tts_first_byte.
2. Streaming assertion: with a slow FixtureMt (multi-chunk over time), first TTS audio chunk
   event is emitted BEFORE the last MT token event.
3. MT stage fault (timeout injection): utterance error event has stage 'mt' and the exact copy
   "mt stage timed out for this utterance — session still running"; a subsequent turn still
   completes successfully.
4. Abort mid-MT: no target-final, no audio after abort; generators all closed (fixture leak
   probes clean).
5. Empty STT result (fault 'empty'): utterance skipped, no crash, session continues (PRD §11).
6. Partials forwarded: source partial events arrive before the source final.
