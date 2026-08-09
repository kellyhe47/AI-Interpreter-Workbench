---
id: 065
title: "\"Batch sweep…\" launches 18 executions immediately — the ellipsis promises a dialog that does not exist"
status: done
source: spec-audit (verified)
depends_on: []
touches: [src/client/views/ReplayView.tsx, src/client/components/replay/RunConfigPanel.tsx]
iterations: 1
test_files: []
branch: main
---

## Observed — re-verified 2026-08-08

`Batch sweep…` (label constant `RunConfigPanel.tsx:96`) calls `startSweep` (`ReplayView.tsx:546-562`,
wired at `:717`) **synchronously on click**. There is no dialog: a repo-wide search finds **no dialog
primitive anywhere in `src/client`** — zero non-test hits for `<dialog`, `role="dialog"`, `Modal`, or
`confirm(`.

What one click actually starts:
- **1** recording — `recordingIds: [selectedRecordingId]`; the library is single-select
- **3** hardcoded arms — `sweepConfigurations()` (`ReplayView.tsx:361-363`) maps the frozen `ARMS`
  (`src/core/arms.ts:110-134`, `deepFreeze`d, tags A/B/C)
- **`SWEEP_REPS = 5`**, hardcoded at `ReplayView.tsx:288`, no UI control
- ⇒ **18 executions** = 1 × 3 × (5 + 1). The `+1` is the uncounted warmup per cell
  (`src/client/batch/runner.ts:26-36`); `runner.ts:308` computes
  `totalRuns = recordingIds.length * configurations.length * reps` = **15**, warmups EXCLUDED.

No cost estimate, no time estimate, no confirmation. PRD §7 scale (`PRD.md:365`, restated at `:717`):
*"roughly $4 and ~68 minutes of unattended wall-clock."*

## Scope note — read before designing

PRD §7 specifies *"selected Recordings × selected configurations × N repetitions"*, but it requires
progress **during** the batch, which exists and works (verified: cancel keeps completed runs). **It
does not literally require a pre-launch estimate.** The defect is the gap between the ellipsis
affordance and the immediate launch — a trailing ellipsis is a promise of a next step.

The cheapest honest fix may be to **remove the ellipsis and add a confirmation naming the cost**,
not to build a matrix picker. `PRD.md:963` §15A cut 5-rep sweeps to 3 (`PRD.md:970`), so the reps
control may be moot — but note `ReplayView.tsx:284-288` and `runner.ts:235-237` both still cite
"PRD §17 22c, five reps". §15A and §17 22c disagree in the document itself; §15A is dated later
(2026-08-09) and wins.

## Acceptance criteria

- [ ] The visible button label contains no trailing ellipsis **unless** clicking it opens an
      intermediate step before any executor call — assert `deps.startBatch` has been called zero
      times immediately after the click
