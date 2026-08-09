# Spec Audit — PRD.md vs. rubric vs. running app

**Date:** 2026-08-08 · **App under test:** `http://localhost:5173` (live, Chrome) · **HEAD:** `ca40359`
**Method:** every number below was computed from the repo, the running server's API, or the browser — not read off the PRD.

> **Decisions recorded since the first draft (Kelly, 2026-08-08):**
> **① The Cantonese track stays** — reversed from the §4 cut list. See "Decided in" in §4 for what that changes.
> **② The Help tab stays** — see §5.
> **③ Ticket 054 (corpus manifest import) is cancelled** — `RecordTake.tsx` already does the job; the placeholder corpus is a dead end, not an input.
> **④ EN Take 1 is verified good** — no re-record needed.

---

## 0 · Verdict in five lines

- The **build is not the problem**. Six real provider adapters, a real WebRTC path to OpenAI, a streaming cascade orchestrator, 311 commits — 7 of the rubric's 8 must-haves have working code behind them.
- The **evidence layer is the problem**. The corpus is synthetic tone bursts, there are 3 runs in the ledger and 0 sweeps, every cost reads `$0.000`, and the headline experiment (Exp 1) is empty.
- The **Results screen is showing numbers that are not in the repo.** It reads browser `localStorage`, not the server ledger. Clearing Chrome deletes the findings.
- The **PRD is ~4× the size the rubric asks for.** 1,105 lines / 97 KB for a *"3–4 day, 15–20 hour"* take-home. Most P2 findings trace to scope the brief never asked for.
- **Rubric must-have #8 — the write-up — has zero artifact.** It is the single largest gap and it is worth more than every open ticket combined.

---

## 1 · Rubric coverage — the contract

The rubric is the grading contract. Quoted wording, verified status.

| # | Rubric must-have (quoted) | Status | Evidence |
|---|---|---|---|
| 1 | "Browser-based SPA with microphone capture and audio playback" | ✅ | Live view, `Start microphone`, four-value permission indicator rendered |
| 2 | "Realtime mode using OpenAI Realtime API (gpt-realtime) - voice in, voice out" | ✅ | `src/client/transport/realtime.ts:490` real `createOffer` → SDP POST; `src/server/token.ts:37` real ephemeral `client_secrets` |
| 3 | "Cascade mode using a composed STT → Translation → TTS pipeline with streaming" | ✅ | `src/server/cascade/orchestrator.ts`; all 6 adapters hit real endpoints (`api.openai.com`, `api.elevenlabs.io`, `api.anthropic.com`) |
| 4 | "UI toggle to switch between modes mid-session or pre-session" | ✅ | Live header toggle + queue-at-boundary |
| 5 | "Language pair selection (minimum: English ↔ Spanish)" | ✅ | EN→ES selector + direction swap + per-mode support pill |
| 6 | "Live transcripts showing both source and target text as they're produced" | ✅ | wired |
| 7 | "Per-stage latency display visible to the user" | ✅ **code**, ⚠️ **data** | Real and labelled in ms: `LiveView.tsx:448 stageRowsFor`, `RunsList.tsx:342` (`[data-run-stage]`), fed by `src/core/timing.ts` marks. But **every stage renders `—` on 2 of 3 stored runs** — those runs predate ticket 051 (`ef7c204`). The code is right; the stored data is stale. Re-run, don't re-code. |
| 8 | "Comparison write-up (1–2 pages) covering latency, quality, cost, controllability, and a recommendation" | ❌ **0%** | No `FINDINGS.md`, no `COMPARISON.md`, no `results/` directory. Nothing exists. |

**Also graded, also missing:**

| Rubric line | Status |
|---|---|
| "Realtime mode: under 1.5s end-to-end perceived latency" | **unproven** — 1 Arm A run, `942 ms`, N=1, synthetic tone input |
| "Cascade mode: under 3s end-to-end, target under 2s" | **unproven** — the only cascade run reports negative latency |
| "sustain a 5-minute back-and-forth conversation" | **unproven** — longest LiveSession on disk is `58,491 ms` (58s) of 300,000 ms required |
| "README with setup, run, and architecture overview" | ✅ present |
| "AGENTS.md describing agent usage" | ✅ 16.5 KB, accreted live |
| "Commits scoped to logical units… no single 'initial commit' dumps" | ✅ 311 commits, `stub/test/feat/fix/docs` convention |
| "full coverage not required, critical paths must be tested" | ⚠️ **overshot** — 2,078 tests, 42,495 test LOC vs 26,092 source LOC (1.63:1) |

---

## 2 · P0 — blocks the deliverable

### P0-1 · Two ledgers. The Results screen reads `localStorage`, not the repo.

**Where:** `src/client/App.tsx:34` ("localStorage-backed RunLedger"), `ResultsView` consumes `deps.ledger`.

**Evidence — measured, not inferred:**

