---
id: 055
title: One ledger, one truth — the server is the only aggregate source, and a clock inversion is a failure
status: done
source: spec-audit + qa
depends_on: []
touches: [src/client/views/useSessionController.ts, src/client/state/ledger.ts, src/client/state/hydrateLedger.ts, src/client/components/results/derive.ts, src/client/replay/runner.ts, src/client/views/ResultsView.tsx, src/client/browserDeps.ts]
iterations: 2
test_files: []
branch: main
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

~~PRD §8: *"Only intervals within one clock are summed."* Client `speech_end` against server
`audio_queued` is two clocks.~~
> **SUPERSEDED by `## CORRECTION`.** Both marks are on the SAME clock — the runner owns both
> (`runner.ts:776`/`:783` per utterance, `:1109`/`:1115` at the envelope). The headline `-13973 ms`
> is a first-wins/last-wins ENVELOPE bug, not a two-clock problem.

## Acceptance criteria

> **Read `## CORRECTION` (bottom of this file) FIRST.** It supersedes the "two clocks" framing above
> and these criteria have been rewritten to agree with it.

**Ledger divergence (defect a)**

- [ ] A `LiveSession` present in the client ledger but absent from the server listing is EXCLUDED
      from every aggregate. Falsifiable: build a ledger holding the 8 server sessions plus 2
      local-only ones; `deriveLiveModel(ledger)` reports `sessions: 8` and the local-only ids
      contribute no utterance to `p50Ms`/`p95Ms`.
- [ ] The exclusion is carried by state ON the record (e.g. a sync flag set when the POST resolves /
      rejects), not by a second aggregation gate and not by a filter local to `deriveLiveModel`.
- [ ] `liveSessions.create(...)` no longer swallows its rejection: the rejection marks the session
      unsynced. Falsifiable: inject a `liveSessions.create` that rejects; the ledger's copy of that
      session ends in the unsynced state and the local append still happened FIRST.
- [ ] Results renders a non-zero unsynced count when such a session exists, and renders no such
      notice when all sessions are synced. (Two assertions, both DOM.)

**The `-13973 ms` (defect b, part 1 — the envelope)**

