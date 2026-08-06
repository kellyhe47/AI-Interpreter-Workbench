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

**Verdict: NOT clean.** One finding, MODERATE, filed as ticket **027**. All seven iteration-1
fixes verified in the running app. No regressions.

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

### F9 — Failed runs are invisible in Results · **MODERATE** · ticket 027

*Flow H.* **Repro:** seed four Runs against one corpus Recording — Arm B/sweep/complete,
Arm C/sweep/complete, ad-hoc/manual/complete, and **Arm B/sweep/failed** — then open
Results → **By Recording & category**.

**Expected** (PRD §7): *"**Failed runs are saved, visible, and excluded from every aggregate.** …
it belongs in the ledger **and in the per-Recording view**."* The design mock's By Recording table
carries a `failed`-status row with `—` for its figures.

**Observed:** the table renders **three** rows. `run-failed-1` appears nowhere, and nothing
indicates a run against this Recording failed. The ad-hoc exclusion case is handled correctly
(`excluded · ad-hoc`) — it is specifically `status: 'failed'` that is dropped rather than labelled.
Downstream, Arm B's Exp 2 provenance reads **`1 of 1 reps completed`** for a cell with two sweep
attempts, so a clean 1/1 is indistinguishable from a 1/2 with a failure.

**Bounded:** no wrong number is reported and no data is lost. The aggregation gate is correct — the
failed run is excluded from every percentile, cost and delta. Replay's runs list shows all four
cards, the failed one carrying *"tts stage timed out — run saved as failed, excluded from every
aggregate"*. The defect is confined to the Results secondary tab and the provenance denominator.

## Checked and deliberately **not** filed

- **`corpus version unrecorded`** in the provenance lines — my seeded runs carry no corpus version;
  the real corpus will. Test-data artifact.
- **Run ids visible in `data-run` attributes** — seed ids encode the arm; production ids are opaque.
  Visible labels stay neutral (`Run 1/2/3`).
- **Empty WER / adequacy / fluency / by-category table** — known-empty by design; blocked on the
  operator's corpus.
- **Ticket 026** (LiveSession records configured rather than actual providers) — filed and
  knowingly deferred; not re-filed.

## Escalations

Unchanged from iteration 1, and none of them blocks this pass:

- **Audible autoplay** — Live states `autoplay on` and drives the playback path, but this
  environment has no audio output. Needs a human with speakers.
- **Real-provider smoke** for ElevenLabs Scribe and Anthropic MT — costs money and Scribe 401s
  until the key scope gains `speech_to_text`.
- **A real microphone session** — needs a grantable mic and a human speaking.
