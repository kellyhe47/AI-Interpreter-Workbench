---
id: 061
title: Runs record no languagePair or direction, and Recordings record no lang — a controlled variable that is not recorded is not controlled
status: pending
source: spec-audit + qa
depends_on: []
touches: [src/client/replay/runner.ts, src/client/views/ReplayView.tsx, src/client/state/ledger.ts, src/server/storage/types.ts, src/client/components/results/derive.ts, src/client/views/ResultsView.tsx]
iterations: 0
test_files: []
branch: ""
---

## Observed — re-verified against the repo (one claim CORRECTED)

**Every stored Run:** no `languagePair`, no `direction`. Stronger than the original wording: the
fields are **not on the `Run` type at all** (`src/client/state/ledger.ts:260-287`;
`src/server/storage/types.ts:100-131`), so nothing could ever have written them. Confirmed against
all 3 records in `data/runs/` and `data/ledger.jsonl`.

**CORRECTION — the Recording claim was wrong.** Recordings **do** record their language. The field
is `sourceLanguage` (not `lang`), it is typed non-optional (`src/client/state/ledger.ts:189`,
`src/server/storage/types.ts:36,57`), it is validated at the route boundary
(`src/server/routes/recordings.ts:73-74`), and all 3 stored takes carry `"sourceLanguage": "en"`.
The record flow does not lose it. That half of this ticket is already done.

**What the Recording does NOT record:** the TARGET language / direction — and the stored Runs prove
the cost. Run `7acb0cc9…` translated the same EN recording into **Spanish**; run `dbeb6d94…`
translated it into **German**. Both are `sourceLanguage: "en"`, both are indistinguishable in the
ledger, and neither says which direction it ran.

PRD §8's utterance record specifies both fields, and the controlled-variable register pins
*"Language pair + direction — fixed per sweep."*

## Why it matters more with Cantonese kept

EN→YUE and YUE→EN are **separate claims** (PRD §7). A run that does not record its own direction:
- cannot be grouped correctly by the by-category results view
- cannot be reproduced from the ledger
- cannot tell the two Cantonese directions apart — and the *asymmetry between them* is the finding
  (Realtime reaches EN→YUE only as Mandarin, and YUE→EN not at all)

A controlled variable that is not recorded is not controlled; it is only intended.

## Acceptance criteria

- [ ] `Run` carries `languagePair` and `direction` on **both** mirrored types — client
      `src/client/state/ledger.ts` and server `src/server/storage/types.ts` — declared optional so
      the 3 pre-existing Runs still parse
- [ ] Replay supplies a direction: `ReplayView`'s `runOnce` call
      (`src/client/views/ReplayView.tsx:522-529`) passes `languagePair` and `direction` into
      `RunOnceConfig`, from an operator-visible control, not a hardcoded default
      *(split out — without this the runner has nothing to write and the fix is inert)*
- [ ] `runOnce` writes both onto the Run it builds (`src/client/replay/runner.ts:1161-1185`) **and**
      onto the abandoned-run stub (`:560-578`), from the same `config` it hands the transport at
      `:938-943` — one source, never two
      *(split out — the stub is a second construction site and is trivially missed)*
- [ ] The by-category grouping key includes direction: `derive.ts:894` currently keys
      `` `${category}|${sample.arm}` ``; EN→YUE and YUE→EN samples must land in different rows and a
      test must show two rows where one appeared before
