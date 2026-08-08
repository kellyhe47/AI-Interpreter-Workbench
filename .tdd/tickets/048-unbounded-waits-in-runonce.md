---
id: 048
title: runOnce still has two unbounded waits — a hung upload freezes a sweep exactly as a wedged context would have
status: pending
source: code-review (046 round 3/4)
depends_on: [046]
touches: [src/client/replay/runner.ts, src/client/batch/runner.ts]
iterations: 0
test_files: []
branch: ""
---

## Why

Ticket 046 R3-1 found and fixed an unbounded `await transport.stop()`: a wedged AudioContext would
hang the run, stall the whole sweep, store no Run and report no error, because **nothing races
`deps.execute(...)`**. `startBatch`'s `runTimeoutMs` only calls `controller.abort()`
(`src/client/batch/runner.ts:302`), and `runOnce` observes the abort signal nowhere after
`await pacer.start()`.

The fix bounded exactly one wait. **Two more of the same shape remain**, found by the same reviewer
in rounds 3 and 4 and deliberately scoped out of 046:

1. `uploadOutputAudio` -> `runs.uploadAudio` is a bare browser `fetch` with **no timeout**
   (`src/client/replay/runner.ts:264`). A server that accepts the connection and never responds
   hangs the run forever.
2. `await finished` is **unbounded for mic-shaped (manifest-less) runs**.

Both are pre-existing, neither is a regression, and both are invisible to the suite. The generalised
defect is the one worth naming: **`runTimeoutMs` is not a timeout.** It aborts a signal that nothing
downstream reads once pacing has started, so it cannot rescue any of these waits.

## Scope

Make `runTimeoutMs` mean what its name says, OR bound each remaining wait the way R3-1 bounded the
close. Prefer the former — three ad-hoc races is the same bug fixed three times, and a fourth wait
added later would not be covered.

## Acceptance criteria

- [ ] A run whose audio upload never responds still completes, stores its Run, and keeps every
      timing figure — the measurement must survive, exactly as R4-2 decided for a throwing `stop()`
- [ ] A manifest-less (mic-shaped) run cannot wait forever on `finished`
- [ ] `runTimeoutMs` actually bounds a run in a sweep — assert a hung run does not stall
      `startBatch`, and that the sweep advances to the next rep
- [ ] A bounded-out run is recorded HONESTLY: `status` reflects what happened, and it is excluded
      from aggregation by the existing gate rather than by a new special case
      (`isAggregatableRun` is the one place that decides — do not add a second)
- [ ] No new unhandled rejection on any bounded path
- [ ] The existing `TRANSPORT_CLOSE_TIMEOUT_MS` behaviour from 046 R3-1 is preserved, not
      duplicated or nested inside a second deadline

## Notes

- `runner.ts:566` and the `closeTransport` helper (046 R3-1/R4-2) are the shape to follow: race a
  single named constant, clear the handle on whichever path wins, never reject.
- Do NOT let a bounded-out run look complete. AGENTS.md: never aggregate a run whose `origin` is
  `manual` or `status` is `failed`; a run that timed out is not a measurement.
