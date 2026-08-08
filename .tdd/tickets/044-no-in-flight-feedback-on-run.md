---
id: 044
title: Run and Batch sweep give no in-flight feedback — the UI is identical to not having clicked
status: pending
source: qa-live
depends_on: []
touches: [src/client/views/ReplayView.tsx]
iterations: 0
test_files: [src/client/views/ReplayView.inflight.test.tsx, src/client/views/ReplayView.failures.test.tsx]
branch: ""
---

## Why

Operator report: *"I just clicked Run and noticed there's no UI response to me clicking the button."*

Verified: `ReplayView` holds **no in-flight state at all** — a grep for `running|inFlight|pending|busy`
returns nothing. Between the click and the run card appearing there is a ~20 s window (the clip
paces at 1×, plus provider latency) in which the UI is byte-identical to not having clicked.

This is not only polish. With no feedback the natural response is to click again, which starts a
**second run** and spends provider budget again. A Replay run is a real, billable action.

## Acceptance criteria

- [ ] While a manual Run is in flight the UI says so — the state is visible, not inferred
- [ ] **Run cannot be double-fired**: a second click while one is in flight starts no second run
- [ ] The indication clears on completion AND on failure — a failed run must not leave the panel
      looking permanently busy
- [ ] Batch sweep already renders `BatchProgress`; make sure the two indications do not contradict
      each other, and that Batch sweep is likewise not double-fireable
- [ ] Selection gating (ticket 024) still holds: with no Recording selected both stay disabled with
      their explanatory titles
- [ ] Assert via `data-*` attributes and text, never CSS classes; design tokens only
- [ ] Nothing about run semantics changes — this is feedback, not behaviour

## Notes

- `ReplayView` already tracks `sweep` state for BatchProgress; mirror that shape for the single-run
  case rather than inventing a second pattern.
- Keep the copy honest about what is happening — a Replay run paces the clip at 1×, so "running"
  genuinely means "playing the clip in real time", and saying so sets the right expectation for a
  ≤45 s corpus take.

## ORCHESTRATOR RULING — 044 vs ticket 024's prose

The test-writer surfaced a real spec collision: `RunConfigPanel.tsx:27-29` and
`ReplayView.tsx:68` both state that the gate is the SELECTION **and nothing else**, and that
"a run already in flight does not disable Run".

**Resolved toward `disabled` + an explanatory title, and 024's prose must be updated.** This
APPLIES 024's principle rather than overturning it: 024 exists so a control that cannot act does
not look actionable. A handler-only guard would satisfy 044's literal criteria while leaving an
enabled button that silently swallows clicks — precisely the failure 024 was written against. The
title still distinguishes the two reasons, so the no-selection explanation is never replaced by the
busy one.