| Source | Contents |
|---|---|
| `GET /api/live-sessions` | **8** sessions, **31** utterances |
| `GET /api/runs` | **3** runs |
| `localStorage['workbench.runLedger.v1']` | **41** utterance records, 93 KB |
| Results screen displayed | **"14 sessions · 41 utterances completed"**, `23` realtime / `18` cascade |

`23 + 18 = 41` — the screen is rendering the browser blob verbatim. The server's 8 sessions are nowhere in it.

**Why it's P0:** PRD §8 states *"One ledger under every view… the ledger is the source of truth, so a metric cannot drift between screens or between a screen and the write-up."* It has already drifted. Concretely: the numbers a reviewer sees cannot be reproduced from a clone, `npm run export-results` cannot see them, and clearing browser data destroys the project's evidence.

**Fix:** server `data/ledger.jsonl` is the single source. `localStorage` becomes a write-through cache that is *hydrated from*, never *aggregated from*.

---

### P0-2 · A run with **negative** end-to-end latency is stored as `status: 'complete'` and is aggregate-eligible.

**Where:** ledger row `7acb0cc9-b38a-48c9-a824-117b84371c45`.

```
speech_end   = 1786148899148
audio_queued = 1786148885175      ← 13,973 ms EARLIER
status       = "complete"
```

Rendered in the UI as `total **-13973 ms**` next to a green `complete` badge. `grep` finds no `< 0` guard anywhere in `src/client/components/results/derive.ts` or `src/client/replay/runner.ts`.

**Why it's P0:** this is exactly the class of error the PRD was written to prevent (§7: *"Failed runs are saved, visible, and excluded from every aggregate"*). A single negative sample silently drags a p50 below the 1.5 s benchmark. The clock bug itself (client `speech_end` vs server `audio_queued` — two clocks, contradicting §8 *"Only intervals within one clock are summed"*) is the root cause.

**Fix:** (a) same-clock assertion at write time; (b) `audio_queued < speech_end` ⇒ `status: 'failed'`, reason `clock-inversion`; (c) aggregates reject non-positive totals loudly.

---

### P0-3 · The Experiment 2 card presents unmeasured figures as measured.

**What the running app shows, with no `illustrative` badge:**

```
Arm B · 14 utterances · 5 of 5 reps completed · cost measured on 65 of 65 samples
Arm C · 13 utterances · 5 of 5 reps completed · cost measured on 61 of 61 samples
p50 latency   1.15 s    1.03 s    -0.12 s
cost per min  $0.014    $0.014
```

**What exists:** `data/ledger.jsonl` has **3 rows**, all `origin: 'manual'`, tally `{A|manual|failed: 1, B|manual|complete: 1, A|manual|complete: 1}`. **Zero sweep runs. Zero Arm C runs.** Every stored `cost` field is `0`. The only provider triple ever recorded is `{openai, openai, openai}` — ElevenLabs has never run.

So "5 of 5 reps completed" and "cost measured on 65 of 65 samples" are provenance lines asserting a sweep that never happened. Exp 1 correctly renders `no sweep runs recorded`; Exp 2 does not.

**Why it's P0:** the PRD's own hard rule (§8) — *"No number reported in the write-up may come from a fixture run"* — plus §8's *"Empty states are mandatory… so polished placeholders can never be mistaken for measured evidence."* This is the failure mode the document exists to prevent, shipped.

**Fix:** one gate — a card renders figures **iff** ≥1 `origin:'sweep' && status:'complete' && providers≠fixture` run backs it. Otherwise empty state. No exceptions, no per-card logic.

---

### P0-4 · The corpus is synthetic tone bursts. No real measurement is possible today.

`corpus/manifest.json`:
```json
{ "corpusId": "placeholder-v0", "placeholder": true,
  "note": "synthetic placeholder — no reported number may come from this corpus" }
```

Verified by decoding the PCM: all 36 clips peak at exactly `9830` — a constant-amplitude tone, generated by `scripts/generate-placeholder-corpus.mjs` ("*a tone burst + silence tail… NOT speech*").

**Consequences, all of them blocking:** STT has nothing to transcribe (hence `expected 4 utterances, observed 0` on run `2ba6332b`), WER is undefined, blind scoring has nothing to hear, and both performance benchmarks are unmeasurable. PRD §15 remaining item 11 names this; it is the **critical path** and it needs a human with a microphone, not an agent.

**Also:** there is **no corpus → Recordings import**. The library holds **1** Recording (a hand-made mic take) against 36 committed clips. A sweep matrix cannot be built.

---

### P0-5 · No output audio is retained, so blind scoring cannot run at all.

Every run row in the UI reads `no output audio stored`. PRD §7: *"Output audio is retained for later blind scoring"*; §10 requires scoring be **playback-only** *"because reading the text would let the Mandarin-pronunciation class of error pass unnoticed."* The `compare blind` button exists and has nothing to play. Quality — one of the five write-up dimensions — is structurally unreachable.

---

## 3 · P1 — will cause rework

