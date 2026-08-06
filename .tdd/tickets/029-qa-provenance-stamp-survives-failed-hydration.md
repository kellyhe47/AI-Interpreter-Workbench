---
id: 029
title: The provenance stamp survives a failed hydration — it asserts a run beside a panel that says it has nothing to show
status: green
source: qa
depends_on: []
touches: [src/client/views/ResultsView.tsx, src/client/views/ResultsView.test.tsx, src/client/App.tsx, src/client/views/App.test.tsx]
iterations: 0
test_files: [src/client/views/App.provenance.test.tsx]
branch: ""
---

## Repro

QA iteration 4.

1. Start the API and the client. Open Results and let it hydrate successfully, so the client ledger
   is populated (it persists to `localStorage["workbench.runLedger.v1"]`).
2. Stop the API server.
3. Reload the page and open Results.

## Expected

Ticket 025 established the rule and the reason: *"PRD §8 attaches provenance to results; with zero
results there is nothing to attribute."* A screen showing no results must not carry a stamp
claiming a run happened against a corpus version.

A failed load has strictly **less** to attribute than an empty one — it does not even know what it
has.

## Observed

The Results body correctly renders its failure state:

> **Could not read the run ledger** — The run store did not answer, so this screen has nothing to
> show. That is not the same as an empty ledger: check that the server is reachable, then reopen
> this tab.

…while the top bar simultaneously renders `[data-provenance-run]`:

```
run 2026-08-06 · corpus v1
```

So the screen says "nothing to show" and "here is the run this came from" at the same time.

## Characterization — exactly one of four states is wrong

Verified all four in the running app:

| ledger | hydration | stamp | verdict |
|---|---|---|---|
| empty | ready | absent | correct |
| populated | ready | present | correct |
| empty | failed | absent | correct |
| **populated (from a previous load, cached in localStorage)** | **failed** | **present** | **WRONG** |

The stamp's gate is computed from **ledger contents only** — the cached ledger still holds
gate-passing runs, so the predicate says "there is evidence" while the view is refusing to show
any. The gate needs to additionally require that hydration did not fail.

The body's failure copy is good and should not change: refusing to report figures it cannot
confirm is the right call for this project, and the copy explicitly distinguishes failure from
emptiness (the same distinction ticket 020 drew for the Recordings library).

## Acceptance criteria

- [ ] With hydration `failed`, `[data-provenance-run]` is **absent**, regardless of what the cached
      ledger holds
- [ ] The other three states are unchanged: empty+ready absent, populated+ready present,
      empty+failed absent
- [ ] The failure body copy is unchanged
- [ ] The stamp still appears immediately when a subsequent successful hydration populates the
      ledger — a recovered load restores it without a reload
- [ ] The predicate stays in ONE place. `ResultsView.tsx` already documents that the App shell and
      the Results panel must not disagree about whether provenance exists (see the comment above
      the shared predicate, ~line 882) — extend that shared predicate rather than adding a second
      condition at the App boundary.

## Notes for the implementer

- Mutation-check the new condition: force hydration status to `ready` in the predicate and confirm
  a test goes red. Without that, a fix that merely reorders rendering would look green.
- This is the same class of defect as ticket 025 and the fix belongs in the same predicate — if it
  ends up in two places, they will drift.

## Attempt log

- iter 1: green, zero implementation retries. Full suite 1085/62; both tsconfigs clean.
- The fix keeps ONE predicate deciding provenance-exists, as AC5 required:
  `resultsAreEmpty(ledger, hydration?)` now takes the load status as an ARGUMENT, and `App` went
  from two provenance conditions (`!hydrating && !resultsAreEmpty(ledger)`) to zero — it supplies
  an input rather than contributing a rule, so there is nothing at the boundary that can drift.
- `App.hydrating: boolean` became `hydration: ResultsHydrationStatus | null`. A boolean could not
  distinguish "finished successfully" from "stopped because it failed" — which was the defect.
  The existing `observe` wrapper records the rejection and **rethrows unchanged**, so
  `hydrateLedger` still rejects and `ResultsView` still derives its own failure state.
- **The trap the test-writer found, and why it mattered:** the gate had to be
  `hydration === 'failed' → hide`, never `hydration !== 'ready' → hide`. Three locked tests
  (`App.test.tsx:261`, `ResultsView.hydration.test.tsx:328`, `App.hydration.test.tsx:132`) pin the
  no-seam case, where `hydration` is `null` and the stamp must still SHOW. Mutation-checked in that
  direction on the orchestrator's side: the `!== 'ready'` form fails **49 tests across four files**.
  The optional/nullable parameter is what preserves it.
- Mutation-checked, both directions:
  | mutation | result |
  |---|---|
  | drop the `'failed'` condition | exactly the 2 target tests red — the fix is the condition, not a rendering reorder |
  | hide whenever hydration `!== 'ready'` | 49 red — the no-seam contract is comprehensively defended |
- Implementer folded `'loading'` into the same predicate. Not strictly required by the ticket, but
  leaving it as a separate `!hydrating &&` in App would have left half the rule at the boundary,
  which is what AC5 forbids. No DOM behaviour changed.
- Naming note carried forward: `resultsAreEmpty` returns `true` for a *failed* load, which reads
  slightly off. It matches what the panel actually says — "this screen has nothing to show" — and
  is documented in the predicate's comment rather than renamed, to avoid churning the export
  surface next to locked tests.
