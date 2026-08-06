---
id: 025
title: Provenance stamp asserts a corpus version on an empty Results screen
status: green
source: qa
depends_on: []
touches: [src/client/App.tsx, src/client/components/TopBar.tsx]
iterations: 0
test_files: [src/server/routes/blindComparisons.test.ts, src/client/replay/blindComparisonsClient.test.ts, src/harness/exportResults.comparisons.test.ts, src/client/views/App.blindComparisons.test.tsx, src/client/views/App.provenance.test.tsx, src/client/views/App.test.tsx]
branch: ""
---

## Repro

1. Open Results with an empty ledger

## Expected

PRD §8 ties provenance to results:

> Every result carries a **provenance line** — corpus version, utterance count, repetitions, pinned
> endpointing value. A number without provenance is a claim; a number with it is citable.

With zero results there is nothing to attribute.

## Observed

The top bar renders `run 2026-08-06 · corpus v1` beside a body reading **"No runs recorded"**. The
results panel itself is correctly digit-free (verified: zero digits), but the stamp sits outside it
and reads as though a run against corpus v1 exists.

Low severity — no figure is fabricated — but it is the same class of misreading that the mandatory
empty state exists to prevent.

## Suggested direction

Suppress the stamp when the ledger has nothing to attribute, or word it as a session/build stamp
rather than a run provenance line.

- iter 1: green (batched with 023). Mutation-checked: making the stamp unconditional fails 9 tests.
- Required updating ONE locked assertion (`App.test.tsx:270`). Its intent is tab scoping — four of
  its five assertions are about WHERE the stamp appears — and the empty ledger it rendered with was
  incidental to `renderPinnedWorkbench()`, not a statement that provenance may attach to nothing.
  `App.tsx:20-22` already documents the same judgement for Live: "a live session is not a run;
  provenance over it would be a category error." Updated through the test-writer with all four
  absence assertions verbatim; the empty-ledger counterpart now lives in `App.provenance.test.tsx`.
- `resultsAreEmpty()` is exported from `ResultsView` and used by BOTH the view and App — duplicating
  that predicate is precisely how the two would drift back apart.