| # | Where | Defect | Evidence |
|---|---|---|---|
| P1-1 | Results → coverage card | Cites `commit a4f21c` and `commit 9d0e77` as proof of onboarding cost. **Neither hash exists in this repo.** | `git cat-file -t a4f21c` → `fatal: Not a valid object name`. PRD §11: *"Onboarding cost is proven by commit, not claimed."* The card is badged illustrative, so this is not a false claim — but the mechanism the PRD promised is fake, and the real diff is trivially derivable from actual history. |
| P1-2 | `ReplayView` batch | The **runner itself is real and good** — `src/client/batch/runner.ts:303 startBatch` does counterbalanced A→B/B→A ordering, an uncounted warmup rep, per-run timeout race, single retry, cancel-keeps-completed. What's missing is the *front* of it: `Batch sweep…` (ellipsis promises a dialog) **launches immediately** against whatever single Recording is selected. PRD §7 specifies *"selected Recordings × selected configurations × N repetitions."* No matrix picker, no rep count, no cost/time estimate before a ~$4 / 68-minute operation. Verified live: clicked, it started; `Cancel — keep completed runs` worked correctly. | manual QA + code |
| P1-3 | `ReplayView` | Navigating away from Replay and back **clears the Recording selection**, disabling Run/Batch and resetting the Runs list to "No Runs of this Recording yet" while the sidebar still reads `3 runs`. | manual QA |
| P1-4 | ledger / Live | **Every** cost is `$0.000` — 3 runs and 8 LiveSessions, all `totalUsd: 0`, `perMinuteMinute1: null`. **No record carries `pricingVersion`**: every one predates the pricing module (`src/core/pricing.ts`, added at `f43c121`/`513c5ef`, near HEAD). Cost is a rubric **Key Impact Metric**. | `data/*.jsonl` |
| P1-5 | LiveSessions | `p50: null` on **all 8** sessions, yet the Results Live card prints `p50 0.40 s / 1.50 s`. **The p50/p95 computation exists and is correct** (`useSessionController.ts:686–711`) — the 8 stored sessions simply predate ticket 051. So the printed figure comes from `localStorage` (P0-1) while the persisted record is null. **This is a data-staleness problem, not a code problem.** | `data/live-sessions.jsonl` |
| P1-5b | Live | `driftMinute1ToEnd`, `heapStart`, `heapEnd` are **hardcoded `null`** at `useSessionController.ts:712, 733–734` — with full type plumbing through `ledger.ts`, `storage/types.ts:205–216`, route validators and export summaries. Latency drift and leak detection are specified, typed, validated, exported — and never measured. The repo's only "heap" data is `benchmark-results/fixture-soak.json`, stamped `"PLACEHOLDER": true` with invented figures (`minutes: 8.5, utterances: 53178`). | code |
| P1-6 | Live results card | The `REALTIME · TRIMMED` column is entirely `—` despite **2** trimmed sessions on disk. The context-policy comparison — the whole of PRD §7's controllability evidence — renders empty. | `data/live-sessions.jsonl` rows 6, 8 |
| P1-7 | Stability | Longest session on disk is **58.5 s**. The rubric's 5-minute benchmark has never been executed once. | `data/live-sessions.jsonl` |
| P1-8 | Test suite | 125 files, **1,631 `it()` blocks**, 42,495 test LOC against 27,579 source LOC (1.54:1). Rubric: *"full coverage not required, critical paths must be tested."* Worst ratios are on trivial modules — `src/core/registry.ts` is **73 lines of three `if` chains defended by 235 test lines / 21 tests (3.2:1)**; `arms.ts` 162/332 for frozen constants; `models.ts` 115/191 for a lookup table. Meanwhile nothing asserts server-ledger-is-source-of-truth, nothing rejects negative latency, nothing gates an experiment card on real samples. **The coverage is inversely correlated with the risk.** | audit |
| P1-10 | Run record | **`languagePair` and `direction` are `undefined`** on every stored Run (verified on `7acb0cc9`). PRD §8's utterance record specifies both, and the controlled-variable register pins *"Language pair + direction — fixed per sweep."* A run that does not record its own direction is not reproducible and cannot be grouped correctly in the by-category view. | `data/runs/*.json` |
| P1-11 | Run record | A cascade run over a **4-utterance** Recording stored **one** source/target pair, not four: `transcripts: { source, target }` is a single object, not an array. Run `7acb0cc9` captured only utterance 3. This is the direct cause of the `—` stage timings and the nonsense total — the run only ever processed one utterance. §8 specifies *"One record per utterance per arm."* | `data/runs/7acb0cc9…json` |
| P1-9 | Never-exercised subsystems | `data/wer-scores.jsonl` and `data/blind-comparisons.jsonl` **do not exist** — neither write path has ever produced a record. `BlindCompare.tsx` is **446 lines with 34 tests** that has never scored anything; the full WER pipeline (`core/wer.ts` 343 lines, `harness/scoreWer.ts` 230) has never scored anything. Both are downstream of P0-4 (no real corpus) and P0-5 (no stored output audio). | audit |

---

## 4 · PRD bloat — cut, don't build

