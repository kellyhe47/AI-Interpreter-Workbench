# Run plan — ticket 062 and the queue behind it

Owner: orchestrating agent. Kelly owns git. Sub-agents run NO git commands.

## Board (in order)

| # | Ticket | State |
|---|---|---|
| 062 | Realtime/cascade ignore the selected language pair | **DONE** — `a57cd3a`, reviewed GREEN |
| 061 | Runs record no languagePair / direction | **DONE** — tests `856c7f3`, impl `a6ca500`, reviewed GREEN |
| 056 | Retain output audio per run | **DONE (buildable half)** — `3295e84`; rest blocked on operator |
| 064 | REALTIME · TRIMMED pooled into default column | queued |
| 055 | One ledger, one truth + run envelope (split 055a/055b) | queued |
| 059 | $0.000 on Results + Replay | queued |
| 060 | Coverage card cites commits that do not exist | queued |
| 065 | Batch sweep launches 18 executions, no dialog | queued |
| 066 | Replay loses selection on tab change | queued |
| 054 | Delete the placeholder corpus | queued — do NOT parallelise with 058 |
| 058 | Delete fabricated benchmark data | queued — collides with 054 on scripts/bench-fixture.mjs |
| 057 | FINDINGS.md (rubric must-have #8) | queued — no code, no tests |

Deferred, do not start: 050, 026, 053 (053 green on unmerged branch tdd/053).
Closed invalid: 022, 063.

## Verified baseline (2026-08-09, re-derived from disk, not from the handoff)

- HEAD is `3637c6f` ("updates" — docs only: deleted HANDOFF.md, added temp_report.md).
  The handoff prompt said HEAD was `54ca789`; that is stale but code-identical.
- `npm test` → 2087 passing, **34 failing across 9 files**. All 34 are ticket 062's locked reds.
- Ticket file `062-*.md` has **no `## CONTEXT FOR A FRESH AGENT` section** (unlike 054–066).
  Its contract is the locked tests themselves — the file headers carry the reasoning.

## 062 — the locked contract, by file

The 9 red files and what each pins:

1. `src/client/transport/realtime.test.ts` — the serialized `session.update` on the data channel
   must name the target language and NOT the other end of the pair; a blank/whitespace target is
   **refused** (0 session.updates, ≥1 onError, state `disconnected`, never `connected`).
2. `src/client/transport/cascade.test.ts` — `session.start` frame carries `targetLanguage`
   alongside `languagePair`/`direction`; a direction swap changes the serialized frame.
3. `src/server/ws.test.ts` — `session.start`'s `targetLanguage` reaches `opts.session` on the
   orchestrator factory.
4. `src/server/cascade/orchestrator.test.ts` — `runCascade` passes `{ targetLanguage }` into
   `mt.translate()`; a session with no target language passes `undefined`, never invents 'Spanish'.
5. `src/server/providers/openai-mt.test.ts` — per-CALL `targetLanguage` overrides the construction
   default; a call for English must not still say Spanish.
6. `src/server/providers/anthropic-mt.test.ts` — same.
7. `src/client/replay/runner.test.ts` — the stored `Run` carries `languagePair`/`direction` equal
   to what the transport was started with; a run with no target language never reports `complete`
   and its `errors` match `/language/i`.
8. `src/client/views/ReplayView.test.tsx` — `run()` and EVERY sweep configuration carry a non-empty
   pair/direction/target; direction follows the clip's `sourceLanguage` (es clip → `es→en`).
9. `src/client/views/LiveView.test.tsx` — drives the REAL transports over faked wires; a pair
   switch or direction swap must re-instruct the session (realtime) / re-open `session.start`
   (cascade). Label-only changes fail.

## Verified seams (file:line, checked against the repo 2026-08-09)

- `src/client/transport/types.ts:93-103` — `TransportConfig` **already declares all three fields**
  (`languagePair`, `direction`, `targetLanguage`). Transports receive them; callers never fill them.
- `src/client/transport/realtime.ts:541-549` — `const targetLanguage = this.config?.targetLanguage ?? ''`
  interpolated into `Translate everything the user says into ${targetLanguage}.` This is the German.
- `src/client/replay/runner.ts:369-371` — `RunOnceConfig` already has the three fields, optional.
- `src/client/replay/runner.ts:938-942` — fills each with `?? ''` before starting the transport.
- `src/client/views/ReplayView.tsx:522-528` — `run()` builds `{ architecture, realtimeModel, providers }`
  only. No language fields. Sweep path is the sibling to fix.
- `src/client/views/useSessionController.ts:387-395` — `runConfig` omits the language fields.
- `src/client/views/useSessionController.ts:799` — `transportKey = JSON.stringify(runConfig)`.
  Adding the language fields to `LiveRunConfig` is what makes a switch reach the wire.
- `src/client/state/sessionMachine.ts:217-218` — `pairs = [{src:'English',tgt:'Spanish'},
  {src:'English',tgt:'Cantonese'}]`, indexed by `langIdx`, flipped by `reversed`. This is the
  single source for deriving `EN↔ES` / `en→es` / `Spanish`.
- `src/client/state/ledger.ts:260` — `interface Run`. Lacks `languagePair` / `direction`.
- Nothing in production currently produces the strings `'EN↔ES'` / `'en→es'` — only
  `src/client/fixtureDeps.ts:201` and `src/client/views/sessionTestKit.ts:121`. A real derivation
  helper has to be written.

## Traps specific to 062

- `LiveRunConfig extends RunConfig` (core/arms) and feeds `deriveArmTag`. Adding language fields
  must NOT change arm derivation. Arm membership is derived from configuration — languages are not
  part of that configuration.
- Fixing only the callers leaves the failure mode armed. The realtime refusal of a blank target is
  a design decision to honour, not route around.
- Do not add post-hoc language detection on output. The instruction must be right at the source.
- `not.toContain(other)` is strict: an instruction naming both ends of the pair fails.

## Loop, per ticket

1. Test-writer sub-agent (skip for 062 — tests already locked at 3bb00a8).
2. Lock = commit the tests. Orchestrator commits; sub-agents never touch git.
3. Implementer sub-agent drives them green. May not edit a locked test. If it believes a test is
   wrong, it stops and says so.
4. Adversarial reviewer sub-agent — read-only, mutation-based, reviews the diff.
5. Loop on findings until reviewer returns GREEN.

## Gates before every commit

```
npm test && npm run eval && npx tsc --noEmit -p tsconfig.json && npx tsc --noEmit -p tsconfig.server.json && npm run build
```

`npm run eval` is the acceptance gate: 12 cases in `eval/golden/`, currently 8 pass / 5 fail, each
failure naming its ticket. A case that goes green must go green because the product changed.

## Standing rules (violating these corrupts the experiment)

- `isAggregatableRun` is the ONE place that decides aggregation. Never add a second gate.
- Arm membership derived from configuration, never declared.
- Unmeasured is `null` → "not measured". Never `$0.00`, never a zero.
- Never report a fixture-sourced number. Never aggregate `origin: manual` or `status: failed`.
- The measured atom is the utterance, not the Run.
- 24 kHz PCM16 mono; `SAMPLE_RATE` in `src/core/protocol.ts` is the single source of truth.
- Live persists no audio, creates no Run records. Replay autoplays nothing; Live autoplays always.
- Everything is an injectable seam — jsdom has no AudioContext / MediaStream / RTCPeerConnection.
- Provenance reports actual N, never intended N.

## Sub-agent rules, every time

- Run NO git commands — not even `checkout`/`stash`. Undo by editing files back by hand.
- Do NOT run prettier (no repo config; it reformats unrelated regions).
- Do not start or stop dev servers without asking — Kelly uses them.
- No new test file in a module that already has one. New assertions go in the existing file.

## Blocked on Kelly — do not attempt

- YUE takes 1–3; ES takes 1–3 (needs a Spanish-speaking coworker — the only externally-blocked item)
- One 5-minute Live session per arm (the rubric's stability benchmark, never executed)
- Listening to EN→YUE output (PRD §10's Mandarin-pronunciation trap is audible only)
- Do NOT re-run the 3 recorded EN corpus takes until 062 lands.

## Progress log

**2026-08-09 — 062 DONE** (`a57cd3a`). 34 locked reds closed. Three defects, one seam
(`deriveLanguageSelection` etc. in `sessionMachine.ts`, beside the `pairs` table). Blank/whitespace
target refused at the source in both `RealtimeTransport.start()` and `runOnce`. Reviewed over 18
mutations — no headline defect reintroducible; 4 unpinned-intent findings closed with 7 assertions,
each watched fail first. The one that mattered: a Live utterance RECORD stamped `EN↔ES` for an
EN↔YUE or reversed session — the defect class moved from wire to ledger.

**2026-08-09 — 061 DONE** (tests `856c7f3`, impl `a6ca500`). Suite 2174 passing. Golden eval case 11
now passes. Reviewed GREEN over 24 mutations, including both relocation mutations.

Scope finding worth carrying forward: `languageSelectionForSource` returned the first matching pair,
so Cantonese was unreachable from Replay — and sweeps run through Replay, so the kept Cantonese track
could not be produced at all. Replay now has the operator-visible target control AC2 specified.
**Ticket 065 (batch sweep dialog) will see this control** — the sweep now has a target-language
dimension it did not have before.

One locked test was repaired by the orchestrator (not the implementer, who correctly stopped and
reported it): `ResultsView.category.test.tsx:194` used `getByText` where n = 1 makes p50 === p95, so
both cells render the same string. Replaced with `getAllByText` plus a strictly stronger clause.

## OPEN QUESTION FOR KELLY — ticket 056

`056-retain-output-audio-per-run.md` is `status: pending`, carries a full `## CONTEXT FOR A FRESH
AGENT` section, and owns a **failing golden eval** (case 12,
`output-audio-is-retained-for-blind-scoring`) — but it appears in **neither** the handoff's work
order **nor** its deferred list (050, 026, 053) **nor** its closed-invalid list (022, 063). Its own
title says "without it the project's most distinctive finding cannot be produced", which reads like
the Cantonese audible-only finding (PRD §10).

Two of the five remaining eval failures are 055; one is 060; one is 056. So 056 is the only red eval
case with no place in the stated queue. Needs a decision: work it, defer it explicitly, or close it.

## Remaining queue (unchanged order)

064 → 055 (split 055a ledger / 055b runner envelope) → 059 → 060 → 065 → 066 → 054 → 058 (never
parallel with 054) → 057.

## CORRECTION — the eval scoreboard was misread all run (2026-08-09)

`npm run eval` read 8 pass / 5 fail before and after 062, so it was reported as "unchanged". It was
not: **the composition swapped.** Verified by running the eval in a worktree at baseline `3637c6f`.

| | 01 | 02 | 04 | 10 | 11 | 12 |
|---|---|---|---|---|---|---|
| baseline `3637c6f` | ✗ | ✗ | ✗ | ✗ | **✗** | ✓ |
| after 062 + 061 | ✗ | ✗ | ✗ | ✗ | **✓** | **✗** |
| after 056 | ✗ | ✗ | ✗ | ✗ | ✓ | ✓ |

061/062 fixed case 11; 062's no-target-language contract broke case 12, whose fixture declared
`EN↔YUE`/`en→yue` with no `targetLanguage`. Two sub-agents reported the composition wrongly and the
orchestrator relayed it before checking.

**Lesson for the rest of this run: a stable pass/fail COUNT is not evidence the same cases pass.**
Enumerate the failing case ids every time, not just the totals.

**056 was never a failing-eval ticket.** The handoff's claim that it owned a red case was wrong.

## 056 — DONE (buildable half), `3295e84`

In scope: PRD §15A rules it in explicitly under "Explicitly NOT cut" — retaining output audio
"becomes load-bearing, because that finding is audible only. It moves ahead of the sweep."

The audio path was "landed and green but never exercised" — this repo's #1 failure mode. Mutation-
tested end to end over **20 mutations; none survived.** All four "already satisfied" claims are real.

But golden eval case 12 was a weak gate: the harness substitutes its own `RunsClient` and never
touches the server, so it stayed green under a wrong sample rate, a constant play gate, a server that
writes nothing, and a client that fabricates the path. The fake now refuses what the real route
refuses. Verified: 16000 Hz turns case 12 red.

Ticket status → `blocked-on-operator`. Remaining ACs are real-data only (see the ticket).

### Flagged for Kelly, deliberately not changed

`ReplayView.tsx:637` picks blind-compare pairs on `status === 'complete'` alone, with no stored-audio
predicate, so BlindCompare can offer a play button for a run with no `.out.wav`. Possibly deliberate
— gating inside BlindCompare would leak which sample is which arm — and adding one would violate
056's own "no second has-audio predicate" rule.

### Ticket 056's own context table has an error

It says `no output audio stored` "is not a literal … do not grep for the sentence." It **is** a
literal (`RunsList.tsx:60`). Corrected in the ticket.

## Queue from here

064 → 055 (split 055a/055b) → 059 → 060 → 065 → 066 → 054 → 058 (never parallel with 054) → 057.
