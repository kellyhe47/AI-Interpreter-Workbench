---
id: 068
title: "Cascade output audio is attributed one utterance late — 44 of 50 'failed' utterances translated perfectly and were rejected by the clock guard"
status: pending
source: operator sweep, 2026-08-09 (verified against stored runs)
depends_on: []
touches: [src/client/replay/runner.ts]
iterations: 0
test_files: []
branch: ""
---

## Observed — from the operator's first real sweep, verified on disk

50 of 72 sweep utterances are stored `status: 'failed'`. **44 of those 50 carry a complete source
AND a correct Spanish target.** The translations are good, including the disfluency category:

```
"None at all."                                  -> "Ninguno en absoluto."
"150 mg twice a day with food starting Monday"  -> "150 mg dos veces al día con comida comenzando el lunes"
"It started, sorry, I think it was Tuesday..."  -> "Comenzó, lo siento, creo que fue el martes por la noche"
```

They are failed **solely** because ticket 055b's write-time guard refused their timing:
`clock-inversion: output audio at <t> precedes its own speech_end <t'>`.

Only 6 of the 50 are genuine failures (`no output audio`).

## Root cause — the audio is attributed one utterance LATE

Recording `rec_msjjjc0m001_f1314d52`, manifest anchors `2400 / 8598 / 14560 / 19797`.
Arm B sweep run `8aba8e2e`, offsets relative to `t0`:

| utterance | own anchor | audio arrived | vs OWN anchor | vs PREVIOUS anchor |
|---|---|---|---|---|
| 2 | 8598 | 5197 | **−3401** | **+2797** |
| 3 | 14560 | 11134 | **−3426** | **+2536** |
| 4 | 19797 | 17161 | **−2636** | **+2601** |

Against its own anchor every interval is impossible. Against the **previous** anchor every interval
is a plausible, tightly-clustered cascade latency of **~2.5–2.8 s** (STT final → MT → TTS first byte).

So the audio answering utterance *N* is being recorded against utterance *N+1*'s anchor. The guard is
working correctly and is reporting a real defect — the defect is the attribution, not the clock.

## Why this matters more than the failure count

**The surviving samples are the mis-attributed ones that happened to come out positive**, so the
figures currently on screen are built on the wrong subset:

- Arm B renders **p50 0.42 s** over 5 surviving samples; the consistent measured interval above is
  **~2.6 s**. The displayed figure is not a slow-but-real number, it is a different quantity.
- Arm C renders **p50 0.02 s / p95 0.08 s** over **2 samples out of 24**. 20 ms from speech end to
  first audio is physically impossible for a full cascade.
- Experiment 2's headline `−1.20 s` delta rests on those 2 samples.

A wrong number is worse than a missing one, and these are wrong numbers on the graded screen.

## Acceptance criteria

- [ ] The audio instant answering utterance *N* is stored against utterance *N*'s record, verified
      against a fixture whose per-utterance latencies are known by construction and DISTINCT (equal
      latencies cannot detect an off-by-one)
- [ ] Falsifiable against the stored evidence: replaying run `8aba8e2e`'s marks through the fixed
      attribution yields per-utterance deltas of roughly `+2797 / +2536 / +2601` ms, all positive
- [ ] The clock-inversion guard is NOT relaxed, weakened, or given a tolerance window — it is
      correct and it is what surfaced this. Ticket 055b's tests stay green untouched.
- [ ] A run whose utterances all translate must not report a majority of them `failed`; assert the
      complete/failed split on a well-formed fixture
- [ ] Whatever the mechanism turns out to be (transport `utt` index base, manifest index base, or
      bucket ordering), a test pins the INDEX MAPPING itself, not just the resulting deltas — a
      test that only checks "no negatives" passes on a fix that shifts everything the other way

## Out of scope

- Re-running the sweep. The stored runs are the evidence; fix the attribution, then re-run.
- Changing `speech_end` or the manifest anchors — the anchors are correct and are what proved this.
- Ticket 053 / cost metering; the audio-concatenation gaps (ticket 069).

## Notes

- Arm A (realtime) shows 15 of 24 complete, so it is affected less or differently — the realtime tap
  is a different capture path (046). Diagnose per-arm rather than assuming one cause.
- This is the second time this project's own guard has surfaced a defect nobody was looking for.
  055b built the detector on one stored run; the sweep proved it systematic.