- [ ] Before the sweep starts, the operator is shown the **execution count including warmups**
      (`recordings × configurations × (reps + 1)`, = 18 at today's defaults) — assert the rendered
      number is 18 and **not** 15, since `runner.totalRuns` reports 15
- [ ] The operator is shown an estimated **wall-clock** derived from the selected Recording's
      `durationMs` × total executions (replay is paced at 1×), not a constant
- [ ] The operator is shown an estimated **cost**, or the words `not measured` when no price is
      available — never `$0.00`
- [ ] The sweep starts only after an explicit confirm; a cancel/dismiss calls `deps.startBatch`
      zero times and opens no `[data-batch-progress]` panel
- [ ] `SWEEP_REPS` is 3, matching §15A, **or** is operator-settable and defaults to 3; the value the
      operator sees in the estimate is the value passed as `reps` to `startBatch`
- [ ] Every estimate scales with reps — assert that changing reps from 3 to 5 changes the execution
      count by `configurations` × 2, proving the reps multiplier is in the arithmetic

> already satisfied: "Cancel-keeps-completed still works." Verified working and locked by
> `src/client/batch/runner.test.ts` and `ReplayView.inflight.test.tsx:488-500`. Kept only as a
> regression note below, not as a criterion to implement.

> already satisfied: "the ellipsis opens something, or it goes" as a single item — it was two
> criteria wearing one checkbox, and split above into the label rule and the confirm-gate rule.

## Out of scope

- Building a matrix picker (multi-Recording or per-arm selection). The library is single-select and
  stays that way for this ticket.
- The batch runner's internals: counterbalanced A→B/B→A ordering, uncounted warmup, per-run timeout
  race, single retry, cancel-keeps-completed. **This ticket is about the front of it only.**
- Changing `ARMS` in `src/core/arms.ts`. It is `deepFreeze`d and derivation-owned.
- The in-flight `BatchProgress` panel (`components/replay/BatchProgress.tsx`) and its
  `estimatedRemainingMs`, which is computed during the run and already works.
- Real pricing lookups. If no price source is in force, the estimate says `not measured`.

## Notes
- The batch runner itself is good. This ticket is about the front of it only.

## CONTEXT FOR A FRESH AGENT

### 1–2. Verified citations, with the code

`src/client/views/ReplayView.tsx:546-562` — the whole launch path.
```ts
  const startSweep = (): void => {
    if (selectedRecordingId === null || sweep !== null) return;
    const configurations = sweepConfigurations();
    const handle = deps.startBatch({
      recordingIds: [selectedRecordingId],
      configurations,
      reps: SWEEP_REPS,
      onProgress: (progress) =>
        setSweep((previous) => (previous === null ? previous : { ...previous, progress })),
    });
    setSweep({ handle, configurations, reps: SWEEP_REPS, progress: null });
    // A cancelled sweep is a SHORT sweep: whatever completed is still listed.
    void handle.done.then(() => {
      setSweep(null);
      void refreshRuns();
    });
  };
```

`src/client/views/ReplayView.tsx:284-288` and `:361-363`.
```ts
/**
 * Retained repetitions per (recording × configuration) cell — PRD §17 22c.
 * The warmup is an ADDITIONAL execution the batch runner discards, never one
 * of these five.
 */
const SWEEP_REPS = 5;
```
```ts
/** The sweep matrix: the frozen arms, named by the derivation that owns them. */
function sweepConfigurations(): BatchConfiguration[] {
  return ARMS.map((entry) => ({ id: entry.tag, label: entry.label, config: entry.config }));
}
```

`src/client/components/replay/RunConfigPanel.tsx:96` — `const BATCH_SWEEP = 'Batch sweep…';`
(busy hints at `:89-94`; the button is `[data-batch-button]`).

`src/client/batch/runner.ts:26-36` — the counting contract, in the module header.
```
 * `reps` MEANS RETAINED REPS. Each (recording × configuration) cell executes
 * `reps + 1` times: one EXTRA, uncounted warmup first, then `reps` measured
 *   BatchOptions.reps            retained reps per recording × configuration
 *   cell executions              reps + 1  (warmup is additional, never one of them)
 *   totalRuns / attemptedRuns    recordings × configurations × reps — warmups EXCLUDED
 *   BatchProgress.totalRuns      the same measured count (3 × 3 × 5 = 45)
 *   BatchExecutorRequest.repIndex 1-based for counted reps; 0 for the warmup
```
`src/client/batch/runner.ts:308` — `const totalRuns = recordingIds.length * configurations.length * reps;`

`src/core/arms.ts:110-134` — `export const ARMS: readonly ArmDefinition[] = deepFreeze([...])`,
three entries, tags `'A'`, `'B'`, `'C'`.

`PRD.md:365` / `PRD.md:717` — the $4 / ~68 min scale figure, both stating replay is paced at 1× so
duration is bounded by real time.
`PRD.md:963` — `## 15A. Cut — 2026-08-09`; `PRD.md:970` — the row cutting 5-rep sweeps to 3.

### 3. Existing test files — where this ticket's tests must land

STANDING POLICY: no new test file in a module that already has one. `ReplayView.tsx` already has
five. **This ticket's tests go in `src/client/views/ReplayView.test.tsx`** (it owns the batch-sweep
launch behaviour). Do not create `ReplayView.sweepConfirm.test.tsx`.

You will have to **update, not bypass, these existing locked assertions** — each one asserts the
current no-dialog behaviour and will fail on a correct fix:
- `src/client/views/ReplayView.test.tsx:939-960` — `openSweep()` clicks `Batch sweep…` and then
  `await waitFor(() => expect(fakes.batches).toHaveLength(1))`, i.e. it asserts the click launches
  immediately. Every later test in that block funnels through this helper.
