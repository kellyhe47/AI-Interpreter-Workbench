---
id: 015
title: Placeholder corpus + benchmark harness skeleton (fixture-driven, never reported)
status: pending
depends_on: [004, 005]
touches: [scripts/generate-placeholder-corpus.mjs, corpus/*, scripts/bench-fixture.mjs, benchmark-results/.gitkeep]
test_files: []
iterations: 0
---

## Scope
- `scripts/generate-placeholder-corpus.mjs`: emits corpus/ with 36 WAV clips (24 kHz mono
  PCM16; tone-burst + silence tail so VAD-style endpointing is exercisable), manifest.json
  {corpusId:'placeholder-v0', PLACEHOLDER:true, note:'synthetic placeholder — no reported
  number may come from this corpus', clips:[{id, lang, category, text(reference), speechEndMs
  (ground truth from generation)}]} covering the 6 PRD categories × EN/ES/YUE structure.
- `corpus/` committed with the generated placeholder set.
- `scripts/bench-fixture.mjs`: drives the SERVER cascade path end-to-end over WS with fixture
  providers using corpus clips: for each clip, stream PCM, collect utterance-complete records,
  attach speechEndSource:'corpus' + corpusId, write
  benchmark-results/fixture-smoke.json. Exercises the harness shape (PRD §7 record流) without
  Playwright tonight; explicitly tagged placeholder so ledger/results exclude it.
- Unit tests: WAV writer correctness (header fields, sample count), manifest schema validation,
  and a vitest integration test running the bench flow in-process against the WS server with
  fixture providers (no child process needed).

## Acceptance criteria
1. Generator produces 36 valid WAVs (RIFF header, 24000 rate, mono, 16-bit; duration matches
   manifest) + manifest with PLACEHOLDER:true and per-clip speechEndMs.
2. Bench flow (in-process): 2-clip run produces records with full 5-interval cascade timings,
   speechEndSource 'corpus', corpusId 'placeholder-v0'.
3. Records from this corpus are excluded by the ledger's hasRuns/aggregation (ticket 009 rule) —
   integration assertion.
4. Output lands in benchmark-results/ (gitignored except .gitkeep).