- [ ] A Run missing either field cannot enter an aggregate — the check goes **inside
      `isAggregatableRun` (`src/client/state/ledger.ts:572-577`) and nowhere else**. Adding a second
      gate anywhere is a rejection of this ticket.
      *(rewritten: "cannot enter an aggregate" named no location, and the obvious implementations
      violate the project's one-gate rule)*
- [ ] The 3 stored Runs are left exactly as they are — no backfill, no inferred direction — and a
      test asserts a fieldless Run is still readable and still excluded
      *(rewritten from "backfill or explicitly quarantine": that was two mutually exclusive options
      with no decision. Decision: quarantine. Backfilling would require guessing.)*

> already satisfied: *"Every Recording records `lang`; the record flow already collects it, so trace
> where it is lost"* — it is not lost. `RecordTake.tsx:355` holds the selection, `:491` writes
> `sourceLanguage: language` into `NewRecordingInput`, `recordingsClient.ts:60` types it,
> `routes/recordings.ts:73-74,91` validates and forwards it, `storage/index.ts:321` persists it,
> `RecordingsLibrary.tsx:443` renders it, and all 3 files in `data/recordings/` carry
> `"sourceLanguage": "en"`. Nothing to fix.

> already satisfied: *"quarantine the 3 existing Runs"* — all 3 carry `origin: "manual"`, and
> `isAggregatableRun` rejects any run whose origin is not `'sweep'` (`ledger.ts:574`). They already
> reach no aggregate. Keep the assertion above; add no mechanism.

## Out of scope

- Anything on the Recording side. `sourceLanguage` works end to end (see above).
- A target-language field on `Recording`. The direction belongs to the RUN — one recording can be
  run into several targets, which is exactly what the stored ES and DE runs demonstrate.
- Backfilling, migrating, or rewriting `data/runs/*.json`, `data/ledger.jsonl`, or
  `data/recordings/*.json`. Read-only.
- Live sessions and `LiveSession`. Live creates no Run records.
- The Cantonese work itself; this ticket only makes direction recordable and groupable.

## Golden eval
`eval/golden/11-a-run-records-its-own-direction.json`

## CONTEXT FOR A FRESH AGENT

### 1-2. Verified citations, with the code

**The fields exist on the *transport* config and die there.** `src/client/replay/runner.ts:367-378`:

```ts
export interface RunOnceConfig extends RunConfig {
  /** Forwarded to the transport config. */
  languagePair?: string;
  direction?: string;
  targetLanguage?: string;
  /**
   * IGNORED. Accepted only so a caller passing a whole run-shaped object does
   * not have to strip it; the produced Run always carries deriveArmTag(config).
   */
  armTag?: ArmTag;
}
```

`src/client/replay/runner.ts:938-943` — the only consumer, and it is the wire, not the ledger:

```ts
  const transportConfig: TransportConfig = {
    languagePair: config.languagePair ?? '',
    direction: config.direction ?? '',
    targetLanguage: config.targetLanguage ?? '',
    providers: config.providers,
  };
```

**Construction site 1 — the real Run.** `src/client/replay/runner.ts:1161-1185`. Note what IS
recorded and what is not:

```ts
  const run: Run = {
    id,
    recordingId: recording.id,
    architecture: config.architecture,
    providerTriple: config.providers,
    modelSnapshots: modelSnapshotsFor(config),
    // DERIVED, never declared — a caller-supplied config.armTag is ignored.
    armTag: deriveArmTag(config),
    // Only the batch runner (ticket 009) produces 'sweep'.
    origin: 'manual',
    status: cancelled || failed || mismatched ? 'failed' : 'complete',
    timings,
    transcripts: { … },
```

**Construction site 2 — the abandoned-run stub.** `src/client/replay/runner.ts:560-578`; same
omission, easy to miss.

**The leaf.** `src/client/views/ReplayView.tsx:522-529` — the UI never supplies a direction at all:

```ts
      .runOnce({
        recordingId: selectedRecordingId,
        config: {
          architecture: config.architecture,
          realtimeModel: config.realtimeModel,
          providers: config.providers,
        },
      })
```

`ARMS` (`src/core/arms.ts:110-134`) carry `architecture` / `realtimeModel` / `providers` only — no
language. So there is no existing source for the value; one has to be added.

**The one gate.** `src/client/state/ledger.ts:572-577`:

```ts
export function isAggregatableRun(run: Run): boolean {
  if (runArmTag(run) === 'ad-hoc') return false;
  if (run.origin !== 'sweep') return false;
  if (run.status !== 'complete') return false;
  return isRealRun(run);
}
```

**The grouping key.** `src/client/components/results/derive.ts:894` inside `groupByCategory`
(`:883`): `` const key = `${category}|${sample.arm}`; ``. Row identity in the DOM is
`key={`${row.category}|${row.arm}`}` at `src/client/views/ResultsView.tsx:753`, rendered with
`data-category` at `:756`.

**The Recording side, verified working (do not touch):**
`src/client/components/replay/RecordTake.tsx:355` (`const [language, setLanguage] = useState(...)`),
`:489-497` (`baseInput`, with `sourceLanguage: language` at `:491`), `:642-644`
(`data-take-language` select) → `src/client/replay/recordingsClient.ts:60` →
`src/server/routes/recordings.ts:43,62,73-74,91` → `src/server/storage/index.ts:321` →
`src/server/storage/types.ts:36,57` / `src/client/state/ledger.ts:189` →
`src/client/components/replay/RecordingsLibrary.tsx:443`.

**The stored data (read-only confirmation):** `data/runs/` holds 3 files, all
`origin: "manual"`, none with `languagePair` or `direction`; `data/recordings/` holds 3 JSON files,
all `"sourceLanguage": "en"`, `"origin": "corpus"`, `"corpusVersion": "corpus-v1"`, 4 utterances
each. `data/ledger.jsonl` mirrors them.

### 3. Where the tests must land

STANDING POLICY — no new test file may be added to a module that already has one:

| Change | File the tests MUST land in |
|---|---|
| Runner writes `languagePair` / `direction` (both sites) | `src/client/replay/runner.test.ts` |
| `isAggregatableRun` rejects a fieldless Run | `src/client/state/ledger.test.ts` (the ledger's existing gate suite) |
| `groupByCategory` splits on direction | `src/client/components/results/derive.test.ts` |
| Category rows in the DOM | `src/client/views/ResultsView.category.test.tsx` |
| Replay UI supplies the direction | `src/client/views/ReplayView.record.test.tsx` |

Do NOT create `runner.direction.test.ts`, `derive.direction.test.ts`, or similar.
`src/server/routes/recordings.test.ts` and `src/server/storage/recordings.test.ts` exist and cover
the Recording path — that path needs **no change**, so they should need no edits; if you find
yourself editing them, you have gone out of scope.

### 4. Seams

- `src/client/replay/runner.ts` — `RunnerDeps` (`:379-390`): `recordings`, `runs`, `createTransport`,
  `now`, `newId`, `pacerDeps`. Everything is injected; `runner.test.ts` builds a fake transport, so
  no `RTCPeerConnection` / `AudioContext` is needed (jsdom has none).
- `src/client/views/ReplayView.tsx` — `ReplayDeps.runOnce` (`:181`) is the seam the record/run tests
  stub; `ReplayRunRequest` is `:148-152`.
- `src/client/components/results/testRecords.ts` — `makeRunEntity` for Run fixtures with and
  without the new fields.
- `src/server/storage/test-support.ts:71` and `src/server/routes/test-support.ts:87,112` already
  default `sourceLanguage: 'en'` — the server-side seam, not needed for this ticket.
- `src/client/browserDeps.ts` (`BrowserDeps extends SessionDeps` ~`:94`),
  `src/client/fixtureDeps.ts` (`buildFixtureDeps` / `isFixtureMode`; note it already declares
  `languagePair: 'EN↔ES'` and `direction: 'en→es'` at `:201-202` — that is the LIVE session config,
  a shape to copy, not a Run).
- `src/client/state/hydrationFixtures.ts:74` — Results hydration fixture, also `sourceLanguage: 'en'`.

### 5. Golden evals

- **`eval/golden/11-a-run-records-its-own-direction.json`** — primary. `surface: "pure"`,
  `result_type: "run_record"`, `must_include: ["languagePair","direction"]`,
  `must_not_contain: [null, "undefined"]`, `counts: { "runs_missing_direction": 0 }`.
- **`eval/golden/05-armtag-is-derived-never-declared.json`** — RELEVANT as a constraint, not a
  target. It pins that a declared `armTag` is ignored (`runner.ts:1168`). `direction` is the
  opposite kind of field: it is genuinely DECLARED by configuration and has nothing to derive it
  from. Do not "derive" a direction from transcripts — that is the guess this ticket forbids.
- **`eval/golden/06-fixture-and-placeholder-never-aggregate.json`** — RELEVANT: `samples_admitted:
  1` of 3. Adding a direction requirement to `isAggregatableRun` must not perturb this count for
  the records it covers; run it after the gate change.

### 6. Traps — this ticket specifically

- **A fix that satisfies the test seam while production has zero callers.** The dominant risk here.
  `RunOnceConfig` already declares `languagePair` and `direction` — a test that passes them into
  `runOnce` and asserts they land on the Run will go green while `ReplayView.tsx:522-529` still
  sends neither, and every real Run stays fieldless. Pin the VIEW, in
  `ReplayView.record.test.tsx`, asserting the object handed to the stubbed `runOnce`.
- **A second gate.** Rejecting fieldless runs in `groupByCategory`, `groupByRecording`,
  `runSamples`, or `exportResults` instead of in `isAggregatableRun` splits the rule across five
  files. `isAggregatableUtterance` applies the gate THROUGH the parent Run (`ledger.ts:679`) and
  needs no change of its own.
- **A guard bypassed by a cast or `!`.** `direction?: string` invites `config.direction!` at the
  construction site, and `?? ''` (already present at `runner.ts:939-940`) turns "not recorded" into
  the empty string — which is a VALUE, not an absence, and would sail through any
  `!== undefined` check. Absent must stay absent.
- **An arithmetic guard that omits the dominant term.** Splitting the category key on direction but
  leaving the DOM row `key` (`ResultsView.tsx:753`) as `category|arm` collapses two React rows into
  one, and the pooling the ticket exists to prevent survives in the rendered output.
- **Wiring delivered incidentally by an unrelated re-render.** A `ReplayView` assertion that reads
  the direction out of a control's DOM rather than out of the recorded `runOnce` argument can pass
  purely because a re-render re-read component state — while the value never crosses the seam.

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
