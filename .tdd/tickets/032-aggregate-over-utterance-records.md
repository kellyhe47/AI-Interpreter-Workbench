---
id: 032
title: Aggregate over utterance records — the by-category table, real N, honest provenance
status: pending
source: v3-corpus
depends_on: [031]
touches: [src/client/components/results/derive.ts, src/client/state/ledger.ts, src/client/views/ResultsView.tsx]
iterations: 0
test_files: []
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

## Notes for the implementer

- This is the ticket where an error becomes a *published wrong number*. Mutation-check each of:
  reps vs utterances not conflated; failed utterances excluded from figures but counted in
  attempts; the gate not bypassed at record level.
- `derive.ts`'s `RunAnnotations.category` and `utteranceId` become derivable from the record —
  reconcile the two representations rather than carrying both silently.
