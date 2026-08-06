---
id: 019
title: Queued mode/language/direction switch never applies — banner stuck indefinitely
status: green
source: qa
depends_on: []
touches: [src/client/views/useSessionController.ts, src/client/state/sessionMachine.ts]
test_files: []
iterations: 0
---

## Finding (QA iteration 2)
Repro A: fixture session, single arm, state `ready` (no utterance in flight) → toggle mode →
banner "switching to Cascade after this sentence finishes" shows and NEVER clears; mode never
applies (≥60 s, multiple utterance completions observed later).
Repro B: switch requested while an utterance was streaming → utterance settled → banner still
stuck.
Expected: PRD §6 — a switch requested mid-utterance queues and applies at the next utterance
boundary. Corollary: requested at a boundary (ready/listening, nothing in flight), there is no
sentence to finish — apply immediately.

## Acceptance criteria
1. REQUEST_SWITCH while `ready` or `listening` with no utterance in flight → applies
   immediately (no pending banner), including mode, language, and direction kinds.
2. REQUEST_SWITCH while an utterance is in flight (processing/playing) → pending set; the next
   UTTERANCE_BOUNDARY applies the patch and clears pending (verify the controller actually
   dispatches UTTERANCE_BOUNDARY on settle in single-arm AND multi-arm sessions — the observed
   bug is that the pending switch survives settles).
3. Applying a mode switch in single-arm mode swaps the active transport to the new mode's arm
   (observable: arm card + arms strip change).
4. View test: banner appears during in-flight request, disappears after the fixture utterance
   completes, and the new mode is active.
