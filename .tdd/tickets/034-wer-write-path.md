---
id: 034
title: WER write path — post-hoc scoring against the corpus reference
status: pending
source: v3-corpus
depends_on: [031]
touches: [src/server/routes/, src/server/storage/, src/client/components/results/derive.ts]
iterations: 0
test_files: [src/core/wer.test.ts, src/server/storage/werScores.test.ts, src/server/routes/werScores.test.ts, src/client/state/ledger.wer.test.ts, src/client/replay/werScoresClient.test.ts, src/client/components/results/derive.wer.test.ts, src/harness/exportResults.wer.test.ts]
branch: ""
---

## Scope

WER is scored AFTER a run, against the manifest's `referenceText`. The append-only Run store
deliberately has no update route, so WER needs its own destination.

**Decision to make and document: a separate append-only scores stream**, following the
blind-comparison precedent (`data/comparisons.jsonl`, its own route), rather than mutating a Run.
That keeps Runs immutable and lets a corpus be re-scored without rewriting history.

## Acceptance criteria

- [ ] A WER score is keyed by (runId, utteranceId) so it attaches to the measured atom
- [ ] Scores persist to their own append-only stream with their own route; Runs are never mutated
- [ ] WER is computed only where a `referenceText` exists — **Cantonese has none by design**
      (PRD SS9: improvised, no written script) and must report `not applicable`, never `0`
      (a zero WER is a perfect score, which is the worst possible way to render "no reference")
- [ ] Results reads WER per arm and per category from the stream
- [ ] The realness rule and the aggregation gate apply to WER exactly as to latency — no fixture-
      sourced WER, no WER from a manual or failed run
- [ ] Re-scoring the same (runId, utteranceId) is last-write-wins on read, and the history survives

## Notes

- Normalisation (case, punctuation, numbers-as-digits-vs-words) materially changes WER and must be
  ONE documented function, applied identically to reference and hypothesis. Numbers matter here:
  the `numbers-dates-dosages` category exists precisely to stress them.
- No real API calls; scoring is local string work.
