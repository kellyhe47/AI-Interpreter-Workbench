---
id: 019
title: Results never sees server-persisted Runs — two disjoint ledgers
status: pending
source: qa
depends_on: []
touches: [src/client/App.tsx, src/client/state/ledger.ts, src/client/views/ResultsView.tsx, src/client/browserDeps.ts]
iterations: 0
test_files: []
branch: ""
---

## Repro

1. POST two Recordings and four Runs to the real API (`/api/recordings`, `/api/runs`)
2. Replay tab → select the corpus Recording — all four Runs render correctly, with derived tags,
   per-stage ms and the failed-run notice
3. Results tab

Evidence: `.qa/screens/F2-results-blind-to-server-runs.txt`

## Expected

PRD §8:

> **One ledger under every view.** Every screen reads from a single append-only run ledger of
> utterance records grouped by run and experiment. Curated screens sit *above* it; the ledger is
> the source of truth, so a metric cannot drift between screens or between a screen and the
> write-up.

## Observed

Results renders **"No runs recorded"** while four Runs exist server-side, two of which pass the
aggregation gate:

```
run-b-sweep-1  armTag=B  origin=sweep  status=complete   -> GATE PASSES
run-c-sweep-1  armTag=C  origin=sweep  status=complete   -> GATE PASSES
```

The client ledger blob (`localStorage["workbench.runLedger.v1"]`) holds
`runs: 0, recordings: 0, liveSessions: 0`.

Replay reads the server over REST; Results reads a disjoint browser-local `RunLedger` that nothing
populates from the server. Two sources of truth — precisely what §8 forbids.

**Consequence:** after a real batch sweep (which writes Runs server-side), the Results view — the
project's primary deliverable — would still be empty. Taken with ticket 018, Results currently
displays fixture-sourced Live data and omits real server Runs: the exact inversion of the intent.

## Suggested direction

Results must read the same store Replay does. Either hydrate the client `RunLedger` from
`GET /api/runs` + `GET /api/recordings` on load, or have `ResultsView` derive from the REST clients
directly. Whichever, one store feeds every view.
