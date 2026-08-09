---
id: 066
title: Leaving Replay and returning clears the Recording selection while the sidebar still shows its run count
status: pending
source: spec-audit (verified)
depends_on: []
touches: [src/client/views/ReplayView.tsx, src/client/App.tsx]
iterations: 0
test_files: []
branch: ""
---

## Observed — verified

`ReplayView.tsx:379` holds the selected Recording in a plain `useState<string|null>(null)` — not
lifted, not persisted, no localStorage, no URL, no context. `App.tsx` mounts exactly one view at a
time and unmounts the one you leave (stated in its own header at `:11-13`).

So switching to Results and back:
- selection → `null` → `selectedRuns` filters to `[]` → the list renders **"No Runs of this
  Recording yet."**
- Run and Batch sweep become disabled
- **but the sidebar still reads `3 runs`**, because that count is built from the full runs array with
  no reference to the selection

The screen therefore contradicts itself: the library says the Recording has runs, the panel says it
has none.

## Acceptance criteria

- [ ] The selection survives a tab round-trip
- [ ] The runs list and the sidebar count never disagree about the same Recording
- [ ] A selection that refers to a Recording that no longer exists resolves to the empty state
      cleanly, not to a stale id
- [ ] The empty state "No Runs of this Recording yet" appears only when that is TRUE

## Notes
- Persisting to the URL also makes a Recording linkable, which helps the write-up cite one.
