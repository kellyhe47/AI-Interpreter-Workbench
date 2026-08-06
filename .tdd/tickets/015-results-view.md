---
id: 015
title: Results view — Experiments tab and By Recording & category tab
status: pending
depends_on: [011]
touches: [src/client/views/ResultsView.tsx, src/client/views/ResultsView.test.tsx]
iterations: 0
test_files: []
branch: ""
---

## Scope

**MODIFY `src/client/views/ResultsView.tsx`** to the v2 two-tab shape. Derivation is
ticket 011 — this ticket renders it and must not compute metrics of its own.

## Structure (PRD §8 "Results view", design README §Results)

Header: *"Every screen reads one append-only run ledger. Experiments aggregate only
sweep-origin runs whose configuration matches a named arm."*

**Tab 1 — Experiments.** Four question-titled cards, each with a track eyebrow, a mono
provenance line, a metric grid, and a gray takeaway:

1. **Does the architecture itself cost latency?** — Exp 1, Arm A vs Arm B, vendor held
   constant. p50, p95, cost/min, WER (**sidecar** for Realtime), adequacy, fluency, observable
   interval count.
2. **What does swapping providers buy?** — Exp 2, Arm B vs Arm C, **only TTS differs**.
   p50, p95, cost/min, WER rendered `— (STT unchanged)`, fluency.
3. **What changes as the conversation continues?** — sourced from **LiveSessions, not Replay
   runs**. Three columns: realtime-default / realtime-trimmed / cascade.
4. **What does provider choice let us reach?** — coverage **per direction, not per pair**
   (EN→YUE and YUE→EN are different claims), cells **per stage** so a failure is attributable
   to a stage rather than to the pair, plus per-cell observation notes and three time-to-add
   tiles citing commit hash and diff size.

**Tab 2 — By Recording & category.** The category table (where findings actually live) and the
per-recording table, which **includes ad-hoc and manual rows and a failed row** — the only
place ad-hoc runs are visible at all.

## Non-negotiables (PRD §8, §17 15g)

- **Empty states are mandatory and are the default.** With no runs the view renders
  *"No runs recorded"* — never sample data. The mock's "show recorded runs (mock)" switch is a
  review-only affordance and **must not be built**.
- **Provenance reports ACTUAL N**: `4 of 5 reps completed`, never the intended N.
- Any figure that is not measured is labelled **illustrative** at card level, so a polished
  placeholder can never be mistaken for evidence.
- **Non-pooling**: each card names its own track and its own data. A LiveSession figure never
  appears on an Exp 1/2 card and vice versa.
- No hardcoded metric may appear in the component — every number comes from ticket 011.

## Acceptance criteria

- [ ] The default render with an empty ledger shows the **"No runs recorded"** empty state on
      both tabs, and no metric grid
- [ ] Both tabs are reachable and exactly one renders at a time; Experiments is the default
- [ ] With gated sweep data, Exp 1 renders p50, p95, cost/min, WER, adequacy, fluency and the
      observable-interval count for Arm A vs Arm B
- [ ] Exp 1's Realtime WER cell is explicitly labelled a **sidecar** measurement
- [ ] Exp 2 renders Arm B vs Arm C and its WER cell reads `— (STT unchanged)` rather than a
      number
- [ ] The conversation-length card is sourced from **LiveSessions** and renders three columns;
      it renders its own empty state when no LiveSessions exist even if Runs do
- [ ] The coverage card rows are **directions** (`English → Cantonese` and
      `Cantonese → English` are separate rows) with per-stage cells
- [ ] Every experiment card renders a mono provenance line carrying actual reps completed vs
      intended, utterance count, the pinned 500 ms endpointing value and the corpus version
- [ ] A configuration with 4 of 5 completed reps renders `4 of 5`, and its p50 is computed over
      4 samples — line and number agree
- [ ] The secondary tab's per-recording table includes **ad-hoc/manual rows and a failed row**,
      marked as excluded from experiments
- [ ] The category table groups by utterance category, not by recording
- [ ] No manual-origin, failed, ad-hoc or fixture-sourced run appears in any experiment
      aggregate rendered by this view
- [ ] No hardcoded latency/cost/WER/quality literal exists in `ResultsView.tsx`
- [ ] Styling uses tokens only

## Test plan

Rework `src/client/views/ResultsView.test.tsx` structurally (manifest Tests table), rendering
against `testRecords.ts` from ticket 011.

## Attempt log
