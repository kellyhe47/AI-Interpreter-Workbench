---
id: 054
title: Delete the placeholder corpus — the real takes are recorded, and keeping both invites a tone burst into the write-up
status: done
source: spec-audit + operator
depends_on: []
touches: [corpus/, scripts/generate-placeholder-corpus.mjs, scripts/bench-fixture.mjs, scripts/soak-fixture.mjs, src/harness/corpus.ts, src/harness/corpus.test.ts]
iterations: 1
test_files: []
branch: main
---

## Why

`corpus/*.wav` (36 clips) are **synthetic tone bursts, not speech.** Verified from the generator's
own header (`scripts/generate-placeholder-corpus.mjs`):

> *Every clip is a tone burst + silence tail — NOT speech. The manifest is marked placeholder so no
> reported number can come from it.*

They were never an input. `RecordTake.tsx` already collects clip label, language, per-utterance
category and `referenceText`, blocks a corpus save until every utterance is categorised, and omits
`referenceText` for Cantonese by design. **The operator has now recorded the real takes through that
flow** — 3 EN Recordings, 12 utterances, every one categorised with reference text, `origin: 'corpus'`,
`corpusVersion: 'corpus-v1'`.

Keeping both sets is the risk: a placeholder number reaching the write-up is exactly what PRD §8's
realness rule exists to prevent, and the manifest's `placeholder: true` is the only thing standing
between a tone burst and a reported figure.

## Scope

Delete the placeholder corpus and the code that exists only to serve it.

## Acceptance criteria

- [ ] The 36 `corpus/*.wav` files and `corpus/manifest.json` are removed from the working tree
- [ ] `scripts/generate-placeholder-corpus.mjs` is removed
- [ ] **`corpus/SCRIPTS.md` and `corpus/LIVE-SCRIPT.md` still exist** — they are the real artifacts,
      and the recorded takes were read from them
- [ ] `src/harness/corpus.ts` (210 lines) is deleted — every export in it exists only to build or
      validate the placeholder manifest, and its only non-test importer is
      `scripts/bench-fixture.mjs`
- [ ] `src/harness/corpus.test.ts` (120 lines) is deleted with it. Do NOT "retarget" it: the real
      recorded-take manifest already has its own module and suite at `src/core/corpus.ts` /
      `src/core/corpus.test.ts`, and a second `validateManifest` would be a second gate.
- [ ] `src/harness/wav.ts` is NOT deleted — `generateClip` is still imported by
      `src/client/replay/segment.test.ts:14`, `src/harness/bench.test.ts:13` and
      `src/harness/wav.test.ts:3`, and `readWav`/`writeWav` are used by production
      (`src/client/replay/runner.ts`, `src/client/replay/capture.ts`, `src/client/browserDeps.ts`)
- [ ] `rg 'corpus/manifest|harness/corpus|generate-placeholder-corpus'` over the repo returns no
      live code reference. The two live ones today are `scripts/bench-fixture.mjs:11,29,36` and
      `scripts/soak-fixture.mjs:14,16` — both must be deleted or de-corpused in the same commit.
- [ ] The realness guards that key on the literal string `placeholder` are KEPT and still pass:
      `src/client/state/ledger.ts:506` (`isRealRun`), `src/client/state/ledger.ts:692`
      (`isRealRecord`), `src/harness/exportResults.ts:318`. Golden eval 06 feeds a record with
      `corpusId: "placeholder-v0"` and requires it be excluded; deleting the guard alongside the
      corpus fails that eval.
- [ ] `GET /api/recordings` still returns the 3 recorded Recordings (`rec_msjjjc0m001_f1314d52`,
      `rec_msl7nxdp001_7df33e53`, `rec_msl9e35g002_87dfb138`) after the deletion
- [ ] `npm test`, both `npm run typecheck` projects and `npm run build` stay green

## Out of scope

- **No corpus→Recordings import.** Proposed and cancelled: the record flow already produces exactly
  the shape the pipeline needs, and the 3 recorded Recordings prove the path.
- **Do not delete `src/harness/bench.ts` or `benchmark-results/`.** That is ticket 058, which also
  owns `scripts/smoke-*.mjs` and the `heapStart`/`heapEnd`/`driftMinute1ToEnd` scaffolding. If 058
  runs first, `scripts/bench-fixture.mjs` and `scripts/soak-fixture.mjs` may already be gone —
  check before editing them.
