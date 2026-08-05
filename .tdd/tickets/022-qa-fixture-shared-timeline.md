---
id: 022
title: Fixture arms must share one utterance timeline (unsynchronized playlists mislead comparison QA)
status: pending
source: qa
depends_on: []
touches: [src/client/fixtureDeps.ts]
test_files: []
iterations: 0
---

## Finding (QA iteration 4, fixture mode only)
Each LoopingFixtureTransport runs its own schedule from its own start time. With two arms
active, cards concurrently display translations of different source sentences (offset by when
each arm started), so the "shared by every arm" premise is visually false and blind compare
pairs different sentences. In the real product the shared mic audio makes this impossible.

## Acceptance criteria
1. All fixture transports built by one buildFixtureDeps call share a single utterance
   timeline: at any moment every STARTED arm is on the same utterance index with the same
   source sentence (arms may differ only in per-arm timings/translation-shape, mock-faithful).
2. An arm added mid-session joins the shared timeline at the NEXT shared utterance (it does
   not replay from index 0).
3. Existing fixtureDeps contract preserved: looping, contiguous utt ids, settles, fail-mt
   single injection, stop() halts.
