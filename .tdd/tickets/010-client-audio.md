---
id: 010
title: Client audio — mic capture to PCM16/24k, playback queue, level meter
status: green
depends_on: []
touches: [src/client/audio/*]
test_files: []
iterations: 0
---

## Scope
`src/client/audio/`:
- `pcm.ts` pure functions: Float32→Int16 conversion (clamped), resample-to-24k (linear
  interpolation from arbitrary AudioContext rate), chunking to 20 ms frames (480 samples),
  Int16→Float32 for playback, base64↔Int16Array.
- `capture.ts`: getUserMedia wrapper exposing permission outcomes mapped to the four-value
  model (granted / denied — distinguishing NotAllowedError vs others), AudioWorklet (with
  ScriptProcessor fallback) pushing 24 kHz PCM16 20 ms chunks to a subscriber; level (RMS)
  computed per chunk for the 5-bar meter; stop() releases tracks.
- `playback.ts`: per-arm playback queue over AudioContext: enqueue Int16Array 24k chunks,
  `audio_queued` timestamp captured at FIRST chunk decode+queue (PRD §7 measurement note —
  even when autoplay off, timestamp = would-have-sounded moment), play()/pause()/onEnded,
  duration accumulation; autoplay mode plays as chunks arrive; buffered mode holds until
  play().
- DOM-heavy parts behind small interfaces; pure logic (pcm math, queue scheduling decisions,
  RMS, permission mapping) unit-tested in jsdom/node without real AudioContext (inject fakes).

## Acceptance criteria
1. Float32→Int16: ±1.0 clamps to ±32767/-32768; 0→0; round-trip error < 1e-4 on samples.
2. Resample 48k→24k halves length (±1); 44.1k→24k length ratio correct ±1; monotone signal
   preserved (no NaN).
3. Chunker emits exactly 480-sample frames, carries remainder across pushes.
4. RMS level: silence→0; full-scale sine→~0.707 (±0.05); mapped to 0..5 bars thresholds.
5. NotAllowedError→'denied'; success→'granted'; other errors→'denied' with distinct reason
   surfaced.
6. Playback queue (fake AudioContext): first enqueue records audioQueuedAt once; play() after
   buffering starts from chunk 0; onEnded fires when all sources complete; pause suspends.
7. Abort/stop: capture stop ends chunk stream and releases tracks (fake observes).
