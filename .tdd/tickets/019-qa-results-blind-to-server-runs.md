---
id: 019
title: Results never sees server-persisted Runs — two disjoint ledgers
status: green
source: qa
depends_on: []
touches: [src/client/App.tsx, src/client/state/ledger.ts, src/client/views/ResultsView.tsx, src/client/browserDeps.ts]
iterations: 0
test_files: [src/client/state/liveRealness.test.ts, src/client/components/results/deriveLive.fixture.test.ts, src/client/views/ResultsView.fixtureLive.test.tsx, src/client/state/hydrateLedger.test.ts, src/client/views/ResultsView.hydration.test.tsx, src/client/views/App.hydration.test.tsx, src/client/state/hydrationFixtures.ts]
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

- iter 1: green (batched with 018). Mutation-checked: making `hydrateLedger` a no-op fails 28 tests.
- `hydrate` is its own optional `AppDeps` field, never derived from `deps.replay` — deriving it
  would break two locked `App.test.tsx` assertions whose replay bag serves gate-passing runs. A test
  locks that decision.
- Hydration is atomic on failure: a partial write would leave Recordings present with no Runs, which
  reads exactly like a real empty sweep.
- **Fixture mode deliberately gets no `hydrate`.** Pulling the server's genuine measurements into a
  bag holding a fabricated session would put real figures on screen under a fixture session — the
  bug this ticket exists to fix, inverted — and would make `?fixture=1`, a QA and screenshot path,
  depend on whatever is on the server that day.