The brief allots **"3–4 days for the build (~15–20 hours total effort)."** The PRD is **1,105 lines**, 17 sections, ~130 decision-log entries, and a scope contract that says *"everything in this document will be built. Nothing here is aspirational."* That contract is the root cause of the backlog regenerating faster than it drains.

**Cut outright — costs days, earns nothing on the rubric:**

| § | Item | Why cut |
|---|---|---|
| §7, §8 | **The 45-run sweep at 5 repetitions** (~68 min, ~$4) | 3 reps × 1 direction gets you p50 and a defensible interval. p95 from 60 samples of read speech is precision nobody is grading. Halves the operator's blocked time. |
| §10 | **In-app blind pairwise scoring with persisted randomized draw** | A whole subsystem (`BlindCompare.tsx`, ledger draw persistence) for `n=1` evaluator and ~24 judgements. Two files on disk and a note in the write-up is honest and costs an hour. |
| §7, §8 | **Heap sampling / leak detection / 60-minute fixture soak** | Not in the rubric except as *"without… memory leaks"* inside the 5-minute benchmark. One before/after heap number in that one session satisfies it. |
| §8 | **Counterbalanced run order + warmup discard as enforced machinery** | Real methodology, but at N=3 recordings it is a paragraph of disclosure, not a runner feature. It is also what makes `origin:'sweep'` load-bearing — cutting it simplifies the whole quarantine. |
| §14 | **EC2 + Caddy deploy** | Rubric: *"Optional… Local-only with clear setup instructions is fine."* AWS credentials are absent (§15 item 14). Delete. |
| §7 | **Recording soft-delete / purge / undeletable-corpus lifecycle** | Three rules and their tests defending a library that currently holds one item. |
| §5, §6 | **`gpt-4o-mini-transcribe` and `eleven_multilingual_v2` as menu options** | The same-vendor contrast is a nice-to-have; the *cross-vendor* swap is what the rubric grades ("providers can be swapped without rewriting the app"). Two options per stage proves it. |

**Keep but stop expanding:** §3 experimental design, §6 architecture and stage interfaces, §8 timing vocabulary, §12 error handling. This is the strongest material in the document and it is already built.

**Net:** cutting the above removes roughly half the remaining work in §15 and none of the graded surface.

### Decided in — not up for cut (Kelly, 2026-08-08)

**The Cantonese track stays** (§5, §9, §11). An earlier draft of this report proposed cutting it to one paragraph. Overruled, and the reasoning holds: the rubric's *"minimum: English ↔ Spanish"* is a floor, and Cantonese is the only place the project can answer *"provider flexibility"* and *"time-to-onboard a new language pair"* — both named **Key Impact Metrics** in the brief — with evidence rather than assertion. It is also the sharpest evidence for the auditability thesis: PRD §10's Mandarin-pronunciation trap is a failure that *"a text-only evaluation scores as a success."*

Three consequences the plan must absorb:

1. **Cantonese is cheap to record and you are the evaluator.** 3 improvised takes from English prompt cards, no written script, no reference text, no coworker. `RecordTake.tsx:165–167` already omits `referenceText` for `yue` by design. ~15 minutes, solo.
2. **P0-5 (retain output audio) is promoted from important to load-bearing.** The Mandarin-vs-Cantonese finding is detectable *only by listening*. With no stored output audio, the single most distinctive result in the project cannot be produced. It moves ahead of the sweep in §7.
3. **P1-1 (fabricated commit hashes) escalates.** The coverage card is now a real deliverable rather than a placeholder, and PRD §11 stakes it on *"onboarding cost is proven by commit, not claimed."* `a4f21c` and `9d0e77` do not exist. Real hashes from the actual EN↔YUE work must replace them, or the card's strongest claim is decoration.

**The Help tab stays** (§5 of this report). Also decided. It is the clearest prose in the project and it doubles as the write-up's first draft — see §7 item 7.

---

## 5 · App bloat — already built, adds risk

