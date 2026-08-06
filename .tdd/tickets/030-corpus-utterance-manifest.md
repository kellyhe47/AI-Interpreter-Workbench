---
id: 030
title: Recording carries a corpus utterance manifest — categories, references, per-utterance true speech-end
status: green
source: v3-corpus
depends_on: []
touches: [src/server/storage/types.ts, src/server/storage/index.ts, src/server/routes/recordings.ts, src/client/state/ledger.ts, src/core/corpus.ts]
iterations: 0
test_files: [src/core/corpus.test.ts, src/server/routes/recordings.test.ts]
branch: ""
---

## Why this exists — read `.tdd/tickets/README-v3-corpus.md` first

028's deferred notes said "add `utteranceId` and a `category` to `Recording`". **That was wrong**,
and the error is mine. PRD §9 decouples them: a Recording holds **~4 utterances**, each with its
own category, and §9 is explicit that *"Categories are distributed across the recordings, not
grouped"*. A Recording therefore cannot carry **a** category — it carries a **manifest** of them.

## Scope

Give a Recording the corpus metadata that §9 says is "committed with reference material", so that
a recorded corpus is saved with everything its analysis later needs.

```ts
export type CorpusCategory =
  | 'short-reply' | 'long-compound' | 'numbers-dates-dosages'
  | 'proper-nouns' | 'disfluency' | 'interruption';

export interface CorpusUtterance {
  /** Stable within the corpus, e.g. 'en-2-3'. This is annotations.utteranceId. */
  id: string;
  /** 1-based position within the Recording. Maps to completion ORDER at replay. */
  index: number;
  category: CorpusCategory;
  /**
   * TRUE speech end, computed offline, as ms from the START OF THE CLIP.
   * PRD §8: "Because the corpus is pre-recorded, true speech-end is computed
   * offline for every clip" and t0 is "corpus-derived true speech end" — never
   * a VAD guess, which differs per arm.
   */
  trueSpeechEndMs: number;
  /**
   * Verbatim script. Present for EN and ES (WER computed); ABSENT for YUE,
   * which is improvised (PRD §9 — no written Cantonese script exists).
   */
  referenceText?: string;
}
```

`Recording` gains, both mirrors (`src/server/storage/types.ts` and `src/client/state/ledger.ts`):

```ts
utterances?: CorpusUtterance[];   // optional: mic Recordings have none
corpusVersion?: string;           // stamped when the corpus is loaded
```

`CorpusCategory` already exists somewhere in core as the `UtteranceCategory` alias used by
`derive.ts` — **find it and reuse it; do not define a second list.** If it is only a type alias with
no runtime values, add the frozen `CORPUS_CATEGORIES` array in `src/core/corpus.ts` and have
`derive.ts` keep aliasing rather than duplicating.

## Acceptance criteria

- [ ] `CorpusUtterance` and `CORPUS_CATEGORIES` live in `src/core/corpus.ts`, deep-frozen, and are
      compiled cleanly by **both** tsconfigs (no node-only or DOM-only globals)
- [ ] `Recording.utterances` and `Recording.corpusVersion` exist on both mirrors, both optional
- [ ] `POST /api/recordings` accepts and persists them; `GET` returns them; the full round trip
      survives (POST → `recordings/<id>.json` → GET → client `Recording`)
- [ ] **Validation, because a bad manifest silently corrupts every later number:**
      - `index` values are 1..N contiguous with no duplicates
      - `trueSpeechEndMs` is strictly increasing with `index`, and every value is
        `> 0` and `<= durationMs`
      - `category` is one of the six
      - `id` values are unique within the Recording
      - a violation is a **400 with a named reason**, never a silent accept
- [ ] A Recording with **no** `utterances` still round-trips exactly as today (mic recordings, and
      every Recording written before this change)
- [ ] Corpus Recordings remain undeletable; the manifest changes no lifecycle rule
- [ ] The existing single `speechEndMs` on `Recording` is **untouched and still authoritative for a
      single-utterance Recording** — ticket 031 decides how it relates to the manifest. Do not
      remove or repurpose it here.

## Explicitly NOT in this ticket

- Per-utterance measurement at replay time — that is **031**, and until it lands the manifest is
  stored but unused by the measurement path.
- WER scoring — **034**.
- Any change to `runOnce`, the batch runner, the aggregation gate, or any derivation.

## Notes for the implementer

- Additive and optional at every layer: storage is append-only and its reader is tolerant.
- `src/client/**` cannot import `src/server/**` — mirror the type, as the codebase already does.
- The route currently whitelists body fields in `parseUpload`; the manifest must be parsed and
  validated there, not passed through blind. Note this is the OPPOSITE of the runs route, which
  passes unknown keys through (see AGENTS.md) — recordings validate, runs do not.

## Attempt log

- Green in one pass. Suite 1118/63 (+33), both tsconfigs clean.
- `CORPUS_CATEGORIES` was NOT duplicated: `src/harness/corpus.ts` already had the six-category list
  for the synthetic placeholder corpus. The new `src/core/corpus.ts` is the canonical home (core is
  compiled by both tsconfigs; harness is not), and the category strings match exactly, so
  `derive.ts`'s `UtteranceCategory` alias keeps working untouched.
- The route VALIDATES rather than passing unknown keys through — deliberately the opposite of the
  runs route (AGENTS.md). A malformed manifest never fails loudly later; it silently mis-attributes
  every category and WER figure derived from it, so it is a hard 400 with a named reason.
- `createRecording` whitelists fields explicitly (unlike `appendRun`, which stringifies the whole
  object), so persistence needed two explicit lines. Verified by mutation rather than assumed.
- Mutation-checked, five properties, each killing its own tests:
  | mutation | result |
  |---|---|
  | route skips manifest validation | 7 red — every malformed manifest is accepted |
  | monotonicity check off | 3 red |
  | index contiguity check off | 2 red |
  | storage drops the manifest | 2 red |
  | duration upper bound off | 2 red |

### ORCHESTRATOR ERROR (mine, and a repeat)

I ran the mutation checks BEFORE committing. `src/core/corpus.ts` was untracked, so
`git checkout -- src/core/corpus.ts` could not revert its mutation and errored — while the same
loop's `git checkout` DID revert `recordings.ts` and `storage/index.ts`, discarding my uncommitted
implementation of both. Two mutation results were contaminated and had to be redone.

This is the same error as ticket 016, one variant worse: an **untracked** file is not merely
un-revertable, it makes the whole batch's results untrustworthy while looking like it worked.
**Commit first, then mutate.** And before any mutation batch, confirm every file it will touch is
tracked and clean — `git status --porcelain` showing no `??` among the targets.
