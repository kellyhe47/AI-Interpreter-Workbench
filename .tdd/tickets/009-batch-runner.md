---
id: 009
title: Batch runner — sequential sweep with counterbalancing and warmup discard
status: pending
depends_on: [001, 008]
touches: [src/client/batch/runner.ts, src/client/batch/runner.test.ts]
iterations: 0
test_files: []
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
- **Warmup discard**: the **first run per configuration is discarded** — cold connection and
  cold provider inflate the first call and it is not representative. Discarded means *not
  aggregated*; the runner records that it discarded.
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
- [ ] **Warmup discard**: the first run of each configuration is marked discarded/excluded and
      does not enter the aggregated set; with 5 reps, 4 are retained per configuration
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
