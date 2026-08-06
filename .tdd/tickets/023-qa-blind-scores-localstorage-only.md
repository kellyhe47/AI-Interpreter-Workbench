---
id: 023
title: Blind scores persist only to browser localStorage, never to the server store
status: pending
source: qa
depends_on: []
touches: [src/server/routes/, src/client/state/ledger.ts, src/client/App.tsx, src/harness/exportResults.ts]
iterations: 0
test_files: []
branch: ""
---

## Repro

1. Replay → select a Recording with ≥2 completed Runs
2. `compare blind (pick 2 runs)` → pick two → score adequacy + fluency on both samples → submit
3. Inspect `localStorage["workbench.runLedger.v1"]` and the server store

## Expected

PRD §7:

> The server owns the store; the client reads and writes it over REST. No database.

PRD §10:

> Scores append to the ledger with the drawn assignment, the evaluator's language, and the Runs
> compared.

and

> A Spanish-speaking coworker scores at the same machine **or on the deployed instance**.

## Observed

The comparison is written to `localStorage["workbench.runLedger.v1"].blindComparisons` and nowhere
else. There is no blind-comparison REST endpoint (routes cover recordings and runs only).

The record itself is complete and correct:

```json
{ "recordingId": "rec_…", "runIds": ["run-adhoc-1","run-b-sweep-1"],
  "order": ["run-b-sweep-1","run-adhoc-1"], "evaluatorLanguage": "es",
  "scores": { "A": {"adequacy":4,"fluency":5}, "B": {"adequacy":2,"fluency":3} } }
```

Only its destination is wrong. Consequences: scores never reach `data/`, will not appear in the
`results/<date>/` bundle that `npm run export-results` produces and the write-up cites, are lost if
browser storage is cleared, and cannot be gathered from a second machine or browser — which is the
scenario §10 explicitly describes.

## Suggested direction

A `POST /api/blind-comparisons` (+ `GET`) alongside the existing routes, written into the same
append-only store, and included in the export bundle's summary provenance (§10 requires the number of
comparisons scored to appear alongside N).
