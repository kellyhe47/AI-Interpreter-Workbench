---
id: 042
title: WER is computed and stored but never rendered, and nothing ever invokes the scoring pass
status: pending
source: v3-corpus
depends_on: [034]
touches: [src/client/views/ResultsView.tsx, scripts/, src/harness/]
iterations: 0
test_files: [src/client/views/ResultsView.wer.test.tsx, src/harness/scoreWer.test.ts]
branch: ""
---

## Why

Ticket 034 built the whole WER path — normalizer, scorer, append-only stream, route, client,
hydration, aggregation by arm and by category, export bundle — and it is all green. But the
operator cannot see a single WER number, for two independent reasons the 034 test-writer flagged:

1. **Nothing renders it.** `ResultsView.tsx` hardcodes the literal `not yet measured` in the
   Experiment 1 WER a/b cells and renders only `model.werCell` in the delta cell. 034's
   `deriveWerByArm` / `deriveWerByCategory` are derived and then dropped on the floor. 034's
   `touches` list omitted `ResultsView.tsx`, so the implementer correctly left the view alone.
2. **Nothing invokes the scoring pass.** `scoreRunWer` and the POST route exist; no UI control and
   no script ever calls them. The write path is complete but **unarmed** — a corpus can be recorded
   and swept and still produce zero scores.

Neither is a defect in 034. Both are the missing last mile between "WER is implemented" and "the
operator can produce WER analysis", which is what the operator actually asked for.

## Acceptance criteria

- [ ] Experiment 1's WER cells render the real per-arm figure from `deriveWerByArm` when scores
      exist, and keep `not yet measured` when they do not
- [ ] The by-category table renders per-category WER from `deriveWerByCategory`
- [ ] **Cantonese renders `not applicable`, never `0` and never `not yet measured`** — the
      distinction 034 built four chokepoints to protect must survive the view layer
- [ ] Exp 2's `— (STT unchanged)` behaviour is unchanged when two arms share an STT stage
- [ ] A scoring pass exists and is discoverable: either an `npm run score-wer` over injected dirs
      (mirroring `export-results`) or an in-app control. State which and why.
- [ ] Re-scoring is safe and idempotent-on-read — running the pass twice does not double-count
      (034's `latestWerScores` already guarantees this; assert it end to end)
- [ ] Scoring never mutates a Run and never writes to `ledger.jsonl`
- [ ] No fixture-sourced or gate-failing run contributes a score to a reported figure

## Notes

- The scoring pass needs the Recording's manifest (`referenceText`) and the Run's `RunUtterance`
  transcripts. Both are already persisted — this is a join, not new measurement.
- Prefer the script: it is re-runnable over a whole corpus after the fact, which is the entire point
  of WER being post-hoc, and it needs no UI decisions.
