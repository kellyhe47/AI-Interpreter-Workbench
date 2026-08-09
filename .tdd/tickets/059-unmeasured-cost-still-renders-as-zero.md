---
id: 059
title: "$0.000 still renders on two surfaces — 052's rule holds on Live and leaks everywhere else"
status: pending
source: qa
depends_on: []
touches: [src/client/state/ledger.ts, src/server/storage/types.ts, src/client/replay/runner.ts, src/client/components/results/derive.ts, src/client/views/ResultsView.tsx, src/client/components/replay/RunsList.tsx, src/harness/exportResults.ts]
iterations: 0
test_files: []
branch: ""
---

## Observed (QA, HEAD `ca40359`)

Ticket 052 established the rule: an unmeasured cost reads **`not measured`**, never `$0.00`. Zero is
a measurement; `$0.00` reads as *"this configuration is free."*

**Live obeys it.** The footer renders `session not measured · 0 of 0 metered`.

**Two surfaces do not:**

| Surface | Renders | Screenshot |
|---|---|---|
| Results › By Recording, COST column | `$0.000` on both rows | `.qa/screens/` |
| Replay › run cards | `$0.000/min` on both complete runs | `.qa/screens/` |

This is the pattern 052's own round-2 review named: *"the module is solid, its consumers are
untested."* `pricing.ts` is correct and heavily pinned (25 of 28 mutations killed); the surfaces
consuming it are not.

## Root cause — verified

`formatCostUsd` is NOT the leak. The leak is that a **stored `0` is read forward as a measurement**.

`LiveSession` carries a `pricingVersion` stamp (`src/client/state/ledger.ts:338`), and
`liveCostOf` uses it as the discriminator (`src/client/components/results/derive.ts:633`):
a session with no stamp prices nothing. **That is the only reason Live is correct.**

`Run` carries **no such stamp** (`src/client/state/ledger.ts:260-287`,
`src/server/storage/types.ts:100-131`). Every stored Run and every stored RunUtterance in
`data/` carries `"cost": 0`, `costFromStored(0)` returns `measured(0)`, and every Run-fed
surface therefore renders `$0.000`. Fix the stamp, not the formatter.

## Acceptance criteria

- [ ] `Run` (client `ledger.ts` and server `storage/types.ts` mirrors) carries an optional
      `pricingVersion`, written by the runner, and a Run **without** the stamp prices nothing —
      the same discriminator `liveCostOf` already applies to `LiveSession`
- [ ] Results › By Recording renders `not measured` for the 3 stored, unstamped Runs — never `$0.000`
- [ ] Replay run cards render `not measured` for those same Runs — never `$0.000/min`
- [ ] A Run written **today** whose measured cost really is `0` still renders `$0.000` — the stamp,
      not the value, is what distinguishes them
      *(split from the old "every surface goes through the one formatter"; this is the half that
      keeps the fix from degenerating into "0 means absent")*
- [ ] No cost value anywhere is rendered through `derive.ts`'s `formatUsd` — the exact remaining
      call sites are `src/client/views/ResultsView.tsx:545`, `:550`, `:828`; all three move to
      `formatCostUsd` / `COST_NOT_MEASURED_CELL`
      *(split from the old formatter criterion; this is the falsifiable half — a named work list)*
- [ ] The export bundle agrees with the screen: `buildExportBundle` reports `costUsd: null` /
      `costCell: 'not measured'` for the unstamped Runs, asserted in
      `src/harness/exportResults.cost.test.ts`
- [ ] The By Recording row discloses its cost denominator (`measured of total`), as the experiment
      card and the Live footer already do

> already satisfied: *"`.toFixed(` on a nullable cost / `?? 0` on a cost field"* — grepped at HEAD.
> The only `.toFixed` on money is `formatAmountUsd` (`src/core/pricing.ts:627-632`), reached only
> after the null check. No `?? 0` remains on a cost field outside transport rate defaults
> (`src/client/transport/{fixture,realtime,cascade}.ts`, which default a *rate card*, not a figure)
> and `useSessionController.ts:952` / `ledger.ts:832,1002`, which all guard `!== null` first.

> already satisfied: *"`measuredCostRecords` / `measuredCostSamples` reach the experiment card and
> the Live footer"* — `derive.ts:704` writes `cost measured on N of M samples` into the provenance
> line, rendered and pinned by `src/client/views/ResultsView.cost.test.tsx:118`; the Live footer
> renders `N of M metered` at `src/client/views/LiveView.tsx:1246`. Only the By Recording row is
> missing it (criterion above).

## Out of scope

