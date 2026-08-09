---
id: 058
title: Delete the fabricated artifacts — invented benchmark data, dead code, and scaffolding for fields hardcoded null
status: done
source: spec-audit
depends_on: []
touches: [benchmark-results/, src/harness/bench.ts, src/harness/bench.test.ts, scripts/bench-fixture.mjs, scripts/soak-fixture.mjs, src/client/views/useSessionController.ts, src/client/state/ledger.ts, src/client/components/results/derive.ts, src/client/views/ResultsView.tsx, src/server/storage/types.ts, src/server/routes/liveSessions.ts, package.json, .tdd/worktrees/]
iterations: 1
test_files: []
branch: main
---

## Why

**`benchmark-results/fixture-soak.json` is stamped `"PLACEHOLDER": true` with invented heap and
utterance figures — and it is the only heap data in the repo.** A reviewer finding fabricated
benchmark numbers does more damage than the missing benchmark it stands in for.

Alongside it, scaffolding for measurements that never happen: `driftMinute1ToEnd` is hardcoded
`null` at `useSessionController.ts:712`, and `heapStart` / `heapEnd` at `:733-734`, with full type
plumbing through the ledger, storage types, route validators and export summaries. Latency drift and
leak detection are specified, typed, validated, exported — and never measured.

## Acceptance criteria

- [ ] `benchmark-results/fixture-soak.json` deleted, and the `benchmark-results/` directory removed
      (it contains nothing else).
- [ ] `src/harness/bench.ts` deleted, TOGETHER WITH `src/harness/bench.test.ts` and its two callers
      `scripts/bench-fixture.mjs` and `scripts/soak-fixture.mjs` (the latter is what generated the
      placeholder file). Verification is DONE — see CONTEXT below: no production importer exists.
      Falsifiable: `rg 'harness/bench|runFixtureBench'` over `src/`, `scripts/`, `package.json`
      returns zero hits.
- [ ] `driftMinute1ToEnd` is REMOVED end-to-end (type, validator, writer, aggregator, render row)
      per the checklist below. Falsifiable: the same `rg` returns zero hits outside git history.
- [ ] `heapStart` / `heapEnd` are REMOVED end-to-end per the same checklist. Falsifiable: same.
      (Split from the line above deliberately — they live in `stability`, not `latency`, and touch a
      different validator block and no render row.)
- [ ] Order the schema change so the wire never breaks: relax `src/server/routes/liveSessions.ts`
      FIRST, then stop writing the field. Falsifiable: a POST of a session body WITHOUT
      `driftMinute1ToEnd`/`heapStart`/`heapEnd` returns 2xx.
- [ ] The 8 sessions already in `data/live-sessions.jsonl` still load and still render after the
      change. Falsifiable: they carry the removed keys; `hasFields` is a SUBSET check, so extra keys
      must remain tolerated — do not add an exact-shape check.
- [ ] `scripts/smoke-openai.mjs` and `scripts/smoke-elevenlabs.mjs` each get a `package.json` script
      entry, OR both files are deleted and the PRD §13 claim of *"one real-provider smoke test per
      path"* is dropped. Pick ONE; do not leave them unreferenced.
- [ ] `.tdd/worktrees/053/` is removed — a reviewer running `find` or `grep` must not hit doubled
      results.
- [ ] Suite, both typechecks and build stay green.

~~`heapStart` / `heapEnd` / `driftMinute1ToEnd`: either measure them or delete the fields~~
> rewritten above into DELETE. "Either measure or delete" is not falsifiable — a test cannot be
> written against a choice. Measuring heap needs `performance.memory`, which jsdom does not provide
> and which this codebase would have to inject as a new seam; that is more scaffolding, not less.

## Out of scope

- Actually measuring heap or latency drift. If the rubric's *"without… memory leaks"* needs
  evidence, it comes from a manual before/after note on the 5-minute stability session, not from
  new typed fields.
- `src/harness/exportResults.ts` and its 6 test files — the export bundle writes LiveSessions
  VERBATIM (`exportResults.ts:678`) and `LiveSessionSummary` (`:195-211`) names NONE of the three
  fields. No export type changes.
- Any change to `isAggregatableLiveSession`, `isAggregatableRun`, or what counts as a sample.
- `scripts/generate-placeholder-corpus.mjs` and the placeholder corpus — those are honestly labelled
  and golden eval `06` depends on them.
- Rewriting or backfilling `data/live-sessions.jsonl`.

## Notes
- Deleting a typed-but-null field is a schema change: the route validator and the client writer must
  move together, validator first.

---

