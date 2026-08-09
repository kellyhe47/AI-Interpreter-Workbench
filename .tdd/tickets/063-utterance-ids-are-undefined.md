---
id: 063
title: Every stored utterance has id undefined — WER and by-category keying cannot work
status: pending
source: verification
depends_on: []
touches: [src/client/replay/runner.ts, src/client/state/hydrateLedger.ts, src/core/wer.ts]
iterations: 0
test_files: []
branch: ""
---

## Observed — verified

All 4 utterances on run `7acb0cc9` and all 4 on `dbeb6d94` carry **`id: undefined`**.

WER scores key on `(runId, utteranceId)` (`hydrateLedger.ts:150-151`, `werScoreKey`), and
`deriveWerByCategory` keys on the sample's utterance. **With undefined ids neither can key
correctly** — so the WER pipeline (`core/wer.ts`, 343 lines) and the by-category view will fail on
their first real exercise, not gracefully but silently, by collapsing every utterance onto one key.

This sits directly under the "never-exercised subsystems" finding and is the reason they will not
work the first time real audio lands.

## Acceptance criteria

- [ ] Every stored utterance carries a stable, unique id
- [ ] `werScoreKey` round-trips: a score written against an utterance is read back onto that same
      utterance and no other
- [ ] `deriveWerByCategory` groups by real utterance identity — assert that two utterances of the
      same category in one run do not collapse
- [ ] The 8 existing utterances are backfilled or explicitly quarantined — **do not infer ids by
      index**; a guessed identity silently mis-attributes a score
- [ ] A run with any unidentified utterance cannot enter the WER path

## Notes
- The measured atom is the utterance (PRD §8). An atom without an identity is not measurable.
