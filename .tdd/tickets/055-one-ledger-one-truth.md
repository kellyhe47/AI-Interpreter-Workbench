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

---

## CORRECTION — verified 2026-08-09, supersedes the framing above

Independent verification refined two things in this ticket. **Read this before implementing.**

### The `-13973 ms` has TWO distinct causes, not one

1. **A run-envelope mark-aggregation bug — the direct cause of the headline number.** The Run record
   pairs **utterance 4's `speech_end` (…899148)** with **utterance 1's `audio_queued` (…885175)**.
   `speech_end` keeps the LAST utterance's value; `audio_queued` keeps the FIRST's. `885175 − 899148
   = −13973`. **This is a last-wins-vs-first-wins bug at the Run envelope, not a clock problem** —
   both marks are on the same clock, so the audit's "two clocks" diagnosis is wrong and a same-clock
   assertion would not have caught it.
2. **Genuine per-utterance drift — a separate defect.** +3424 / +1231 / **−1435** / **−2364** ms.
   Utterances 2 and 3 are inverted on their own marks, independent of the envelope bug.

**Fix both.** Fixing only the envelope makes the headline number plausible while two of four
utterances remain physically impossible.

### The negative run is NOT aggregate-eligible — the audit's claim is false

`7acb0cc9` is `origin: 'manual'`, and `isAggregatableRun` (`ledger.ts:574`) requires
`origin === 'sweep'`. It contributes **zero** samples to any aggregate. The audit's follow-on —
*"a single negative sample silently drags a p50 below the 1.5 s benchmark"* — **is false today**, and
it contradicts the audit's own P0-3 evidence that all 3 runs are manual.
**The gate is working.** This ticket is about a wrong number being *displayed*, not aggregated.
Do not add a second gate to fix a leak that does not exist.

### The experiment-card gate needs no fix — and the reported symptom is structurally impossible

`exp1` and `exp2` are built by the SAME call under the SAME `empty` flag (`ResultsView.tsx:1091`),
and `deriveComparison` returns `null` unless both arms have an aggregate. Exp 2 (B vs C) is strictly
*harder* to populate than Exp 1 (A vs B). **Exp 1 empty ⟹ Exp 2 empty. There is no path producing
the reported Exp1-empty/Exp2-full asymmetry.** Locally-appended `records` never reach
`runAggregates()` (which reads `this.runs` only); LiveSessions reach only `deriveLiveModel`;
`?fixture=1` hands back a fresh in-memory ledger with no runs, making the cards *more* empty.

**Keep the gate as a pinned invariant** (golden eval `03` encodes the observed-correct behaviour),
but do not go looking for a leak. One residual risk is real and worth a guard: `hydrateLedger` is
**add-only and never replaces** (`:116-132`), so a stale `localStorage` blob containing sweep runs
would survive indefinitely against an empty server. No current code path can create one — but the
add-only merge is the mechanism that would let it persist.

### P1-5 is FALSE — the Live card's figures are honest

The audit claimed the Live card's p50s come from `localStorage` while the persisted record is null.
`deriveLiveModel` **never reads `session.latency.p50`** — it recomputes from utterance timings
(`derive.ts:1223-1228`). Recomputing from `data/live-sessions.jsonl` **alone** gives realtime p50
**399 ms** and cascade p50 **1487 ms** → the exact `0.40 s` / `1.50 s` on screen. The stored
`p50: null` is dead data nothing reads.
This does not weaken the ledger-divergence defect above, whose mechanism is pinned independently —
but it removes the supporting narrative, and **the honest cascade figures (p50 1487 ms, p95 2858 ms
over 16 samples) partially meet the rubric's "under 3s, target under 2s" on real data.**
