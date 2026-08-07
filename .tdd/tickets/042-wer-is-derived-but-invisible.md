---
id: 042
title: WER is computed and stored but never rendered, and nothing ever invokes the scoring pass
status: green
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

## Attempt log

- Green in one implementation pass, 30 red -> 0. Suite 1632/91; both tsconfigs clean; build clean.
- **Render:** both derivations run ONCE at the view root and are passed down as props, so the cards
  stay renderers of a model. The view never computes or inspects a WER number — `WerAggregate.cell`
  already encodes the precedence (figure -> not applicable -> not yet measured), so the view has
  exactly two behaviours: echo `.cell`, or use `WER_NOT_MEASURED_CELL` when the aggregate is absent
  entirely. **There is no branch that can turn a null mean into a digit.**
- The by-category cell is joined on **(category x arm)**, never the category alone — the same
  mistake 032's test-writer caught in its own reference implementation, now defended at the view
  layer too (mutation: 3 red).
- `data-sidecar` and the `(sidecar transcript)` suffix stay on column a **unconditionally**, even
  once it carries a figure. The test-writer verified the pre-existing `ResultsView.test.tsx:376`
  survives only because of this; dropping the suffix when a figure appears would have broken it.
- **Scoring pass:** `src/harness/scoreWer.ts` + a thin `scripts/score-wer.mjs` shell, mirroring
  `export-results`. Its only write is `appendWerScore` — `runs/*.json` and `ledger.jsonl` are
  byte-identical after a pass and `totals.runs` is untouched.
- Implementer's good call, outside the ticket's `touches`: rather than restate the four-clause
  aggregation gate it **exported `isGatePassingRun` from `exportResults.ts`** and imported it, so the
  two cannot drift.
- **Manifest absent != reference absent**, the decision that matters most here: a Recording with no
  `utterances` manifest (a mic take), or a Run naming a Recording the store lacks, is SKIPPED. A
  Cantonese manifest — entries present, no `referenceText` — is SCORED `wer: null` /
  `no-reference-text`. Without the split every mic run would emit null scores that read as
  "we tried and could not".
- No de-duplication and no read of prior scores: last-write-wins lives only in `latestWerScores`, on
  read, so a second pass appends lines without growing the atom set.
- Mutation-checked:
  | mutation | result |
  |---|---|
  | category WER keyed on category alone, not (category x arm) | 3 red |
  | the scoring pass skips its gate check | 5 red |
  | a no-manifest run scored as null instead of skipped | 2 red |