- Changing rate cards, `PRICING_VERSION`, or any pricing arithmetic in `src/core/pricing.ts`.
- Backfilling or rewriting the stored records in `data/`. Unstamped is the correct reading of them.
- The Live footer, the experiment cards, and the cascade orchestrator's cost path — all correct.
- Adding a second formatter, a second cost gate, or a per-surface special case.

## Notes
- Do NOT add a second formatter or a per-surface special case. One vocabulary for one fact.
- Golden eval `eval/golden/07-unmeasured-cost-is-null-not-zero.json` lists the surfaces to check.

## CONTEXT FOR A FRESH AGENT

### 1-2. Verified citations, with the code

**The one formatter — already correct, do not change it.** `src/core/pricing.ts:654-661`:

```ts
export function formatCostUsd(cost: CostResult | number | null | undefined): string {
  if (cost === null || cost === undefined) return COST_NOT_MEASURED_CELL;
  if (typeof cost === 'number') {
    return Number.isFinite(cost) ? `$${formatAmountUsd(cost)}` : COST_NOT_MEASURED_CELL;
  }
  if (!cost.measured || cost.usd === null) return COST_NOT_MEASURED_CELL;
  return `$${formatAmountUsd(cost.usd)}`;
}
```

`COST_NOT_MEASURED_CELL = 'not measured'` — `src/core/pricing.ts:49`.
`PRICING_VERSION = 'pricing-v1'` — `src/core/pricing.ts:46`.
`sumMeasuredCosts` — `src/core/pricing.ts:607-619` (returns `usd: null` when `measured === 0`).

**The actual defect.** `src/core/pricing.ts:649-652` — a stored `0` is a measurement:

```ts
export function costFromStored(usd: number | null | undefined): CostResult {
  if (typeof usd !== 'number' || !Number.isFinite(usd)) return unmeasured('no-usage-reported');
  return measured(usd, true);
}
```

**The pattern that already works, for Live only.** `src/client/components/results/derive.ts:625-635`:

```ts
  const costs = sessions.flatMap((s) =>
    s.utterances.map((u) =>
      // A SESSION WITH NO PRICE SOURCE PRICED NOTHING. […] The stamp is the
      // discriminator, not the value — a session written TODAY that really did
      // cost 0 still reports, which is what keeps 0 and null distinct.
      s.pricingVersion === undefined ? costFromStored(null) : costFromStored(u.costUsd),
    ),
  );
```

`LiveSession.pricingVersion?: string` — `src/client/state/ledger.ts:338`, server mirror
`src/server/storage/types.ts:195`.

**The unstamped Run path.** `src/client/components/results/derive.ts:580-583` (feeds the By
Recording COST column via `groupByRecording`, `derive.ts:802-867`, cost applied at `:862-863`):

```ts
function costOf(values: Array<number | null>): { costUsd: number | null; costCell: string } {
  const sum = sumMeasuredCosts(values.map(costFromStored));
  return { costUsd: sum.usd, costCell: formatCostUsd(sum.usd) };
}
```

**Replay run card.** `src/client/components/replay/RunsList.tsx:79-86`, called at `:356` with
`run.cost`:

```ts
function formatPerMinute(cost: number | null, recording: Recording | null): string {
  // TICKET 052 — an UNMEASURED cost is not a cheap run. `not measured` says so;
  // `$0.000/min` would report the run as free.
  if (cost === null) return COST_NOT_MEASURED_CELL;
  if (recording === null || recording.durationMs <= 0) return ABSENT;
  const minutes = recording.durationMs / MS_PER_MINUTE;
  return `${formatCostUsd(cost / minutes)}/min`;
}
```

The guard is real; it never fires, because every stored `run.cost` is `0`, not `null`.

**Export.** `src/harness/exportResults.ts:364-366` — same `costFromStored` on `run.cost`;
`costCell: formatCostUsd(cost.costUsd)` at `:376`, `pricingVersion: PRICING_VERSION` at `:377`
(stamped on the *bundle*, never on the Run).

**The second vocabulary — the three remaining `formatUsd` call sites.**
`src/client/components/results/derive.ts:183-186`:

```ts
export function formatUsd(usd: number | null): string {
  if (usd === null) return '—';
  return `$${usd.toFixed(3)}`;
}
```

Rendered at `src/client/views/ResultsView.tsx:545`, `:550` (Live card cost-per-minute rows) and
`:828` (`{row.n === 0 ? formatUsd(null) : row.costCell}` — the By Recording COST cell's `n === 0`
branch, which emits `—` where the rest of the screen says `not measured`).

**Correct and untouched:** `src/client/views/ResultsView.tsx:773` (category COST cell,
`row.costCell`), `src/client/views/LiveView.tsx:1240,1246`,
`src/client/components/results/derive.ts:1104-1105`.

