---
id: 033
title: corpusVersion reaches the Run — the last of 028's deferred fields
status: green
source: v3-corpus
depends_on: [030]
touches: [src/client/batch/runner.ts, src/client/replay/runner.ts]
iterations: 0
test_files: [src/client/replay/runner.corpusVersion.test.ts, src/client/components/results/derive.corpusVersion.test.ts, src/harness/corpusVersionRoundTrip.test.ts]
branch: ""
---

## Scope

`buildProvenance` reads `annotations.corpusVersion` and it is always `undefined`, so every
provenance line ends `corpus version unrecorded`. Once 030 puts `corpusVersion` on the Recording,
`runOnce` copies it onto the Run's annotations the same way 028 threaded `repIndex`.

## Acceptance criteria

- [ ] A Run of a Recording carrying `corpusVersion` persists it in `annotations.corpusVersion`
- [ ] The provenance line ends with that version instead of `corpus version unrecorded`
- [ ] A Recording without one still yields `corpus version unrecorded` — the honest fallback stays
- [ ] Runs of DIFFERENT corpus versions in one aggregate are surfaced, not silently mixed: the
      provenance line must not pick the first and imply homogeneity (PRD SS8 - a number without
      provenance is a claim). Decide and document: either refuse to aggregate across versions, or
      name every version present.
- [ ] `isAggregatableRun` unchanged

## Notes

The last bullet is the only non-mechanical part and it is a real measurement question: an aggregate
spanning two corpus versions is comparing across a changed input. Do not let it report one version.

## Attempt log

- Green in one pass, batched with 038. Suite 1438/82; both tsconfigs clean; build clean.
- Stamped in **`runOnce`, not the batch wrapper** — a MANUAL run's provenance is displayed too and a
  manual run never passes through `createRunOnceExecutor`. The test-writer verified the batch
  wrapper needs NO change: it already spreads `...run.annotations` before stamping `repIndex`, so
  the stamp survives untouched. **This ticket's `touches` list was wrong** — it named
  `batch/runner.ts` (no change needed) and omitted `derive.ts` (where the real hazard lived).
- **The real fix was in `buildProvenance`,** which did
  `.map(r => r.annotations?.corpusVersion).find(v => v !== undefined)` — it picked the FIRST version
  and silently implied homogeneity. Once two corpora exist that is a confident WRONG provenance
  claim, strictly worse than the honest "unrecorded" it replaced.
- **Ruling on multi-version aggregates: name every version, do not refuse to aggregate.** The
  test-writer's reasoning, adopted: the samples are real measurements, and suppressing them destroys
  evidence to avoid a labelling problem. What the line owes the reader is that the input changed,
  and a joined list says exactly that. `Provenance.corpusVersions: string[]` (deduped, sorted
  ascending so order is stable regardless of append order); `Provenance.corpusVersion` is the single
  version iff there is exactly one and **null for none AND for several**, so any caller rendering
  the singular field alone degrades to honest "unrecorded" rather than to a wrong claim.
- Only gate-passing runs contribute a version.
- Mutation-checked:
  | mutation | result |
  |---|---|
  | provenance picks the FIRST version again | 3 red |
  | runner never stamps `corpusVersion` | 6 red |
- Known limitation, recorded rather than hidden: the sort is lexicographic, so a hypothetical
  `corpus-v10` would sort before `corpus-v2`. Harmless at the current scale; revisit if versions
  ever reach double digits.
