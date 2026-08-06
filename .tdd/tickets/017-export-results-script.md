---
id: 017
title: export-results script and npm entry
status: pending
depends_on: [002]
touches: [scripts/export-results.mjs, package.json]
iterations: 0
test_files: []
branch: ""
---

## Scope

**ADD `scripts/export-results.mjs`** and the `export-results` npm script.

`data/` is gitignored working state; `results/` is committed and **is what the write-up
cites** (PRD §7, §17 20c). The exported dated bundle — not the working directory — is what a
reviewer reproduces from.

Node script, no vitest involvement (`scripts/` is outside the test glob), following the style
of the existing `scripts/*.mjs`. **No new dependency.**

## Behaviour

- Reads `data/` (base path overridable by argument or env so it is testable) and writes
  `results/<YYYY-MM-DD>/` containing the run records plus a summary.
- The summary reports, per experiment and per configuration, the **actual** N and reps
  completed vs intended — the same actual-N discipline as the in-app provenance line.
- **Aggregate figures in the summary obey the ledger gate**: named `armTag` AND
  `origin === 'sweep'` AND `status === 'complete'`, with fixture-sourced runs excluded.
  Manual, ad-hoc and failed runs are **included in the exported record set** (they are real
  information) but never inside an aggregate.
- Export failure is reported plainly and leaves `data/` untouched, so export is always
  re-runnable (PRD §12).
- Exits non-zero on failure with a readable message; prints the output path on success.

## Acceptance criteria

- [ ] `npm run export-results` exists in `package.json` and invokes the script
- [ ] Running against a populated data dir writes `results/<date>/` with the run records and a
      summary file
- [ ] The summary's aggregates exclude manual-origin, failed, ad-hoc and fixture-sourced runs
      while the exported record set still contains them
- [ ] The summary reports actual reps completed vs intended per configuration
- [ ] Running against an empty data dir produces an empty-but-valid bundle rather than
      throwing, and says so
- [ ] A failure (unwritable output path) reports plainly, exits non-zero, and leaves `data/`
      unmodified
- [ ] `data/` stays gitignored and `results/` is not gitignored — the script does not change
      either

## Test plan

The script is exercised by a small node-env test that invokes its exported entry function
against a temp dir (mirroring how `src/harness/bench.test.ts` covers `scripts/bench-fixture.mjs`
logic). If the script is a thin wrapper, extract the logic into a testable exported function
and keep the `.mjs` as the CLI shell.

## Attempt log
