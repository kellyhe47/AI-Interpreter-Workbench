---
id: 024
title: Run and Batch sweep are enabled with no Recording selected; Run is a silent no-op
status: pending
source: qa
depends_on: []
touches: [src/client/components/replay/RunConfigPanel.tsx, src/client/views/ReplayView.tsx]
iterations: 0
test_files: []
branch: ""
---

## Repro

1. Replay with no Recording selected — the panel header reads *"select a Recording to run against"*
2. Click **Run**

## Expected

A control that cannot act should not look actionable. The app already models this correctly one view
away: Results' "Run sweep" button is `disabled` with
`title="Sweeps require the real corpus to be loaded"`.

## Observed

Both **Run** and **Batch sweep…** are enabled (`disabled: false`, no `title`). Clicking **Run**
produces nothing at all — no run, no message, no console error. The runs list continues to read
*"No Runs of this Recording yet."*

Not a data-integrity problem, but an operator clicking Run and seeing nothing has no way to tell
whether the app is broken or the click was ignored.

## Suggested direction

Disable both while no Recording is selected, with a title explaining why — matching the Results
pattern. Auto-selecting the first Recording when the library is non-empty would also remove the
state entirely.
