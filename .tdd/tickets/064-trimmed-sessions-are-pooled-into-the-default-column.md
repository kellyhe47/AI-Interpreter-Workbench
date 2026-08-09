---
id: 064
title: "REALTIME · TRIMMED renders empty while its samples are silently pooled into the DEFAULT column"
status: pending
source: verification (corrects the spec audit's P1-6)
depends_on: []
touches: [src/client/views/ResultsView.tsx, src/client/components/results/derive.ts]
iterations: 0
test_files: []
branch: ""
---

## Observed — and the mechanism is worse than reported

The spec audit reported the `REALTIME · TRIMMED` column rendering entirely `—` despite 2 trimmed
sessions on disk, and attributed it to stale data. **Both halves are wrong.**

The real mechanism:
- `ResultsView.tsx:510-518` hardcodes three columns and gives `realtime-trimmed` **`arm: null`**;
  `columnFor` (`:556`) returns `undefined` for a null arm, so every row renders ABSENT
  **unconditionally**. It is not a data problem at all.
- `deriveLiveModel` (`derive.ts:1195`) groups **only by derived armTag** and never reads
  `contextPolicy`, so no trimmed column can exist in the model.

**The consequence the audit missed:** all 8 trimmed utterances carry valid anchors
(`server_speech_stopped` → `detectedEndOfSpeechMs`) and are therefore **silently pooled into the
`realtime · default` column.** That column is really *"realtime, all policies"*.

So this is not a missing number. **It is a wrong number**: the default column's p50 mixes two context
policies, and the context-policy comparison — the whole of §7's controllability evidence, and the
reason PRD §17 21e files context policy under controllability — is contaminated rather than empty.

## Acceptance criteria

- [ ] `deriveLiveModel` groups by `(armTag, contextPolicy)`, not by armTag alone
- [ ] The `realtime · trimmed` column renders its own samples
- [ ] **`realtime · default` contains ONLY default-policy samples** — assert the pooling is gone, not
      merely that the trimmed column filled
- [ ] A session whose context policy is unknown is excluded from both columns and disclosed, never
      defaulted into one
- [ ] The cost-slope rows follow the same grouping — the slope is *per policy* by definition (§8)

## Notes
- Cutting the 5-rep sweep does not touch this: context policy is a Live-only measurement and the
  slope is the finding for Arm A.
