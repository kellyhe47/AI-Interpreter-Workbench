---
id: 063
title: Every stored utterance has id undefined — WER and by-category keying cannot work
status: closed-invalid
source: verification
depends_on: []
touches: [src/client/replay/runner.ts, src/client/state/hydrateLedger.ts, src/core/wer.ts]
iterations: 0
test_files: []
branch: ""
---

## Observed — RE-VERIFIED 2026-08-08: THE PREMISE IS FALSE. RECOMMEND CLOSING AS INVALID.

The original report said all 4 utterances on run `7acb0cc9` and all 4 on `dbeb6d94` carry
**`id: undefined`**. That is literally true and completely misleading: **`id` is not a field on
`RunUtterance` and never was.** The identity field is **`utteranceId`**
(`src/server/storage/types.ts:87-98`). The original observation read the wrong key off the stored
JSON.

What the store actually holds (`data/ledger.jsonl` — note: there is no `data/runs.jsonl`; the
ledger is one JSONL file plus per-run blobs under `data/runs/`):

| run | utterances | `utteranceId` present | values |
| --- | --- | --- | --- |
| `2ba6332b` | 0 | n/a | run is `status: failed`, `origin: manual` |
| `7acb0cc9` | 4 | 4 of 4 | `95a1ee2e…`, `066ae905…`, `08279447…`, `d07088c1…` |
| `dbeb6d94` | 4 | 4 of 4 | the same four ids (same Recording, same manifest) |

Every one is a distinct UUID. They repeat **across** runs by design — the manifest entry id is
stable, and the WER key is the pair `(runId, utteranceId)`, so repetition across runs is what makes
a re-run comparable rather than a collision.

The claimed downstream failures do not exist either:

- `werScoreKey` (`src/core/wer.ts:147-151`) keys on `(runId, utteranceId)` with a `\u001f`
  separator; `hydrateLedger.ts:150-151` composes it with `scoredAt`. Both receive real ids.
- `werAtoms` (`src/client/components/results/derive.ts:1002-1016`) **already refuses an
  unidentified utterance**: `if (utteranceId === undefined) continue;` at `:1009-1010`.
- `src/client/replay/runner.ts:790` writes `utteranceId: entry.id` from the corpus manifest entry —
  the write path has always been correct.
- No production code anywhere reads `.id` off a `RunUtterance`. The only `utterance.id` in
  non-test source is `src/core/corpus.ts:140`, which is a *manifest* entry, a different type.

Also note both stored complete runs are `origin: 'manual'`, so `isAggregatableRun`
(`src/client/state/ledger.ts:572-577`) excludes them from every aggregate regardless.

## Acceptance criteria

> All five original criteria were removed: the repo already satisfies each one, verified at the
> line numbers cited above. Nothing is left to implement.

> already satisfied: "Every stored utterance carries a stable, unique id" — `utteranceId` is
> present and a distinct UUID on all 8 stored utterances (`data/ledger.jsonl`), written from the
> manifest at `src/client/replay/runner.ts:790`.

> already satisfied: "`werScoreKey` round-trips" — `src/core/wer.ts:147-151` plus
> `src/core/wer.test.ts:306-308`, which already asserts the three-way discrimination.

> already satisfied: "`deriveWerByCategory` groups by real utterance identity" — it groups by
> `(category, arm)` **on purpose** (`derive.ts:1045-1066`). Two utterances of the same category in
> one run are *meant* to land in one tally; that is what an aggregate is. The original criterion
> asked for behaviour that would break the feature.

> already satisfied: "The 8 existing utterances are backfilled or quarantined" — there is nothing
> to backfill. No id was ever inferred by index.

> already satisfied: "A run with any unidentified utterance cannot enter the WER path" —
> `derive.ts:1009-1010` skips exactly that case.

## Out of scope

- Renaming `utteranceId` to `id`. The field name is load-bearing across `types.ts`, `ledger.ts`,
  `wer.ts`, `derive.ts` and the on-disk JSONL. There is no defect to justify a rename.
- The `sampleUtteranceId` fallback chain (`derive.ts:551-554`). It falls back to `recordingId` for a
  record-less Run, but it feeds **only** the provenance utterance count (`derive.ts:673`), never the
  WER path. Documented and deliberate.
- Ticket 062 (in flight) and the clock-inversion finding on `7acb0cc9` — different defect, same run.

## Notes
- The measured atom is the utterance (PRD §8). It has an identity, and it is `utteranceId`.

## CONTEXT FOR A FRESH AGENT

### 1–2. Verified citations, with the code

