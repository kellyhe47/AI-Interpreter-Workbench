---
id: 041
title: LiveSessions are never persisted server-side — the stability benchmark lives in one browser's localStorage
status: pending
source: qa-live
depends_on: []
touches: [src/server/routes/, src/server/storage/, src/client/state/hydrateLedger.ts, src/harness/exportResults.ts]
iterations: 0
test_files: [src/server/storage/liveSessions.test.ts, src/server/routes/liveSessions.test.ts, src/harness/exportResults.liveSessions.test.ts, src/client/state/hydrateLiveSessions.test.ts, src/client/components/results/deriveLive.empty.test.ts, src/client/views/LiveView.persistence.test.tsx, src/client/views/App.liveHydration.test.tsx]
branch: ""
---

## Operator question that surfaced it

> Where are these takes being saved? Do you see it in the db? Should I be able to see any metrics
> about it in the UI?

## Observed

After the operator's Live takes, `data/` contains **only** the seeded corpus fixtures — 3
recordings, 30 runs, all of them mine. Nothing from any Live session.

A repo-wide grep for `liveSession` under `src/server/` returns **nothing**: there is no route, no
storage method, and no file. `hydrateLedger` (ticket 019) restores `recordings` and `runs` from the
server and does not mention live sessions, because there is nothing to fetch.

The operator's 12 sessions exist **only** in their Chrome's `localStorage`
(`workbench.runLedger.v1` → `liveSessions[]`), where they are real and correctly shaped —
architecture, arm, provider triple, per-utterance array, cost envelope.

## Why this matters

- PRD §17 19i: **every Live session IS the stability artifact** — the rubric's benchmark is simply
  the one run for a full five minutes. That artifact currently cannot leave the browser.
- PRD §8: *"One ledger under every view… the ledger is the source of truth."* Runs and Recordings
  are server-owned; LiveSessions are not, so half the ledger is per-browser.
- `npm run export-results` reads the SERVER ledger, so **no Live metric can appear in the exported
  bundle the write-up cites**.
- Clearing site data destroys them. So does using a second browser or machine.

This is consistent with §17 19h ("Live persists no audio and creates no Run records") — that rule is
about *audio* and *Runs*. The session METRICS are a different thing and have no such exemption.

## Also observed while inspecting — likely a separate defect

Of the operator's 12 sessions, most have **`utterances: 0`** and `totalUsd: 0`, including cascade
sessions that could never have started (ticket 039). Empty sessions are being persisted at all.
Decide whether a session that produced nothing should be recorded — a zero-utterance session in an
aggregate is the "a zero reads as a measurement" trap. Probably it should be stored but never
aggregated, exactly like a failed Run.

## Acceptance criteria

- [ ] LiveSessions persist server-side through their own append-only stream, following the
      blind-comparison precedent (own file, own route, tolerant reader) — **never** in
      `ledger.jsonl`, which is typed `Run[]` and would count them as runs
- [ ] `hydrateLedger` restores them, so Results shows Live metrics after a reload or on another machine
- [ ] `npm run export-results` includes them in the exported bundle
- [ ] The realness rule and the fixture gate (ticket 018) still apply — a `?fixture=1` session must
      never reach a reported figure
- [ ] A zero-utterance session is stored but never aggregated; decide and document
- [ ] Live still persists **no audio** and creates **no Run records** (§17 19h is unchanged)

## Answer to give the operator

Their takes are not lost — they are in that browser's localStorage and visible in Results on that
machine. They are simply not in `data/` and not exportable yet.
