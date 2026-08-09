---
id: 065
title: "\"Batch sweep…\" launches 18 executions immediately — the ellipsis promises a dialog that does not exist"
status: pending
source: spec-audit (verified)
depends_on: []
touches: [src/client/views/ReplayView.tsx, src/client/components/replay/RunConfigPanel.tsx]
iterations: 0
test_files: []
branch: ""
---

## Observed — verified

`Batch sweep…` (`RunConfigPanel.tsx:96`) calls `startSweep` (`ReplayView.tsx:546-562`) **synchronously
on click**. There is no dialog: a repo-wide search finds **no dialog primitive anywhere in
`src/client`** — zero hits for `<dialog>`, `role="dialog"`, `Modal`, or `confirm(`.

What one click actually starts:
- **1** recording — `recordingIds: [selectedRecordingId]`; the library is single-select
- **3** hardcoded arms — `sweepConfigurations()` over the frozen `ARMS`
- **`SWEEP_REPS = 5`**, hardcoded at `ReplayView.tsx:288`, no UI control
- ⇒ **18 executions** (15 + 3 uncounted warmups)

No cost estimate, no time estimate, no confirmation. PRD §7 scale: *"roughly $4 and ~68 minutes of
unattended wall-clock."*

## Scope note — read before designing

PRD §7 specifies *"selected Recordings × selected configurations × N repetitions"*, but it requires
progress **during** the batch, which exists and works (verified: cancel keeps completed runs). **It
does not literally require a pre-launch estimate.** The defect is the gap between the ellipsis
affordance and the immediate launch — a trailing ellipsis is a promise of a next step.

The cheapest honest fix may be to **remove the ellipsis and add a confirmation naming the cost**,
not to build a matrix picker. §15A cut 5-rep sweeps to 3, so the reps control may be moot.

## Acceptance criteria

- [ ] The label and the behaviour agree — either the ellipsis opens something, or it goes
- [ ] Before a multi-dollar, multi-minute unattended operation the operator sees the **execution
      count, the estimated wall-clock and the estimated cost**, and confirms
- [ ] `SWEEP_REPS` reflects §15A's cut to 3, or is operator-settable
- [ ] Cancel-keeps-completed still works (verified working — do not regress it)

## Notes
- The batch runner itself is good — counterbalanced A→B/B→A ordering, uncounted warmup, per-run
  timeout race, single retry, cancel-keeps-completed. **This ticket is about the front of it only.**
