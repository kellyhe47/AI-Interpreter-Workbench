---
id: 029
title: The provenance stamp survives a failed hydration — it asserts a run beside a panel that says it has nothing to show
status: pending
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
