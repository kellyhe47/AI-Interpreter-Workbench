---
id: 068
title: "A hallucinated leading utterance shifts every real one, and the runner truncates instead of noticing"
status: pending
source: operator sweep, 2026-08-09 (verified against stored runs)
depends_on: []
touches: [src/client/replay/runner.ts]
iterations: 0
test_files: []
branch: ""
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
