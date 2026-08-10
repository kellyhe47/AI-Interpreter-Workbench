---
id: 068
title: "A hallucinated leading utterance shifts every real one, and the runner truncates instead of noticing"
status: done
source: operator sweep, 2026-08-09 (verified against stored runs)
depends_on: []
touches: [src/client/replay/runner.ts]
iterations: 1
test_files: []
branch: main
---

## Observed — from the operator's first real sweep, verified on disk

50 of 72 sweep utterances are stored `status: 'failed'`. **44 of those 50 carry a complete source AND
a correct Spanish target** — the translations are good, disfluencies included. They failed only
because ticket 055b's guard refused their timing as a clock inversion. Only 6 are genuine
`no output audio`.

## Root cause — TWO defects, and the second is ours

### 1. The STT hallucinates a leading utterance (upstream)

Across the 17 runs that stored utterances, the FIRST stored source text is:

```
10x  "No, none at all."   <- correct, manifest idx1
 1x  "Turn right."          1x  "그러나."        1x  "Hallo."
 1x  "żeśmy."               1x  "Yardımımın"     1x  "Telephone"     1x  "Ok."
```

Korean, German, Polish, Turkish — the textbook Whisper-family hallucination on leading
silence/non-speech. It is intermittent: roughly 7 of 17 runs.

### 2. The runner truncates silently instead of detecting the extra segment — THIS IS THE BUG

`attributeUtterances` (`src/client/replay/runner.ts:829`) maps `manifest[i]` → bucket
`entry.index - 1`, reading exactly `manifest.length` buckets and **never asking how many the
transport actually produced**. So a spurious leading segment consumes bucket 0 and every real
utterance lands one slot late; the last real utterance falls into a bucket nobody reads.

Recording `rec_msjjjc0m001_f1314d52`, run `8aba8e2e`:

| slot | manifest reference | stored source |
|---|---|---|
| 1 | "No, none at all." | **"Turn right."** ← in no manifest entry |
| 2 | "Take two hundred fifty milligrams…" | "None at all." ← *manifest 1* |
| 3 | "It started— sorry…" | "150 mg twice a day…" ← *manifest 2* |
| 4 | "Doctor Nguyen referred you…" | "It started, sorry…" ← *manifest 3* |

Manifest utterance 4 is **absent from the record entirely**.

The timing evidence agrees exactly. Anchors `2400 / 8598 / 14560 / 19797`; audio arrived at
`5197 / 11134 / 17161`:

| utterance | vs OWN anchor | vs PREVIOUS anchor |
|---|---|---|
| 2 | −3401 | **+2797** |
| 3 | −3426 | **+2536** |
| 4 | −2636 | **+2601** |

Against the shifted-by-one anchor every interval is a plausible, tightly clustered cascade latency of
**~2.5–2.8 s**.

**Every run stored exactly 4 utterances and ZERO runs carry a segmentation error.** Ticket 031's
guard catches "too few" (`expected 4, observed 3`) and nothing catches "too many". A misaligned run
therefore reports `status: 'complete'` with confident, wrong per-utterance numbers, and it was only
caught downstream by 055b's clock guard firing by accident.

## Why this matters more than the failure count

The surviving samples are the mis-attributed ones that happened to come out positive, so the figures
on the graded screen are built on the wrong subset:

- Arm B renders **p50 0.42 s** where the measured interval is **~2.6 s** — a different quantity, not
  a fast one.
- Arm C renders **p50 0.02 s / p95 0.08 s** over **2 samples of 24**. 20 ms speech-end-to-first-audio
  is physically impossible for a full cascade.
- Experiment 2's headline **−1.20 s** rests on those two samples.

A wrong number is worse than a missing one.

## Acceptance criteria — the runner half only

- [ ] The runner compares the transport's OBSERVED segment count against the manifest length in
      **both** directions. Too many is as much a mismatch as too few, and the existing "too few"
      message and behaviour are unchanged.
- [ ] On a mismatch the Run is stored `failed` with a segmentation error naming both counts, and it
      does **not** silently truncate to `manifest.length`. Falsifiable: a transport emitting 5
      segments against a 4-entry manifest must not produce a `complete` run.
