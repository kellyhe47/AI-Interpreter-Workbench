---
id: 034
title: WER write path — post-hoc scoring against the corpus reference
status: green
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

## Attempt log

- Green in one implementation pass, 156 red -> 0. Suite 1594/89; both tsconfigs clean; build clean.
- Own append-only stream `data/wer-scores.jsonl` + `POST/GET /api/wer-scores` (code
  `invalid-wer-score`), mirroring the blind-comparison and 041 LiveSession precedents. Runs stay
  immutable; re-scoring writes a SECOND line and readers collapse last-write-wins via
  `latestWerScores`, so the earlier score survives on disk.

### Normalization rulings (one function, applied identically to both sides)

- **No digit<->word conversion in either direction.** `250` and `two hundred fifty` are different
  tokens. A lexicon would be a silent error source *inside the metric*, and the reference is a
  verbatim script the operator controls. Consequence stated rather than hidden: `numbers-dates` WER
  will be dominated by digit-vs-word vendor divergence — which is the finding that category exists
  to produce. `1,250 === 1250`; `2.5 != 25`.
- **Strip accents, PRESERVE `ñ`.** Accents are an orthographic convention vendors disagree about, so
  scoring them measures a style guide. `ñ` is a separate letter — folding it makes `año`/`ano` one
  word, a semantic collapse rather than a spelling one.
- **WER is never clamped.** A hypothesis longer than the reference exceeds 1.0 on purpose; clamping
  would render a babbling arm and a silent arm identically.
- Empty hypothesis = 1.0. Empty reference THROWS (no denominator) and `scoreUtteranceWer` guards it
  as not-applicable.

### The bug the reference-implementation check caught before it shipped

`[^\p{L}\p{N} ]` (literal space, not `\s`) deleted tabs and newlines as punctuation, welding
`a\t\tb` into `ab`. Any transcript containing a newline would have silently lost a token boundary
and inflated WER. Fixed to spare `\s`. Verified by direct probe against the shipped code:
`a\t\tb` -> `"a b"` (2 tokens), `one\ntwo` -> `"one two"` (2 tokens).

### "Not applicable" can never render as 0 — four structural chokepoints

1. `scoreUtteranceWer` has exactly two `return`s setting `wer: null`, each setting
   `notApplicableReason` in the SAME object literal; the numeric branch is the only caller of
   `wordErrorRate`.
2. The route refuses the confusion at the wire in both directions — a numeric `wer` carrying a
   reason, and a null `wer` without one — so a bad record cannot enter an append-only stream where
   it could not be repaired.
3. `tallyScore` returns on `score.wer === null` before any value is pushed; `toWerAggregate` decides
   the cell in one place: percentage -> not applicable -> not yet measured.
4. `summariseWerScores` continues on a null atom before the arm bucket is touched, so an
   all-Cantonese store yields `meanByArm: {}` rather than a zero.

- Mutation-checked:
  | mutation | result |
  |---|---|
  | not-applicable rendered as `0` instead of `null` | 12 red — the load-bearing rule is defended |
  | WER clamped to 1.0 (babble == silence) | 2 red |
  | normalizer eats tabs/newlines | **inconclusive** — see below |
- The normalizer mutation could not be made to apply (repeated escaping failures against the regex
  literal), so it is NOT mutation-verified. The BEHAVIOUR was instead verified directly against the
  shipped code by probe, as recorded above. Worth pinning properly if that line is ever touched.
