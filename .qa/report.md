```yaml
sha: 24a3dbd
branch: main
tree: clean
launched: preview_start "workbench" (npm run dev) → http://localhost:5173, API on :8787
iterations: 6 of max 6 — converged on 5 and 6
suite: 1085 tests / 62 files green · tsconfig.json + tsconfig.server.json clean · npm run build clean
```

# Manual QA — AI Interpreter Workbench v2 · final report

**Spec:** `PRD.md` (§6, §7, §8, §10, §12).
**Designs:** `design_handoff_interpreter_workbench/`. PRD wins on conflict.
*(Earlier reports archived: `.qa/report-v1.md`, `.qa/report-iter1.md`, `.qa/report-iter2.md`.)*

## Verdict: CONVERGED — two consecutive clean passes

| iteration | outcome |
|---|---|
| 1 | 8 findings → tickets 018–025 (022 later withdrawn as a QA sampling error) |
| 2 | all 7 fixes verified; **2 new findings** → tickets 027 (MODERATE), 028 (HIGH) |
| 3 | 027 + 028 verified live; full walk — **clean** |
| 4 | **1 new finding** → ticket 029 (MODERATE) |
| 5 | 029 verified live; full walk — **clean** |
| 6 | full walk, independent emphasis — **clean** |

Ten defects found and fixed across the run. Everything filed this pass is green and verified in the
running product, not just in tests.

## What iterations 3–6 fixed

### Ticket 027 — a failed run left no trace in Results · MODERATE

A `failed` Run was **absorbed** into its `(recordingId × configurationKey)` group rather than
dropped — the grouping is deliberate and correct — but the view rendered only
`excludedFromExperiments`, which is `false` for a group that also holds a gate-passing run. So every
failure signal in the model (`runCount`, `failedCount`, `'failed'` in `exclusionReasons`) was
discarded at the view boundary and the row read a clean `in experiments`.

Verified live: the Arm B row now reads `in experiments` **and** `1 of 2 attempts failed`, carrying
`data-failed-count` / `data-run-count`; rows with no failures carry neither. Figures did not move
(`n = 1`, p50 1.05 s, cost unchanged).

A second defect surfaced while fixing it: an all-failed group rendered **`$0.000`** for cost — a
zero over zero samples, which AGENTS.md explicitly calls out as reading like a measurement. Now
dashes, gated on `n === 0`.

### Ticket 028 — run annotations were never persisted · HIGH

Found by reading the write path when 027's provenance symptom did not match its apparent cause.

`AnnotatedRun`'s `annotations` envelope is read by every Results derivation and was **written by
nothing outside test fixtures**; the persisted `Run` had no such field. Consequently
`intendedReps` always fell back to `completedReps` — **the denominator was structurally incapable of
exceeding the numerator, so provenance could only ever read "N of N"**. A sweep that lost reps to
failures would have reported as clean and complete. This is the exact failure mode AGENTS.md names.

It was invisible without a corpus and would have surfaced only after the operator recorded one and
ran sweeps — when the numbers were supposed to be trustworthy.

Verified live through the real server: five sweep reps POSTed with `annotations.repIndex`, rep 3
failed →

```
Arm B · 2 utterances · 4 of 5 reps completed · endpointing pinned 500 ms · turn-final trigger
p50 1.10 s   p95 1.30 s
```

