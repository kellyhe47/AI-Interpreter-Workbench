---
id: 020
title: A dead API backend renders as a normal empty state in Replay
status: green
source: qa
depends_on: []
touches: [src/client/views/ReplayView.tsx, src/client/components/replay/RecordingsLibrary.tsx]
iterations: 0
test_files: [src/client/views/ReplayView.failures.test.tsx]
branch: ""
---

## Repro

1. Ensure the API server is not running (or is unreachable)
2. Open the Replay tab

Evidence: `.qa/screens/F3-dead-backend-reads-as-empty.txt`

## Expected

PRD §12 requires storage and load failures to surface clearly — a failure must be distinguishable
from emptiness. The table covers "Recording upload fails", "Recording audio missing or unreadable"
and "Disk full on write"; a completely unreachable store is the same class.

## Observed

`fetch('/api/recordings')` returns **500 with an empty body**; the Vite proxy logs
`AggregateError [ECONNREFUSED]`. The UI shows:

> **No Recordings yet**
> Record a clip or load the corpus. Nothing is listed until a Recording exists — a sample row would
> be indistinguishable from one you could measure.

No error, no retry affordance, no indication the backend is unreachable. An operator would conclude
the app is working and simply empty.

The empty-state copy is otherwise excellent — the problem is only that a hard failure borrows it.

## Suggested direction

Distinguish "loaded, zero Recordings" from "could not load". The recordings client already returns
typed `ApiError`s; the library needs a third state that surfaces the failure and offers a retry.

- iter 1: green (batched with 024). 23 tests.
- ROOT CAUSE was deeper than the finding: `ReplayView`'s load effect had **no catch at all**, so a
  rejecting `recordings.list()` escaped as an unhandled rejection (12 of them in the scoped run) and
  the UI fell back to the reassuring empty state. Now three mutually exclusive states, failure first.
- Mutation-checked: suppressing the error branch fails 12 tests.