| Surface | Assessment |
|---|---|
| **Help tab** (`HelpView.tsx`, 313 lines, static copy, zero controls) | **KEEP — decided.** Not in PRD §16 deliverables and not in the rubric, so it was listed here for a ruling; the ruling is keep. It is the clearest prose in the project, it explains the arms and the 5-vs-3 auditability gap better than the PRD does, and it costs nothing to maintain (no controls, no state). Treat it as the write-up's first draft — §7 item 7 harvests from it. Do not extend it further; new prose belongs in `FINDINGS.md`. |
| **`src/client/components/results/derive.ts`** — 1,262 lines | The largest file in the repo is aggregation logic for data that does not exist. |
| **`testRecords.ts`** — 840 lines of test fixtures | A fixture-construction DSL larger than the orchestrator (549 lines) it supports. |
| **`LiveView.tsx` 1,257 · `runner.ts` 1,234 · `ResultsView.tsx` 1,192 · `useSessionController.ts` 1,002** | Four files over 1,000 lines. `useSessionController.ts` and `replay/runner.ts` were each touched **8×** in the last 60 commits — that churn rate is the tech-debt signal, and it is concentrated exactly where the P0s are. |
| **Fixture mode (`?fixture=1`)** | Correct call, keep. It is how QA runs without a mic. |
| **`corpus/` 36 synthetic WAVs** | Delete on the day real audio lands. Keeping both invites a placeholder number into the write-up. |
| **`benchmark-results/fixture-soak.json`** | **Delete now.** Stamped `"PLACEHOLDER": true` with fabricated heap and utterance counts. It is the only heap data in the repo and it is invented. A reviewer finding this file does more damage than the missing benchmark it stands in for. |
| **`src/harness/bench.ts`** (192 lines) | Dead — imported by no production module, reachable only from two fixture-only scripts. Superseded by the in-app batch runner per PRD §8 (*"There is no separate harness"*). |
| **`scripts/smoke-openai.mjs` · `smoke-elevenlabs.mjs`** | Not referenced by any npm script. PRD §13 promises "one real-provider smoke test per path" — either wire them into `package.json` or drop the claim. |
| **`heapStart`/`heapEnd`/`driftMinute1ToEnd` plumbing** | Types, validators, exporters, and tests for three fields hardcoded to `null`. Delete the fields or measure them; do not ship the scaffolding. |
| **`src/client/deletions.test.ts` + `testSource.ts`** | Meta-tests that grep the source tree to assert identifiers are *absent*. Clever, but they couple tests to file contents and will fire on innocent renames. |
| **`.tdd/worktrees/053/`** | A full duplicate copy of the repo sitting in the tree. Clean it up before submission — a reviewer running `find` or a grep will hit doubled results. |

---

## 6 · Golden evals — draft

Per `/product-inception` Phase 4: `eval/golden/*.json`, 6–10 cases, **assert decisions and counts, never model prose**, every expectation traced to the audit or the brief. Each case below defends a specific verified defect or a quoted rubric line. Directory does not exist yet.

