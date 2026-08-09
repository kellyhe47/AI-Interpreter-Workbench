---
id: 056
title: Retain output audio per run — without it the project's most distinctive finding cannot be produced
status: pending
source: spec-audit + operator (Cantonese track kept)
depends_on: []
touches: [src/client/replay/runner.ts, src/server/routes/runs.ts, src/client/components/replay/RunsList.tsx, src/client/components/replay/BlindCompare.tsx]
iterations: 0
test_files: []
branch: ""
---

## Why — this is load-bearing, not a nicety

Every run row in the UI reads **`no output audio stored`** (observed at HEAD `ca40359`, all 3 runs).

PRD §7 requires output audio be retained for later blind scoring. §10 requires scoring be
**playback-only** — *"because reading the text would let the Mandarin-pronunciation class of error
pass unnoticed."*

**With the Cantonese track kept, that stops being a design nicety and becomes the project's sharpest
result.** A TTS that does not distinguish the spoken languages reads Cantonese text aloud **in
Mandarin**: a transcript that reads perfectly and audio that is wrong. *A text-only evaluation scores
this as a success.* It is detectable only by listening — and with no stored output audio, it cannot
be produced at all.

`BlindCompare.tsx` is 446 lines with 34 tests and **has never scored anything**, because it is
playback-only by design and there is nothing to play. Quality is one of the five dimensions the
rubric's write-up must cover; it is currently structurally unreachable.

Ticket 046 built the Arm A capture path (a Web Audio tap on the inbound WebRTC media track, gated to
the model's speaking windows). **That work is landed and green but has never been exercised against a
real session** — every stored run predates it.

## Acceptance criteria

- [ ] A completed run that produced audio stores it, and `GET /api/runs/:id/audio` returns it
- [ ] Both arms: cascade from the TTS stream, Arm A via 046's inbound tap
- [ ] The stored audio is **24 kHz PCM16 mono in both arms**, so blind compare cannot be told apart
      by format
- [ ] **Nor by content shape** — 046 gated Arm A capture to the model's speaking windows precisely so
      an Arm A file is not a 45-second recording of mostly silence against cascade's gapless TTS.
      Verify that holds on real audio.
- [ ] Blind compare can play an Arm A vs Arm B pair, and an EN→YUE pair
- [ ] Replay still autoplays nothing
- [ ] Live still persists NO audio (§17 19h) — this ticket must not change that

## The operator check this ticket exists to enable

Once audio is retained, listen to an EN→YUE cascade output and confirm whether the TTS speaks
Cantonese or Mandarin. **That single listen is the finding.** No test can produce it.

## Golden eval
`eval/golden/12-output-audio-is-retained-for-blind-scoring.json`
