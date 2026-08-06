---
id: 028
title: Run annotations are never persisted — provenance can only ever report "N of N", category table can never fill
status: pending
source: qa
depends_on: []
touches: [src/client/batch/runner.ts, src/client/batch/runner.test.ts, src/server/storage/types.ts, src/client/state/ledger.ts, src/client/components/results/derive.ts]
iterations: 0
test_files: [src/harness/repIndexRoundTrip.test.ts, src/client/batch/runner.test.ts, src/client/state/ledger.test.ts, src/server/storage/runs.test.ts, src/server/routes/runs.test.ts, src/client/components/results/derive.test.ts]
branch: ""
---

## Severity: HIGH — and it is invisible until the corpus exists

This defect cannot be seen today because there is no corpus and no real sweep. It surfaces at the
worst possible moment: after the operator records the corpus and runs the sweeps, when the numbers
are supposed to be trustworthy. Found by reading the write path during QA iteration 2, then
confirmed against the running app.

## The defect

`src/client/components/results/derive.ts:192` defines the analysis envelope:

```ts
export type AnnotatedRun = Run & { annotations?: RunAnnotations };
// RunAnnotations: utteranceId?, category?, repIndex?, corpusVersion?, wer?
```

Everything in Results reads from it. **Nothing in the production write path ever populates it.**
A repo-wide search finds `annotations` written in exactly three places — `hydrationFixtures.ts`,
`components/results/testRecords.ts`, and `ReplayView.test.tsx` — all test/fixture code. The
persisted `Run` (`src/server/storage/types.ts:45`) has no `annotations` field at all, and neither
`category`, `utteranceId` nor `corpusVersion` appears anywhere in `src/server` or `src/core`.

### Consequence 1 — provenance can only ever say "N of N" · the load-bearing one

`buildProvenance` (`derive.ts:387-391`):

```ts
const attemptedRepIndices = distinct(attempted.map((r) => r.annotations?.repIndex));
const intendedReps = attemptedRepIndices.size > 0 ? attemptedRepIndices.size : completedReps;
```

With `repIndex` always `undefined`, the set is always empty, so `intendedReps` **always** falls
back to `completedReps`. The denominator is structurally incapable of exceeding the numerator.

Observed in the running app: Arm B, one complete sweep run and one failed sweep run against the
same Recording, provenance reads `1 of 1 reps completed`.

This is precisely the failure mode the project exists to prevent — AGENTS.md: *"**Provenance
reports ACTUAL N, never intended N.** … A line that claims 5 while aggregating 4 is the failure
mode this project exists to prevent."* The line here does not overstate the numerator; it
understates the denominator, and the reader is misled identically. A sweep that lost reps to
failures will report a clean, complete-looking run.

The fix is available today and does not need the corpus: `createRunOnceExecutor`
(`runner.ts:476`) already receives `request.repIndex` and already stamps `request.origin` onto the
Run on its way to `create()`. It drops `repIndex` on the floor.

### Consequence 2 — the category table can never fill

`groupByCategory` (`derive.ts:531`) skips any run without `annotations.category`, so
**"By utterance category — where the heterogeneity lives"** renders zero rows no matter how many
real sweeps run. PRD §9's six-category grouping — the analysis the corpus was designed around — has
no data path to reach it.

QA note: iteration 2's report listed this empty table under "known-empty by design, blocked on the
corpus". That was wrong, and this ticket corrects it. The corpus alone will not fill it.

### Consequence 3 — corpus version and WER

`corpusVersion` is always null, so every provenance line ends `corpus version unrecorded` — also
dismissed as a test-data artifact in iteration 2, also wrong. `wer` has no write path either, so
WER stays `not yet measured` permanently.

## Scope: what is fixable now vs. what needs the corpus model

**Fixable now — this ticket's required scope:**

- `repIndex` — the runner has it; thread it through to the persisted Run.
- The persistence envelope itself: `Run` needs somewhere for annotations to live and survive a
  round trip through `ledger.jsonl` and back out through `hydrateLedger`.

**Needs a corpus metadata model that does not exist yet:** `utteranceId`, `category` and
`corpusVersion` have no source — a `Recording` carries no category or utterance identity, on either
the client or the server. Wiring them is a design question about how the corpus is described, and
it is reasonable to defer it. **Do not silently skip it — extend this ticket's notes with what a
corpus-metadata model would need, so the operator's corpus work and this plumbing land together
rather than discovering each other later.**

## Acceptance criteria

- [ ] A Run produced by a batch sweep persists its `repIndex`, and that value survives the round
      trip: POST → `ledger.jsonl` → `hydrateLedger` → `groupByRecording` / `buildProvenance`
- [ ] The warmup run (repIndex 0, `origin: 'manual'`) still fails the aggregation gate — the
      annotation must not become a second way into the aggregate
- [ ] A cell with 5 attempted sweep reps of which 4 completed renders `4 of 5 reps completed`,
      with the p50 beside it computed over the 4 — verified end to end, not just in `buildProvenance`
- [ ] A cell whose reps all completed still renders `5 of 5` — no off-by-one from counting the warmup
- [ ] Runs carrying no annotations (every run written before this change) still render, with the
      current fallback behaviour, and no existing figure moves
- [ ] `isAggregatableRun` is unchanged
- [ ] The persisted envelope is additive: existing `ledger.jsonl` lines remain readable, and the
      tolerant reader still skips a malformed line

## Notes for the implementer

- Storage is append-only and the reader is tolerant — the new field must be optional at every layer.
- `src/client/**` cannot import `src/server/**`; mirror the type as the codebase already does.
- Mutation-check the denominator specifically: delete the `repIndex` stamp and confirm a test goes
  red with `4 of 5` collapsing to `4 of 4`. That single assertion is the whole point of the ticket.