- `src/client/views/ReplayView.failures.test.tsx:448-530` — "Run and Batch sweep have no affordance
  without a selection", and `:523` "Batch sweep with a Recording selected still starts a sweep over
  it".
- `src/client/views/ReplayView.inflight.test.tsx:447-505` — the not-double-fireable / disabled-while-
  sweeping contract; `:504` lists the exact accessible name `'Batch sweep…'`.
- `src/client/views/HelpView.test.tsx:133` and `HelpView.tsx:271` mention `Batch sweep` in prose. If
  the label changes, that copy changes with it — but **`HelpView.tsx` is not in `touches`; get the
  ticket's scope amended before editing it.**
- Runner arithmetic (if you add an exported estimator there) → **`src/client/batch/runner.test.ts`**.

### 4. Seams

- **`deps.startBatch`** on `ReplayDeps` is THE injected executor seam. The tests already fake it
  (`fakes.batches[n].request` / `.emit(progress)`); see `App.test.tsx:183-187` for the minimal bag.
  Assert on `startBatch` call count for "did not launch".
- `src/client/batch/runner.ts` is the real implementation behind that seam and is where a shared
  `executionCount(recordings, configurations, reps)` helper belongs if you add one — so the estimate
  and the runner cannot drift.
- `src/client/fixtureDeps.ts` (`buildFixtureDeps`, `isFixtureMode`) for a fixture-mode host.
- Not relevant: `src/client/views/sessionTestKit.ts`, `src/client/state/hydrationFixtures.ts`,
  `src/client/components/results/testRecords.ts`, `src/client/browserDeps.ts`.
- jsdom has no AudioContext/MediaStream/RTCPeerConnection. Never construct one; there is also no
  native `<dialog>` `showModal` in jsdom, so if you reach for `<dialog>` you must render it open, not
  imperatively.

### 5. Golden evals

- **`eval/golden/08-replay-is-paced-at-1x.json`** — PRIMARY, and it is the arithmetic ground truth
  for the wall-clock estimate: a 20,940 ms recording takes ~20,940 ms of wall clock (1047 frames of
  20 ms at 24 kHz, ±10%). The time estimate is therefore
  `durationMs × recordings × configurations × (reps + 1)`, not a compute guess.
- **`eval/golden/04-provenance-reports-actual-n.json`** — the intended-vs-actual rep distinction.
  A pre-launch estimate is an *intended* N; it must never later be reported as the achieved N.
- `eval/golden/07-unmeasured-cost-is-null-not-zero.json` — applies to the cost estimate: an
  unpriced sweep estimates `not measured`, never `$0.00`.
- No other eval applies.

### 6. Known traps for this ticket

- **ACUTE — the arithmetic guard that omits the dominant term.** `runner.ts:308`'s `totalRuns`
  is **15**, not 18: it excludes the 3 warmups (20% of the bill, and 20% of the wall clock). It is
  the number already on screen in `BatchProgress` ("run 17 of 45"), so it is the number a fresh
  implementer will reach for. Likewise a per-cell estimate that forgets the `reps` multiplier
  reports one-fifth of the truth. Assert both: total = 18 at reps 5, and the count moves by
  `configurations × Δreps` when reps changes.
- **ACUTE — a test that compares a render against itself.** These are DOM tests; `ReplayView.test.tsx`
  uses `q()`/`get()` over `document.querySelector` and RTL **appends** to `document.body`. Two
  renders in one test and the first one answers your query. Call `cleanup()`, and pin the estimate to
  a **literal 18 / literal ms figure**, never to an expression re-derived from the same constants the
  component uses — that tautology passes with the warmups missing.
- **A fix with zero production callers.** Exporting `estimateSweep()` and unit-testing it, while
  `startSweep` still calls `deps.startBatch` directly on click, leaves the screen unchanged. The
  binding assertion is: click, then `expect(startBatch).not.toHaveBeenCalled()`.
