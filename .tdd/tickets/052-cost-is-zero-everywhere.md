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

---

## ROUND 2 — code review of `513c5ef` (with 051 r2 at `e4b0452`)

**`src/core/pricing.ts` itself is excellent and heavily pinned** — 25 of 28 mutations killed. The
cached-token arithmetic was executed and verified EXACT (1M audio-in with 600k cached = **$13.04** =
400k x 32/M + 600k x 0.40/M; every term a disjoint slice, no token billed twice or dropped; cached
input is now CHEAPER than uncached, inverting R2-3's inversion). The 1k-char floor is structurally
uncollapsible inside the module — `StageUsage` has no total field — and 12x100 chars ($0.60) vs
1x1200 ($0.06) is 10x apart, as it must be.

**Everything OUTSIDE that module is untested.** Five majors.

### R2-1 (MAJOR) — the `$0.00 -> not measured` rule is VACUOUS at both Live enforcement points
Two mutations that restore **the literal headline defect this ticket was filed against** leave
2014/2014 green:
- footer initialiser `costUsd: null, costCell: COST_NOT_MEASURED_CELL` -> `costUsd: 0, costCell: '$0.00'` — **SURVIVED**
- `aggregates()`'s `if (r.costUnits !== null)` -> unconditional `(agg.costUsd ?? 0) + (r.costUnits ?? 0)` — **SURVIVED**

The Replay twin IS guarded (the same mutation in `runAggregates` kills 5 tests). The **Live** path —
the one the ticket names in its first line — has nothing. `LiveView.timings.test.tsx:485` pins
`costUnits === null` on the RECORD; nothing pins what the FOOTER renders from it.
A cascade Live session (every `costUnits` null today by design) can regress to a confident
`session $0.00` with CI green.

### R2-2 (MAJOR) — the whole cascade cost path has ZERO coverage, wiring seam included
Five mutations, all green: `cascadeCostUsd` body -> `return 0`; `requestCharCounts: chunks.map(...)`
-> one summed total; `ws.ts` `models: msg.providers` -> `models: undefined`; `sttSamples += len` ->
`+= 0`; drop the `rateFor(models.tts)?.shape === 'per-character'` gate.
`cascadeCostUsd` — the function that exists to stop cascade reporting `$0.00` — **can be replaced
with `return 0` and nothing notices.** The `models` forwarding in `ws.ts` is the
"wiring-seam-delivered-incidentally" pattern again: load-bearing for every future cascade price,
pinned by nothing. And the ElevenLabs per-request modelling is exercised only INSIDE `pricing.ts`,
never end to end.

### R2-3 (MAJOR) — `exportResults`' entire 052 change is unguarded
Replacing `sumMeasuredCosts(...costFromStored)` with the old `reduce((t,r) => t + (r.cost ?? 0), 0)`
and `measuredCostRuns: aggregated.length` — **SURVIVED 2014/2014**. `measuredCostRuns`, `costCell`
and `pricingVersion` appear in **no test file**. This is the artifact the write-up cites: an arm with
3 of 5 runs priced exports as if all 5 were, and the field that would disclose it is asserted
nowhere.

### R2-4 (MAJOR) — the denominator does not reach the Live surface; `measuredCostRecords` is DEAD
Results/Replay experiment cards are CORRECT — `cost measured on X of N samples` renders and is
non-vacuous in both directions. But:
- **Live footer** renders a bare dollar figure summed over measured records only, with no count.
  `ArmAggregate.measuredCostRecords` is computed for exactly this and **read by nothing outside
  tests.**
- **Results Live card** names sessions, utterances, the anchor and WER — no cost denominator.
Ticket 051's deferred clause said 052 would add the `n of m metered` disclosure. The nullable half
landed; the disclosure half did not. Arm A is where it bites: `priceRealtimeUsage` returns null
whenever a `response.done` arrives with no usage block — a PER-TURN condition, not all-or-nothing.
**DECIDED:** render `$0.041 · 3 of 5 metered` in the Live footer; same clause on the Results Live line.

### R2-5 (MAJOR) — three of this ticket's OWN acceptance criteria are unimplemented, their code dead
- **`pricing-v1` is not in provenance.** It reaches `exportResults` only. `Provenance` has no
  `pricingVersion`; the rendered line names `corpus-v1` and never the rate source. A rate change
  would restate the bundle but not the screen.
- **Nothing labels an unverified figure.** `PRICING_ASSUMPTIONS`, `assumptionsFor`,
  `isVerifiedPricing` and `CostResult.verified` appear ONLY in `pricing.ts` and its tests. `verified`
  is discarded at every call site. **No surface can ever say "unverified"** — including the
  cached-token assumption, which exists precisely so a reader is warned.
- **Cost slope is not implemented.** `costSlope()` and `costPerMinuteUsd()` are dead exports;
  `useSessionController` hardcodes `perMinuteMinute1: null, perMinuteFinalMinute: null`, so
  ResultsView's two Live rows render `—` forever. PRD §8 makes the climb the finding for Arm A.
**DECIDED:** implement all three. Shipping a module with its consumers missing is the failure this
ticket was written against.

### R2-6 (MINOR, but it becomes the dominant term after 053) — the ElevenLabs meter is at the WRONG SEAM
`orchestrator.ts:220` bills `targetPartials` — the **MT token stream, one token at a time**. But
`elevenlabs-tts.ts` opens ONE WebSocket per utterance and sends one frame per chunk. A 40-token
sentence models as 40 x 1000 = 40,000 billed chars = **$2.00 for one sentence** against ~$0.01
one-shot. Harmless today only because `priceCascade` nulls the total on the MT hole.
**DECIDED:** meter at the TTS adapter (frames actually sent), not at the MT bridge, and say in the
assumption text that a chunk is an MT token delta.

### R2-7 (MINOR) — cached-token edge cases
- `cached_tokens: 0` with `cached_tokens_details.audio_tokens: 600_000` -> discount applied anyway
- `cached_tokens: 600_000` with details summing to `100_000` -> 500k silently full-priced, no mismatch
- `audio_tokens: -5` -> `measured: true, usd: 0` — a malformed count becomes a measured FREE turn
**DECIDED:** refuse (`shape-mismatch`) when `cached_tokens` and the details disagree; treat a
negative count as unreported.

### R2-8 (MINOR) — smaller
- `requestCharCounts.length === 0` -> `measured(0)` SURVIVED; the comment calls it a metering hole
- `exportResults.latencySample` has no guard pinning its Replay anchor (the ledger twin does)
- `ExperimentArmAggregate.costCell` is computed and pinned but **rendered nowhere** — ResultsView
  shows `costPerMinuteUsd` via `formatUsd` -> `—`, not `not measured`. Two vocabularies, one screen.
- `data/live-sessions.jsonl`'s 8 stored sessions carry `cost.totalUsd: 0`, now read back as MEASURED
  $0.00. Inert today; if 053 surfaces it, those rows lie. Migrate or reinterpret on read.

## ALSO — one 051 residual worth fixing here (same screen)
**The Live bar denominator is not honest and is not pinned.** The four bars sum to
`audio_queued - vad_fired`; the headline immediately below reads `tts_first_byte - vad_fired`. **The
number the bars decompose is never displayed.** A reader sees four bars at 100% and one total and
reads the former as a decomposition of the latter — so `deliver` reads as a share of a latency it is
explicitly outside of. On real stored data (`session-1786215745428` utt 1) `deliver` takes 13.8% of
the bar row while contributing 0% of the headline, and that fraction grows without bound on a longer
utterance — R2-1's confound re-entering as pixels instead of digits.
**DECIDED:** bars decompose the HEADLINE (`transcribe`/`translate`/`synthesize`); render `deliver`
with no bar or a muted one, matching its outside-the-headline status. Pin it.