**The stored data.** `data/runs/*.json` (3 files) and `data/ledger.jsonl`: every Run has
`"cost": 0` and every RunUtterance has `"cost": 0`; no `pricingVersion` on any of them.
`data/live-sessions.jsonl` is the same shape and is *already handled* by the stamp check.

### 3. Where the tests must land

STANDING POLICY — no new test file may be added to a module that already has one. New assertions
go in the existing file:

| Surface | File the tests MUST land in |
|---|---|
| Results view DOM (By Recording, Live card) | `src/client/views/ResultsView.cost.test.tsx` |
| `derive.ts` pure derivations | `src/client/components/results/derive.cost.test.ts` |
| Ledger aggregation | `src/client/state/ledger.cost.test.ts` |
| Export bundle | `src/harness/exportResults.cost.test.ts` |
| `pricing.ts` | `src/core/pricing.test.ts` (also `pricing.edges.test.ts`, `pricing.realtime.test.ts`) |
| Replay run card | `src/client/components/replay/RunsList.playGate.test.tsx` |
| Runner writes the stamp | `src/client/replay/runner.test.ts` |

Do NOT create `RunsList.cost.test.tsx`, `ResultsView.byRecording.test.tsx`, or similar.

### 4. Seams

- `src/client/components/results/testRecords.ts` — `makeRunEntity` / `makeRecordingEntity` /
  `resetEntitySeq`, and it already imports `PRICING_VERSION` (`:129`). This is the seam for
  stamped-vs-unstamped Run fixtures.
- `src/client/state/hydrationFixtures.ts` — Results hydration seam (`BrowserDeps.hydrate`).
- `src/client/browserDeps.ts` — `BrowserDeps extends SessionDeps` (~`:94`); `hydrate` is its own
  field, deliberately not inferred from `replay`.
- `src/harness/exportResults.ts` takes a ledger directly — no DOM, no server.
- jsdom has no `AudioContext` / `MediaStream` / `RTCPeerConnection`. `RunsList` tests must not
  construct one; `RunsList.playGate.test.tsx` already renders the component with plain props.

### 5. Golden eval

`eval/golden/07-unmeasured-cost-is-null-not-zero.json` — `surface: "dom"`;
`surfaces_checked: ["live_footer","results_by_recording","replay_run_card","results_experiment_card","export_bundle"]`;
`must_not_contain: ["$0.000","$0.00","0.000/min"]`; `must_include: "not measured"`.

### 6. Traps — this ticket specifically

- **ACUTE (DOM ticket): a test that compares a render against itself.** RTL *appends* to
  `document.body`, and every accessor in `ResultsView.cost.test.tsx` is `document.querySelector`
  (`:67`, `:75`). `afterEach(cleanup)` exists at `:32` — but two `render()` calls inside ONE `it()`
  leave both trees mounted and `querySelector` returns the FIRST. A "before/after the fix" assertion
  written that way passes against the wrong DOM. One render per test, or scope to the returned
  container.
- **A fix that satisfies the seam while production has zero callers.** Adding `pricingVersion` to
  the `Run` type and to `makeRunEntity` makes every new test pass while the runner still never
  writes it. Pin the runner writing it in `src/client/replay/runner.test.ts` against the real
  construction site (`src/client/replay/runner.ts:1161-1185`).
- **A guard bypassed by a cast or `!`.** `ResultsView.cost.test.tsx:34` already carries
  `const UNPRICED = null as unknown as number;`. Do not extend that pattern; widen the fixture type.
- **An arithmetic guard that omits the dominant term.** `formatAmountUsd`
  (`src/core/pricing.ts:627-632`) has an explicit `|| abs === 0` branch so a real zero renders
  `$0.000`. That branch is CORRECT and must survive — the zero being suppressed is the *unstamped*
  one, upstream.
- **Wiring delivered incidentally by an unrelated re-render.** The By Recording COST cell's
  `n === 0` branch (`ResultsView.tsx:828`) can mask a broken `costCell` whenever the fixture happens
  to have no complete samples. Seed a row with `n > 0` and unstamped costs.

### Standing project rules

- `isAggregatableRun` (`src/client/state/ledger.ts:572`) is the ONE place that decides aggregation —
  never add a second gate.
- Arm membership is DERIVED from configuration, never declared.
- Unmeasured is `null` and renders `not measured` — never `$0.00`, never a zero.
- Never report a fixture-sourced number; never aggregate a run whose `origin` is `manual` or
  `status` is `failed`.
- The measured atom is the UTTERANCE, not the Run.
- 24 kHz PCM16 mono everywhere; `SAMPLE_RATE` in `src/core/protocol.ts` is the single source of truth.
- Live persists no audio and creates no Run records.
- Replay autoplays nothing; Live autoplays always.
