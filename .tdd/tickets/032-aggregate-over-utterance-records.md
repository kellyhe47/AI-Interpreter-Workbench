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
