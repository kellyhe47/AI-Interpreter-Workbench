---
id: 007
title: Replay pacer — 1× playback in 20 ms framing
status: in-progress
depends_on: []
touches: [src/client/replay/pacer.ts, src/client/replay/pacer.test.ts]
iterations: 0
test_files: [src/client/replay/pacer.test.ts]
branch: "tdd/007"
---

## Scope

**ADD `src/client/replay/pacer.ts`** — feeds a Recording's PCM into a transport at **1× real
time**, in the same **20 ms** framing live microphone capture uses.

This is the whole reason Replay measurements are trustworthy. Dumping the buffer as fast as
the socket accepts would invalidate VAD, endpointing and every latency figure — **and would
look like it worked** (PRD §7, §17 19d). It is PRD §13 test 7, one of the three new tests v2
verification requires.

Nothing else: no transport, no run record, no UI. Ticket 008 consumes this.

## Design

- Clock and scheduler are **injected**, never `Date.now`/`setTimeout` captured directly, so
  tests drive time deterministically instead of sleeping. Follow the injection style already
  used across `src/client` (`deps.now()`, an injected timer seam).
- 20 ms at 24 kHz mono = **480 samples per frame** (`SAMPLE_RATE` from
  `src/core/protocol.ts` — derive it, do not hardcode 24000 twice).
- `start()` returns a promise resolving when the clip has been fully emitted; `cancel()`
  (or an `AbortSignal`) stops emission promptly and resolves/returns without emitting more.
- Pacing is **wall-clock anchored, not cumulative-delay anchored**: frame *n* is due at
  `t0 + n*20ms`. A slow consumer must not let error accumulate into a drift that silently
  stretches the clip beyond 1×.
- A trailing partial frame (clip length not a multiple of 480 samples) is emitted once, whole,
  rather than dropped or zero-padded into a full frame.

## Acceptance criteria

- [ ] A clip of N samples is emitted as `ceil(N/480)` frames, in order, and the concatenation
      of the frames is **sample-identical** to the input
- [ ] Every frame except possibly the last is exactly 480 samples; the last carries the
      remainder
- [ ] **1× pacing**: with a fake clock, the k-th frame is emitted at ~`k * 20 ms` of virtual
      time — a 1-second clip takes ~1000 ms of virtual time, not ~0. Assert the schedule,
      not just the ordering; this is the criterion that catches "dumped the buffer"
- [ ] Emission does not run ahead: at virtual time T only `floor(T/20ms)+1` frames have been
      emitted
- [ ] Pacing does not drift when the consumer is slow: a consumer that takes longer than 20 ms
      on one frame does not push every later frame permanently late (schedule is anchored to
      the start, not to the previous emission)
- [ ] `cancel()` / abort mid-clip stops emission promptly, emits no further frames, and
      completes cleanly (no throw, no leaked timer)
- [ ] An already-cancelled/aborted pacer emits nothing at all
- [ ] An empty clip (0 samples) emits no frames and completes immediately
- [ ] Exposes the frame size and frame duration as named constants derived from
      `SAMPLE_RATE`, so a future sample-rate change cannot desynchronize the two

## Test plan

New `src/client/replay/pacer.test.ts` (jsdom env — under `src/client/**`). Use vitest fake
timers or an injected clock; **no real sleeping** — a test suite that waits a real second per
case is a tax on every regression gate for the rest of the project.

## Attempt log
