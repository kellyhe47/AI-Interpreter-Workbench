---
id: 031
title: runOnce measures every utterance in a Recording, not just the first
status: pending
source: v3-corpus
depends_on: [030]
touches: [src/client/replay/runner.ts, src/client/state/ledger.ts, src/server/storage/types.ts]
iterations: 0
test_files: []
branch: ""
---

## Why — read `.tdd/tickets/README-v3-corpus.md`

`runOnce` today finishes at the FIRST `utterance.complete` and keeps one flat `timings` map whose
entries are overwritten by each later utterance. A 4-utterance corpus Recording yields one
incoherent sample instead of four clean ones.

## Scope

A Run becomes a **container** for the utterance records it produced. The measured atom is the
utterance.

```ts
export interface RunUtterance {
  utteranceId: string;          // from the manifest
  index: number;                // 1-based, manifest order
  category: CorpusCategory;
  timings: Record<string, number | null>;   // per-utterance, anchored per-utterance
  transcripts: { source?: string; target?: string };
  cost: number;
  status: 'complete' | 'failed';
  errors: string[];
}
```

`Run` gains `utterances?: RunUtterance[]`, additive and optional.

### Anchoring — the part that must not be got wrong

Each utterance's `speech_end` is `t0 + manifest[i].trueSpeechEndMs`, from the **corpus manifest**,
never from VAD (PRD §8: t0 is "corpus-derived true speech end", and a transport-sent `speech_end`
is already discarded). Its `audio_queued` is the first output sample attributable to THAT
utterance. Latency is per utterance; the existing rule that every Run of one Recording shares its
anchors is preserved and now holds per utterance.

## Acceptance criteria

- [ ] A Run of an N-utterance Recording produces N `RunUtterance` records, in manifest order
- [ ] Each carries its manifest `utteranceId`, `index` and `category`
- [ ] Each `speech_end` is `t0 + manifest[i].trueSpeechEndMs`; a transport `speech_end` is still discarded
- [ ] `audio_queued` is per utterance — utterance 2's first audio does not report utterance 1's
- [ ] **Segmentation mismatch is a run-level failure.** If the number of `utterance.complete`
      events does not equal the manifest length, the Run is saved `status: 'failed'` with a named
      reason (e.g. `segmentation: expected 4 utterances, observed 5`) and **no** partial
      per-utterance attribution is recorded. A run whose segmentation disagrees with the manifest
      is not evidence.
- [ ] A single-utterance Recording (mic, or corpus with a 1-entry manifest) behaves exactly as
      today, and a Recording with **no** manifest behaves exactly as today — every existing
      `runOnce` test stays green untouched
- [ ] A run that loses a stage mid-clip still saves, still fails, still resolves rather than throws
- [ ] Cancellation still POSTs nothing
- [ ] Pacing is unchanged: still 1x, still one continuous clip, still one pacer

## ORCHESTRATOR DECISION — a short manifest must FAIL, not hang

Raised by the test-writer during 031 and decided here rather than deferred.

The "too many" direction is detectable (the extra completion arrives inside a settle window). The
**"too few"** direction is not: if a provider's VAD MERGES two utterances, only N-1 completions ever
arrive, the settle timer never starts, and `runOnce` never resolves. A manual run has no timeout at
all, and in an overnight 30-run sweep one merged clip stalls the entire sweep.

A merge is precisely the segmentation mismatch this ticket exists to catch, so it must surface as
the same named run-level failure — never as a hang.

**Rule:** for a manifest-backed run, once pacing has completed, wait at most
`SEGMENTATION_IDLE_MS` for the outstanding completions. If the count is still short, fail the Run
with the SAME named reason (`segmentation: expected N utterances, observed M`) and record no
per-utterance attribution. Manifest-less runs are unaffected — their termination is unchanged.

- [ ] A run whose transport delivers only N-1 completions and then goes quiet RESOLVES, saves
      `status: 'failed'`, names the segmentation reason, and records no `utterances`
- [ ] It does so without a lost stage — going quiet is the whole scenario
- [ ] No timer leaks past the run in either the short or the happy path
- [ ] A manifest-less run's termination is byte-for-byte unchanged

## Explicitly NOT in this ticket

Aggregation over the new records — that is **032**. Until it lands, `RunUtterance[]` is written and
unread, and every existing aggregate keeps working off the Run-level fields.

## Notes for the implementer

- Do not stop pacing at an utterance boundary. The clip is paced continuously; utterances are
  segmented by the transport as it goes.
- Keep the Run-level `timings`/`transcripts`/`cost` fields populated as they are today (first or
  aggregate as appropriate, and say which) so nothing downstream breaks before 032.
- Mutation-check the anchoring: point utterance 2's `speech_end` at the Recording-level
  `speechEndMs` instead of its own manifest offset and confirm a test goes red. That single
  assertion is what makes per-utterance latency mean anything.
