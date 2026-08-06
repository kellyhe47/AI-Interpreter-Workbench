---
id: 013
title: Replay view — recordings library, run config panel, runs list, batch progress
status: green
depends_on: [001, 008, 009]
touches: [src/client/views/ReplayView.tsx, src/client/views/ReplayView.test.tsx, src/client/components/replay/]
iterations: 0
test_files: [src/client/views/ReplayView.test.tsx]
branch: ""
---

## Scope

**ADD** the Replay screen and its four components (design README §Replay):

- `src/client/views/ReplayView.tsx` — two columns: 330px Recordings library + config/runs column
- `src/client/components/replay/RecordingsLibrary.tsx`
- `src/client/components/replay/RunConfigPanel.tsx`
- `src/client/components/replay/RunsList.tsx`
- `src/client/components/replay/BatchProgress.tsx`

Blind compare is ticket 014. App routing is ticket 016 (ReplayView is testable standalone
until then).

## Copy and behaviour (design mock is the visual spec; PRD wins on function)

**Header:** *"Record once, run it through any configuration. Runs of the same Recording are
comparable by construction."* Plus a **"Record new clip · max 1 min"** button.

**RecordingsLibrary** — rows carry label, corpus/mic pill, language, duration, run count.
Footer states the lifecycle rules verbatim: *"Labels are editable; audio is immutable.
Deleting hides a Recording but keeps its Runs. Corpus Recordings can't be deleted —
experiments depend on them."* Labels are editable in place; delete is soft; **corpus
Recordings expose no delete affordance at all** (PRD §17 25c — the operation is disallowed,
not warned about).

**RunConfigPanel** — architecture toggle, per-stage model selectors (cascade only), a **live
derived-tag pill** reading `derived tag: Arm B` / `derived tag: ad-hoc`, and **Run** +
**Batch sweep…** buttons. Default state is **Arm B's triple** (`DEFAULT_CASCADE_TRIPLE`), so
the untouched panel produces comparable runs rather than orphans. Pinned-constants note:
*"context pinned to zero in Replay · voice pinned per vendor · replay paced at 1× · manual
runs are explorable but never aggregated into experiments"*. **Replay context is a locked,
displayed field — not a control.**

**RunsList** — per-Recording run cards: armTag pill (accent for a named arm, gray for ad-hoc),
config string, origin/rep/snapshot meta in mono, complete/failed pill, **on-demand playback**
(nothing autoplays), labelled per-stage ms inline, total and $/min. A failed run card shows the
stage-named red notice and states it is saved and excluded from aggregates.

**BatchProgress** — position in the matrix, elapsed/remaining, progress bar, the controls note
(*counterbalanced order · first run per configuration discarded as warmup · failures retried
once, then the batch continues · origin: sweep*), and **"Cancel — keep completed runs"**.

## Acceptance criteria

- [ ] With no Recordings the library renders a genuine empty state — no sample rows
- [ ] A recording row shows label, origin pill (corpus/mic), language, duration and run count
- [ ] Editing a label calls the update path and leaves duration/origin/audio untouched in the
      rendered row
- [ ] A `mic` Recording offers delete; a `corpus` Recording **offers no delete control**
- [ ] Deleting a `mic` Recording removes it from the library while its runs remain listed
- [ ] The config panel's **default state derives `Arm B`** and the pill says so
- [ ] Changing one stage selector off Arm B's triple flips the pill to `derived tag: ad-hoc`
      live, before any run is triggered
- [ ] Switching the architecture toggle to Realtime derives `Arm A` and hides the per-stage
      selectors
- [ ] There is **no control anywhere** that sets an arm tag directly
- [ ] Replay context is rendered as a **locked/disabled** field pinned to zero — the user
      cannot change it
- [ ] "Run" triggers a single run for the selected Recording with the panel's configuration
- [ ] Run cards render `armTag` pill, config string, origin/rep meta, status pill, labelled
      per-stage ms, total and $/min
- [ ] **Nothing autoplays**: a completed run renders a play control and produces no audio until
      it is pressed
- [ ] A failed run card names the failing stage and states it is excluded from aggregates
- [ ] "Batch sweep…" opens BatchProgress showing matrix position, elapsed, estimated remaining
      and a progress bar
- [ ] "Cancel — keep completed runs" cancels and the already-completed runs remain in the list
- [ ] The record-new-clip affordance states the **1 minute** cap
- [ ] All styling uses `src/client/styles/tokens.css` CSS variables — no hardcoded colors or
      sizes

## Test plan

New `ReplayView.test.tsx` plus co-located component tests, RTL/jsdom, following the existing
`SessionView.test.tsx` style (render with injected fakes; never touch real browser APIs).

## Attempt log

- iter 1: green, after ONE test-writer correction round (not an implementation iteration).
- The implementer hit 23 failures and correctly STOPPED, reporting a defect in the LOCKED tests
  rather than editing them: `makeFakes` shallow-copied the recordings array but shared the element
  objects, and the `remove` fake wrote `deletedAt` through to the module-level `MIC_REC` const —
  so the delete test poisoned every later mount. Order-dependent pollution, real regardless of the
  implementation. Verified by the orchestrator, fixed through the test-writer (fixture isolation
  only, zero assertions touched), re-verified order-independent across five shuffled seeds.
  Had the implementer been free to edit tests, the cheapest green would have been relaxing the
  row-count guard — silently dropping the assertion that a soft delete keeps its Runs listed.
- Runtime: 52 tests in ~370 ms. The earlier ~24 s was pure waitFor-timeout accumulation.
- Process finding from the test-writer, worth keeping: a bare `tsc -p tsconfig.json` in an agent
  bash thread can silently typecheck the MAIN repo instead of the worktree and still print OK.
  vitest fails loudly in that situation; tsc does not. Gate typechecks with explicit paths.