- **The guard bypassed.** `startSweep`'s early return is
  `if (selectedRecordingId === null || sweep !== null) return;`. A confirm step added *inside*
  `startSweep` after that line, while `onBatchSweep={startSweep}` (`:717`) still fires on click, can
  be re-entered; and typing round it with `startBatch(request as BatchOptions)` or a `!` on the
  selection restores the immediate launch. Gate at the handler, not inside the launcher.
- **Do not regress cancel-keeps-completed** (`handle.done.then` at `:558-562` clears `sweep` and
  refreshes runs) or the disabled-while-in-flight contract.
- `SWEEP_REPS` appears twice in `startSweep` (`:552` and `:556`) — the request and the local sweep
  state. Change both or the progress panel will report a denominator the sweep is not running.

### Standing project rules

- `isAggregatableRun` is the ONE place that decides aggregation — never add a second gate.
- Arm membership is DERIVED from configuration, never declared.
- Unmeasured is `null` and renders `not measured` — never `$0.00`, never a zero.
- Never report a fixture-sourced number; never aggregate a run whose `origin` is `manual` or
  `status` is `failed`.
- The measured atom is the UTTERANCE, not the Run.
- 24 kHz PCM16 mono everywhere; `SAMPLE_RATE` in `src/core/protocol.ts` is the single source of truth.
- Live persists no audio and creates no Run records.
- Replay autoplays nothing; Live autoplays always.

## RESOLUTION (2026-08-09) — worked as one loop with ticket 066

Suite 2403 passing / 0 failing. `npm run check` (typecheck + test + eval + verify-citations) exits 0.

The press now opens `[data-sweep-confirm]` and reaches no executor; `[data-sweep-confirm-start]` is
the only path to `deps.startBatch`. `SWEEP_REPS` is 3 (PRD §15A, dated 2026-08-09, postdates §17 22c
— the document contradicted itself and §15A wins).

**Every number is derived.** `executionCount` is exported from `batch/runner.ts` and is literally
`planCells(...).length` — the same schedule `startBatch` walks — not a second formula. A test runs a
**real** batch and requires the estimate to agree with what executed while staying strictly larger
than `summary.totalRuns`, which excludes warmups. At 1 clip × 3 arms × 3 reps the dialog shows **12**
and `totalRuns` is 9.

### Two ticket premises corrected rather than built to

- **AC2 (the screen shows 18, not 15) and AC6 (`SWEEP_REPS` becomes 3) cannot both hold of the same
  screen.** At 3 reps it is 12 and 9. The 18/15 pair is preserved exactly as pure estimator
  arithmetic where reps is an argument; the screen is pinned to 12/9. **Do not "fix" the test back
  to 18.**
- **AC7 presumes an operator reps control** that AC6's fixed `SWEEP_REPS` rules out. Tested on the
  pure estimator, per the ticket's own §4 suggestion.

### The review finding that mattered most

**The quote froze; the screen behind it did not.** `SweepPlan` captured the clip and configurations
at press time, but nothing disabled the library or ticket 061's target-language control while the
dialog was open — so the operator could change either and then press Start sweep, launching the
**quoted** values while the screen showed the **new** ones. *A displayed value disagreeing with what
runs — the characteristic failure, one step further along than the one this ticket fixed.* And
`aria-modal="true"` on a non-modal panel was itself a false claim.

Fixed by making the panel genuinely modal in **both** halves: `quoteOpen` gates `selectRecording` and
`chooseTarget` (the fact), and `[data-replay-background]` carries `inert` (the affordance) — the same
fact/affordance division `run()` and `startSweep()` already make. The dialog now also **names the
pair, direction and target** it will run, so the quote is self-describing.

Also closed: the displayed execution figure was unpinned from its source (`const executions = 12`
passed everything — it only diverges when `ARMS` grows, so a source-scoped assertion was added by
necessity), and the priced branch of `[data-sweep-cost]` was never exercised because every test
mounted with `runs: []`.

**Ruling on a flagged deviation:** the cost guard reported a genuinely measured zero rate as absence,
inverting 059's other half. Fixed rather than pinned — zero is a measurement. `$0.000` renders for a
real free rate; `not measured` is reserved for the `measured === 0` case, which is the actual absence
test. AC4 is unharmed: the string it forbids is `$0.00`.

The stale "five reps" comments were finished off — five sites, one more than the review listed.
A ticket partly about a document contradicting itself should not leave its own header stale.
