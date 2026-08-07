---
id: 032
title: Aggregate over utterance records — the by-category table, real N, honest provenance
status: green
source: v3-corpus
depends_on: [031]
touches: [src/client/components/results/derive.ts, src/client/state/ledger.ts, src/client/views/ResultsView.tsx]
iterations: 0
test_files: [src/client/components/results/derive.utterances.test.ts, src/client/views/ResultsView.category.test.tsx]
branch: ""
---

## Why — read `.tdd/tickets/README-v3-corpus.md`

PRD §8: *"One record per utterance per arm"*; the ledger is *"a single append-only run ledger of
utterance records"*. Every aggregate today is computed per-Run, which under a multi-utterance
corpus is wrong by construction.

## Scope

Aggregations read `Run.utterances[]` when present and fall back to the Run-level sample when not.

- **By utterance category** fills for the first time — `groupByCategory` groups on the record's
  `category`, which now exists. PRD §8 calls this *"where the heterogeneity actually lives … the
  grouping that produces findings"*.
- **By Recording** aggregates that recording's **20 samples (4 utterances x 5 reps)**, per §8.
- **Experiment aggregates** reach **60 samples per arm** (12 utterances x 5 reps).
- **Provenance** `utteranceCount` becomes a real count of distinct utterances, not a fallback to
  `recordingId`.

## Acceptance criteria

- [ ] `groupByCategory` returns one row per (category x derived arm) and is non-empty for a ledger
      of manifest-backed runs — with a fixture asserting all six categories
- [ ] p50/p95 for an arm are computed over **utterance records**, not Runs: 3 recordings x 4
      utterances x 5 reps = 60 samples for that arm
- [ ] **The gate is applied per record via its parent Run** — a record inherits its Run's
      `origin`/`status`/derived arm. `isAggregatableRun` is unchanged; add the record-level
      selector beside it rather than editing it.
- [ ] A `failed` utterance inside a `complete` Run is excluded from figures but still counted in
      attempts (this is 027's rule, one level down)
- [ ] Provenance `utteranceCount` is the distinct utterance count; `4 of 5 reps completed` still
      derives from `repIndex` and does not double-count utterances as reps
- [ ] Runs with **no** `utterances[]` still aggregate exactly as today — every existing derivation
      test stays green untouched
- [ ] No figure moves for any ledger that has no manifest-backed runs

## The shape 031 actually fixed — aggregate against THIS

```ts
export interface RunUtterance {
  utteranceId: string;   // manifest CorpusUtterance.id
  index: number;         // 1-based, manifest order (transport utt === index - 1)
  category: CorpusCategory;
  timings: Record<string, number | null>;   // per-utterance; speech_end from the MANIFEST
  transcripts: { source?: string; target?: string };
  cost: number;          // Run cost split by manifest span; the splits sum back to run.cost EXACTLY
  status: 'complete' | 'failed';
  errors: string[];
}
// Run gains: utterances?: RunUtterance[]
```

Decisions inherited from 031 that this ticket must respect:

- **Run-level `timings`/`transcripts`/`cost` keep TODAY's semantics verbatim** (last-mark-wins,
  first-audio-overall, whole-clip cost) and a 031 regression test pins that. 031 was purely
  additive so no figure moved. **If 032 wants the Run-level fields to become aggregates, it must
  change them CONSCIOUSLY and update that pin through the test-writer** — never drift into it.
- The per-utterance latency sample is `timings.audio_queued - timings.speech_end`, same formula as
  the Run-level one, so the two cannot disagree about what latency means.
- An utterance with no output audio is `status: 'failed'` with `audio_queued: null`. It does NOT
  fail its Run. That is 027's rule one level down: excluded from figures, still counted in attempts.
- A Run whose segmentation disagreed with its manifest has `status: 'failed'` and **no**
  `utterances` at all — so it can never contribute a partial, mis-attributed sample.
- `RunUtterance.errors` is narrow in practice: `TransportError` carries no `utt`, so a stage failure
  cannot be attributed to one utterance. Do not build a category finding on per-utterance errors.

## Notes for the implementer

- This is the ticket where an error becomes a *published wrong number*. Mutation-check each of:
  reps vs utterances not conflated; failed utterances excluded from figures but counted in
  attempts; the gate not bypassed at record level.
- `derive.ts`'s `RunAnnotations.category` and `utteranceId` become derivable from the record —
  reconcile the two representations rather than carrying both silently.

## Attempt log

- Green in one implementation pass, 49 red -> 0. Suite 1265/68; both tsconfigs clean; build clean.
- **The double-counting trap is closed STRUCTURALLY, not by a check.** `runSamples(run)` is an
  either/or, never a union: a Run carrying records returns ONLY its records, and the Run-level
  fallback is emitted solely in the `records === undefined || records.length === 0` branch. Every
  consumer — `runAggregates`, `groupByRecording`, `groupByCategory`, provenance — goes through that
  one function, so there is no second path that could re-add the container's own sample. Hence 60,
  never 75.
- `runAggregates()` in the LEDGER became record-aware; `derive.ts` still delegates rather than
  reimplementing the gate, which a locked test pins. `isAggregatableRun` is byte-identical.
- `pairedLatencyMs(timings)` reads `audio_queued - speech_end` out of ONE timings map, so a Run's
  stamp can never be crossed with a record's.
- Orchestrator rulings taken during the ticket:
  1. `Provenance.attemptedSamples` APPROVED — `intendedReps` is about reps and a failed utterance
     loses no rep, so without it a 20-attempt/18-measured arm is indistinguishable from a clean one.
  2. `UtteranceCategory` now points at `src/core/corpus.ts` (canonical, compiled by both tsconfigs)
     rather than `harness/corpus.ts` (the pre-22a synthetic placeholder). Live drift risk closed.
  3. `RunAnnotations.category`/`utteranceId` KEPT as the record-less fallback; the record wins.
  4. `groupByRecording` expanding ad-hoc/manual Runs into records is INTENDED — PRD §8 makes
     By Recording the one place ad-hoc runs are visible, so `n = 4` for a 4-utterance ad-hoc Run is
     right exactly as `n = 1` was right before.
- Mutation-checked, four properties, each independently load-bearing:
  | mutation | result |
  |---|---|
  | emit the Run-level sample ALONGSIDE its records (double count) | 36 red |
  | parent gate ignored at record level | 21 red |
  | category rows keyed on category alone, dropping the arm | 18 red |
  | a failed utterance counted as a figure | 4 red |
- Test-writer's reference check caught a real design error before it shipped: category rows are
  **(category x arm)**, not category alone — a mixed ledger yields three rows, and a category-only
  lookup silently picks the wrong arm's numbers.
- `costPerMinuteUsd` deliberately keeps a Run-level denominator: the clip is played once per Run,
  so treating each record's audio as a whole clip would quarter it.