- **Do not touch `src/core/corpus.ts`, `src/core/corpus.test.ts`, `RecordTake.tsx`,
  `RecordingsLibrary.tsx` or anything in `data/`.** The recorded takes are the input; this ticket
  only removes the fake one.
- **Do not weaken or relocate the `placeholder`-prefix realness rule.**
- No new test file. See the fresh-agent section below.

## Notes

- Ship the deletion in ONE commit so the repo is never in a state where both a real and a
  placeholder corpus are present.

## CONTEXT FOR A FRESH AGENT

### 1. Verified facts and citations (checked against the working tree)

| Claim | Verified |
| --- | --- |
| 36 `corpus/*.wav` | true — `ls corpus/*.wav \| wc -l` = 36 (en/es/yue × 6 categories × 2) |
| `corpus/manifest.json` marked placeholder | true — `"corpusId": "placeholder-v0"`, `"placeholder": true` |
| `scripts/generate-placeholder-corpus.mjs` exists | true — 46 lines |
| `corpus/SCRIPTS.md`, `corpus/LIVE-SCRIPT.md` exist | true |
| `src/harness/corpus.ts` = 210 lines | true |
| `src/harness/corpus.test.ts` = 120 lines | true (the ticket previously said 339 — corrected) |
| 3 recorded Recordings, 12 utterances | true — `data/recordings/*.json`: 3 files, 4 utterances each, all `origin: "corpus"`, `corpusVersion: "corpus-v1"`, every utterance carries a `category` and a `referenceText` |
| Non-test importers of the manifest | `scripts/bench-fixture.mjs:11,29,36`, `scripts/soak-fixture.mjs:14,16` — and nothing under `src/` |
| Tests that load `corpus/manifest.json` from disk | NONE. `src/harness/bench.test.ts:52,83` only uses the string literal `'placeholder-v0'`. |

### 2. The code, inline

`src/harness/corpus.ts:192-210` — the whole reason the module exists:

```ts
export function validateManifest(m: CorpusManifest): void {
  const expected = CORPUS_LANGS.length * CORPUS_CATEGORIES.length * CLIPS_PER_CELL;
  if (m.clips.length !== expected) {
    throw new Error(`manifest must have ${expected} clips, got ${m.clips.length}`);
  }
  if (m.placeholder !== true) {
    throw new Error('manifest placeholder flag must be exactly true');
  }
  ...
}
```

`src/client/state/ledger.ts:500-508` — KEEP THIS:

```ts
export function isRealRun(run: Run): boolean {
  const triple = run.providerTriple;
  if (triple && (triple.stt === 'fixture' || triple.mt === 'fixture' || triple.tts === 'fixture')) {
    return false;
  }
  if (Object.values(run.modelSnapshots ?? {}).includes('fixture')) return false;
  if (run.recordingId.startsWith('placeholder')) return false;
  return true;
}
```

`src/client/state/ledger.ts:687-697` — and this:

```ts
export function isRealRecord(record: UtteranceRecord): boolean {
  const { stt, mt, tts } = record.providers;
  if (stt === 'fixture' || mt === 'fixture' || tts === 'fixture') return false;
  if (record.corpusId.startsWith('placeholder')) return false;
  if (record.arm === 'fixture') return false;
  return true;
}
```

`src/harness/exportResults.ts:308-318` — and this:

```ts
 * recording is one of the generated placeholder clips.
 ...
  return (run.recordingId ?? '').startsWith('placeholder');
```

`scripts/bench-fixture.mjs:29,36-37` — the only `src/` importer of the module being deleted:

```js
const { validateManifest } = await import('../src/harness/corpus.ts');
...
const manifest = JSON.parse(await readFile(path.join(corpusDir, 'manifest.json'), 'utf8'));
validateManifest(manifest);
```

### 3. Existing tests — where assertions must land

STANDING POLICY: no new test file may be added to a module that already has one.

- `src/harness/corpus.test.ts` — **delete outright** with its module. Nothing replaces it.
- The `placeholder`-guard assertions **already exist** and must stay green, in
  `src/client/state/ledger.test.ts` (lines 123, 128, 132-142, 170, 288, 604-605, 651-664) and
  `src/client/components/results/derive.wer.test.ts:329-330`. **If this ticket needs any new
  assertion, it goes in `src/client/state/ledger.test.ts` — do not create a new file.**