```jsonc
// eval/golden/01-server-ledger-is-the-only-source.json
{
  "name": "server-ledger-is-the-only-source",
  "why": "Results must aggregate the server's append-only ledger, never the browser cache (P0-1: server had 8 sessions, screen showed 14).",
  "given": {
    "server_ledger": { "runs": 3, "live_sessions": 8, "utterances": 31 },
    "local_storage": { "key": "workbench.runLedger.v1", "utterances": 41 }
  },
  "expect": {
    "result_type": "results_aggregate",
    "counts": { "sessions_reported": 8, "utterances_reported": 31 },
    "must_exclude": [
      { "id": "localStorage-only-records",
        "reason": "cache may be ahead or stale; it is hydrated from, never aggregated from" }
    ]
  }
}
```
```jsonc
// eval/golden/02-clock-inversion-is-failed.json
{
  "name": "clock-inversion-is-failed",
  "why": "A run whose first audio precedes speech end is a clock bug, not a fast run (P0-2: -13973 ms stored as complete).",
  "given": {
    "run": { "id": "7acb0cc9", "speech_end": 1786148899148, "audio_queued": 1786148885175 }
  },
  "expect": {
    "result_type": "run_record",
    "status": "failed",
    "error_code": "clock-inversion",
    "counts": { "latency_samples_contributed": 0 },
    "must_not_contain": ["complete"]
  }
}
```
```jsonc
// eval/golden/03-experiment-card-requires-real-sweep-samples.json
{
  "name": "experiment-card-requires-real-sweep-samples",
  "why": "PRD §8 'Empty states are mandatory'; Exp 2 rendered p50 1.15 s over a ledger with zero sweep runs (P0-3).",
  "given": {
    "ledger": [
      { "armTag": "A", "origin": "manual", "status": "failed" },
      { "armTag": "B", "origin": "manual", "status": "complete" },
      { "armTag": "A", "origin": "manual", "status": "complete" }
    ]
  },
  "expect": {
    "result_type": "experiment_card",
    "exp1": { "state": "empty", "digits_rendered": 0 },
    "exp2": { "state": "empty", "digits_rendered": 0 },
    "must_not_contain": ["5 of 5 reps completed", "65 of 65 samples"]
  }
}
```
```jsonc
// eval/golden/04-provenance-reports-actual-n.json
{
  "name": "provenance-reports-actual-n",
  "why": "PRD §7: 'Provenance reports actual N, never intended N.'",
  "given": {
    "sweep": { "intended_reps": 5, "completed": 4, "failed": 1 }
  },
  "expect": {
    "result_type": "provenance_line",
    "must_include": [{ "id": "4 of 5 reps completed", "reason": "actual, not intended" }],
    "counts": { "latency_samples": 4 }
  }
}
```
```jsonc
// eval/golden/05-armtag-is-derived-never-declared.json
{
  "name": "armtag-is-derived-never-declared",
  "why": "PRD §6 quarantine: mislabelling must be structurally impossible. Rubric #3 provider swapping is graded here.",
  "given": {
    "configs": [
      { "id": "exact-b",  "architecture": "cascade",  "triple": ["gpt-4o-transcribe", "gpt-4o-mini", "gpt-4o-mini-tts"] },
      { "id": "exact-c",  "architecture": "cascade",  "triple": ["gpt-4o-transcribe", "gpt-4o-mini", "eleven_flash_v2_5"] },
      { "id": "one-off",  "architecture": "cascade",  "triple": ["gpt-4o-transcribe", "claude-haiku-4-5", "gpt-4o-mini-tts"] },
      { "id": "realtime", "architecture": "realtime", "triple": null }
    ]
  },
  "expect": {
    "result_type": "arm_tags",
    "must_include": [
      { "id": "exact-b:B", "reason": "matches the frozen Arm B triple" },
      { "id": "exact-c:C", "reason": "exactly one stage differs from B" },
      { "id": "one-off:ad-hoc", "reason": "MT deviates; explorable, never evidence" },
      { "id": "realtime:A", "reason": "sealed box" }
    ]
  }
}
```
```jsonc
// eval/golden/06-fixture-and-placeholder-never-aggregate.json
{
  "name": "fixture-and-placeholder-never-aggregate",
  "why": "PRD §8 hard rule; corpus/manifest.json is placeholder:true and must never back a reported figure (P0-4).",
  "given": {
    "records": [
      { "id": "r1", "providers": { "stt": "fixture", "mt": "fixture", "tts": "fixture" } },
      { "id": "r2", "corpusId": "placeholder-v0", "providers": { "stt": "openai", "mt": "openai", "tts": "openai" } },
      { "id": "r3", "corpusId": "corpus-v1",      "providers": { "stt": "openai", "mt": "openai", "tts": "openai" } }
    ]
  },
  "expect": {
    "result_type": "aggregate_input",
    "counts": { "samples_admitted": 1 },
    "must_include": [{ "id": "r3", "reason": "real providers on a real corpus" }],
    "must_exclude": [
      { "id": "r1", "reason": "fixture latency is a configured constant" },
      { "id": "r2", "reason": "placeholder corpus is a tone burst, not speech" }
    ]
  }
}
```
```jsonc
// eval/golden/07-unmeasured-cost-is-null-not-zero.json
{
  "name": "unmeasured-cost-is-null-not-zero",
  "why": "All 11 stored records read $0.000 (P1-4). Zero is a measurement; null is an absence. Cost is a rubric Key Impact Metric.",
  "given": {
    "run": { "architecture": "cascade", "usage": { "stt": null, "mt": null, "tts": null }, "audio_ms": 20940 }
  },
  "expect": {
    "result_type": "cost_record",
    "total_usd": null,
    "per_minute": null,
    "must_not_contain": ["$0.000", "0.00"],
    "must_include": [{ "id": "not yet measured", "reason": "absence is stated, never rendered as a figure" }]
  }
}
```
```jsonc
// eval/golden/08-replay-is-paced-at-1x.json
{
  "name": "replay-is-paced-at-1x",
  "why": "PRD §7 / test 7: dumping the clip invalidates VAD, endpointing, and every latency figure — and would look like it worked.",
  "given": { "recording": { "duration_ms": 20940, "sample_rate": 24000, "frame_ms": 20 } },
  "expect": {
    "result_type": "pacing_trace",
    "counts": { "frames_sent": 1047 },
    "within_tolerance": { "field": "wall_clock_ms", "target": 20940, "pct": 10 }
  }
}
```
```jsonc
// eval/golden/09-observable-intervals-5-vs-3.json
{
  "name": "observable-intervals-5-vs-3",
  "why": "Rubric #7 'Per-stage latency display visible to the user'; the 5-vs-3 asymmetry is the auditability finding. Two of three stored runs render every stage as '—' (P1/#7).",
  "given": {
    "cascade_run":  { "marks": ["speech_end","vad_fired","stt_final","mt_first_token","tts_first_byte","audio_queued"] },
    "realtime_run": { "marks": ["speech_end","server_speech_stopped","first_output_audio_delta","audio_queued"] }
  },
  "expect": {
    "result_type": "interval_breakdown",
    "counts": { "cascade_intervals_labelled_ms": 5, "realtime_intervals_labelled_ms": 3 },
    "must_include": [
      { "id": "realtime.model.opaque", "reason": "explicitly labelled opaque, not hidden" }
    ],
    "must_not_contain": ["—"]
  }
}
```
```jsonc
// eval/golden/10-onboarding-cost-cites-a-real-commit.json
{
  "name": "onboarding-cost-cites-a-real-commit",
  "why": "PRD §11 'proven by commit, not claimed'; the coverage card cites a4f21c and 9d0e77, neither of which exists (P1-1).",
  "given": { "claims": [{ "pair": "en-yue", "commit": "a4f21c", "lines": 14 }] },
  "expect": {
    "result_type": "coverage_tile",
    "must_include": [{ "id": "commit_resolves_in_repo", "reason": "git cat-file -t must succeed" }],
    "on_unresolvable": { "render": "illustrative", "digits_rendered": 0 }
  }
}
```

