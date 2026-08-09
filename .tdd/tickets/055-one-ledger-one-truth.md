---
id: 055
title: One ledger, one truth — the server is the only aggregate source, and a clock inversion is a failure
status: pending
source: spec-audit + qa
depends_on: []
touches: [src/client/views/useSessionController.ts, src/client/state/ledger.ts, src/client/state/hydrateLedger.ts, src/client/components/results/derive.ts, src/client/replay/runner.ts]
iterations: 0
test_files: []
branch: ""
---

## Why — two defects that both make a displayed number untrustworthy

### (a) The client ledger can hold LiveSessions the repo never received — VERIFIED
`useSessionController.ts:740`:
```js
// LOCAL FIRST, UNCONDITIONALLY.
depsRef.current.ledger.appendLiveSession(session);
void depsRef.current.liveSessions?.create(session).catch(() => {});   // rejection SWALLOWED
```
The local append is unconditional; the server POST is fire-and-forget with a swallowed rejection.
**A failed POST leaves a session in the browser that the repo never gets — and the aggregate reads
that store.** The audit measured 14 sessions on screen over 8 on the server.

The local-first ORDER is correct and deliberate (ticket 023: the operator's take is not contingent
on a reachable server). The defect is that the same store is then AGGREGATED FROM. PRD §8: *"One
ledger under every view… a metric cannot drift between screens or between a screen and the
write-up."* Concretely: the numbers a reviewer sees cannot be reproduced from a clone,
`npm run export-results` cannot see them, and clearing browser data destroys the evidence.

**SCOPE NOTE — do not over-fix.** Runs canNOT diverge: `appendRun` is called only from
`hydrateLedger.ts:131`. This is a LiveSession-only path. A QA pass in a freshly-hydrated browser saw
local and server agree exactly, which is why the defect needs a *divergence* test, not a snapshot.

### (b) A clock inversion is stored as `complete` — VERIFIED, and the audit's root cause is WRONG
Run `7acb0cc9` renders `total -13973 ms` in Replay and `-1.44 s` as a p50 in Results.

The audit attributed this to the run having processed only one of four utterances. **That is false.**
All four processed, each with source and target transcripts. The real defect is per-utterance and
**progressive**:

| utterance | source | `audio_queued − speech_end` |
|---|---|---|
| 0 | "Ok." | **+3424 ms** |
| 1 | "at all." | **+1231 ms** |
| 2 | "Monday the 4th." | **−1435 ms** |
| 3 | "I think it was Tuesday…" | **−2364 ms** |

The LATER two are inverted — `speech_end` drifts later than `audio_queued` as the run proceeds.
Nearest-rank p50 over those four is −1435 ms, exactly the figure rendered. **The UI is faithfully
reporting a real measurement defect; the display is not the bug.**

PRD §8: *"Only intervals within one clock are summed."* Client `speech_end` against server
`audio_queued` is two clocks.

## Acceptance criteria

- [ ] **The server ledger is the only aggregate source.** `localStorage` is hydrated FROM, never
      aggregated INTO a figure. A session that exists only locally is EXCLUDED from every aggregate.
- [ ] **A locally-unsynced session is SURFACED, not silently dropped** — the operator is told it
      exists and was not counted. Silence here recreates the same class of problem from the other side.
- [ ] Retry the failed POST, or make the failure visible. A swallowed rejection that also loses the
      record from the aggregate is the worst of both.
- [ ] **Find and fix the `speech_end` drift** — why does it move later, per utterance, within a run?
      This is the disease.
- [ ] A write-time guard rejects `audio_queued < speech_end` as `status: 'failed'`,
      reason `clock-inversion`, naming WHICH utterances inverted. **This is the backstop, not the
      fix** — landing it alone would relabel the run and hide the drift.
- [ ] Aggregates reject non-positive latency samples loudly rather than averaging them
- [ ] Same-clock assertion: an interval may only be computed between two marks from one clock
- [ ] `isAggregatableRun` stays the ONE place deciding aggregation — no second gate

## Also in scope — the experiment-card gate

PRD §8: *"Empty states are mandatory… so polished placeholders can never be mistaken for measured
evidence."* A QA pass at HEAD `ca40359` observed BOTH cards correctly rendering their empty states
over the 3 manual runs on disk, so the audit's report of Exp 2 showing `p50 1.15 s` / `5 of 5 reps`
**did not reproduce**. Verification of whether any path can render figures without qualifying sweep
runs is in flight.

- [ ] Regardless: pin the gate — a card renders figures **iff** ≥1
      `origin:'sweep' && status:'complete' && providers≠fixture` sample backs it. One gate, no
      per-card logic. Golden eval `03` encodes the observed-correct behaviour.

## Golden evals
`eval/golden/01-server-ledger-is-the-only-aggregate-source.json`,
`02-clock-inversion-is-per-utterance-and-progressive.json`,
`03-experiment-card-requires-real-sweep-samples.json`,
`04-provenance-reports-actual-n.json`
