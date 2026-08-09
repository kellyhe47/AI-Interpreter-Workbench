---
id: 064
title: "REALTIME · TRIMMED renders empty while its samples are silently pooled into the DEFAULT column"
status: done
source: verification (corrects the spec audit's P1-6)
depends_on: []
touches: [src/client/views/ResultsView.tsx, src/client/components/results/derive.ts]
iterations: 1
test_files: []
branch: main
---

## Observed — and the mechanism is worse than reported

The spec audit reported the `REALTIME · TRIMMED` column rendering entirely `—` despite 2 trimmed
sessions on disk, and attributed it to stale data. **Both halves are wrong.**

The real mechanism (re-verified 2026-08-08):
- `ResultsView.tsx:510-518` hardcodes three columns and gives `realtime-trimmed` **`arm: null`**
  (`:516`); `columnFor` (`:556-557`) returns `undefined` for a null arm, so every row renders ABSENT
  **unconditionally**. It is not a data problem at all.
- `deriveLiveModel` (`derive.ts:1195-1210`) groups **only by `liveArmTag(session)`** and never reads
  `contextPolicy` — the string `contextPolicy` does not appear in `derive.ts` at all — so no trimmed
  column can exist in the model.

**The consequence the audit missed:** the two trimmed sessions on disk are `architecture: realtime`
with `modelSnapshots.realtime = 'gpt-realtime'`, so `liveArmTag` derives **arm `A`**; their
utterances carry `server_speech_stopped` + `audio_queued`, so `anchoredLatencyMs` returns a number
for every one of them. They are therefore **silently pooled into the `realtime · default` column.**
That column is really *"realtime, all policies"*.

So this is not a missing number. **It is a wrong number**: the default column's p50 mixes two context
policies, and the context-policy comparison — the whole of §7's controllability evidence, and the
reason PRD §17 21e files context policy under controllability — is contaminated rather than empty.

## Acceptance criteria

- [ ] `deriveLiveModel` groups by the pair `(armTag, contextPolicy)`, not by armTag alone —
      assert two sessions identical except for `contextPolicy` produce **two** columns
- [ ] `LiveCard`'s `realtime-trimmed` column is bound to a real column of the model rather than to
      `arm: null`, and renders that column's `p50Ms` / `p95Ms` / `utterancesCompleted` /
      `disconnects` from `deriveLiveModel`, not `—`
- [ ] **`realtime · default`'s p50 is computed from default-policy samples ONLY** — seed one
      default session and one trimmed session whose pooled p50 differs from the default-only p50 by
      construction, and assert the rendered figure equals the default-only value
- [ ] A session whose `contextPolicy` is `undefined` (pre-012 sessions; the field is optional at
      `ledger.ts:325`) opens **no** column and is counted in neither, and the card discloses the
      exclusion rather than defaulting it into `default`
- [ ] A `cascade` session carries `contextPolicy: 'n/a'` and must land in the `cascade` column, not
      in a fourth `cascade · n/a` column — the pair grouping must not fragment arm B
- [ ] The cost-slope rows (`cost-minute-1`, `cost-final-minute`) read from the same per-pair column
      as the latency rows — assert they change when the pair grouping splits, not just the p50

> already satisfied: "The `realtime · trimmed` column renders its own samples" as a bare statement —
> the *header* already exists and is locked by `ResultsView.test.tsx:480-489`. Split into the two
> falsifiable criteria above (model grouping, then cell binding), because the header rendering and
> the cell content are different facts and only one of them is broken.

## Out of scope

- Adding a context-policy control or column to the **Replay** side. Replay's context is pinned to
  zero turns (`RunConfigPanel.tsx` `CONTEXT_VALUE = 'zero turns · locked'`); the policy knob is
  Live-only.
- Backfilling `contextPolicy` onto the pre-012 sessions in `data/live-sessions.jsonl`. Five of the
  eight read `n/a` (all cascade) and are correct as stored.
- Renaming the stored field. `contextPolicy` is the real name on `LiveSession`
  (`ledger.ts:325`, `types.ts:202`); the separate `n` field seen in `sessionMachine.ts` /
  `useSessionController.ts` is the in-flight UI state that is *mapped into* `contextPolicy` at save.
- The Live anchor itself (ticket 051 R2) — do not re-derive `anchoredLatencyMs`.

## Notes
- Cutting the 5-rep sweep does not touch this: context policy is a Live-only measurement and the
  slope is the finding for Arm A.

## CONTEXT FOR A FRESH AGENT

### 1–2. Verified citations, with the code

`src/client/views/ResultsView.tsx:505-518` — the hardcoded columns. `realtime-trimmed` is `:516`.
```ts
/**
 * The three columns of the conversation-length card. 'realtime · trimmed' has
 * no arm behind it: a trimmed-context policy is not something a LiveSession
 * declares yet, so the column renders absent rather than borrowing the default
 * realtime figures.
 */
const LIVE_COLUMNS: ReadonlyArray<{
  key: string;
  label: string;
  arm: ArmTag | null;
}> = [
  { key: 'realtime-default', label: 'realtime · default', arm: 'A' },
  { key: 'realtime-trimmed', label: 'realtime · trimmed', arm: null },
  { key: 'cascade', label: 'cascade', arm: 'B' },
];
```
(The doc comment's claim that "a trimmed-context policy is not something a LiveSession declares yet"
is **stale** — `LiveSession.contextPolicy` has existed since ticket 012.)

`src/client/views/ResultsView.tsx:554-557` — the binding that guarantees `—`.
```ts
function LiveCard(props: { model: LiveModel }): ReactElement {
  const { model } = props;
  const columnFor = (arm: ArmTag | null): LiveArmColumn | undefined =>
    arm === null ? undefined : model.columns.find((column) => column.arm === arm);
```
Cells render at `:592-599` via `row.value(columnFor(column.arm))`; every `LIVE_ROWS` entry
(`:520-552`) maps `undefined` to `ABSENT` or `formatMs(null)`.

`src/client/components/results/derive.ts:1195-1210` — grouping by arm only.
```ts
export function deriveLiveModel(ledger: RunLedger): LiveModel {
  const order: ArmTag[] = [];
  const groups = new Map<ArmTag, LiveSession[]>();

  for (const session of ledger.getLiveSessions()) {
    if (!isMeasuredLiveSession(ledger, session)) continue;
    const arm = liveArmTag(session);
    let group = groups.get(arm);
    if (!group) {
      group = [];
      groups.set(arm, group);
      order.push(arm);
    }
    group.push(session);
  }
```
The samples that get pooled, `derive.ts:1223-1226`:
```ts
    const samples = sessions
      .flatMap((s) => s.utterances)
      .map((u) => anchoredLatencyMs(u.timings))
      .filter((ms): ms is number => ms !== null);
```

`src/client/state/ledger.ts:309` — `export type LiveContextPolicy = 'default' | 'trimmed' | 'n/a';`
`src/client/state/ledger.ts:325` — `contextPolicy?: LiveContextPolicy;` (optional, pre-012 parse).
Mirrored at `src/server/storage/types.ts:179` and `:202`.
`src/client/components/results/derive.ts:522-528` — `liveArmTag`, derived from architecture +
`modelSnapshots.realtime` + `providerTriple`, never from a declared field.
`src/client/state/ledger.ts:562-565` — `isAggregatableLiveSession` (real + `utterances.length > 0`);
`derive.ts:1170-1173` — `isMeasuredLiveSession` adds the record-realness clause.

**On-disk evidence** (`data/live-sessions.jsonl`, 8 sessions, READ ONLY):
`contextPolicy` is `default` ×1 (7 utterances), `trimmed` ×2 (7 + 1 = **8 utterances**), `n/a` ×5
(all cascade). Both trimmed sessions are `architecture: realtime`,
`modelSnapshots: {realtime: 'gpt-realtime'}`, no `providerTriple` → arm `A`, and every utterance has
both `server_speech_stopped` and `audio_queued`.

### 3. Existing test files — where this ticket's tests must land

STANDING POLICY: no new test file in a module that already has one.

- `deriveLiveModel` changes go in **`src/client/components/results/deriveLive.anchor.test.ts`** —
  it is the existing deriveLive column-shape/statistic file. (`deriveLive.empty.test.ts` owns the
  empty-state rule and `deriveLive.fixture.test.ts` the realness rule; do not overload those, and do
  **not** create `deriveLive.contextPolicy.test.ts`.)
- `ResultsView` LiveCard DOM changes go in **`src/client/views/ResultsView.liveAnchor.test.tsx`**
  (explicitly "ADDITIVE to the locked ResultsView.test.tsx").
- **`src/client/views/ResultsView.test.tsx` is a locked contract you will have to update**, not
  work around: `:480-489` asserts the exact three `data-live-column` header keys, and `:491+` asserts
  `liveCell('p50','realtime-default') === formatMs(armA.p50Ms)` — that assertion *is* the pooling
  bug, expressed as a test, and it must be re-pointed at the default-only column.

### 4. Seams

Pure derivation plus a jsdom render — no browser seam needed. jsdom has no
AudioContext/MediaStream/RTCPeerConnection, so never construct one.

- **`src/client/components/results/testRecords.ts` → `makeLiveSessionEntity(overrides)`** (`:118-137`)
  is the fixture factory. It does **not** currently set `contextPolicy`, so pass it via `overrides`;
  it defaults to `architecture: 'cascade'` + `ARM_B_TRIPLE`, so an arm-A fixture must override
  `architecture: 'realtime'`, `providerTriple: undefined`,
  `modelSnapshots: { realtime: REALTIME_MODEL }` (see the existing pattern at `testRecords.ts:815-825`).
- `src/client/state/ledger.ts` → `new RunLedger()` + `appendLiveSession`.
- `src/client/state/hydrationFixtures.ts` for App-level hydration if needed.
- Not relevant here: `src/client/browserDeps.ts`, `src/client/fixtureDeps.ts`,
  `src/client/views/sessionTestKit.ts`, `src/client/batch/runner.ts`.

### 5. Golden evals

- **`eval/golden/09-live-intervals-are-anchored-and-commensurable.json`** — PRIMARY. It pins that
  Live's two arms must not "measure DIFFERENT quantities under one label". Pooling `default` and
  `trimmed` under `realtime · default` is the same failure one axis over, and the fix must not
  disturb the `firstAudio = tts_first_byte ?? audio_queued` anchor it locks.
- **`eval/golden/06-fixture-and-placeholder-never-aggregate.json`** — the realness gate that
  `isMeasuredLiveSession` implements must survive the regrouping; a new group key must not become a
  second way into the model.
- No other eval applies. `01-server-ledger-is-the-only-aggregate-source.json` concerns the
  LiveSession *write* path, not this grouping.

### 6. Known traps for this ticket

- **Comparing a render against itself.** `ResultsView.test.tsx` reads cells with
  `document.querySelector('[data-card="live"] [data-metric=…] [data-live-column=…]')` and compares
  them to `deriveLiveModel(ledger)` computed in the test. If both sides change together the test
  stays green while pooling persists. Pin at least one expected p50 to a **literal number** derived
  by hand from the fixture latencies, the way `deriveLive.anchor.test.ts` does (its header shows the
  pooled-vs-mean numbers written out longhand). Also: RTL **appends** to `document.body` and these
  accessors are global `document.querySelector` — call `cleanup()` between renders or the first
  render's cells answer the second render's query.
- **A fix with zero production callers.** Adding a `contextPolicy` field to `LiveArmColumn` without
  changing `LIVE_COLUMNS`/`columnFor` leaves the DOM identical. The seam test would pass; the screen
  would not change. Assert on the rendered cell, not only on the model.
- **The `arm: null` bypass.** `columnFor` is typed `(arm: ArmTag | null)`. Do not "fix" it with
  `model.columns.find(c => c.arm === (column.arm as ArmTag))` or a `!` — that reintroduces the
  pooling via a cast. The column identity must become a pair, not a coerced arm.
- **The dominant term is the *default* column, not the trimmed one.** It is tempting to declare
  victory when `realtime · trimmed` stops showing `—`. The defect is the contaminated
  `realtime · default` p50; a test that only checks the trimmed column fills is vacuous.
- **`n/a` must not fragment cascade.** Grouping naively on `(armTag, contextPolicy ?? 'default')`
  both invents a policy for pre-012 sessions and is fine for cascade only by accident. Handle
  `undefined` as an exclusion and `'n/a'` as "this arm has no policy axis".
- Arm membership stays derived: do not add a declared `column` field to `LiveSession`.

### Standing project rules

- `isAggregatableRun` is the ONE place that decides aggregation — never add a second gate.
- Arm membership is DERIVED from configuration, never declared.
- Unmeasured is `null` and renders `not measured` — never `$0.00`, never a zero.
- Never report a fixture-sourced number; never aggregate a run whose `origin` is `manual` or
  `status` is `failed`.
- The measured atom is the UTTERANCE, not the Run.
- 24 kHz PCM16 mono everywhere; `SAMPLE_RATE` in `src/core/protocol.ts` is the single source of truth.
- Live persists no audio and creates no Run records.
- Replay autoplays nothing; Live autoplays always.

## RESOLUTION (2026-08-09)

Suite 2208 passing / 0 failing. Eval unchanged at 9 pass / 4 fail (01, 02, 04 → 055; 10 → 060).

Both halves fixed — either alone would have left the screen unchanged:

- `deriveLiveModel` groups by the pair, key `contextPolicy === 'n/a' ? arm : ${arm}·${contextPolicy}`.
  `LiveArmColumn` carries `contextPolicy` as a first-class field; `LiveModel` gains
  `sessionsWithoutContextPolicy`.
- `LIVE_COLUMNS` entries bind `{arm, contextPolicy}` — `arm: null` is gone, so there is nothing left
  to coerce — and `columnFor` matches the pair.
- `undefined` policy → counted and excluded, checked **after** `isMeasuredLiveSession` so the realness
  gate stays the one gate and the new key never becomes a second way into the model.
- `'n/a'` → a positive statement that the arm has no policy axis; cascade stays one column.

### The number this actually changes

Recomputed independently from `data/live-sessions.jsonl` by the reviewer, replicating
`anchoredLatencyMs` and nearest rank:

| column | sessions | n | p50 | p95 |
|---|---|---|---|---|
| `realtime · default` | 1 | 7 | **260 ms** | 512 ms |
| `realtime · trimmed` | 2 | 8 | **423 ms** | 449 ms |
| pooled (the bug) | 3 | 15 | 399 ms | 512 ms |
| `cascade` | 5 | 16 | 1487 ms | 2858 ms |

**`realtime · default` moves 399 → 260 ms.** Two riders for the write-up: p95 is *unchanged* by the
fix (512 either way — the pooled p95 lands on the default session's own tail), and all 8 stored
sessions declare a policy, so the exclusion note is dormant on real data.

### Adversarial review — RED, four survivors, all closed

The headline defect is dead: every mutation reintroducing pooling, the `arm: null` blank, the cast
shortcut, the `?? 'default'` naive fix, and a partial "trimmed fills but default stays pooled" went
red on the DOMINANT assertions. Four survived, all in the disclosure/labelling periphery, all
dormant on today's data — but three of them let the card print something false:

1. **Nothing pinned a header LABEL to its column KEY.** Swapping the two `label` strings left the
   suite green while the card rendered `realtime · trimmed` above the default figures and vice versa
   — this ticket's own failure mode, a number under the wrong policy name. Every DOM accessor
   addresses cells by `data-live-column`, so nothing could see it.
2. **The exclusion COUNT was never asserted.** `count > 0 ? 99 : 0` stayed green — the card could
   print "99 sessions excluded", a fabricated number, in a ticket whose thesis is that a wrong
   number is worse than a missing one. Singular/plural now pinned too.
3. **The exclusion note on the `model.empty` branch** could be deleted with the suite green.
4. **The gate ORDERING was unverified** while two test files carried comments asserting it. The
   fixture auto-assigns `contextPolicy`, so the count was 0 under both orderings. A pre-012
   `?fixture=1` session would have been disclosed as an evidence hole when it is really refused for
   being fabricated.

19 assertions added, each watched fail under its mutation first. **No production change was needed
for any of the four** — the code was already correct; nothing bit.

Not a finding, deliberately left alone: dropping the `'n/a'` special case from the key is an
**equivalent mutant** — both forms are injective over `(arm, policy)`, so no ledger can distinguish
them and no test should be written.

### Residual hole — flagged, not fixed

`resultsAreEmpty` (`ResultsView.tsx:1100-1106`) blanks the whole view when the live model is empty
and every recording is fixture-only. So a user whose **only** Live evidence is pre-012 policy-less
sessions, with no Replay runs, sees the global "No runs recorded" state with **no disclosure at
all**. The count derives correctly; nothing renders it. Fixing it means changing `resultsAreEmpty`
or the global empty state — a production decision outside this ticket.
