---
id: 061
title: Runs record no languagePair or direction, and Recordings record no lang — a controlled variable that is not recorded is not controlled
status: pending
source: spec-audit + qa
depends_on: []
touches: [src/client/replay/runner.ts, src/client/components/replay/RecordTake.tsx, src/client/state/ledger.ts, src/client/components/results/derive.ts]
iterations: 0
test_files: []
branch: ""
---

## Observed — verified

**Every stored Run:** `languagePair: undefined`, `direction: undefined` (all 3 runs).

**Every recorded Recording:** `lang: null` — including all 3 takes the operator recorded on
2026-08-09, which are otherwise complete (4 utterances each, every category set, reference text
verbatim).

PRD §8's utterance record specifies both fields, and the controlled-variable register pins
*"Language pair + direction — fixed per sweep."*

## Why it matters more with Cantonese kept

EN→YUE and YUE→EN are **separate claims** (PRD §7). A run that does not record its own direction:
- cannot be grouped correctly by the by-category results view
- cannot be reproduced from the ledger
- cannot tell the two Cantonese directions apart — and the *asymmetry between them* is the finding
  (Realtime reaches EN→YUE only as Mandarin, and YUE→EN not at all)

A controlled variable that is not recorded is not controlled; it is only intended.

## Acceptance criteria

- [ ] Every Run records `languagePair` and `direction`, from the configuration actually used
- [ ] Every Recording records `lang` — the record flow already collects it, so trace where it is lost
- [ ] The by-category view groups by direction, and EN→YUE and YUE→EN never pool
- [ ] Backfill or explicitly quarantine the 3 existing Runs and 3 Recordings that lack these fields —
      **do not infer them**; a guessed direction is worse than a missing one
- [ ] A run missing either field cannot enter an aggregate

## Golden eval
`eval/golden/11-a-run-records-its-own-direction.json`
