---
id: 033
title: corpusVersion reaches the Run — the last of 028's deferred fields
status: pending
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
