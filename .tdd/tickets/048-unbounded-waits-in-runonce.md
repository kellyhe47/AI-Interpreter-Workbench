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

---

## ROUND 2 — code review findings (independent reviewer, against `3c03c7a`)

The replay-side work is correct and well-falsified: both deadlines, the fatal/non-fatal split, the
series-not-nested close, and the suite around them survive every mutation that matters (13 caught).
**The flagged judgement call — arming the completion deadline for every run — was verified RIGHT:**
`idleTimer` is armed once at pacing end for every manifest-backed run and is a fixed 5 s deadline,
not an idle-reset, so such a run always resolves `finished` within 5.25 s of pacing and can never
reach the 30 s budget; its named segmentation reason is preserved unconditionally. Budget arithmetic
checks out — the completion deadline starts AFTER `await pacer.start()`, so a 45 s clip does not
consume it. Worst-case sane run ~62 s against the 120 s backstop.

The problem is the BATCH side. Making the timeout real without a teardown path created three
defects, one of which fabricates a wrong number.

### R2-1 (MAJOR — silently wrong number) — a bounded-out attempt can still POST, giving ONE rep TWO aggregatable Runs
`batch/runner.ts:338`. The budget abandons `pending` but nothing STOPS it. `runOnce` reads `signal`
exactly once (`replay/runner.ts:734`, right after pacing), so an attempt that blows the budget AFTER
pacing — a stalled `runs.create`, a stalled upload — ignores the abort, finishes, and POSTs an
`origin: 'sweep'`, `status: 'complete'` Run carrying `annotations.repIndex`, WHILE the retry POSTs
its own.

Demonstrated by probe (`runTimeoutMs` 5 s, first sweep POST stalls 10 s):
```
posted: run-1 manual complete rep0 | run-3 sweep complete rep1 | run-2 sweep complete rep1
summary.failures = []        summary.runs = 1        aggregatable sweep runs for rep 1 = 2
```
**The sweep summary is CLEAN.** `derive.ts:548` counts DISTINCT `repIndex`, so provenance reads
"1 of 1 reps completed" while p50/p95/`n` are pooled over two samples of the SAME rep. Silent
double-weighting of one measurement — exactly the class of dishonesty AGENTS.md exists to prevent.
Nothing in the branch tests it.
**DECIDED:** make the abandoned attempt unable to write. The timer calls `controller.abort()` BEFORE
resolving, so an abandoned run can see it: gate `uploadOutputAudio` and `await deps.runs.create(run)`
on `signal?.aborted` AT THAT INSTANT, rather than on the `cancelled` snapshot taken at line 734.

### R2-2 (MAJOR) — a bounded-out attempt leaves a LIVE TRANSPORT running beside its retry
Probe with a stall inside `transport.start()`: `maxConcurrentTransports = 2`. The abandoned run still
holds its transport — for Arm A that is the outbound sink PLUS the inbound tap, two `AudioContext`s
— while the retry builds its own. **Ticket 046's entire premise is that Chrome caps concurrent
contexts at ~6 and exceeding it kills a run.** Making the timeout real without teardown reintroduces
that pressure at exactly the moment the sweep is already unhealthy, and partially reverses 046's
reasoning without naming it.
**DECIDED:** `runOnce` must honour a late abort at its next await so the abandoned run tears its
transport down. Same mechanism as R2-1 — re-read the signal rather than trusting the pacing-time
snapshot.

### R2-3 (MAJOR) — a bounded-out rep is INVISIBLE to the provenance denominator
`batch/runner.ts:349` and its comment claim *"there is no Run at all, so nothing needs excluding
downstream."* True for exclusion, FALSE for counting: `intendedReps` is distinct
`annotations.repIndex` over sweep-origin Runs of ANY status (`derive.ts:551`). A rep that produced
no Run is not in the denominator, so a sweep that lost rep 3 to the budget renders a clean
**"4 of 4"**. AGENTS.md names this verbatim — *"the denominator silently falls back to the numerator
and every line reads a clean N of N."* Pre-existing, but before 048 the timeout never fired, so this
branch is what makes it reachable.
**DECIDED:** persist a FAILED Run stub for a bounded-out attempt, carrying `repIndex`, so the rep
appears in the denominator and is excluded from the numerator by the existing `status` clause. No
second gate.

### R2-4 (MINOR) — the upload budget is a WHOLE-TRANSFER budget, not time-to-first-byte
`replay/runner.ts:203`. A 45 s clip's output WAV is ~2 MB; 10 s demands ~1.7 Mbps sustained. Fine on
localhost, marginal on the planned EC2 + Caddy deploy over a home uplink. The cost is not a lost
measurement (correct) but a silently missing `outputAudioPath` — and **blind compare is
playback-only, so it needs that artifact.**
**DECIDED:** raise `AUDIO_UPLOAD_TIMEOUT_MS` to 30_000 and say in the constant's doc that losing it
costs BLIND-COMPARE ELIGIBILITY, not merely "the bytes".

### R2-5 (MINOR) — the cancelled-yield on the bounded-out path is untested
`batch/runner.ts:352`. Deleting `if (cancellation.signal.aborted) return { kind: 'cancelled' }`
leaves 93/93 green. Pin it, in both directions.

### R2-6 (MINOR) — both `void pending.catch(() => undefined)` lines are DEAD
`replay/runner.ts:337`, `batch/runner.ts:336`. `Promise.race` already attaches a handler to both
branches, so removing either keeps the suite green AND raises no unhandled rejection. Defensible as
armour — but the comments claim they are what prevents the leak, and what the AC5 tests actually pin
is the RACE SHAPE (the naive `new Promise(r => { p.then(r); setTimeout(...) })` form IS caught).
**DECIDED:** keep the lines, reword the comments to say what is actually load-bearing.

