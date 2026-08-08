---
id: 049
title: A throwing AudioContext constructor still kills Live from inside the transport callback, and Replay leaks one context per press
status: pending
source: code-review (047 round 3)
depends_on: [047]
touches: [src/client/audio/playback.ts, src/client/browserDeps.ts, src/client/views/useSessionController.ts]
iterations: 0
test_files: []
branch: ""
---

## Why

Ticket 047 R3-1 fixed ONE path where `new AudioContext()` throwing wedged Live: the Start-gesture
resume now runs inside a `try/catch`, after `requestCapture()`. Two related problems remain, both
found while writing that test and both deliberately scoped out.

### 1. The lazy construction inside `ArmPlayback.enqueue` is unguarded
`ArmPlayback` builds its context lazily, so with a hostile `AudioContext` the FIRST TTS chunk throws
from inside the transport's `onAudio` callback rather than from the click handler. This is
**pre-existing** — true before 047 R2-3 added the Start-path resume — which is exactly why it did
not belong in 047. The test-writer's first draft of the R3-1 test drove real audio and stayed red
even with the agreed fix applied; narrowing that test to an audio-free cascade script was the right
call, and it carries an in-file note so nobody reads it as full coverage of a hostile `AudioContext`.
With 047 landed, Live starts and runs — and then the first chunk throws into a transport callback,
where nothing catches it and nothing is surfaced.

### 2. `playRun` / `playTake` leak one AudioContext per press
`browserDeps.ts` constructs a NEW `AudioContext` on every Replay play press and never `close()`es
it. This is what makes problem 1 (and 047's R3-1) reachable in practice rather than theoretically:
Chrome caps contexts per document (~6), so a QA pass playing a dozen Replay runs exhausts the cap,
and the next `new AudioContext()` anywhere in the app throws. The reviewer named this sequence
explicitly — play >= 6 Replay runs, then go to Live and press Start.

## Scope

Make a failing `AudioContext` a degraded experience, never a dead one — and stop manufacturing the
condition.

## Acceptance criteria

- [ ] A hostile `AudioContext` (constructor throws) does not kill a Live session at ANY point: not
      at Start (047 R3-1, already green — keep it), and not on the first or any later audio chunk
- [ ] When playback cannot be constructed, the operator is TOLD — a surfaced, non-fatal state, not a
      silent swallow. Live continues: the session still runs, transcripts still arrive, timings are
      still measured. Only the sound is missing.
- [ ] Realtime Live is unaffected either way: it never uses `ArmPlayback`, and its audio rides the
      `remoteAudioSink` element
- [ ] `playRun` / `playTake` release their `AudioContext` — one per press must not accumulate.
      Prefer ONE reused context over closing each; state which you chose.
- [ ] Playing >= 10 Replay runs, then starting a Live session, works — the sequence that motivated
      this ticket
- [ ] **Measurement is untouched.** A missing playback context must not change a timing, fail a run,
      or alter `status` — sound is not a measurement. Pin it.

## Notes

- 047's `useSessionController.ts` Start-path `try/catch` is the shape to follow.
- jsdom has no `AudioContext`; everything stays an injectable seam
  (`playbackContextFactory` already is).
- Do NOT make this a reason to reintroduce a play/pause control in Live — ticket 047 removed it
  deliberately and its source guards forbid it.