## CONTEXT FOR A FRESH AGENT

### 1. Verified facts (checked against the working tree, 2026-08-08)

| claim | evidence | status |
|---|---|---|
| the fabricated benchmark exists and is stamped | `benchmark-results/fixture-soak.json` line 2: `"PLACEHOLDER": true`, then `"minutes": 8.5`, `"utterances": 53178`, a `heapSamples` array | verified |
| it is the ONLY file in `benchmark-results/` | `ls benchmark-results/` → `fixture-soak.json` | verified |
| what wrote it | `scripts/soak-fixture.mjs:49` (`heapStartMB`/`heapEndMB`) | verified |
| **`src/harness/bench.ts` has NO production importer** | only importers: `scripts/bench-fixture.mjs:27`, `scripts/soak-fixture.mjs:10`, `src/harness/bench.test.ts:12`. Neither script is referenced by `package.json`. A stale prose mention sits at `src/harness/exportResults.ts:6` (comment only — update it) | **verified — do not redo this** |
| `bench.ts` exports exactly one symbol | `runFixtureBench` at `src/harness/bench.ts:183` | verified |
| its test exists and must die with it | `src/harness/bench.test.ts` (`describe('runFixtureBench (in-process integration)')`, `:17`) | verified |
| smoke scripts exist | `scripts/smoke-openai.mjs`, `scripts/smoke-elevenlabs.mjs` | verified |
| **neither is referenced by `package.json`** | `scripts` block is `dev, dev:server, dev:client, build, start, export-results, score-wer, test, test:watch, typecheck` (`package.json:6-17`) — no `bench`, no `soak`, no `smoke` | verified |
| stale worktree present | `.tdd/worktrees/053/` (30 entries) | verified — the criterion is NOT yet satisfied |
| `driftMinute1ToEnd` write site | `src/client/views/useSessionController.ts:712` | **CORRECTED** — the ticket previously said `:733-734` |
| `heapStart` / `heapEnd` write site | `src/client/views/useSessionController.ts:733-734` | verified |
| validator is a SUBSET check | `src/server/routes/liveSessions.ts:90-96` — `Object.entries(shape).every(...)`; extra keys on stored records are tolerated | verified |

### 2. The code

`src/client/views/useSessionController.ts:709-713` and `:731-735`
```ts
      latency: {
        p50: latencies.length === 0 ? null : nearestRank(latencies, 0.5),
        p95: latencies.length === 0 ? null : nearestRank(latencies, 0.95),
        driftMinute1ToEnd: null,
      },
...
      stability: {
        utterancesCompleted: store.utterances.length,
        disconnects: store.disconnects,
        heapStart: null,
        heapEnd: null,
      },
```

`src/server/routes/liveSessions.ts:90-96` — subset validation, the reason stored records survive
```ts
function hasFields(
  value: unknown,
  shape: Record<string, (field: unknown) => boolean>,
): boolean {
  if (!isObject(value)) return false;
  return Object.entries(shape).every(([key, ok]) => ok(value[key]));
}
```

`src/server/routes/liveSessions.ts:134-162` — the two blocks to relax
```ts
  if (
    !hasFields(body.latency, { p50: isNumberOrNull, p95: isNumberOrNull, driftMinute1ToEnd: isNumberOrNull })
  ) {
    return 'latency must give p50, p95 and driftMinute1ToEnd as numbers or null';
  }
  ...
  if (
    !hasFields(body.stability, {
      utterancesCompleted: isNumber, disconnects: isNumber,
      heapStart: isNumberOrNull, heapEnd: isNumberOrNull,
    })
  ) {
    return 'stability must give numeric counters and heap figures or null';
  }
```

`src/client/components/results/derive.ts:1238-1241` — the only consumer that computes anything
```ts
      driftMinute1ToEndMs: meanOf(
        sessions
          .map((s) => s.latency.driftMinute1ToEnd)
          .filter((v): v is number => v !== null),
      ),
```

`src/client/views/ResultsView.tsx:538-540` — the only render site
```tsx
    metric: 'drift',
    label: 'drift, first minute to end',
    value: (c) => formatMs(c ? c.driftMinute1ToEndMs : null),
```
`heapStart` / `heapEnd` have NO render site and NO consumer — grep for `heap` under `src/client/`
outside tests returns only the type declarations and the `null` writes.

### 3. THE SCHEMA-CHANGE CHECKLIST (every site, in safe order)

Relax the server first, then stop writing, then delete the types, then the consumers.

