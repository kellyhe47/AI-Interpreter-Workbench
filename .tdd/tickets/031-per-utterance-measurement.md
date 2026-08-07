---
id: 031
title: runOnce measures every utterance in a Recording, not just the first
status: green
source: v3-corpus
depends_on: [030]
touches: [src/client/replay/runner.ts, src/client/state/ledger.ts, src/server/storage/types.ts]
iterations: 0
test_files: [src/client/replay/runner.test.ts]
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

## Attempt log

- Green in one implementation pass. Suite 1210/66; both tsconfigs clean; `npm run build` clean.
- **The enabling fact:** every transport event already carries `utt`
  (`TimingMark.utt`, `SourceTextEvent.utt`, `onAudio(pcm, utt)`, `UtteranceCompletion.utt`).
  `runOnce` was DISCARDING an index it was already handed, so no transport change was needed.
- Test-writer's reference-implementation check earned the **settle window**: without it the
  "too many utterances" direction is undetectable in principle, because the run stops the transport
  the instant the Nth completion lands and the (N+1)th — the only evidence of a bad split — is
  never delivered.
- **Orchestrator decision taken mid-ticket:** a SHORT manifest (a VAD that merges two utterances)
  previously hung forever; a manual run has no timeout and one merged clip would stall an overnight
  30-run sweep. Now fails with the same named reason via `SEGMENTATION_IDLE_MS = 5_000`, armed only
  once pacing completes so it can neither truncate the clip nor kill a legitimately slow final
  utterance. 5 s was chosen as 20x the settle window and 24x shorter than the sweep's
  `RUN_TIMEOUT_MS = 120_000`, so a merge fails with a diagnosis long before the sweep's blunt abort.
- Mutation-checked. Six properties independently load-bearing:
  | mutation | result |
  |---|---|
  | anchor from the Recording instead of the manifest | 21 red |
  | segmentation mismatch not flagged | 6 red |
  | settle window never armed | 20 red |
  | idle deadline never armed (the hang returns) | 5 red |
  | partial attribution recorded on a mismatch | 5 red |
  | a mismatched run still reported complete | 5 red |
  | bucket by array position instead of `entry.index - 1` | 0 red — **equivalent**, not a gap: `validateManifest` guarantees contiguous 1..N indices and the manifest is sorted first, so the two agree by construction. Defensive coding, correctly kept. |

### PROCESS BREACH — the lock commit contained an implementation

`f232e12` ("test(031): failing tests…") also carried the test-writer's **throwaway reference
implementation** of `runner.ts` (+141 lines), swept in by `git add -A`. Both the test-writer and the
implementer independently flagged it; the implementer additionally observed the file changing under
it mid-read, as the test-writer reverted its reference to the stub.

The TDD guarantee held in substance, and this was checked rather than assumed:
- 26 red were verified **twice**, 20 s apart, against the stubbed working tree before dispatch.
- The shipped implementation is **structurally distinct** from that reference — it introduces
  `attributeUtterances` and `UtteranceBuckets`, drops the reference's `uttTimings`, and differs on
  252 of 552 lines. The names both share (`disarm`, `idleTimer`, `settleTimer`, `mismatched`) were
  specified in the dispatch prompt.

**Rule this establishes: a lock commit stages ONLY the ticket's declared `test_files`, never
`git add -A`.** A test-writer that runs a reference implementation (which is a practice worth
keeping — it has caught three real problems now) leaves source in the tree at exactly the moment
the orchestrator commits.

### Method note — a mutation that moves a SHARED constant proves nothing

Three of my first six mutations were vacuous and looked like passes:
- changing `SEGMENTATION_IDLE_MS` / `SEGMENTATION_SETTLE_MS` moves the **test's** expectation too,
  because the test imports the same constant. Both sides shift and nothing fails.
- one pattern simply did not match.

Mutate the **behaviour** (never arm the timer at all), not a constant both sides read.