**How to run them:** these are decision fixtures, not UI tests. Point them at `derive.ts` / the ledger / `armTag` / the pacer as pure functions, plus one Playwright-free DOM assertion for cases 03 and 09. They should replace, not augment, roughly 300 of the existing tests.

---

## 7 · What to actually implement, in order

Everything below is scoped to fit what remains of a 15–20 hour brief.

| # | Work | Why first | Owner |
|---|---|---|---|
| **1** | **Record the real corpus — in the app, not via a script.** **EN Take 1 is already done and verified** (4/4 utterances, categories correct, reference text verbatim-matched to `SCRIPTS.md`, clean 5–6 s segmentation, real speech that a cascade run transcribed and translated correctly). So: **EN Takes 2–3** (~12 min, solo) · **YUE Takes 1–3** (~15 min, solo, improvised from English prompt cards, no reference text) · **ES Takes 1–3** when the coworker is free. | Blocks latency, WER, quality, cost — every number in the write-up. Nothing an agent can do. | **You, today** |
| **2** | ~~Corpus → Recordings import~~ **— CANCELLED, not needed.** `RecordTake.tsx` already collects clip label, language, per-utterance category and `referenceText`, and saves with `origin:'corpus'` (`RecordTake.tsx:160, 217–218, 451–456`). `corpus/SCRIPTS.md` is a complete ready-to-read script. The placeholder manifest is a dead end, not an input — **delete `corpus/*.wav` + `manifest.json`, do not import them.** | The 36 synthetic WAVs were never the path in | agent, ~15 min |
| **3** | **P0-1 + P0-2 + P0-3 as one ticket**: server ledger is the only aggregate source · clock-inversion ⇒ failed · experiment cards gate on real sweep samples | These three are one defect wearing three hats, and they are what make every displayed number untrustworthy | agent, ~3 h |
| **4** | **Retain output audio per run (P0-5)** — moved ahead of the sweep | Now load-bearing: with Cantonese kept, the Mandarin-pronunciation finding is **audio-only** and cannot be produced without stored output | agent, ~1 h |
| **5** | Run **Exp 1** — Arm A vs Arm B, 3 recordings × 3 reps, EN→ES | The headline result. Currently empty. | agent-driven, ~25 min wall |
| **6** | **Cantonese pass** — EN→YUE and YUE→EN on cascade, plus Realtime on Cantonese to document *how* it fails. Listen to every output. Record real commit hashes for the EN↔YUE diff and put them in the coverage card, replacing `a4f21c` / `9d0e77` (P1-1). | Answers "provider flexibility" and "time-to-onboard" — two named Key Impact Metrics — with evidence. PRD §11: ~10 min, ~$0.50. | agent runs, **you listen** |
| **7** | Run **one 5-minute Live session per arm** | The rubric's stability benchmark, verbatim, never once executed | you, 15 min |
| **8** | **Write `FINDINGS.md`** — 1–2 pages: latency / quality / cost / controllability / recommendation. **Harvest the Help tab** (`HelpView.tsx`) for structure and phrasing — it already explains the arms, the experiments, and the 5-vs-3 auditability gap in plain language. | Rubric must-have #8, 0% done, worth more than the entire open backlog | agent drafts, you edit |
| **9** | `npm run export-results` → commit `results/<date>/` | PRD §7: the committed bundle is the artifact of record. Directory doesn't exist. | agent, ~30 min |
| — | Ticket 053 (provider usage channel), 050, 026, batch matrix UI, in-app blind-scoring polish, EC2 deploy | **Deferred or cut.** See §8. Cantonese and the Help tab are **not** on this list — both decided in. | — |

---

## 8 · The implementation agent — assessment and directive

**Current state:** idle. Ticket **053** ("providers report no usage") is in flight in worktree `.tdd/worktrees/053`, branch `tdd/053`, **HEAD identical to main — zero commits landed**, stopped mid test-writer with four new uncommitted test files.

**Is the work worthwhile? Partly — and it is solving the wrong end of the problem.**

*Credit where due.* The 051 → 052 → 053 chain is genuinely structural, not whack-a-mole: observable timing marks → a versioned pricing module → a usage channel through the provider protocol. Its discipline is sound — it consistently refuses to fabricate, rendering unmeasured values as `null` rather than `$0.00`. That instinct is exactly right and it is why the codebase is in decent shape.

*The problem.* It is optimising the **precision** of a cost figure that has **zero samples behind it**. Cascade cost can be estimated to within a few percent from `audio_duration × published rate` — the PRD publishes the rate card in §5 and states cascade is flat at ~$0.021/min. A per-token usage channel across four adapters is a multi-hour refactor buying a second decimal place on a number nobody has measured once. Meanwhile Exp 1 — the *headline* — has no runs, the corpus is tone bursts, and the write-up does not exist.

