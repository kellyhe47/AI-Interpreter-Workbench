---
id: 023
title: Blind scores persist only to browser localStorage, never to the server store
status: green
source: qa
depends_on: []
touches: [src/server/routes/, src/client/state/ledger.ts, src/client/App.tsx, src/harness/exportResults.ts]
iterations: 0
test_files: [src/server/routes/blindComparisons.test.ts, src/client/replay/blindComparisonsClient.test.ts, src/harness/exportResults.comparisons.test.ts, src/client/views/App.blindComparisons.test.tsx, src/client/views/App.provenance.test.tsx, src/client/views/App.test.tsx]
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

- iter 1: green (batched with 025). Mutation-checked: writing comparisons into `ledger.jsonl`
  instead of their own stream fails 11 tests.
- Comparisons get `comparisons.jsonl`, NOT the run ledger: `readLedger()` is typed `Run[]` and
  `exportResults` unions it into the run record set, so a shared file would count a comparison in
  `totals.runs` and derive it into an arm — the exact contamination the project exists to prevent.
- `summary.blindComparisons {total, scored, unattributable, byRecording}` sits OUTSIDE `totals`
  (a locked test pins `totals` by `toEqual`). `scored` = both runIds present in the export — PRD
  §10's disclosure requirement.
- Dual-sink in App: a REJECTED post still records locally. The evaluator never loses their work.
- `json({ strict: false })` on the POST so a scalar body reaches our own validator instead of
  express answering with an HTML error page and no `{code, message}` envelope.