`4 of 5` — the denominator now exceeds the numerator — with **p50 computed over the four
survivors** (the failed rep's 0 ms reached no figure; had it leaked in, p50 would read 1.05 s).
Arm C, carrying no annotations, correctly still falls back to `1 of 1`. Replay's run cards now show
`rep 1`–`rep 5`.

**Deliberately still deferred**, documented in the ticket: `utteranceId`, `category`,
`corpusVersion` and `wer` have no source — a `Recording` carries no category or utterance identity
on either side. So the by-category table and WER stay empty and every provenance line still ends
`corpus version unrecorded`. The plumbing 028 built is the template; ticket 028's notes specify what
a corpus-metadata model needs. **This should land with the operator's corpus work, not after it.**

### Ticket 029 — the provenance stamp survived a failed load · MODERATE

The stamp was gated on ledger contents only. With the ledger populated from a previous load (it
persists to localStorage) and hydration failing, the top bar asserted `run 2026-08-06 · corpus v1`
beside a panel reading *"this screen has nothing to show."*

Exactly one of four states was wrong. All four re-verified live after the fix:

| ledger | hydration | stamp | |
|---|---|---|---|
| empty | ready | absent | ✅ |
| populated | ready | present | ✅ |
| empty | failed | absent | ✅ |
| populated (cached, 9 runs) | failed | **absent** | ✅ fixed |

Recovery verified without a page reload: reopening the tab with the API back re-hydrates and the
stamp returns.

## Properties re-verified in the running product (iterations 5 & 6)

- **The derived arm tag never lies.** Realtime → `A` (stage selectors hidden); cascade default →
  `B`; `eleven_flash_v2_5` → `C`; `eleven_multilingual_v2` → `ad-hoc`; `claude-haiku-4-5` →
  `ad-hoc`; `gpt-4o-mini-transcribe` and `scribe_v2_realtime` → `ad-hoc`. Every cycle returns to
  `B`. Replay's panel agrees. **No control anywhere sets a tag.**
- **Derived beats declared** — a Run stored `armTag: "B"` with an off-arm triple renders `ad-hoc`.
- **Nothing autoplays in Replay** — instrumented `AudioContext` and `HTMLMediaElement.play`:
  **0 constructions, 0 media elements, 0 play calls** while rendering five run cards. Live is the
  opposite: `autoplay on`.
- **Blind compare is blind** — of five runs, only the **four completed** are offered as pair
  candidates. Zero `[data-blind-identity]` nodes; no model id, arm label or transcript in the panel
  before submit. Submit stayed disabled through three of four scores. Persisted server-side to
  `data/comparisons.jsonl` with both run ids, the drawn order, both dimensions for both samples and
  the evaluator language.
- **Corpus Recordings expose no delete control**; mic rows have edit + delete.
- **Run / Batch sweep gated on selection** — `disabled` with title *"Select a Recording in the
  library to run against"*, enabled once selected.
- **Mic denial** — `mic blocked`, both remediation layers named (browser site permission **and** OS
  privacy setting), the no-re-prompt statement, a retry, and Replay/Results/Help still usable.
- **Live indicator persists across tabs** — started under `?fixture=1`, the dot stayed on Replay
  and Results, and the session kept counting (`0:06` → `0:08 / 5:00`).
- **The fixture gate holds (018)** — after a 7-utterance `?fixture=1` session: no live card, no
  stamp, **zero digits** in the Results body, no `0.98 s`.
- **A dead backend still reads as an error, not emptiness (020)** — *"This is not an empty library
  — the library is unknown until the load succeeds"*, `reported: HTTP 500`, working Retry. Results
  has the matching copy: *"That is not the same as an empty ledger."*
- **Help** — six cards, the three-entity explainer, the derived-tag statement, the non-pooling rule.
- **Honest empties** — Exp 1 reads *"no sweep runs recorded for Arm A vs Arm B"*; WER, adequacy and
  fluency read `not yet measured` (8 cells).

## Two QA process errors made this run, recorded because they nearly cost findings

1. **Iteration 2's first draft of F9 was wrong.** I claimed the failed run was missing from the
   table and drafted a ticket demanding a separate row. Reading `derive.ts` before dispatching
   showed the `(recording × configuration)` grouping is deliberate and the run was absorbed, not
   dropped. A separate row would have fought the model. **Diagnose before filing, even when the
   symptom is unambiguous.**
2. **Two seeding errors produced phantom defects.** `POST /api/recordings` generates its own id and
   ignores a supplied one, so my runs pointed at a nonexistent Recording and Replay correctly showed
   "0 runs" — which looked like a bug. Separately, runs are stored **twice by design** (a queryable
   `data/runs/*.json` plus the append-only `ledger.jsonl`), so editing only the ledger left the
   store unchanged. Neither was a product defect. **Verify the fixture before believing the
   symptom.**

*(Iteration 1's withdrawn F5 — spot-checking a transient per-utterance failure instead of polling —
is recorded in `.qa/report-iter1.md`.)*

## Checked and deliberately not filed

- **Empty adequacy / fluency** — legitimately blocked on the operator; blind scoring needs a human.
- **Empty by-category table, `corpus version unrecorded`, absent WER** — NOT filed separately
  because they are ticket 028's documented deferred scope, not independent defects.
- **Ticket 026** (a LiveSession records configured rather than actual providers) — filed in v2 and
  knowingly deferred; the reporting layer is already gated, so no wrong number reaches a screen.
- **Run ids visible in `data-run` attributes** — seed ids encode the arm; production ids are opaque
  and visible labels stay neutral (`Run 1/2/3`).

## Escalations — unchanged, none blocking

- **Audible autoplay** — Live states `autoplay on` and drives the playback path, but this
  environment has no audio output. Needs a human with speakers.
- **Real-provider smoke** for ElevenLabs Scribe and Anthropic MT — costs money, and Scribe 401s
  until the key scope gains `speech_to_text`.
- **A real microphone session** — needs a grantable mic and a human speaking.
- **The corpus itself**, and everything downstream of it: sweeps, WER, blind scores, the write-up,
  the AWS deploy.

## Note on QA fixture data

`data/` currently holds QA seed Recordings and Runs (including deliberately failed and ad-hoc ones)
plus three blind comparisons. It is gitignored working state. **Clear it before recording the real
corpus** so no seeded figure can be mistaken for a measurement.