### R2-7 (MINOR) — name the remaining unbounded awaits
`runner.ts:587` `recordings.get`, `:590` `getAudio`, `:716` `transport.start()`, `:941`
`runs.create` are bare fetches/handshakes with no timeout — and they are precisely the stalls that
produce R2-1..R2-3. Name them in the header as considered-and-delegated-to-`runTimeoutMs`, or the
next reviewer files this same ticket a fourth time.

### R2-8 (MINOR) — `runner.unboundedWaits.test.ts:498` hardcodes `120_000`
`browserDeps`' `RUN_TIMEOUT_MS` is not exported, so the ordering guard rots silently if it moves.
Export it and import it.

---

## ROUND 3 — re-review of round 2 (independent reviewer)

The R2-1 probe was re-run across FOUR stall points, not just the one named, each ending in a real
`RunLedger` -> `deriveExperimentAggregates`:

| stall point | aggregatable sweep Runs for rep 1 | provenance | max concurrent transports |
|---|---|---|---|
| upload | **1** OK | n=1, 1 of 1 | 1 |
| `recordings.getAudio` | **1** OK | n=1, 1 of 1 | 1 |
| `transport.start()` | **1** OK | n=1, 1 of 1 | **2** |
| **`runs.create`** | **2** WRONG | **n=2, "1 of 1"** | 1 |

Round-1 battery re-run with no regressions, and m16 (a round-1 slip) is now CAUGHT. Both re-reads
verified independently load-bearing. The reason gate was traced airtight in both directions
(cancel-then-budget keeps the cancel reason and writes no stub; budget-then-cancel keeps the budget
reason and the stub was already owed) and `wrote` is genuinely race-free (`wrote = true` is the
first statement of the `create` wrapper, before any await, and `abort()` dispatches listeners
synchronously). **R2-3 is the strongest test in the branch** — it drives the real executor, builds a
real ledger, and asserts the RENDERED "2 of 3 reps completed".

### R3-1 (MAJOR) — R2-1 SURVIVES for a stalled `runs.create`
`replay/runner.ts:1047` (last re-read) and the executor's `create` wrapper. Probe with the stall
inside `deps.runs.create`:
```
posted: run-1 manual complete rep0 | run-3 sweep complete rep1 (retry)
      | run-2 sweep complete rep1 (abandoned attempt, POST landed at 10 s)
aggregatable sweep runs for rep 1 = 2     provenance n=2, completedReps=1, intendedReps=1
summary.failures = []
```
The last re-read sits immediately BEFORE `deps.runs.create(run)`, so an abort landing while the POST
is IN FLIGHT is too late. Worse: the wrapper sets `wrote = true` at CALL time, so `onAbandoned` also
declines to write a stub — **the guard actively converts this case into the duplicate rather than
the accounted one.** p50/p95/`n` pooled over two samples of one repetition, provenance reading clean.
**No test stalls `runs.create`.** The header's new claim that delegating it to `runTimeoutMs` "buys
nothing" is false — it demonstrably buys a duplicate aggregatable sample.
**DECIDED:** bound `runs.create` inside `runOnce` with its own deadline strictly shorter than
`runTimeoutMs`. The attempt then RETURNS and is never retried, so no second sample can exist. The
alternatives do not work: you cannot un-POST, and the batch cannot know the attempt already wrote.

### R3-2 (MAJOR, test quality) — both mechanisms round 2 INVENTED are entirely unpinned
Three separate deletions each leave **1848/1848 green**:
| mutation | consequence (probed, not theorised) |
|---|---|
| drop the `reason !== RUN_BUDGET_EXCEEDED` guard | operator **cancel** writes a `sweep`/`failed` stub into the APPEND-ONLY ledger — contradicts "a cancelled run is never POSTed" and R2-5's own pin, and permanently records the operator's decision as a pipeline failure |
| drop `if (wrote) return;` | the stalled-POST case writes a stub BESIDE the real Run for the same execution |
| drop `wrote = true` from the `create` wrapper | same double-write |
The design is correct and the logic is airtight — but its correctness rests entirely on statement
ordering that nothing protects, and each deletion writes a FALSE ROW into an append-only stream.
**DECIDED:** pin all three. Cancel writes no stub; a budget abort writes exactly one; an execution
that already POSTed gets none.

### R3-3 (MINOR) — R2-2 holds only for aborts at a wait `runOnce` OBSERVES
Probe: abort inside `transport.start()` -> `maxConcurrentTransports = 2`, held until `start()`
resolves on its own (forever if it never does). The R2-2 test's assertions are honest for the
`finished` window they exercise, but the `describe` title "an abandoned attempt gives its transport
back" is broader than what holds.
**DECIDED:** route `transport.start()` through `untilSettledOrAborted` too — it is a promise, the
helper already fits, and teardown can then actually run. (Do not merely narrow the title; 046's
context-cap premise is what is at stake.)

### R3-4 (MINOR) — an abort landing mid-upload orphans the artifact
`runner.unboundedWaits.test.ts:611` knowingly asserts `calls === ['uploadAudio']` after the abort.
Correct call — but `runs/<id>.out.wav` is then stored for a Run that is never POSTed. Harmless to
every number.
**DECIDED:** name it as the accepted cost in the header rather than leaving it silent.

### NON-BLOCKING, confirmed by the reviewer
- `summary.failures[].runId` undefined for a budget-abandoned cell — the denominator (the thing that
  mattered) is fixed and rendered honestly, and the stub is findable by `(repIndex, arm)`. Follow-up.
- The setup-await leak — inherent to abandoning rather than terminating; the stub makes the rep
  accounted for. Same follow-up.