`driftMinute1ToEnd`
1. `src/server/routes/liveSessions.ts:138` (validator) and `:141` (message)
2. `src/client/views/useSessionController.ts:712` (the `null` write)
3. `src/server/storage/types.ts:205` (`latency` type)
4. `src/client/state/ledger.ts:341` (`latency` type — mirror of the above)
5. `src/client/components/results/derive.ts:464` (`driftMinute1ToEndMs` on the column type) and
   `:1238-1241` (the `meanOf`)
6. `src/client/views/ResultsView.tsx:538-540` (remove the row — do NOT blank it; a blank row claims
   the measurement exists)
7. fixtures/builders: `src/client/state/hydrationFixtures.ts:192, 205, 218`;
   `src/client/components/results/testRecords.ts:131, 821, 834`;
   `src/server/storage/test-support.ts:120, 133`

`heapStart` / `heapEnd`
1. `src/server/routes/liveSessions.ts:157-158` (validator) and `:161` (message)
2. `src/client/views/useSessionController.ts:733-734`
3. `src/server/storage/types.ts:215-216`
4. `src/client/state/ledger.ts:351-352`
5. fixtures/builders: `src/client/state/hydrationFixtures.ts:194, 207, 220`;
   `src/client/components/results/testRecords.ts:133, 823, 836`;
   `src/server/storage/test-support.ts:122, 135`

Test files that assert on these fields and will need updating (NOT new files):
`src/server/routes/liveSessions.test.ts:226`, `src/client/views/ResultsView.test.tsx:511`,
`src/client/views/ResultsView.fixtureLive.test.tsx:59, 65-66`,
`src/client/views/ResultsView.liveAnchor.test.tsx:42-43`,
`src/client/state/ledger.test.ts:448, 450`, `src/client/state/liveRealness.test.ts:123-124`,
`src/client/components/results/deriveLive.empty.test.ts:48, 50, 63, 65`,
`src/client/components/results/deriveLive.fixture.test.ts:52, 58-59, 149, 166-167, 200-201`,
`src/client/components/results/derive.test.ts:478`,
`src/client/components/results/derive.pricing.test.ts:107-108`,
`src/client/components/results/deriveLive.anchor.test.ts:66, 70-71, 83, 87-88, 144-145, 167-168`.

### 4. Existing tests — where this ticket's assertions MUST land

**Standing policy: no new test file in a module that already has one.**

| area | EXISTING file — put the new assertions HERE |
|---|---|
| POST accepted without the removed fields; stored records still load | `src/server/routes/liveSessions.test.ts` |
| storage round-trip of the trimmed shape | `src/server/storage/liveSessions.test.ts` |
| the Live column no longer derives drift | `src/client/components/results/deriveLive.empty.test.ts` |
| the drift ROW is gone from the DOM | `src/client/views/ResultsView.test.tsx` |
| the session written at Stop carries no removed field | `src/client/views/LiveView.persistence.test.tsx` |
| ledger type / persisted shape | `src/client/state/ledger.test.ts` |

**Create no new test file. Delete `src/harness/bench.test.ts` outright** (its subject is being
deleted) — that is a removal, not a policy violation.

### 5. Seams (jsdom has no AudioContext / MediaStream / RTCPeerConnection — everything is injected)

- `src/client/views/useSessionController.ts:166` — `liveSessions?: Pick<LiveSessionsClient, 'create'>`.
  Assert the POSTed body shape through this seam, not through a network mock.
- `src/client/views/sessionTestKit.ts` — `makeDeps()` / `TestDeps`; every LiveView test builds here.
- `src/client/browserDeps.ts:94` (`BrowserDeps extends SessionDeps`), real client at `:470`, wired at
  `:525-526`. **Production wiring lives here.**
- `src/client/fixtureDeps.ts:105` `isFixtureMode`, `:428` `buildFixtureDeps`.
- `src/client/state/hydrationFixtures.ts` and `src/client/components/results/testRecords.ts` — the
  record builders that carry the fields being deleted; they are where the compile errors will land.
- `src/server/storage/test-support.ts` (`:120-135`), `src/server/providers/test-support.ts`.

### 6. Golden evals this ticket must satisfy

- `eval/golden/06-fixture-and-placeholder-never-aggregate.json` — the PRIMARY one. PRD §8: no
  reported number may come from a fixture run; it cites
  `scripts/generate-placeholder-corpus.mjs` by name, so that script STAYS. Deleting the fabricated
  `fixture-soak.json` is the same rule applied to a file that is *not* honestly labelled at the
  point of use.
