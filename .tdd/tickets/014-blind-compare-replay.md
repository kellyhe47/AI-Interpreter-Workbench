---
id: 014
title: Blind compare moves to Replay — pairwise, playback-only, persisted draw
status: pending
depends_on: [010, 013]
touches: [src/client/components/replay/BlindCompare.tsx, src/client/components/replay/BlindCompare.test.tsx, src/client/components/session/BlindCompare.tsx, src/client/components/session/BlindCompare.test.tsx, src/client/views/ReplayView.tsx]
iterations: 0
test_files: []
branch: ""
---

## Scope

**MOVE `src/client/components/session/BlindCompare.tsx` to Replay** (delete the session copy),
launched on demand from a Recording's runs. PRD §10.

Because Replay never autoplays, blind comparison is a natural feature rather than an offline
chore — and building it into the product removes the spreadsheet step and *guarantees* the
ordering was actually randomized.

## Requirements (PRD §10, §17 16b · 25d)

- **Pairwise only.** With three or more Runs of a Recording the evaluator picks the pair.
  Ranking three simultaneously is not something a human can actually judge.
- **Playback only — transcripts hidden until submit.** Showing the text would let the
  wrong-language-pronunciation class of error pass unnoticed: a TTS that reads Cantonese text
  aloud in Mandarin produces a transcript that reads correctly and audio that is wrong, and a
  text-visible evaluation scores it as a success (PRD §11).
- **Randomization is per comparison, not a fixed swap.** A fixed A↔B inversion teaches the
  evaluator the mapping after a single reveal.
- **The drawn assignment is persisted to the ledger** alongside the scores and the evaluator's
  language. That is what makes the blinding auditable after the fact rather than merely
  asserted.
- Adequacy and fluency, **1–5 each**, per sample. Identity revealed **after** submission.
- Launched on demand from the per-Recording view; it is not a phase you must complete.
- The randomness source is **injected**, not `Math.random` captured directly, so the draw is
  deterministic under test.

Copy from the mock: *"Playback only — transcripts are hidden until you submit, so a
wrong-language pronunciation can't pass by reading. Assignment drawn at random per comparison
and persisted to the ledger."*

## Acceptance criteria

- [ ] `src/client/components/session/BlindCompare.tsx` no longer exists; the component lives
      under `components/replay/` and is launched from the runs list of one Recording
- [ ] Offered only when the selected Recording has **≥2 completed runs**; with exactly 2 it
      uses them, with ≥3 the evaluator picks which two
- [ ] Only runs **of the same Recording** can be compared — the pair picker cannot select a run
      from a different Recording (identical input is the whole basis of the comparison)
- [ ] Before submit, **neither** run's configuration identity **nor** its transcript is
      rendered anywhere in the component — assert the absence of both
- [ ] Each sample offers a play control and adequacy + fluency rated 1–5
- [ ] The A/B assignment comes from the injected randomness source: two different draw values
      produce the two different orderings
- [ ] Submitting persists to the ledger: the two run ids, **the drawn assignment**, both
      scores, and the evaluator language
- [ ] Identity is revealed only after submit, and the revealed identity matches the persisted
      draw
- [ ] Submit is unavailable until both dimensions are scored for both samples
- [ ] Styling uses tokens only

## Test plan

Move and rework `BlindCompare.test.tsx` (manifest Tests table: pairwise, playback-only,
persisted draw). The old session-mode test asserting the two-arm live comparison is superseded
— update it in place rather than leaving a stale pin.

## Attempt log
