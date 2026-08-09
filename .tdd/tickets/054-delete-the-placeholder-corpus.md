---
id: 054
title: Delete the placeholder corpus — the real takes are recorded, and keeping both invites a tone burst into the write-up
status: pending
source: spec-audit + operator
depends_on: []
touches: [corpus/, scripts/generate-placeholder-corpus.mjs, src/harness/corpus.ts]
iterations: 0
test_files: []
branch: ""
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

- [ ] `corpus/*.wav` and `corpus/manifest.json` removed
- [ ] `scripts/generate-placeholder-corpus.mjs` removed
- [ ] **`corpus/SCRIPTS.md` and `corpus/LIVE-SCRIPT.md` are KEPT** — they are the real artifacts, and
      the recorded takes were read from them
- [ ] Tests in `src/harness/corpus.ts`'s suite that exist only to validate the placeholder manifest
      are dropped or retargeted at the recorded Recordings (~210 source / 339 test lines for a
      generator being deleted)
- [ ] Nothing in the app imports or references the manifest afterwards — grep clean
- [ ] The 3 recorded Recordings still load and are still runnable after the deletion

## Notes

- Ship the deletion in ONE commit so the repo is never in a state where both a real and a
  placeholder corpus are present.
- Do NOT write a corpus→Recordings import. It was proposed and cancelled: the record flow already
  produces exactly the shape the pipeline needs, and the one pre-existing Recording proves the path.