*The sharpest version of this.* The audit found that **every stored record predates the code that would have populated it**: no record carries `pricingVersion` (they predate `src/core/pricing.ts`), all 8 LiveSessions have `p50: null` (they predate ticket 051), and 2 of 3 runs render every stage as `—` for the same reason. The p50 computation is correct. The pricing module is correct. **The last three tickets already fixed these — nobody has re-run anything since.** The marginal value of ticket 054, 055, 056 of the same kind is near zero next to the value of one sweep.

*The structural signal.* 048 → spawned 050. 051 → spawned 052 → spawned 053. Four review rounds on 048, four on 049, round-2 rework on both 051 and 052. **The backlog regenerates faster than it drains**, and 052's own round-2 note — *"the module is solid, its consumers are untested"* — describes adding a second test layer to already-tested code. At 2,078 tests against a rubric that says *"full coverage not required,"* the loop has become self-sustaining. Its own honest assessment was correct: *"#8 is blocked on you, not on the build."* It said that, then started 053 anyway.

**Directive: PAUSE 053. PIVOT to the evidence layer.**

Message to send:

> **Stop 053.** Stash the worktree; do not land it. Cascade cost will be estimated from `audio_duration × the §5 rate card` and labelled `estimated (rate-card)` — that is honest, it is one function, and it unblocks the write-up today. Reopen 053 only if time remains after item 7 below.
>
> **Close 051 and 052** — the code landed; restatus the files.
>
> **Defer 050 and 026** to a `wont-fix-this-cycle` section with a one-line reason each.
>
> **New tickets, in this order:**
> 1. `054 · corpus import` — load `corpus/manifest.json` clips as Recordings with `origin:'corpus'`; ship the delete of the placeholder WAVs behind the same commit as the real ones landing.
> 2. `055 · one ledger, one truth` — the server's `data/ledger.jsonl` is the sole aggregate source; `localStorage` becomes a hydration cache only. Reject `audio_queued < speech_end` at write time as `status:'failed'`, `clock-inversion`. Gate every experiment card on ≥1 `origin:'sweep' && status:'complete' && providers≠fixture` sample — otherwise the empty state. *These three are one defect; do them in one ticket.*
> 3. `056 · retain output audio per run` — unblocks blind scoring.
> 4. `057 · FINDINGS.md skeleton` — the five required sections with explicit `not yet measured` placeholders, ready to fill the hour the corpus lands. **Yes, draft it now** — you offered, and the answer is yes.
> 5. `058 · delete the placeholders` — remove `benchmark-results/fixture-soak.json` (it is stamped `PLACEHOLDER: true` with invented heap and utterance figures and is the only heap data in the repo), `src/harness/bench.ts` (dead), and the `heapStart`/`heapEnd`/`driftMinute1ToEnd` plumbing that is hardcoded `null` through five layers. Either wire `scripts/smoke-*.mjs` into `package.json` or drop the §13 claim. Remove `.tdd/worktrees/053/` once 053 is stashed.
>
> **Before you write any new code:** note that every stored record predates the fix that would have populated it — no record has `pricingVersion`, all 8 LiveSessions have `p50: null`, 2 of 3 runs show `—` for every stage. **051 and 052 already work. Nothing has been re-run since they landed.** Re-running is worth more than the next three tickets combined.
>
> **Test policy for the rest of this cycle:** no new test file may be added to a module that already has one. New assertions land in the existing file. Write the ten `eval/golden/*.json` cases in `temp_report.md` §6 and delete whatever they subsume.
>
> **Do not start any ticket that is not on the list above.** If a fix reveals a new hole, file it and keep going — do not work it.
>
> **Already ruled on — the Cantonese track and the Help tab stay.** Do not cut, trim, or "simplify" either. Two things follow: (1) retaining output audio per run (`056`) is now **load-bearing**, not a nicety — the Mandarin-vs-Cantonese finding is audible only, so it moves ahead of the sweep; (2) the coverage card's `commit a4f21c` / `9d0e77` must be replaced with hashes that actually resolve, since PRD §11 stakes onboarding cost on *"proven by commit, not claimed."*

---

## 9 · The two questions only you can answer

1. **~~When are you recording the real corpus?~~ — answered: today.** EN Take 1 is already done and verified. Remaining: EN 2–3 (~12 min), YUE 1–3 (~15 min), ES 1–3 on the coworker's schedule. **The Spanish set is now the only externally-blocked item in the entire project** — worth deciding today whether you ask for it tonight or accept EN→ES one-directional and say so in the limitations.

2. **Is the PRD still the contract?** It opens with *"everything in this document will be built. Nothing here is aspirational."* Against a 15–20 hour brief, that promise is what keeps generating tickets. With Cantonese and the Help tab now explicitly **in**, the cut list narrows to: 5-rep sweeps → 3, in-app blind scoring → listen and note, heap soaks, counterbalancing machinery, soft-delete lifecycle, EC2, and the second same-vendor option per stage. Either formally amend §15 to that list, or accept that the write-up ships thin. The third option — build it all — is not available in the time remaining, and §15's scope contract is the reason the backlog regenerates faster than it drains.