- [ ] A misaligned run's per-utterance figures never reach an aggregate — assert through
      `isAggregatableRun` / the existing gate, **not** a second gate.
- [ ] The clock-inversion guard is NOT relaxed, weakened, or given a tolerance. It is correct and it
      is what surfaced this; ticket 055b's tests stay green and untouched.
- [ ] A well-formed run (observed == manifest) is untouched: same records, same `complete`, same
      figures. Pin it, so the fix cannot be "fail more often".
- [ ] The fixture proving alignment uses **distinct** per-utterance latencies — equal ones cannot
      detect a shift.

## Out of scope — deliberately

- **Suppressing the hallucination itself.** Trimming leading silence, VAD prefix padding, a language
  hint or an STT prompt are provider/config decisions and belong in their own ticket. This ticket
  makes the corruption *loud*; it does not stop the provider producing it.
- Re-running the sweep. Fix detection first, then re-run — the stored runs are the evidence.
- Changing `speech_end`, the manifest anchors, or ticket 031's "too few" behaviour.
- Cost metering (ticket 053) and the audio-concatenation gaps.

## Notes

- Arm A (realtime, 15 of 24 complete) uses a different capture path (046's media tap). Diagnose
  per-arm rather than assuming one cause; the realtime transport may number segments differently.
- This is the second time this project's own guard surfaced a defect nobody was looking for. 055b
  built the detector on one stored run; the sweep proved it systematic. The lesson is the same one
  the repo keeps relearning: the honest failure is the one that tells you it happened.

## RESOLUTION (2026-08-09)

Suite 2453 passing / 0 failing. `npm run check` exits 0.

### A premise in this ticket was FALSE and was corrected while writing the tests

"There is no too-many check" is wrong. `runner.ts` already compared `observed !== expected` in
**both** directions, and `runner.test.ts:862` already pinned
`segmentation: expected 4 utterances, observed 5`.

**The real hole was narrower.** `observed` counted `onUtteranceComplete` events *that arrived before
the run stopped listening*. The 4th completion arms the 250 ms settle window; it expires, `finished`
resolves, the transport is torn down — so in run `8aba8e2e` the 5th segment's completion landed
~1.6–2.5 s later into nothing, **while its transcript had already been delivered into bucket 4**,
which `attributeUtterances` never reads. A segment the transport demonstrably produced was not
counted as a segment at all.

### The fix

`segmentsProduced()` derives the count from the **buckets** — `source`, `targetFinal`, `targetDelta`,
`audioAt`, `timings` — because no count of completions can ever see a segment that completes after
teardown. Two properties carry the design:

- **Only keys `>= expected` are consulted**, which is what leaves the too-few direction alone.
  `runner.test.ts:1275` (`expected 1, observed 0`) and `replayArmA.test.ts:537` (`expected 4,
  observed 0`) both have content on `utt 0` with no completions; a global "distinct utts seen"
  redefinition would report `observed 1` and stop them being mismatches.
- **It is a `max`, not a sum.** The in-time control emits 5 completions *and* has a bucket at 4;
  summing would report `observed 6` and break the locked `observed 5` assertion.

Ticket 031's message is byte-for-byte unchanged — the same template, a different value substituted.

### How the tests pin it

The index mapping is pinned three independent ways rather than the sign of the deltas: stored sources
must equal the manifest reference texts **in order**; each record walks back to its own manifest entry
by `utteranceId`; and the shifted fixture's deltas are deliberately **all positive**, so 055b's clock
guard never fires and a sign-only fix would see nothing wrong. Four of the nine tests are controls
that passed before the fix, including a well-formed run pinned record-for-record so the fix could not
degenerate into "fail more often".

Mutation-verified by the orchestrator: ignoring the buckets → 5 red; dropping the `>= expected`
filter → the too-few case goes red exactly as predicted; summing instead of `max` → 4 red.

### What this does NOT do

It makes the corruption **loud** — a misaligned run is now stored `failed` with both counts named,
and is excluded by `isAggregatableRun`'s existing `status` clause. **It does not stop the STT
hallucinating.** That is a provider/config matter — silence trimming, VAD prefix padding, a language
hint or an STT prompt — and needs its own ticket before the sweep is re-run, or roughly 7 runs in 17
will now fail loudly instead of lying quietly.
