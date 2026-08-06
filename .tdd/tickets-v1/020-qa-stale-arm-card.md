---
id: 020
title: Arm card shows previous utterance's translation labelled 'ready' after source advances
status: green
source: qa
depends_on: []
touches: [src/client/views/useSessionController.ts, src/client/views/SessionView.tsx]
test_files: []
iterations: 0
---

## Finding (QA iteration 2)
When an arm produced no output for the current utterance (script gap), its card kept the PRIOR
utterance's target text with status 'ready' while the source card showed the new utterance —
observed 3 utterances apart. Misleading: reads as the current utterance's translation.
Expected: PRD §6 per-arm states are per-utterance (in flight / ready / failed for THIS
utterance).

## Acceptance criteria
1. When a new utterance begins (source partial for utterance N), every active arm card resets
   to in-flight for utterance N (no stale target text from N−1 displayed as current).
2. An arm that never delivers for utterance N stays visibly in-flight (or empty) rather than
   'ready' with old content.
3. Completed utterance content remains available in the transcript history semantics (records
   in ledger unaffected).
