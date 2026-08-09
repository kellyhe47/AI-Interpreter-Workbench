---
id: 067
title: "The sweep clock does not tick — it updates once per completed run, so a live sweep looks frozen"
status: done
source: operator (2026-08-09, during the first real sweep)
depends_on: []
touches: [src/client/components/replay/BatchProgress.tsx, src/client/views/ReplayView.tsx]
iterations: 1
test_files: []
branch: main
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

## RESOLUTION (2026-08-09)

Suite 2441 passing / 0 failing. `npm run check` exits 0.

`SweepClock { now, subscribe }` is optional on `ReplayDeps`; the interpolation lives in
`BatchProgress.tsx` (the only component that renders the figure, and its mount is exactly the
subscription's lifetime); the real 1 Hz timer lives in `App.tsx`, in **one** place, because every
Replay bag — production, `?fixture=1`, and injected — reaches the view through App's `replayDeps`
memo. In `browserDeps.ts` it would tick production only and leave fixture mode frozen, and App would
still need a default, i.e. two timers that can disagree about their period.

`now` is on the seam rather than reused from `deps.now` so the anchor and the tick read one clock.

### The distinction that mattered

A tick is an **interpolation between measurements and never a substitute for one**:
- a progress event **re-anchors** both figures, pinned in **both** directions — an event carrying a
  *lower* elapsed than the local accumulation wins, which kills `Math.max` and any monotonic guard;
- `estimatedRemainingMs === null` renders `—` **however long the panel ticks** — nothing is derived
  from the elapsed side, so no countdown is invented before there is measured throughput;
- a spent countdown reads `finishing`, never `0:00`. The threshold is `< 1000` because `formatClock`
  prints `0:00` for anything under a second, which is the fabricated precision AC4 refuses — and it
  makes a negative unreachable. A measured `0:00` (`sinceMeasuredMs === 0`) is still a measurement
  and still renders.

Position and bar are pinned byte-identical across a tick — per-run facts, never interpolated.

### The RED finding — the repo's #1 failure, in the very next ticket after 066

`App.tsx`'s `sweepClock: bag.sweepClock ?? sweepClock` could be reduced to `bag.sweepClock` with the
**whole suite green at 2439/2439**. Every locked 067 test injects its own probe clock, so none could
see it. The consequence is exact: with no App default, any host that does not inject a clock — which
is the real app — stops ticking, silently restoring the defect this ticket exists to fix.

Closed behaviourally, not by grep alone: `App.test.tsx` now renders the **real `<App>`** over a bag
that wires **no** `sweepClock`, drives a sweep to the progress panel, anchors on one event, and waits
on **real** time for the clock to advance with `progressEvents() === 1`. ~2 s of wall clock,
deliberately — `vi.useFakeTimers` is refused throughout this ticket because under fake timers a
direct `setInterval` reach satisfies every behavioural assertion while production leaks past unmount.
A scoped source belt on the `replayDeps` memo backs it up, mirroring
`browserDeps.inboundTap.test.ts`'s two-way shape.

No production change was needed for the guard — the code was right; nothing held it there.

### Out of scope, still true

Refresh still kills a running sweep: the batch runner is client-side and there is no resume. This
ticket makes a live sweep *look* alive; it does not make it survive a reload. A `beforeunload`
warning remains an open, separate decision.