- `src/harness/bench.test.ts:52,83` uses the `'placeholder-v0'` string as a literal only; it does
  not need the corpus dir and must keep passing untouched.
- `src/client/replay/segment.test.ts:107-108` and `src/harness/wav.test.ts` keep `generateClip`
  alive — this is why `wav.ts` survives.

### 4. Seams / injectable dependencies

This ticket needs **none**. It is a file deletion plus a grep sweep; no jsdom-hostile browser object
is involved. Do not add a seam. (For reference only, the project's seams live in
`src/client/browserDeps.ts`, `src/client/fixtureDeps.ts`, `src/client/views/sessionTestKit.ts`,
`src/server/providers/test-support.ts`, `src/server/storage/test-support.ts`.)

### 5. Golden evals this ticket must satisfy

- `eval/golden/06-fixture-and-placeholder-never-aggregate.json` — **the binding one.** Its `why`
  quotes `scripts/generate-placeholder-corpus.mjs` and its `given` includes
  `{ "id": "r2", "corpusId": "placeholder-v0" }` which must stay in `must_exclude`. The generator
  file goes away; the RULE must not.
- `eval/golden/03-experiment-card-requires-real-sweep-samples.json` — must still render empty
  states over the 3 manual runs on disk after the deletion (i.e. deleting the corpus must not
  change what the Results cards render).

### 6. Known traps for THIS ticket

- **Deleting the guard with the data.** The obvious "clean up all the placeholder stuff" sweep rips
  out `startsWith('placeholder')` in `ledger.ts` and `exportResults.ts`. Golden eval 06 is the only
  thing that catches it, and it is a fixture eval, not a vitest file — the suite stays green.
- **The arithmetic guard that omits the dominant term.** `validateManifest` in `src/harness/` and
  `validateManifest` in `src/core/` are DIFFERENT FUNCTIONS with the same name. Deleting the wrong
  import, or "consolidating" them, breaks the recorded-take validation that the record flow depends
  on.
- **A dead import that lint does not catch.** There is no lint script in `package.json`. Removing a
  function while leaving its import line compiles under `tsc --noEmit` only if the module still
  exists — so delete importers and module together, then run BOTH typecheck projects
  (`tsc -p tsconfig.json` and `tsc -p tsconfig.server.json`); `scripts/*.mjs` is covered by neither,
  so those two scripts must be checked by eye.
- **`wav.ts` looks placeholder-only and is not.** `generateClip`'s doc comment says "SYNTHETIC
  placeholder clip", but three live test files import it and production imports `readWav`/`writeWav`
  from the same module.

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

## RESOLUTION (2026-08-09) — worked as one loop with ticket 058

Suite 2426 passing / 0 failing. `npm run check` exits 0. Golden eval 06 still green.

Deleted: 36 `corpus/*.wav` tone bursts, `corpus/manifest.json`,
`scripts/generate-placeholder-corpus.mjs`, `src/harness/corpus{,.test}.ts`.

**Survived, each pinned by an assertion in the same test as its deletion** (so a typo'd path fails
loudly rather than passing): `corpus/SCRIPTS.md`, `corpus/LIVE-SCRIPT.md`, `src/core/corpus.ts` (the
route imports `validateManifest` from there, never the harness copy — the two were **not**
consolidated), and `src/harness/wav.ts`, which has real production importers.

### The rule outlives the data

The point of this ticket is that deleting the placeholder *data* must not delete the *rule*. All
three placeholder-prefix guards survive (`ledger.ts` ×2, `exportResults.ts` ×1), pinned three ways:
physically present **together with** the manifest being gone; golden eval 06's `must_exclude` intact;
and behaviourally against ids that were **never in the deleted manifest**
(`placeholder-2027-something-new`), so the rule cannot degrade into a lookup against data that no
longer exists. It protects future placeholders, not just the ones removed.

### Premise corrected

**Ticket 058's out-of-scope note was wrong and contradicted this ticket.** It said the generator must
stay "because golden eval 06 depends on it". It does not: eval 06 only *quotes the path in its `why`
prose*, the harness treats `why` as an opaque string, and the eval's only `readFileSync` reads
`package.json`. Deleting the generator is safe and 054 wins.