- `eval/golden/07-unmeasured-cost-is-null-not-zero.json` — read it before deleting anything: the
  never-measured-is-`null` doctrine is why these fields were typed nullable. Deleting the field
  entirely must not be implemented as "write a 0".
- `eval/golden/04-provenance-reports-actual-n.json` — the export summary's counts must not move.
- NOT in play: `01`, `02`, `03`, `05`, `08`, `09`, `10`, `11`, `12`.

### 7. Traps that have actually bitten this project

- **Deleting the field but leaving the validator strict.** `liveSessions.ts:138`/`:157-158` still
  demand the key; the client stops sending it; every POST 400s and the rejection is SWALLOWED at
  `useSessionController.ts:747`, so the failure is invisible until `data/` is empty. Relax the
  validator FIRST.
- **The inverse: making `hasFields` exact-shape.** The 8 records in `data/live-sessions.jsonl` carry
  the old keys. Subset checking is what lets them keep loading.
- **A guard bypassed by bracket access, a cast, or a `!`.** After removing a field from the type,
  `session['driftMinute1ToEnd']` or `as LiveSession` will still compile. Grep for the string, not
  just for type errors.
- **A fix that satisfies the test seam while production has zero callers.** `bench.ts` is precisely
  that pattern already — one test, two unwired scripts, zero production importers. Do not replace it
  with another.
- **Blanking a row instead of removing it.** A `drift, first minute to end` row rendering
  `not measured` forever asserts the measurement is expected. PRD §8 wants the row gone.
- **A test that compares a render against itself.** RTL APPENDS on re-render and the Results
  accessors are `document.querySelector`; asserting "the drift row is absent" after a prior render
  in the same test will pass or fail for the wrong reason. `cleanup()` first.

### Standing project rules

- `isAggregatableRun` is the ONE place that decides aggregation — never add a second gate.
- Arm membership is DERIVED from configuration, never declared.
- Unmeasured is `null` and renders `not measured` — never `$0.00`, never a zero.
- Never report a fixture-sourced number; never aggregate a run whose `origin` is `manual` or whose
  `status` is `failed`.
- The measured atom is the UTTERANCE, not the Run.
- 24 kHz PCM16 mono everywhere; `SAMPLE_RATE` in `src/core/protocol.ts` is the single source of truth.
- Live persists no audio and creates no Run records.
- Replay autoplays nothing; Live autoplays always.

## RESOLUTION (2026-08-09) — worked as one loop with ticket 054

Suite 2426 passing / 0 failing. `npm run check` exits 0.

Deleted: `benchmark-results/` entirely (its `fixture-soak.json` was stamped `"PLACEHOLDER": true`
with invented heap figures and was the **only** heap data in the repo), `src/harness/bench{,.test}.ts`,
`scripts/bench-fixture.mjs`, `scripts/soak-fixture.mjs`.

Removed end-to-end: `driftMinute1ToEnd`, `heapStart`, `heapEnd` — type, validator, writer,
aggregator, render row. Ban sweeps over `src/`, `scripts/`, `package.json` (comments included) return
**0** for all of them and for `harness/bench` / `runFixtureBench`. 94 hits of scaffolding for
measurements that never happened are gone.

**Removing a field that is always `null` is not the same as reporting zero** — it removes a claim
that a measurement exists. A pinned test asserts an empty take still reports `p50`/`p95` as `null`,
never `0`, and that the posted `latency` keys are exactly `['p50','p95']`.

### The ordering held

Relaxed `routes/liveSessions.ts` **first**, verified 40/40 green at that exact point — the trimmed
body now 2xx **while** a legacy body still 201s and stores verbatim, and *relaxing is not deleting*
(missing `latency`, missing `stability`, non-numeric values all still 400) — and only then stopped
writing the fields. A read-only load of real `data/` confirms all **8 stored sessions still load with
their old keys intact**, verbatim, no re-added nulls, no zeros.

### `.tdd/worktrees/053/` — removed by the orchestrator, work preserved

It was a **full repo copy**, with its own `corpus/`, `src/` and `scripts/` — exactly the
doubled-results hazard AC7 names. Removed with `git worktree remove`, which deletes the directory and
**keeps the branch**: `tdd/053` still holds all three commits (`3e844e2`, `741983d`, `ca40359`) and
remains unmerged, exactly as PRD §15B intends. `git worktree add` recreates it from the branch at any
time.

### Smoke scripts

**Wired, not deleted** — `npm run smoke:openai` / `npm run smoke:elevenlabs`. They make real provider
calls and are the evidence behind PRD §13's "one real-provider smoke test per path"; deleting them
would have dropped a true claim.
