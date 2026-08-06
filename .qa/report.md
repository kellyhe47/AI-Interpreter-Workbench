```yaml
sha: 2d970b1
branch: main
tree: clean
launched: preview_start "workbench" (npm run dev) → http://localhost:5173
         + API on :8787 — bound correctly on its own this pass (see fix 021 below)
iteration: 2 of max 6
```

# Manual QA — AI Interpreter Workbench v2 · iteration 2

**Spec:** `PRD.md` (§6, §7, §8, §10, §12).
**Designs:** `design_handoff_interpreter_workbench/README.md` + `interpreter-workbench-v2.dc.html`. PRD wins on conflict.
*(Iteration 1's report is archived at `.qa/report-iter1.md`; the v1 report at `.qa/report-v1.md`.)*

**Verdict: NOT clean.** Two findings — **F10 HIGH** (ticket 028) and **F9 MODERATE** (ticket 027).
All seven iteration-1 fixes verified in the running app. No regressions; both findings are
pre-existing gaps this pass uncovered rather than anything the iteration-1 fixes broke.

## Part A — re-verification of the seven fixes

| # | Fix | Result |
|---|---|---|
| 018 | Fixture LiveSession must not produce a figure | ✅ after a 5-utterance `?fixture=1` session Results holds **0 digits**, empty state intact, no live card, no `0.98 s`, no provenance stamp |
| 019 | Results reads server-persisted Runs | ✅ Experiments renders Exp 2 — Arm B vs Arm C, p50 1.05 s / 0.93 s, delta −0.13 s. Ad-hoc/manual run present in By Recording, marked `excluded · ad-hoc` (**failed run is not — finding F9**) |
| 020 | Dead backend ≠ empty library | ✅ distinct error region: *"Couldn't load Recordings … This is not an empty library — the library is unknown until the load succeeds"*, `reported: HTTP 500`, Retry present, "No Recordings yet" absent. **Retry re-issues**: after restarting the API the error cleared and both Recordings loaded |
| 021 | API binds 8787 under `PORT=5173` | ✅ `server listening on :8787` with the harness exporting `PORT=5173`; proxy clean, zero ECONNREFUSED |
| 023 | Blind scores reach the server | ✅ new comparison read back from `GET /api/blind-comparisons` and on disk in `data/comparisons.jsonl`, carrying `runIds`, the **drawn `order`** (swapped relative to `runIds`), both dimensions for both samples, `evaluatorLanguage` |
| 024 | Run/Batch gated on selection | ✅ both `disabled` with title *"Select a Recording in the library to run against"*; enabled once a Recording is selected |
| 025 | No provenance stamp on empty Results | ✅ absent on an empty ledger; `run 2026-08-06 · corpus v1` returns once gate-passing runs exist |

## Part B — full journey re-walk

| Flow | Journey | Result |
|---|---|---|
| A | Cold landing → all four tabs | pass |
| B | Derived arm tag across both architectures and all three stages | pass |
| C | Live fixture session, tab-switch mid-session | pass |
| D | Language pair / Cantonese warning | pass |
| E | Mic denied | pass |
| F | Replay with the API down, then recovered | pass |
| G | Replay with seeded data → runs list → blind compare → submit | pass |
| H | Results, both tabs, empty and populated | **F9** |
| I | Help | pass |

### Verified in the running product this pass

- **The derived arm tag never lies, on every axis.** Realtime → `A` (stage selectors hidden);
  cascade default → `B`; then cycling **each** stage in turn:
  `tts → eleven_flash_v2_5` = `C`, `→ eleven_multilingual_v2` = `ad-hoc`, `→ gpt-4o-mini-tts` = `B`;
  `mt → claude-haiku-4-5` = `ad-hoc`, back = `B`; `stt → gpt-4o-mini-transcribe` = `ad-hoc`,
  `→ scribe_v2_realtime` = `ad-hoc`, back = `B`. Every full cycle returns to B. The pill is a
  `<span data-arm-tag>`; **no control anywhere sets a tag** (0 arm-labelled controls).
  Replay's panel behaves identically.
- **Derived beats declared.** `run-adhoc-1` is *stored* with `armTag: "B"` and an off-arm triple;
  Results renders it `ad-hoc` / `excluded · ad-hoc`.
- **Nothing autoplays in Replay.** With `AudioContext` and `HTMLMediaElement.play` instrumented,
  selecting a Recording and rendering four run cards produced **0 AudioContexts, 0 media
  elements, 0 play() calls**.
- **Blind compare is blind.** Panel shows Sample A / Sample B, a `play` control each, adequacy and
  fluency 1–5 each. Zero `[data-blind-identity]` nodes; no model id, arm label or transcript in the
  panel before submit. Submit stayed disabled through the first three scores and enabled only on
  the fourth. After submit: *"identity revealed — appended to ledger"*. Only the **three completed**
  runs are offered as pair candidates — the failed run is correctly not scoreable.
- **Corpus Recordings expose no delete control** — corpus row has edit only; the mic row has edit +
  delete.
- **Mic denial** — status `mic blocked`; the blocking card names **both** layers (*"Check the
  browser site permission… look for the mic icon in the address bar"* and *"Check the OS microphone
  setting: your system privacy settings must allow this browser"*), states *"Browsers do not
  re-prompt after a denial — reset the site permission first, then retry"*, offers retry, and
  Replay / Results / Help stay usable.
- **Live indicator persists across tabs.** Session started under `?fixture=1`; the blue dot +
  `live` remained in the top bar on Replay and on Results, and returning to Live showed the same
  session still counting (`0:03 → 0:06 / 5:00`) — session state survives tab switches.
- **Cantonese warns, never blocks, and is architecture-correct.** `English → Cantonese` flips the
  pair pill to `cascade only`; under **Realtime** it adds *"Realtime does not list Cantonese as a
  supported output language — the run proceeds to observe the actual failure mode. Text may look
  correct while audio pronunciation is not."* with **Start microphone still enabled**. Under
  Cascade there is no warning, which is correct — cascade supports the pair.
- **Help** renders exactly six cards in order, carrying the three-entity explainer, the
  *"you never label a run yourself"* statement, and the non-pooling rule.
- **Honest empties** — Exp 1 reads *"no sweep runs recorded for Arm A vs Arm B"*; WER, adequacy and
  fluency read `not yet measured`; `corpus version unrecorded`. Nothing invents a figure.

## Findings

### F10 — Run annotations are never persisted · **HIGH** · ticket 028

*Found by reading the write path after F9's provenance symptom did not match its apparent cause,
then confirmed against the running app.*

**Expected** (PRD §8, and AGENTS.md's statement of it): *"Provenance reports ACTUAL N, never
intended N. … A line that claims 5 while aggregating 4 is the failure mode this project exists to
prevent."* PRD §9: the six utterance categories are the analytical grouping.

**Observed:** `AnnotatedRun`'s `annotations` envelope — `repIndex`, `utteranceId`, `category`,
`corpusVersion`, `wer` — is read by every derivation in Results and **written by nothing outside
test fixtures**. The persisted `Run` has no `annotations` field, and `category` / `utteranceId` /
`corpusVersion` appear nowhere in `src/server` or `src/core`.

Three consequences, all latent until the corpus exists:

1. **Provenance can only ever read "N of N".** `intendedReps` falls back to `completedReps`
   whenever no `repIndex` is present, which in production is always — the denominator is
   structurally incapable of exceeding the numerator. Observed live: Arm B with one complete and
   one failed sweep run reads `1 of 1 reps completed`. A sweep that loses reps to failures will
   report as clean and complete.
2. **The "By utterance category" table can never fill** — `groupByCategory` skips any run without
   `annotations.category`, so it renders zero rows no matter how many real sweeps run.
3. **`corpus version unrecorded` is permanent**, and WER has no write path at all.

`repIndex` is fixable today and is the load-bearing one: `createRunOnceExecutor` already receives
`request.repIndex` and already stamps `request.origin` onto the Run — it simply drops the index.
The corpus-metadata fields need a model that does not yet exist; ticket 028 scopes the split.

**This finding corrects two dismissals made earlier in this same report** (see "Checked and
deliberately not filed", now amended): the empty category table and `corpus version unrecorded`
are *not* test-data artifacts waiting on the corpus. The corpus alone will not fix either.

### F9 — Failed runs are invisible in Results · **MODERATE** · ticket 027

*Flow H.* **Repro:** seed four Runs against one corpus Recording — Arm B/sweep/complete,
Arm C/sweep/complete, ad-hoc/manual/complete, and **Arm B/sweep/failed** — then open
Results → **By Recording & category**.

**Expected** (PRD §7): *"**Failed runs are saved, visible, and excluded from every aggregate.**"*

**Observed:** the table renders **three** rows and nothing indicates a run against this Recording
failed.

**Diagnosis — a render gap, not a dropped record.** `groupByRecording` groups on
`(recordingId × configurationKey)`, so `run-failed-1` — which shares Arm B's configuration — is
**absorbed into the Arm B row**, not discarded. The row model already carries `runCount: 2` against
`n: 1`, `failedCount: 1`, and `'failed'` in `exclusionReasons`. The view renders only
`excludedFromExperiments`, which is `false` for this group because the complete Arm B run passes
the gate — so the row prints `in experiments` and every failure signal in the model is discarded at
the view boundary.

*(My first pass at this finding claimed the row was missing entirely and demanded a separate
`failed` row. Reading `derive.ts` before filing showed the grouping is deliberate and correct;
ticket 027 was rewritten to the actual defect. A separate row would have fought the model.)*

**Bounded:** no wrong number is reported and no data is lost. The figures on that row are right —
`n = 1`, p50 over the one measured run, cost over measured runs only — and the aggregation gate
correctly excludes the failed run from every percentile, cost and delta. Replay's runs list shows
all four cards, the failed one carrying *"tts stage timed out — run saved as failed, excluded from
every aggregate"*. The defect is that Results alone gives no sign a failure occurred.

The provenance symptom in the same scenario (`1 of 1 reps completed` for two attempts) has a
**different and deeper cause** and is filed separately as **F10 / ticket 028** — fixing this
finding will not fix that line.

## Checked and deliberately **not** filed

- ~~**`corpus version unrecorded`** — test-data artifact.~~ **AMENDED: this was wrong.** No write
  path exists for `corpusVersion`; the real corpus will not fix it. Rolled into **F10 / ticket 028**.
- ~~**Empty by-category table and WER** — known-empty by design, blocked on the corpus.~~
  **AMENDED: also wrong** for the category table and WER — neither has a write path, so neither
  fills when the corpus arrives. Rolled into **F10 / ticket 028**. Empty **adequacy/fluency** *is*
  legitimately blocked on the operator (blind scoring needs a human), and stays not-filed.
- **Run ids visible in `data-run` attributes** — seed ids encode the arm; production ids are opaque.
  Visible labels stay neutral (`Run 1/2/3`).
- **Ticket 026** (LiveSession records configured rather than actual providers) — filed and
  knowingly deferred; not re-filed.

## Escalations

Unchanged from iteration 1, and none of them blocks this pass:

- **Audible autoplay** — Live states `autoplay on` and drives the playback path, but this
  environment has no audio output. Needs a human with speakers.
- **Real-provider smoke** for ElevenLabs Scribe and Anthropic MT — costs money and Scribe 401s
  until the key scope gains `speech_to_text`.
- **A real microphone session** — needs a grantable mic and a human speaking.
