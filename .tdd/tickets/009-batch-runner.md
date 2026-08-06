---
id: 009
title: Batch runner — sequential sweep with counterbalancing and warmup discard
status: green
depends_on: [001, 008]
touches: [src/client/batch/runner.ts, src/client/batch/runner.test.ts]
iterations: 0
test_files: [src/client/batch/runner.test.ts]
branch: ""
---

## Scope

**ADD `src/client/batch/runner.ts`** — executes a matrix of *recordings × configurations × N
repetitions*, writing Runs to the same ledger as manual runs. No UI (ticket 013 renders
`BatchProgress`).

**The batch runner exists for control enforcement, not click reduction** (PRD §17 22f).
Counterbalancing and warmup discard are §8 requirements that a human will apply
inconsistently across 45 runs — and they are the entire reason `origin: 'sweep'` means
something. If the runner silently skips them, `origin: 'sweep'` is a lie. This ticket carries
**PRD §13 test 9 (sweep controls)**, the third of the three new tests v2 verification requires.

## Behaviour (PRD §7 "The batch runner", §8 register)

- **Sequential, never concurrent.** Concurrent streams contend for network and CPU and the
  effects measured are ~100 ms (§17 14g).
- **Counterbalanced run order** across repetitions: A→B on odd reps, B→A on even. Always
  running A first systematically advantages or penalises one arm if provider latency drifts
  across the sweep window.
- **Warmup discard**: an **extra, uncounted warmup run per configuration** is executed first and
  discarded — cold connection and cold provider inflate the first call and it is not
  representative. Discarded means *not aggregated*; the runner records that it discarded.
  **`reps` means RETAINED reps.** Total executions per cell = `reps + 1`. The PRD is decisive:
  §8 "60 samples per arm (12 utterances × 5 repetitions)", §17 22c "5 repetitions **retained**",
  §7 "3 recordings × 5 reps × 2 arms = 30 runs", and the mock's batch note "first run per
  configuration discarded as warmup" (an ADDITIONAL run, not one of the five). Treating the
  warmup as one of the 5 would silently cost 20% of N and weaken p95 — and the fatter cascade
  tail is precisely what 5 reps were chosen to resolve.
- **`origin: 'sweep'`** on every retained run.
- **A failed run does not abort the batch**: it is retried **once**, then recorded
  `status: 'failed'`, and the batch continues. Failures are summarised at the end rather than
  interrupting an unattended ~68-minute operation.
- **Cancellable at any point, retaining completed runs.** A cancelled sweep is a short sweep,
  not a discarded one.
- **Progress is observable**: current run, position in the matrix, elapsed, estimated
  remaining.
- **Short rep counts are surfaced, not hidden** — the summary reports actual vs intended reps
  per configuration so the results provenance can say `4 of 5`.

## Acceptance criteria

- [ ] Executes the full matrix `recordings × configurations × reps` **sequentially** — at no
      point are two runs in flight (assert with an injected runner that would observe overlap)
- [ ] **Counterbalancing**: with two configurations, odd-numbered reps run them in order
      [A, B] and even-numbered reps in [B, A]. Assert the actual execution order across ≥4 reps
- [ ] **Warmup discard**: an extra uncounted warmup run per configuration runs first and is
      excluded from the aggregated set; with `reps: 5`, **5 are retained** per configuration and
      6 executions occur (`intendedReps === reps`, never `reps - 1`)
- [ ] The discard is **recorded**, not silent — the batch summary states that warmup was
      discarded and counterbalancing applied
- [ ] Every retained run carries `origin: 'sweep'`
- [ ] A run that fails is **retried exactly once**; if the retry succeeds the run is retained
      as complete; if it fails again it is recorded `status: 'failed'` and **the batch
      continues** to the next matrix cell
- [ ] A failed cell does not consume the retry budget of any other cell
- [ ] `cancel()` mid-batch stops promptly, **retains every already-completed run**, and the
      summary reports the batch as cancelled with the completed count
- [ ] Progress is emitted per run with position in the matrix (e.g. run 17 of 45), the current
      recording × configuration, rep index, elapsed, and an estimated remaining
- [ ] The end-of-batch summary reports, per configuration, **actual completed reps vs intended**
      — the input to the results provenance line
- [ ] The runner drives ticket 008's single-run execution rather than reimplementing it, so a
      sweep run goes through the *same code path* as a manual run (PRD §8: "There is no
      separate harness")

## Test plan

New `src/client/batch/runner.test.ts` (jsdom), injecting a fake single-run executor and a fake
clock so the matrix runs instantly and execution order is directly observable. **No real
timing, no network.**

## Attempt log

## Correction (orchestrator, after the first test-writing pass)

The first draft said "the first run per configuration is discarded ... with 5 reps, 4 are
retained". That was **wrong**, and the tests faithfully encoded it. The PRD pins `reps` as
retained (§8's 60-sample arithmetic, §17 22c's "5 repetitions retained", §7's 30-run matrix), so
the warmup is an **additional** execution. Corrected through the test-writer, not by editing
locked tests.

- iter 1 (after a test-writer correction pass on reps semantics): green. 18 tests, `tests 6ms` —
  a nominally ~68-minute sweep is exercised entirely on a fake clock.
- Mutation-checked, both sweep controls independently: removing counterbalancing (always declared
  order) fails 2 tests; promoting the warmup to a counted rep fails 4. PRD §13 test 9 holds.
- Per-run timeout closes the hang gap ticket 008 left open: rejection, resolved-`failed`, and
  timeout all funnel to one failure path, each retried once.
