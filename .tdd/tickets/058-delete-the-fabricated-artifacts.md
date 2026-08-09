---
id: 058
title: Delete the fabricated artifacts — invented benchmark data, dead code, and scaffolding for fields hardcoded null
status: pending
source: spec-audit
depends_on: []
touches: [benchmark-results/, src/harness/bench.ts, src/client/views/useSessionController.ts, src/client/state/ledger.ts, src/server/storage/types.ts, package.json]
iterations: 0
test_files: []
branch: ""
---

## Why

**`benchmark-results/fixture-soak.json` is stamped `"PLACEHOLDER": true` with invented heap and
utterance figures — and it is the only heap data in the repo.** A reviewer finding fabricated
benchmark numbers does more damage than the missing benchmark it stands in for.

Alongside it, scaffolding for measurements that never happen: `heapStart`, `heapEnd` and
`driftMinute1ToEnd` are hardcoded `null` at `useSessionController.ts:733-734` with full type
plumbing through the ledger, storage types, route validators and export summaries. Latency drift and
leak detection are specified, typed, validated, exported — and never measured.

## Acceptance criteria

- [ ] `benchmark-results/fixture-soak.json` deleted
- [ ] `src/harness/bench.ts` deleted if verification confirms no production importer (PRD §8 says
      *"There is no separate harness"* — it was superseded by the in-app batch runner)
- [ ] `heapStart` / `heapEnd` / `driftMinute1ToEnd`: **either measure them or delete the fields.**
      Do not ship the scaffolding. One before/after heap number in the single 5-minute stability
      session satisfies the rubric's *"without… memory leaks"*; nothing more is graded.
- [ ] `scripts/smoke-openai.mjs` / `smoke-elevenlabs.mjs`: wire into `package.json` or drop the PRD
      §13 claim of *"one real-provider smoke test per path"*
- [ ] `.tdd/worktrees/` contains no stale checkout at submission — a reviewer running `find` or
      `grep` must not hit doubled results
- [ ] Suite, both typechecks and build stay green

## Notes
- Deleting a typed-but-null field is a schema change: check the server route validators and the
  export bundle shape together, or a stored record will fail to load.
