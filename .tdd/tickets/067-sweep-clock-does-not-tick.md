---
id: 067
title: "The sweep clock does not tick — it updates once per completed run, so a live sweep looks frozen"
status: pending
source: operator (2026-08-09, during the first real sweep)
depends_on: []
touches: [src/client/components/replay/BatchProgress.tsx, src/client/views/ReplayView.tsx]
iterations: 0
test_files: []
branch: ""
---

## Observed — reported by the operator, verified

> *"when a sweep is running, there should be some sort of UI indication. At least an active
> countdown until the sweep is done"*

The panel **already exists** and is not missing: `BatchProgress.tsx` renders a title, a
`[data-batch-position]` line (`run N of M · recording × config · rep R/reps`), a
`[data-batch-clock]` line (`elapsed M:SS · est. remaining M:SS`), a `[data-batch-bar]` progressbar
with correct aria attributes, and a cancel control.

**The defect is that none of it moves between runs.** `elapsedMs` and `estimatedRemainingMs` are
fields on the `BatchProgress` event, and `emit` is called only at run boundaries
(`src/client/batch/runner.ts:382-400`). Replay is paced at **1×** (golden eval 08 pins this), so a
single execution takes at least the clip's duration — the stored corpus takes are 20.9 / 21.3 /
22.6 s — plus provider latency.

A one-recording sweep is 1 × 3 arms × (3 reps + 1 warmup) = **12 executions**, so the clock advances
about **12 times across roughly 6–8 minutes**. Between events it displays a stale snapshot. To an
operator that is indistinguishable from a hung sweep, which is precisely what happened: the operator
refreshed the page, and because the batch runner is client-side the refresh **killed the sweep**
(only the warmup run `3ba2d3b3` had been POSTed and survived).

So the frozen clock did not merely look bad — it cost a sweep.

## Acceptance criteria

- [ ] While a sweep is running, `[data-batch-clock]`'s **elapsed** figure advances without a
      progress event arriving — driven by an injected clock/interval seam, never `setInterval`
      reached directly from the component
- [ ] The **remaining** figure counts DOWN between progress events, from the last estimate the
      runner actually produced
- [ ] A progress event **re-anchors** both figures to the runner's own numbers — the ticking is
      interpolation between measurements, never a substitute for one. Falsifiable: after an event
      carrying `elapsedMs: X`, the rendered elapsed is X, not the locally accumulated value.
- [ ] **Remaining never goes negative and never invents precision.** When the local countdown
      reaches zero while the sweep is still running, the cell says so honestly (e.g. `finishing`)
      rather than showing `0:00` or a negative clock
- [ ] `estimatedRemainingMs === null` (no run has completed yet, so there is no measured throughput)
      still renders the existing `—`. **A countdown is not invented before there is anything to
      count down from.**
- [ ] The ticking **stops** when the sweep ends, is cancelled, or the panel unmounts — no leaked
      interval, asserted by the seam
- [ ] The progress bar and `[data-batch-position]` are unchanged — they are per-run facts and must
      NOT be interpolated

## Out of scope

- Persisting or resuming a sweep across a page refresh. The batch runner is client-side by design;
  resume is a much larger change and is not what this ticket fixes.
- A `beforeunload` warning. Related and cheap, but a separate decision.
- Any change to `runner.ts`'s emission cadence, to `BatchProgress` event fields, or to the pacing
  (golden eval 08 pins Replay at 1×).
- The confirmation dialog's pre-launch estimate (ticket 065) — that is a different figure at a
  different moment.

## Notes

- **Everything is an injectable seam** — jsdom has no real timers under `vi.useFakeTimers` unless the
  component is driven through one. `ReplayView` already owns the sweep state and passes
  `progress` / `configurations` / `reps` into the panel; the clock seam belongs on the same path.
- The measured-vs-interpolated distinction is this project's recurring rule in a new place: the
  runner's figure is the measurement, and a tick between measurements must never be mistaken for
  one. That is why AC3 requires re-anchoring and AC4 refuses a fabricated `0:00`.