`src/server/storage/types.ts:87-98` — the record type. **There is no `id`.**
```ts
export interface RunUtterance {
  utteranceId: string;
  /** 1-based, manifest order. Maps to transport `utt` as `index - 1`. */
  index: number;
  category: CorpusCategory;
  timings: Record<string, number | null>;
  transcripts: { source?: string; target?: string };
  /** TICKET 052 — `null` is UNMEASURED, and it is NOT the same fact as `0`. */
  cost: number | null;
  status: 'complete' | 'failed';
  errors: string[];
}
```

`src/core/wer.ts:146-151` — the key.
```ts
/** The stable string key of a score. (runId, utteranceId), nothing else. */
export function werScoreKey(runId: string, utteranceId: string): string {
  // The separator is a unit separator rather than a printable character, so no
  // id containing the delimiter can forge another pair's key.
  return `${runId}\u001f${utteranceId}`;
}
```

`src/client/components/results/derive.ts:1002-1016` — the WER atom gate.
```ts
function werAtoms(
  ledger: RunLedger,
): Array<{ sample: RunSample; utteranceId: string; score: WerScore | undefined }> {
  const atoms: Array<{ sample: RunSample; utteranceId: string; score: WerScore | undefined }> = [];
  for (const run of ledger.getRuns() as AnnotatedRun[]) {
    for (const sample of runSamples(run)) {
      if (!isAggregatableUtterance(run, sample.utterance)) continue;
      const utteranceId = sample.utteranceId;
      if (utteranceId === undefined) continue;
      atoms.push({ sample, utteranceId, score: ledger.getWerScore(run.id, utteranceId) });
    }
  }
  return atoms;
}
```

`src/client/replay/runner.ts:789-791` — the write path.
```ts
    return {
      utteranceId: entry.id,
      index: entry.index,
```

Other verified anchors: `src/client/state/ledger.ts:597-611` (`RunSample`, `utteranceId?: string`),
`:657` (`runSamples` copies `utterance.utteranceId`), `:679` (`isAggregatableUtterance`),
`src/client/state/hydrateLedger.ts:150-151` (`scoreKey`).

### 3. Existing test files — where any assertion must land

STANDING POLICY: no new test file in a module that already has one.

- `src/core/wer.ts` → **`src/core/wer.test.ts`** (already has the key round-trip at `:306-308`).
- `src/client/replay/runner.ts` → **`src/client/replay/runner.test.ts`**.
- `src/client/state/hydrateLedger.ts` → **`src/client/state/hydrateLedger.test.ts`**.
- `src/client/components/results/derive.ts` WER paths →
  **`src/client/components/results/derive.wer.test.ts`**; utterance-atom paths →
  **`src/client/components/results/derive.utterances.test.ts`**.
- `src/client/state/ledger.ts` WER paths → **`src/client/state/ledger.wer.test.ts`**.

If this ticket is worked at all, **`src/core/wer.test.ts`** is the file. Do not create
`utteranceId.test.ts` or similar.

### 4. Seams

Nothing here needs a browser seam — `wer.ts`, `derive.ts` and `hydrateLedger.ts` are pure. Fixtures
come from `src/client/components/results/testRecords.ts` (`makeRunEntity`, `resetEntitySeq`) and
`src/client/state/hydrationFixtures.ts`. `src/client/replay/runner.ts` takes its transport and clock
by injection; jsdom has no AudioContext/MediaStream/RTCPeerConnection, so never construct one.

### 5. Golden evals

**No golden eval applies to this ticket, and none should be forced.** The nearest is
`eval/golden/02-clock-inversion-is-per-utterance-and-progressive.json`, which is about run
`7acb0cc9` — but it is about *timings*, and it corroborates this ticket's correction by asserting
that all four of that run's utterances processed individually with their own transcripts, which is
only possible because they are individually identified.
`eval/golden/11-a-run-records-its-own-direction.json` is about missing `languagePair`/`direction`
on the same runs — a real missing-field defect, and the one this ticket was probably confused with.

### 6. Known traps for this ticket

- **The whole trap already fired once here: reading a field that does not exist and calling the
  `undefined` a bug.** Before asserting a field is missing, read the interface in
  `src/server/storage/types.ts` first.
- A "fix" that adds an `id` alias would satisfy a test seam while **production has zero callers** —
  nothing reads `.id`. That is the dead-seam trap in its purest form.
- Do not "de-duplicate" utteranceIds across runs. They are *supposed* to repeat; the run id
  disambiguates. A uniqueness guard here would delete the ability to compare two runs of one clip.
- A guard on `utteranceId` bypassed by `sample.utterance!.utteranceId` or
  `(sample as any)['utteranceId']` re-opens exactly the hole `derive.ts:1009-1010` closes.

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
