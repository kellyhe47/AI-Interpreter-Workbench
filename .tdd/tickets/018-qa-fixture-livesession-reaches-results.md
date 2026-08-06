---
id: 018
title: Results reports fixture-sourced LiveSession figures as measurements
status: pending
source: qa
depends_on: []
touches: [src/client/components/results/derive.ts, src/client/state/ledger.ts]
iterations: 0
test_files: []
branch: ""
---

## Repro

1. Open `/?fixture=1` → Live tab
2. Start microphone; let ~20 utterances run
3. Stop session
4. Results tab

Evidence: `.qa/screens/F1-results-fixture-livesession.txt`

## Expected

PRD §8, hard rule:

> **No number reported in the write-up may come from a fixture run.** Fixture latency is a
> configured constant. Every latency, cost, and quality figure comes from real providers on real
> audio.

PRD §17 15g: mandatory empty states exist so *"polished placeholders can never be mistaken for
measured evidence."*

## Observed

The conversation-length card leaves its empty state and renders measured-looking figures:

```
utterances completed  20
disconnects           0
p50 latency           0.98 s
p95 latency           0.98 s
provenance: "LiveSessions only · 1 sessions · 20 utterances completed · no reference text, so no WER"
illustrative badge:  ABSENT
```

Results panel digit count: **0** on an empty ledger → **29** after one fixture session.

The Run path enforces the realness rule correctly (Exp 1 and Exp 2 both render "no sweep runs
recorded"). The **LiveSession path has no equivalent gate** — `deriveLiveModel` renders whatever
`getLiveSessions()` returns.

`?fixture=1` is the documented QA/demo path, so this is easy to hit. p50 == p95 == 0.98 s is itself
the signature of a constant-delay fixture, but nothing in the UI says so.

## Suggested direction

A LiveSession needs the same realness predicate the Run path has (`isRealRun`) — a session whose
provider triple or model snapshots are fixture-named must not contribute a figure, and a
fixture-only ledger should derive the same empty state as an empty one.
