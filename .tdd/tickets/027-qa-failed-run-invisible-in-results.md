---
id: 027
title: Failed runs are invisible in Results — absent from By Recording, uncounted in provenance
status: pending
source: qa
depends_on: []
touches: [src/client/views/ResultsView.tsx, src/client/views/ResultsView.test.tsx, src/client/state/ledger.ts, src/client/state/ledger.test.ts]
iterations: 0
test_files: []
branch: ""
---

## Repro

QA iteration 2, flow H (Results, both tabs, populated). Seeded via the real API against
Recording `rec_mshzkyej001_c403e231` ("clinic intake · corpus"):

| run id | arm | origin | status |
|---|---|---|---|
| `run-b-sweep-1` | B | sweep | complete |
| `run-c-sweep-1` | C | sweep | complete |
| `run-adhoc-1` | derives ad-hoc | manual | complete |
| `run-failed-1` | B | sweep | **failed** |

1. Start the API server and the client; seed the four Runs above.
2. Results → **By Recording & category**.

## Expected

PRD §7: *"**Failed runs are saved, visible, and excluded from every aggregate.** … it belongs in
the ledger **and in the per-Recording view**."*

The design mock's By Recording table carries a `failed`-status row
(`rrow('pharmacy dosage test', 'ad-hoc', 'manual', '—', '—', 'failed')`) — dashes for the
figures, the status in the last column. Exclusion is a *label*, not a deletion.

PRD §8, provenance: reports ACTUAL N. Two sweep attempts were made on Arm B against this
Recording; one completed.

## Observed

**By Recording — includes ad-hoc runs, excluded from experiments** renders exactly **three** rows:

```
clinic intake · corpus | cascade · …→eleven_multilingual_v2 | ad-hoc | manual | 1 | 1.19 s | 1.19 s | $0.015 | excluded · ad-hoc
clinic intake · corpus | cascade · …→gpt-4o-mini-tts        | Arm B  | sweep  | 1 | 1.05 s | 1.05 s | $0.015 | in experiments
clinic intake · corpus | cascade · …→eleven_flash_v2_5      | Arm C  | sweep  | 1 | 0.93 s | 0.93 s | $0.015 | in experiments
```

`run-failed-1` appears **nowhere**. There is no failed row and no indication that a run against
this Recording failed. The manual/ad-hoc exclusion case is handled correctly (`excluded · ad-hoc`)
— it is specifically the `status: 'failed'` case that is dropped rather than labelled.

Consequently the Arm B row reads `N = 1` with nothing to suggest that figure came from one of two
attempts, and the Experiments tab's Arm B provenance line reads:

```
Arm B · 1 utterances · 1 of 1 reps completed · endpointing pinned 500 ms · turn-final trigger · corpus version unrecorded
```

`1 of 1` for a cell with two sweep attempts. A reader cannot tell a clean 1/1 from a 1/2 with a
failure, which is exactly the provenance failure mode AGENTS.md names: *"A line that claims 5
while aggregating 4 is the failure mode this project exists to prevent"* — here the denominator
is understated rather than the numerator overstated, and the effect is the same: the reported
line hides that something failed.

## Scope of the defect

The data is **not** lost, and no wrong number is reported:

- Replay's runs list shows all four cards including the failed one, with the stage-named notice
  *"tts stage timed out — run saved as failed, excluded from every aggregate"*.
- The aggregation gate is correct: the failed run is properly excluded from every percentile,
  cost figure and delta on the Experiments tab.

The defect is confined to the **Results** view's secondary tab and its provenance denominator.

## Acceptance criteria

- [ ] A `failed` Run appears as a row in **By Recording & category**, grouped like any other
      configuration cell for that Recording
- [ ] Its percentile and cost cells render `—` (never `0`, and never a figure) — a failed run has
      no measurement, and a zero reads as one
- [ ] Its experiment-status cell names the exclusion reason distinctly from the ad-hoc case
      (e.g. `excluded · failed` alongside the existing `excluded · ad-hoc`)
- [ ] `isAggregatableRun` is **unchanged** — this ticket changes what is *displayed*, never what
      is aggregated. Every existing exclusion assertion stays green.
- [ ] The Experiments provenance line's denominator counts **attempted** sweep reps for the cell,
      so a cell with one completed and one failed sweep run reads `1 of 2 reps completed` while
      the p50 beside it is still computed over the 1
- [ ] With no failed runs present, every existing provenance string is byte-identical to today's
      (`1 of 1 reps completed` stays `1 of 1`)

## Notes for the implementer

- The two changes are independent and both load-bearing; mutation-check them separately.
- Deriving the denominator must not reach past the gate — count sweep-origin runs whose
  configuration derives the same named arm, regardless of `status`, and keep the numerator on
  the gate-passing set.
- Grouping must not resurrect a failed run into a percentile input via a shared code path;
  assert the p50 for a Recording is unchanged by adding a failed run to the ledger.
