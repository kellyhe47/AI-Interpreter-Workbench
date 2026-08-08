---
id: 053
title: Cascade cost is unmeasurable because MT and TTS report no usage — the provider protocol has no usage channel
status: pending
source: discovered during 052
depends_on: [052]
touches: [src/core/types.ts, src/server/providers, src/server/cascade/orchestrator.ts, src/client/replay/runner.ts]
iterations: 0
test_files: []
branch: ""
---

## Why

Ticket 052 landed a real cost model. **Cascade's total is still `not measured` for Arms B and C**,
and correctly so — it is refusing to report a figure it cannot compute.

Two of four stages CAN be metered and are wired and correct:
- **STT** — per-minute, from the audio samples handed to the provider
- **ElevenLabs TTS** — per-character, as ONE REQUEST PER STREAMED CHUNK, which is the PRD §5
  1,000-char-minimum trap modelled properly

The two that cannot:
- **MT** (`MtProvider.translate`) yields text and reports **no token usage at all**
- **`gpt-4o-mini-tts`** bills audio-out TOKENS, which are not derivable from PCM sample counts

`priceCascade` refuses a total when any stage is unmeasured, so Arm B and Arm C report
`not measured` rather than a partial figure. **That was the right call** — a total that silently
omits MT is a number wearing a measured number's clothes, and estimating tokens from characters
would be an invented figure that would have to be registered as an unverified assumption.

**Experiment 2 is Arm B vs Arm C, and its entire question is what swapping providers buys.** Until
this lands, that experiment has no cost axis.

## Scope

Give the provider protocol a usage channel, and meter the two stages that currently cannot report.

## Acceptance criteria

- [ ] `MtProvider` and `TtsProvider` report usage from the vendor response (`{input_tokens,
      output_tokens}` for OpenAI; whatever the vendor actually returns otherwise) — **reported, not
      estimated**
- [ ] A provider that genuinely cannot report usage yields `stage-unmeasured`, and the run's cost
      stays `null`. Never a fabricated or estimated figure.
- [ ] `priceCascade` produces a real per-stage total for Arm B and Arm C once every stage reports
- [ ] The per-stage split is preserved end to end — Experiment 2's finding is *which stage* the cost
      difference lives in, so a blended total is not sufficient
- [ ] `cascadeCostUsd` already builds `CascadeStageUsages` and prices with no further change the
      moment a stage reports usage — **verify that is still true rather than rebuilding it**
- [ ] REPLAY: `transport.costPerMinUsd` is a single blended $/min that defaults to `0` on every
      transport and is configured NOWHERE. 052 made it report `null` instead of `$0.00`. Replace it
      with the same per-stage metering rather than leaving a second, weaker cost path in the codebase
- [ ] No existing measured figure moves. `isAggregatableRun` stays the one place that decides
      aggregation — do not add a cost gate beside it.

## Notes

- This is a `src/core/types.ts` interface widening across four adapters. 052 judged it out of scope
  and said so rather than estimating — the right call.
- `gpt-realtime-mini` declares no published text/cached rates, so its text and cached tokens fall
  back to the audio meter and OVERSTATE a development run. Documented in `RATE_CARD`; fix if a rate
  is ever published.
- The `realtime-cached-tokens-are-a-subset` assumption is registered `verified: false` until
  confirmed against a live `response.done`. That confirmation is an operator task, not a code task.
