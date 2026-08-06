---
id: 011
title: Results derivation — aggregation predicate, groupings, provenance
status: green
depends_on: [001, 010]
touches: [src/client/components/results/derive.ts, src/client/components/results/derive.test.ts, src/client/components/results/testRecords.ts]
iterations: 0
test_files: [src/client/components/results/derive.test.ts, src/client/components/results/testRecords.ts]
branch: ""
---

## Scope

**MODIFY `src/client/components/results/derive.ts`** — pure derivation feeding the results
screens. **MODIFY `src/client/components/results/testRecords.ts`** — the shared test fixtures,
reshaped to `Recording` / `Run` / `LiveSession`.

No React in this ticket; `ResultsView.tsx` is ticket 015.

## What changes

1. **Aggregation predicate** updated to the ticket-010 gate: derived `armTag` matches a named
   arm **AND** `origin === 'sweep'` **AND** `status === 'complete'` (and the realness rule
   still applies on top).
2. **`groupBy` for Recording and for utterance category.** Per PRD §8, the per-Recording
   grouping is low-information by construction (categories are distributed evenly across
   recordings) but it is how you navigate your own recordings and **ad-hoc runs appear nowhere
   else**. Per-category is where the findings actually live.
3. **Provenance reports ACTUAL N, never intended N.** If a sweep intended five repetitions and
   one failed, the line reads `4 of 5 reps completed`. Silently aggregating over four samples
   while the line claims five is exactly the class of quiet error the PRD exists to prevent.

`testRecords.ts` must include, at minimum: a clean multi-rep sweep, **a failed run**, **an
ad-hoc/manual run**, and **a short-rep-count case** (fewer completed reps than intended) — the
three cases the results screens have to render honestly.

## Acceptance criteria

- [ ] The experiment aggregate over a mixed set includes only sweep-origin, complete,
      named-arm runs — and one test asserts each of the four exclusion reasons individually
      (ad-hoc tag / manual origin / failed status / fixture-sourced)
- [ ] Provenance for a configuration with 4 completed of 5 intended reps reports
      **actual 4** and intended 5 (e.g. `{completedReps: 4, intendedReps: 5}`), and the
      p50/p95 are computed over the 4 — the number and the line agree
- [ ] Provenance carries the PRD §8 fields: utterance count, repetitions, pinned endpointing
      value (500 ms), and corpus version
- [ ] `groupByRecording` returns one row per (recording × configuration), **including** ad-hoc
      and manual runs, and marks them as excluded-from-experiments
- [ ] `groupByCategory` groups on the utterance category tag, not on the recording
- [ ] Both groupings are computed from the **same** ledger data as the experiment aggregates —
      no second source of truth, so a metric cannot drift between screens
- [ ] Exp 2's WER cell is representable as "— (STT unchanged)" rather than a fabricated
      number: only TTS differs between B and C, so there is no STT delta to report
- [ ] `LiveSession`-sourced derivation (the conversation-length screen) is computed from
      LiveSessions only and never mixes in Runs
- [ ] With an empty ledger every derivation returns an explicit empty state — no zeros
      masquerading as measurements, no sample data
- [ ] Nothing in `derive.ts` contains a hardcoded latency, cost, WER or quality figure — every
      number is computed from records passed in

## Test plan

Rework `src/client/components/results/derive.test.ts` structurally (manifest Tests table).
Drive the exclusion cases table-style off `testRecords.ts`.

## Attempt log

- iter 1: green. 48 tests (26 new + 22 v1 guards). Additive: the v1 `deriveResultsModel` surface
  and `ResultsView.test.tsx` stayed green throughout; ticket 015 deletes the v1 block.
- Mutation-checked by the orchestrator: weakening the aggregate from `isAggregatableRun` to bare
  `isRealRun` (i.e. dropping the armTag/origin/status conditions) turns 5 tests red.
- Grouping keeps excluded runs with `n: 0` and NULL percentiles rather than a zero — a zero would
  read as a measurement.
