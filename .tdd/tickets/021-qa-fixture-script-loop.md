---
id: 021
title: Fixture transports must loop their script (exhaustion wedges session in 'processing')
status: pending
source: qa
depends_on: []
touches: [src/client/fixtureDeps.ts]
test_files: []
iterations: 0
---

## Finding (QA iteration 2, fixture mode only)
The 8-utterance fixture script runs out; if it ends mid-utterance the session sits in
'processing' forever (no settle, no error). Also makes boundary-dependent behaviors (queued
switches) untestable after ~30 s.

## Acceptance criteria
1. Fixture transports loop their utterance script indefinitely (with the same spacing) until
   stop() — QA sessions always have a next utterance.
2. Every scripted utterance settles (completion or scripted failure) — no dangling utterance
   at loop wrap.
3. Utterance numbering keeps incrementing across loops (utt ids unique per session).
