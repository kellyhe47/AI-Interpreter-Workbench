---
id: 052
title: Cost is not implemented anywhere — every run, every arm, every figure is $0.00
status: pending
source: discovered during 051
depends_on: []
touches: [src/core, src/server/cascade/orchestrator.ts, src/client/views/useSessionController.ts, src/client/replay/runner.ts]
iterations: 0
test_files: []
branch: ""
---

## Why

Found while investigating 051's blank Live figures. The `$0.00` in the Live footer is **not a
plumbing bug — there is no cost model at all.**

Verified three ways:
- `costUnits: 0` is HARDCODED at `src/client/views/useSessionController.ts:437` (the realtime Live
  path) and at `src/server/cascade/orchestrator.ts:359` (the cascade path).
- **No pricing table exists anywhere in `src/core`** — no per-minute rate, no per-token rate, no
  provider price map. Nothing to compute a cost FROM.
- The stored ledger confirms it end to end: of the 3 Runs currently in `data/ledger.jsonl`,
  **zero carry a cost** — `costUsd` is `None` on every one.

**Cost is one of the PRD's three measured axes** (§8: latency, cost, quality). It is currently
absent from all of them — Live, Replay, sweeps, and every export. Not degraded, not approximate:
absent, and rendering as a confident `$0.00` rather than as "not measured".

That last part is the sharp edge. A blank or "not measured" cell is honest. **`$0.00` is a
figure**, and it reads as "this configuration is free" — the exact class of confidently-wrong number
this project's aggregation gate and provenance line exist to prevent.

## Scope

Give cost a real model, and make an unmeasured cost render as unmeasured rather than as zero.

## Acceptance criteria

- [ ] A price source exists and is **declared, versioned and visible** — the same discipline as
      `corpus-v1` and `wer-norm-v1`. A number that moves when a vendor changes its rates must not
      silently restate old results.
- [ ] **Arm A (Realtime)** is metered from what the provider actually reports — `response.done`
      carries usage; audio input and audio output are priced at DIFFERENT rates and must not be
      collapsed into one
- [ ] **Cascade (Arms B, C)** is metered per stage — STT, MT and TTS are three vendors with three
      rate cards; a single blended number cannot attribute a cost difference to a stage
- [ ] A run whose cost cannot be computed reports it as **NOT MEASURED, never as `$0.00`** — in the
      Live footer, the Replay listing, Results and the export
- [ ] Cost survives the round trip: computed once, stored on the record, and read back — not
      recomputed at display time from figures that may have moved
- [ ] Aggregates sum real costs only. A run with an unmeasured cost must not contribute a silent
      zero to an arm's total — that would understate the arm and is the same failure as `$0.00`
- [ ] The provenance line discloses how many runs in an aggregate carry a measured cost, the way it
      already discloses N and completed reps

## Notes

- Ticket 051 scopes **only Arm A's Live cost** (metered from `response.done`), because that is the
  observed defect. Cascade Live, Replay and sweeps stay `$0.00` until this ticket lands — a known,
  documented gap rather than a silent one.
- `isAggregatableRun` stays the ONE place that decides aggregation. Do not add a cost gate beside it.
- Check `src/server/storage/types.ts` and `src/server/routes/liveSessions.ts` — they were the only
  files matching a pricing-shaped grep, worth reading before designing the model.

---

## THE RATE TABLE ALREADY EXISTS — PRD §5 "Published rates"

Do NOT invent prices. The PRD carries the rate card, headed *"verify at build time; cost model
computes from metered usage"*:

| Item | Rate |
|---|---|
| `gpt-realtime` | **$32/M audio-in tokens, $64/M audio-out tokens** |
| `gpt-realtime-mini` | $10/M in, $20/M out — used for development |
| `gpt-4o-transcribe` | ~$0.006/min |
| `gpt-4o-mini` | $0.15/M in, $0.60/M out |
| `gpt-4o-mini-tts` | $12/M audio-out tokens |
| ElevenLabs Flash v2.5 | **$0.05 / 1k chars** |

Note the shapes differ per provider and MUST NOT be collapsed: token-billed (realtime, MT, OpenAI
TTS), per-minute (OpenAI STT), per-character (ElevenLabs). One blended $/min hides exactly the
attribution this experiment is built to produce.

**Input and output are billed at DIFFERENT rates** (2x for realtime). Collapsing them halves or
doubles the figure depending on the direction of traffic.

### The ElevenLabs trap — PRD §5, verbatim
> **Known cost trap:** ElevenLabs bills a 1,000-character minimum per request. Because cascade
> streams text in chunks, aggregate-vs-per-chunk billing must be verified before any Arm C cost
> figure is reported.

This is not a detail. Arm C streams translated text in chunks; if each chunk is billed at a 1,000
character minimum, Arm C's real cost is a large multiple of the naive character count. **A cost
model that multiplies total characters by the rate would report Arm C as cheap when it may be the
most expensive arm in the study** — and Arm B vs Arm C is Experiment 2, whose whole question is what
swapping providers buys.
- [ ] Model per-request billing with the 1k-char minimum explicitly, and make the assumption VISIBLE
      in the pricing module rather than buried in arithmetic
- [ ] Until it is verified against a real invoice, an Arm C cost figure must be labelled as
      **unverified**, not reported as fact

### What §8 says cost MEANS
- **Cost per minute** = *metered spend for the run ÷ audio duration*. A snapshot — a <=1-minute clip
  accumulates almost no conversation context.
- **Cost slope** (Live only) = $/min in minute 1 vs $/min in the final minute, under each context
  policy. Realtime bills the accumulated conversation each turn, so cost per minute CLIMBS. A
  <=1-minute clip cannot show it — this is a Live-only measurement and one of the reasons Live
  exists at all (§17 21e files context policy under controllability).
- [ ] `costPerMinUsd` is derived as metered spend / audio duration, not stored as an independent
      figure that can drift from the spend it came from
- [ ] Live reports the cost SLOPE, not just a total — the climb is the finding for Arm A

### Versioning
The rate table is a **declared control**, like `corpus-v1` and `wer-norm-v1`. Stamp it
(`pricing-v1`), record it in provenance, and make a rate change visibly restate results rather than
silently move them.
