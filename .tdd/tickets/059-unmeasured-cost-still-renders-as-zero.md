---
id: 059
title: "$0.000 still renders on two surfaces — 052's rule holds on Live and leaks everywhere else"
status: pending
source: qa
depends_on: []
touches: [src/client/components/results/derive.ts, src/client/views/ResultsView.tsx, src/client/components/replay/RunsList.tsx, src/harness/exportResults.ts]
iterations: 0
test_files: []
branch: ""
---

## Observed (QA, HEAD `ca40359`)

Ticket 052 established the rule: an unmeasured cost reads **`not measured`**, never `$0.00`. Zero is
a measurement; `$0.00` reads as *"this configuration is free."*

**Live obeys it.** The footer renders `session not measured · 0 of 0 metered`.

**Two surfaces do not:**

| Surface | Renders | Screenshot |
|---|---|---|
| Results › By Recording, COST column | `$0.000` on both rows | `.qa/screens/` |
| Replay › run cards | `$0.000/min` on both complete runs | `.qa/screens/` |

This is the pattern 052's own round-2 review named: *"the module is solid, its consumers are
untested."* `pricing.ts` is correct and heavily pinned (25 of 28 mutations killed); the surfaces
consuming it are not.

## Acceptance criteria

- [ ] Results › By Recording renders `not measured`, never `$0.000`
- [ ] Replay run cards render `not measured`, never `$0.000/min`
- [ ] **Every** cost surface goes through the one formatter — `formatCostUsd`. Grep for `.toFixed(`
      on a nullable cost and for `?? 0` on a cost field; both are the failure mode.
- [ ] The export bundle agrees with the screen — a reviewer must not find `$0.000` in the artifact
      after reading `not measured` in the UI
- [ ] `measuredCostRecords` / `measuredCostSamples` reach every surface that shows a summed cost, so
      a reader can tell 3-of-5 metered from 5-of-5

## Notes
- Do NOT add a second formatter or a per-surface special case. One vocabulary for one fact.
- Golden eval `eval/golden/07-unmeasured-cost-is-null-not-zero.json` lists the surfaces to check.
