---
id: 001
title: Core stage interfaces, timing vocabulary, protocol types, fixture providers
status: pending
depends_on: []
touches: [src/core/types.ts, src/core/timing.ts, src/core/protocol.ts, src/core/fixtures/*, src/core/registry.ts]
test_files: []
iterations: 0
---

## Scope
`src/core/` shared module (isomorphic TS — no node/DOM imports):
- `types.ts`: `SttProvider`, `TranslationProvider`, `TtsProvider` exactly per PRD §6 (async
  generators; TTS takes `AsyncIterable<string>`; `AbortSignal` in opts; `SttEvent =
  {type:'partial'|'final', text, tStart, tEnd}` where `final` means TURN-final).
- `timing.ts`: canonical timing vocabulary. Cascade events: `speech_end, vad_fired, stt_final,
  mt_first_token, tts_first_byte, audio_queued`; realtime events: `speech_end,
  server_speech_stopped, first_audio_delta, audio_queued`. Interval derivation functions
  (cascade: endpointing/stt/mt/tts/queue; realtime: endpointing/model/queue) + end-to-end.
  `UtteranceRecord` shape per PRD §7 (id, arm, mode, languagePair, direction, sourcePartials[],
  sourceFinal, targetPartials[], targetFinal, audioState, audioDurationMs, timings,
  speechEndSource 'corpus'|'vad', providers, costUnits, error?, corpusId, runId).
- `protocol.ts`: cascade WS wire protocol types (client→server: binary PCM16 frames + JSON
  control {type:'start'|'stop'|'configure', languagePair, direction, providers}; server→client:
  JSON events {type:'source-partial'|'source-final'|'target-delta'|'target-final'|'stage-timing'|
  'utterance-complete'|'error'|'audio-chunk'(base64)|...}). SAMPLE_RATE = 24000 constant.
- `fixtures/`: `FixtureStt`, `FixtureMt`, `FixtureTts` implementing the interfaces; canned
  output replayed on configurable timers (`delayMs` etc.); fault injection opts
  ({failWith: 'timeout'|'rate-limit'|'empty'|'error'}); respect AbortSignal (stop yielding,
  clean up timers). FixtureTts consumes its AsyncIterable input incrementally and yields
  Int16Array audio chunks; FixtureMt yields tokens over time (streaming=true).
- `registry.ts`: `createStt/createMt/createTts(name, options)` factory maps; fixtures registered.

## Acceptance criteria
1. FixtureStt emits ≥1 `partial` then exactly one `final` per utterance; `final` is turn-final.
2. FixtureMt with `delayMs` yields ≥2 token chunks over time; concatenation equals canned text.
3. FixtureTts starts yielding audio before its text input iterable completes (streaming).
4. Abort mid-stream on each fixture: generator returns promptly (<50ms), no timers leak
   (vi.useFakeTimers clean), no further yields.
5. Fault injection: `timeout` = hangs until aborted; `rate-limit` = throws RateLimitError with
   status 429; `empty` = completes with no output; `error` = throws ProviderError.
6. Registry: `createTts('fixture', opts)` returns working provider; unknown name throws with
   the list of known providers.
7. Interval derivation: given a full cascade timing record, returns the 5 named intervals whose
   sum equals `audio_queued − speech_end`; realtime record → 3 intervals; missing events → null
   intervals, no throw.
