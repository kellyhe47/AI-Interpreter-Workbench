---
id: 027
title: A failed run leaves no trace in Results — absorbed into its config row, failedCount never rendered
status: pending
source: qa
depends_on: []
touches: [src/client/views/ResultsView.tsx, src/client/views/ResultsView.test.tsx]
iterations: 0
test_files: [src/client/views/ResultsView.test.tsx]
branch: ""
---

## Repro

QA iteration 2, flow H. Seeded via the real API against Recording `rec_mshzkyej001_c403e231`
("clinic intake · corpus"):

| run id | derived arm | origin | status |
|---|---|---|---|
| `run-b-sweep-1` | B | sweep | complete |
| `run-c-sweep-1` | C | sweep | complete |
| `run-adhoc-1` | ad-hoc | manual | complete |
| `run-failed-1` | B | sweep | **failed** |

Results → **By Recording & category**.

## Observed

Three rows. `run-failed-1` produces no row of its own and no mark on any row:

```
clinic intake · corpus | …→eleven_multilingual_v2 | ad-hoc | manual | 1 | 1.19 s | 1.19 s | $0.015 | excluded · ad-hoc
clinic intake · corpus | …→gpt-4o-mini-tts        | Arm B  | sweep  | 1 | 1.05 s | 1.05 s | $0.015 | in experiments
clinic intake · corpus | …→eleven_flash_v2_5      | Arm C  | sweep  | 1 | 0.93 s | 0.93 s | $0.015 | in experiments
```

## Diagnosis — a render gap, not a model gap

`groupByRecording` (`src/client/components/results/derive.ts:469`) groups on
`(recordingId × configurationKey)`, which is deliberate and correct. `run-failed-1` shares Arm B's
configuration, so it is **absorbed into the Arm B row** rather than dropped. The row model already
carries everything needed:

- `runCount: 2` vs `n: 1` — the group holds two runs, one measured
- `failedCount: 1`
- `exclusionReasons` includes `'failed'`

`ResultsView.tsx:714` renders only `excludedFromExperiments`, which is **false** for this group
(the complete Arm B run passes the gate), so the row prints `in experiments` and every failure
signal in the model is discarded at the view boundary.

So the figures are all correct — `n = 1`, p50 over the one measured run, cost over the measured
runs only. What is missing is any indication that a second attempt against this configuration
failed. PRD §7 requires failed runs to be *"saved, visible, and excluded from every aggregate"*;
they are saved and excluded, but not visible here.

## Acceptance criteria

- [ ] A group containing at least one `failed` Run renders its `failedCount` in the row — the
      failure is visible without leaving Results
- [ ] The distinction between `n` (measured) and `runCount` (attempted) is legible on such a row,
      so `n = 1` cannot be read as "one attempt, clean"
- [ ] A group that is BOTH gate-passing and partially failed shows both facts: it is still
      `in experiments`, and it still shows the failure. These are not mutually exclusive and the
      row must not have to choose.
- [ ] A group whose runs are ALL failed keeps its existing `excluded · failed` treatment and
      renders `—` for p50/p95/cost — never `0`
- [ ] `groupByRecording`, `isAggregatableRun` and every figure are **unchanged**. This ticket
      changes only what the view renders from an already-correct model; no aggregate moves.
- [ ] A ledger with no failed runs renders byte-identically to today

## Notes for the implementer

- Do **not** give a failed run its own row. The `(recording × configuration)` grouping is
  documented at `derive.ts:465` and is the right model — a failed run of Arm B's configuration is
  a fact *about that cell*, not a separate configuration.
- Mutation-check the "both gate-passing and failed" case specifically: it is the case the current
  code gets wrong, and a fix that only handles the all-failed group would look green against a
  carelessly written test.

## See also

Ticket **028** — the same failure is also invisible in the Experiments provenance line
(`1 of 1 reps completed` for a cell with two attempts), but for an unrelated and deeper reason:
nothing ever writes `repIndex` onto a persisted Run. That is a separate defect with a separate
fix; this ticket is the view-layer one and does not resolve it.
