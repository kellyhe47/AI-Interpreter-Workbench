---
id: 016
title: Elapsed timer must not run when no session has started (permission-denied)
status: pending
source: qa
depends_on: []
touches: [src/client/views/useSessionController.ts, src/client/views/SessionView.tsx, src/client/state/sessionMachine.ts]
test_files: []
iterations: 0
---

## Finding (QA iteration 1, sha aa9a6c0)
Repro: open app → Start microphone in a mic-blocked environment → status strip.
Observed: elapsed counts up (00:31 → 00:53 → 01:08) while state is `permission-denied`; no
session ever entered `listening`.
Expected: PRD §6 lifecycle — the elapsed timer belongs to a running session (`listening`
onward); idle/permission-denied show `00:00` (mock idle shows 00:00). Screenshot: run session,
flow 2/3 screenshots.

## Acceptance criteria
1. In `permission-denied` (after a denied START), the status strip elapsed shows 00:00 and
   does not advance.
2. Elapsed starts counting only when the session enters `listening` (permission granted).
3. Existing behavior preserved: elapsed freezes at stop; resets on new session.
