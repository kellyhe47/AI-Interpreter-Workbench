---
id: 017
title: Default mode should be Realtime (design mock initial state), not Cascade
status: pending
source: qa
depends_on: []
touches: [src/client/state/sessionMachine.ts, src/client/views/sessionTestKit.ts]
test_files: []
iterations: 0
---

## Finding (QA iteration 1, sha aa9a6c0)
Repro: cold open → controls card + idle subline.
Observed: Cascade pre-selected; subline "English → Spanish · Cascade · autoplay on…".
Expected: the design mock's logic class initializes `{mode: 'realtime', arms: ['realtime']}`
and the handoff README's arms-strip spec shows Realtime as the default pill (accent-soft).
PRD §6 is mode-agnostic about the default ("single-arm live mode with autoplay on"), so the
mock governs. dc.html line ~419.

## Acceptance criteria
1. createInitialState defaults mode 'realtime', arms ['realtime' catalog id].
2. Idle subline reads "… · Realtime · autoplay on."
3. All existing suites updated ONLY where they assert the old default (test-writer change,
   since sessionMachine.test.ts and sessionTestKit are locked artifacts).
