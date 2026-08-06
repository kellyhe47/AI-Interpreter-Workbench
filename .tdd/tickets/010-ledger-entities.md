---
id: 010
title: Ledger becomes the client view over Recording / Run / LiveSession
status: pending
depends_on: [001]
touches: [src/client/state/ledger.ts, src/client/state/ledger.test.ts]
iterations: 0
test_files: []
branch: ""
---

## Scope

**MODIFY `src/client/state/ledger.ts`** — it is currently a client-owned append-only store of
`UtteranceRecord`s. In v2 it becomes **the client's view over the server-persisted ledger**,
carrying the three v2 entities and, critically, the aggregation gate.

Files: `src/client/state/ledger.ts` and its co-located test. No UI, no HTTP client, no
results derivation (that is ticket 011).

## The aggregation gate (the point of this ticket)

Experiments aggregate a Run **only when all three hold** (PRD §7, §8, §17 22d):

1. its computed `armTag` matches a named arm (`'A' | 'B' | 'C'` — never `'ad-hoc'`), **AND**
2. `origin === 'sweep'`, **AND**
3. `status === 'complete'`

`origin` matters because sweep runs had counterbalancing and warmup discard applied and a
manual run with an identical triple did not — same configuration, different measurement
conditions. A failed run is real information and stays visible in the per-Recording view; it
is simply not a latency sample.

`armTag` is **derived** via `deriveArmTag` from `src/core/arms.ts` — the ledger never trusts a
declared tag on an incoming record. If a record arrives carrying an `armTag` that disagrees
with its configuration, the derived value wins.

The existing **realness rule** (`isRealRecord`: no `fixture` provider, no `placeholder`
corpusId, arm not `'fixture'`) is **retained and still applied on top** — no fixture-sourced
number may ever be reported (PRD §8 hard rule). Do not weaken it.

## Acceptance criteria

- [ ] The ledger stores `Recording`, `Run` and `LiveSession` entities alongside utterance
      records, with getters for each
- [ ] `Run`s are grouped/queryable by `recordingId` — "runs of the same Recording are
      comparable by construction"
- [ ] A Run whose derived `armTag` is a named arm, `origin === 'sweep'`, and
      `status === 'complete'` **is** included in experiment aggregates
- [ ] A Run identical except `origin === 'manual'` is **excluded** from aggregates and still
      **present** in the per-Recording listing
- [ ] A Run identical except `status === 'failed'` is **excluded** from aggregates and still
      **present** in the per-Recording listing
- [ ] A Run identical except for an off-arm triple (derives `'ad-hoc'`) is **excluded** from
      aggregates and still **present** in the per-Recording listing
- [ ] A record carrying a declared `armTag` that contradicts its configuration aggregates
      under the **derived** tag, not the declared one
- [ ] A fixture-backed Run is stored and exportable but never aggregated — the realness rule
      still applies after the three new gates (a sweep-origin, complete, Arm-B-shaped run
      built from fixture providers is still excluded)
- [ ] `LiveSession`s are stored separately and are **never** pooled with Runs in any
      aggregate (PRD §7: "Nothing from a LiveSession is compared against a Run")
- [ ] Aggregates report **actual N** — the count of runs that actually passed the gate — so a
      caller can render `4 of 5 reps completed` rather than the intended N
- [ ] Percentile behaviour is preserved: nearest-rank `sorted[ceil(p*n)-1]`, and p50/p95 are
      `null` (never `0`) when there are no latency samples
- [ ] Append-only is preserved: records are never mutated or removed, and getters return deep
      copies
- [ ] `exportRuns()` / `importRuns()` still round-trip deep-equal, now including the three
      entities

## Test plan

Rework `src/client/state/ledger.test.ts` structurally (manifest Tests table). Build the gate
cases as a table over `{origin, status, triple} → aggregated?` so all four exclusion reasons
are covered without four near-duplicate test bodies.

## Attempt log