- [ ] The Run envelope's `speech_end` and `audio_queued` are taken from the SAME utterance.
      `runner.ts:1109` sets `speech_end = t0 + recording.speechEndMs` (the LAST utterance's speech
      end) while `:1115` sets `audio_queued = firstAudioAt` (the FIRST utterance's audio).
      Falsifiable: a 4-utterance run whose per-utterance deltas are all POSITIVE must not produce a
      negative run-level `audio_queued − speech_end`.

**Per-utterance drift (defect b, part 2 — separate, do not conflate)**

- [ ] For a run whose `speech_end` comes from manifest ground truth, per-utterance
      `audio_queued − speech_end` is non-negative for every utterance. Falsifiable against the
      recorded deltas `+3424 / +1231 / −1435 / −2364`: utterances 2 and 3 must not remain negative
      after the fix.
- [ ] A write-time guard marks a run with any inverted utterance `status: 'failed'`, reason
      `clock-inversion`, and the stored error names WHICH utterance indices inverted.
      **Backstop, not the fix** — landing it alone relabels the run and hides the drift.
- [ ] Aggregates never average a non-positive latency sample: such a sample is dropped from the
      numerator AND the denominator, and the drop is reported (n falls), not silent.

~~Same-clock assertion: an interval may only be computed between two marks from one clock~~
> removed: CONTRADICTED by the CORRECTION. Both marks in the headline bug are on the SAME clock;
> a same-clock assertion would not have caught it, and adding one invites a fix that leaves the
> first-wins/last-wins envelope bug in place.

~~`isAggregatableRun` stays the ONE place deciding aggregation — no second gate~~
> already satisfied: `isAggregatableRun` (`ledger.ts:572`) is the sole gate and `7acb0cc9`
> (`origin: 'manual'`) already contributes zero samples. Retained as a standing rule below, not as
> work.

## Also in scope — the experiment-card gate

PRD §8: *"Empty states are mandatory… so polished placeholders can never be mistaken for measured
evidence."* A QA pass at HEAD `ca40359` observed BOTH cards correctly rendering their empty states
over the 3 manual runs on disk, so the audit's report of Exp 2 showing `p50 1.15 s` / `5 of 5 reps`
**did not reproduce**. Verification of whether any path can render figures without qualifying sweep
runs is in flight.

- [ ] REGRESSION PIN ONLY: a card renders figures **iff** ≥1
      `origin:'sweep' && status:'complete' && providers≠fixture` sample backs it. Add the assertion;
      change no production code. Golden eval `03` encodes the observed-correct behaviour.
> already satisfied: `ResultsView.tsx:1091-1092` builds `exp1` and `exp2` from the same
> `deriveComparison` call under the same `empty` flag, and `deriveComparison` returns `null` unless
> both arms have an aggregate. Exp1-empty ⟹ Exp2-empty. Do not go hunting for a leak.

## Out of scope

- Changing `isAggregatableRun`, or adding any second aggregation gate anywhere.
- Any fix to the Live card's p50/p95 figures — P1-5 is FALSE (see CORRECTION); `deriveLiveModel`
  already recomputes from utterance timings and the on-screen `0.40 s` / `1.50 s` are honest.
- Backfilling or repairing the 3 existing manual runs on disk, including `7acb0cc9`.
- Populating `session.latency.p50` / `driftMinute1ToEnd` (dead/never-measured fields) — that is
  ticket 058's territory.
- Making the local-first ordering conditional. The local append stays FIRST and UNCONDITIONAL
  (ticket 023); only its use as an AGGREGATE SOURCE changes.
- Removing Runs from `localStorage`, or any change to `appendRun` — Runs cannot diverge.

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

`7acb0cc9` is `origin: 'manual'`, and `isAggregatableRun` (`ledger.ts:572`) requires
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

---

## CONTEXT FOR A FRESH AGENT

### 1. Verified citations (checked against the working tree, 2026-08-08)

| claim | file:line | status |
|---|---|---|
| local append is unconditional | `src/client/views/useSessionController.ts:738` (`// LOCAL FIRST, UNCONDITIONALLY.`), `:740` (`ledger.appendLiveSession(session)`) | verified |
| POST rejection swallowed | `src/client/views/useSessionController.ts:747` | verified |
| the `liveSessions` seam type | `src/client/views/useSessionController.ts:166` | verified |
| the one aggregation gate | `src/client/state/ledger.ts:572` | CORRECTED from `:574` |
| `appendRun` has exactly one caller | `src/client/state/hydrateLedger.ts:131` | verified (the only call site outside `ledger.ts:780`) |
| hydrate is add-only, never replaces | `src/client/state/hydrateLedger.ts:116-132` (runs), `:134-142` (live sessions) | verified |
| aggregates read the client's own array | `src/client/state/ledger.ts:722` (`private runs`), `:809` `runAggregates()`, `:813` `for (const run of this.runs)` | verified |
| `deriveLiveModel` entry point | `src/client/components/results/derive.ts:1195` | verified |
| Live p50 recomputed from utterances, never read off `session.latency.p50` | `src/client/components/results/derive.ts:1223-1228` | verified |
| exp1/exp2 same call, same `empty` flag | `src/client/views/ResultsView.tsx:1091-1092` | CORRECTED from `:1091` (it is two lines) |
| run envelope `speech_end` (LAST utterance) | `src/client/replay/runner.ts:1109` | verified — NEW citation |
| run envelope `audio_queued` (FIRST audio) | `src/client/replay/runner.ts:1115`, `firstAudioAt` declared `:834`, stamped `:894` | verified — NEW citation |
| per-utterance marks (correct, per-index) | `src/client/replay/runner.ts:776`, `:780-783` | verified — NEW citation |
| server holds 8 live sessions | `data/live-sessions.jsonl` is 8 lines | verified |

### 2. The code

`src/client/views/useSessionController.ts:736-747`
```ts
    };
    // LOCAL FIRST, UNCONDITIONALLY. The operator's take is not made contingent
    // on a reachable server (ticket 023's order exactly).
    depsRef.current.ledger.appendLiveSession(session);
    // TICKET 041 — then the SAME record to the server, so the stability
    // artifact reaches data/, the exported bundle and a second machine. A
    // rejection is swallowed: it costs the server's copy and nothing else, and
    // the view stays usable. A session that produced NOTHING is posted too —
    // storing is not aggregating, and deleting the record of a take that failed
    // to produce anything would delete the finding.
    void depsRef.current.liveSessions?.create(session).catch(() => {});
```

`src/client/state/ledger.ts:572-577` — the ONE gate
```ts
export function isAggregatableRun(run: Run): boolean {
  if (runArmTag(run) === 'ad-hoc') return false;
  if (run.origin !== 'sweep') return false;
  if (run.status !== 'complete') return false;
  return isRealRun(run);
}
```

`src/client/replay/runner.ts:1108-1115` — THE ENVELOPE BUG (headline `-13973`)
```ts
  const outputAudio = concatPcm(audioChunks);
  timings.speech_end = t0 + recording.speechEndMs;          // LAST utterance's speech end
  // TICKET 040 — a decoded PCM sample wins, then a transport-sent mark (the
  // WebRTC media-track case, where nothing is ever decoded), then null. Before
  // this the mark was overwritten with a null firstAudioAt, so every Replay
  // Arm A run counted toward n and cost while contributing no latency sample.
  const markedAudioQueued = typeof timings.audio_queued === 'number' ? timings.audio_queued : null;
  timings.audio_queued = firstAudioAt ?? markedAudioQueued;  // FIRST utterance's audio
```
Both marks are on the SAME clock. `885175 − 899148 = −13973` is first-wins vs last-wins.

`src/client/replay/runner.ts:772-783` — the per-utterance path, correctly per-index
```ts
    // Marks pass through verbatim by event name, exactly as at run level...
    const timings: Record<string, number | null> = { ...(buckets.timings.get(utt) ?? {}) };
    // ...except the two the runner owns. The anchor is the MANIFEST's, never
    // the Recording's and never VAD's.
    timings.speech_end = t0 + entry.trueSpeechEndMs;
    const audioAt = buckets.audioAt.get(utt);
    const markedAt = typeof timings.audio_queued === 'number' ? timings.audio_queued : null;
    const audioQueued = audioAt ?? markedAt;
    timings.audio_queued = audioQueued;
```

`src/client/state/hydrateLedger.ts:127-132` — add-only merge (the residual-stale-blob risk)
```ts
  const knownRuns = new Set(ledger.getRuns().map((r) => r.id));
  for (const run of runs) {
    if (knownRuns.has(run.id)) continue;
    knownRuns.add(run.id);
    ledger.appendRun(run);
  }
```

`src/client/views/ResultsView.tsx:1091-1092`
```tsx
  const exp1 = empty ? null : deriveComparison(props.ledger, 'A', 'B');
  const exp2 = empty ? null : deriveComparison(props.ledger, 'B', 'C');
```

### 3. Existing tests — where this ticket's assertions MUST land

**Standing policy: no new test file in a module that already has one.**

| area | EXISTING file — put the new assertions HERE |
|---|---|
| append-then-POST order, rejected POST, unsynced state | `src/client/views/LiveView.persistence.test.tsx` (docblock already declares this seam normative) |
| ledger sync-state / gate / `isAggregatableRun` | `src/client/state/ledger.test.ts` (see `:618-621`, `:939-951`) |
| hydration merge / dedupe | `src/client/state/hydrateLedger.test.ts`, live half in `src/client/state/hydrateLiveSessions.test.ts` |
| `deriveLiveModel` excluding unsynced sessions | `src/client/components/results/deriveLive.empty.test.ts` (do NOT add a 4th `deriveLive.*` file) |
| run-envelope + per-utterance mark aggregation | `src/client/replay/runner.test.ts` (module also has `runner.corpusVersion`, `runner.outputAudio`, `runner.unboundedWaits` — reuse `runner.test.ts`) |
| Results DOM: unsynced notice, exp1/exp2 empty pin | `src/client/views/ResultsView.test.tsx` |
| App-level live hydration wiring | `src/client/views/App.liveHydration.test.tsx` (`:122` already asserts the `liveSessions.create` seam exists) |

**Create no new test file for this ticket.**

### 4. Seams (jsdom has no AudioContext / MediaStream / RTCPeerConnection — everything is injected)

- `src/client/views/useSessionController.ts:166` — `liveSessions?: Pick<LiveSessionsClient, 'create'>`. THE seam for defect (a). Inject a rejecting `create` to drive the unsynced path.
- `src/client/state/ledger.ts` — `RunLedger`; `appendLiveSession` `:792`, `getLiveSessions` `:797`, `runAggregates` `:809`. The ledger is constructed by the test and handed in; no global.
- `src/client/views/sessionTestKit.ts` — `makeDeps()` / `TestDeps`, `advance`, `cascadeUtteranceScript`, `clickStartMicrophone`. Every LiveView test builds through this.
- `src/client/browserDeps.ts:94` `BrowserDeps extends SessionDeps`; the real client is wired at `:470` and passed at `:525-526` (`hydrate: { recordings, runs, liveSessions, werScores }`). **Production wiring lives here — a fix that only satisfies `makeDeps` has zero production callers.**
- `src/client/fixtureDeps.ts:105` `isFixtureMode`, `:428` `buildFixtureDeps` — `?fixture=1` hands back a FRESH in-memory ledger with no runs.
- `src/client/state/hydrationFixtures.ts`, `src/client/components/results/testRecords.ts` — record builders for derive/Results tests.
- `src/server/storage/test-support.ts`, `src/server/providers/test-support.ts` — server-side builders.

### 5. Golden evals this ticket must satisfy

- `eval/golden/01-server-ledger-is-the-only-aggregate-source.json` — 8 server sessions / 31 utterances; `session-local-1` and `session-local-2` MUST be excluded and an `unsynced-count` MUST be surfaced.
- `eval/golden/02-clock-inversion-is-per-utterance-and-progressive.json` — deltas `[3424, 1231, -1435, -2364]`; expects `status: 'failed'`, `error_code: 'clock-inversion'`, `latency_samples_contributed: 0`, `inverted_utterances_named: 2`, and must NOT contain `-1.44 s` or `-13973`.
- `eval/golden/03-experiment-card-requires-real-sweep-samples.json` — DOM; both cards empty over 3 manual runs; must not contain `reps completed` / `p50`. **Pin only.**
- `eval/golden/04-provenance-reports-actual-n.json` — the denominator keeps the rep whose POST went unacknowledged (`2 of 3`, never `2 of 2`). Directly relevant: the unsynced-session work must not shrink a denominator.

### 6. Traps that have actually bitten this project

- **A fix that satisfies the test seam while production has zero callers.** If the sync flag is only set by `sessionTestKit`'s `makeDeps`, `browserDeps.ts:470-526` still ships the old behaviour. Assert the production wiring too.
- **The last-wins-vs-first-wins envelope aggregation** (`runner.ts:1109` vs `:1115`) — the LIVE trap here. Fixing per-utterance drift alone leaves the headline `-13973`; fixing the envelope alone leaves two physically impossible utterances.
- **The add-only hydrate merge** (`hydrateLedger.ts:127-132`) — a stale `localStorage` blob is never replaced, so a bad record survives every reload. A "fix" that relies on re-hydration overwriting the local copy does not work.
- **A guard bypassed by bracket access, a cast, or a `!`.** `timings` is `Record<string, number | null>`; a sync flag read as `session['syncState']` or through `as LiveSession` defeats the type.
- **A wiring seam delivered incidentally by an unrelated re-render.** Assert the exclusion at `deriveLiveModel` level (pure), not only via a rendered number.
- **An arithmetic guard that omits the dominant term.** Dropping negative samples from the numerator but not the denominator halves the p50 instead of removing the sample.
- **A test that compares a render against itself.** RTL APPENDS on re-render and the Results accessors are `document.querySelector`; `cleanup()` between renders, or query within an explicit container.

### Standing project rules

- `isAggregatableRun` is the ONE place that decides aggregation — never add a second gate.
- Arm membership is DERIVED from configuration, never declared.
- Unmeasured is `null` and renders `not measured` — never `$0.00`, never a zero.
- Never report a fixture-sourced number; never aggregate a run whose `origin` is `manual` or whose `status` is `failed`.
- The measured atom is the UTTERANCE, not the Run.
- 24 kHz PCM16 mono everywhere; `SAMPLE_RATE` in `src/core/protocol.ts` is the single source of truth.
- Live persists no audio and creates no Run records.
- Replay autoplays nothing; Live autoplays always.

## RESOLUTION (2026-08-09) — worked as 055b then 055a

Suite 2279 passing / 0 failing. **Golden evals 01, 02 and 04 all green.** `npm run eval` is now
12 pass / 1 fail — only case 10 (ticket 060) remains.

### 055b — the `-13973 ms` (commit `8565e5c`)

Two distinct causes, both fixed; fixing either alone leaves the other:

- **The envelope** now copies the LAST utterance record's pair instead of assembling
  `recording.speechEndMs` with `firstAudioAt`, so it can no longer manufacture an interval by mixing
  utterances. Both marks were always on the SAME clock — the audit's "two clocks" diagnosis was
  wrong, and a same-clock assertion would have passed on the defect.
- **Per-utterance drift**: a mark preceding its own manifest anchor is refused and stored `null`
  ("not measured"), never clamped — a `Math.max` would invent a 0 ms measurement nothing observed.

On `7acb0cc9`'s real timeline the deltas become `+3424 / +1231 / null / null`. An unconditional
"all deltas ≥ 0" was never satisfiable there: no audio instant exists at or after the fourth anchor
(17433 < 19797).

`appendRun` is the write-time backstop (`failed`, `clock-inversion`, naming which utterances
inverted); `runAggregates` drops a non-positive sample from numerator AND denominator together.
`isClockInversion` is `< 0` and `isMeasuredLatencyMs` is `> 0`, deliberately different: a zero is a
measurement that may not enter a percentile, but it is not an impossible ordering.

**Three existing fixtures encoded the defect** and were repaired (data only, no assertion weakened):
the 031 corpus fixture answered at 130/230/330/430 against anchors 200/400/600/800; `replayArmA`'s
anchors sat 20 ms after the model's own answers; and `runTimeout`'s `SlowStartTransport` armed the
script BEFORE a 25 s stall, so the answer landed 25 s before the run's own `t0`.

### 055a — the ledger divergence and the denominator (commit pending)

The mark rides the record and **the listing is the acknowledgement that settles it**. That design was
forced by three locked pins simultaneously: hydrated sessions are compared field-for-field, so a
*synced* session carries no `syncState` at all; a bare `appendLiveSession` stays aggregatable; yet
bare-appended locals must be excluded once a listing has been hydrated.

Hydration branches on the **key's presence**, never the array's emptiness — a wired server holding
nothing legitimately demotes every take, while a pre-041 source with no key makes no statement and
moves no mark in either direction. Hydration can never un-mark: only the server naming an id clears
one. The local append stays FIRST and UNCONDITIONAL (ticket 023).

The denominator is a **floor**: `max(distinct repIndex over the arm's attempted rows, highest
declared annotations.intendedReps)`. A lost rep leaves no row, so no derivation over survivors
recovers it — the plan has to ride the rows that did land. A stale plan can only raise, never shrink.

**PRD tension resolved, not violated:** *"Provenance reports actual N, never intended N"* governs the
NUMERATOR. `completedReps` and `n` stay derived from rows only; `intendedReps` was always the
denominator and was always named "intended". Before this it silently collapsed onto the numerator —
the failure AGENTS.md names verbatim.

### The golden-eval-04 executor edit — legitimate, and why

Case 04's `given` declares `intended_reps: 3`, but its fixture encoded that **nowhere**: two rows
carrying `repIndex` and nothing else. A rep whose POST is unacknowledged leaves no row, so no
derivation over the two survivors could recover the 3 — **the case was unsatisfiable by any
implementation that did not invent a number.** The fixture now carries `annotations.intendedReps`,
the same shape the real sweep writes. The golden JSON and every assertion are untouched.

The product proof is `runTimeout.test.ts:1269` — a real `startBatch` losing a rep — which renders
`2 of 3` and goes red when the production stamp is removed. Its own prior comment instructed exactly
this update: *"When 050 lands this assertion must be UPDATED to '2 of 3', never deleted."*

**Recorded honestly:** golden eval 04 stays green with the production stamp removed, because it
declares `"surface": "pure"` and builds rows with `makeRunEntity`, exercising `buildProvenance`
alone. That is in-spec, but the eval is NOT the gate that proves the sweep writes the plan. Same
lesson as ticket 056's case 12.

### Adversarial review

055b: 16 mutations, GREEN, 5 survivors closed with 19 assertions. 055a: 19 mutations, GREEN, 6
survivors closed with 12 assertions. Every survivor was unpinned intent, not wrong code.

Worth naming among them: the runner's `clock-inversion` reason could be deleted entirely so a record
was refused **silently with `errors: []`** — against this ticket's own thesis (*"a write-time guard
is a BACKSTOP, not the fix; relabelling the run would hide the drift"*) that is the failure mode,
not a detail. And the empty-vs-absent listing distinction was unpinned, which is this ticket's
headline scenario in another shape.

The production wiring is genuinely closed: `App.liveHydration.test.tsx` builds the bag with
`buildBrowserDeps()` and drives the REAL `createLiveSessionsClient`, faking only `globalThis.fetch`,
and asserts `POST /api/live-sessions` was issued — a URL that exists nowhere in `sessionTestKit`. It
goes red when the rejection is swallowed again.

### Premises this ticket overturned, confirmed still overturned

- **P1-5 is FALSE** — `deriveLiveModel` never reads `session.latency.p50`; the on-screen Live figures
  are honest (realtime p50 399 ms, cascade 1487 ms / p95 2858 ms over 16 samples, which partially
  meets the rubric's "under 3s, target under 2s" on real data).
- **The exp1/exp2 asymmetry is structurally impossible** — same call, same `empty` flag. Golden eval
  03 passes; no production code was changed for it.
- **The negative run never dragged an aggregate** — `7acb0cc9` is `origin: 'manual'` and the gate
  already rejected it. This ticket was about a wrong number being *displayed*.
