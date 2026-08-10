---
id: 070
title: "Replay prices nothing — the realtime transport reports usage and the runner throws it away"
status: pending
source: operator ("I need cost fixed"), 2026-08-09, after the first real sweep
depends_on: []
touches: [src/client/replay/runner.ts, src/client/transport/types.ts, src/client/transport/realtime.ts]
iterations: 0
test_files: []
branch: ""
---

## Observed — on the operator's own sweep

Every arm on the Results screen reads `cost measured on 0 of N samples`:

```
Arm A · cost measured on 0 of 15 samples
Arm B · cost measured on 0 of 5 samples
Arm C · cost measured on 0 of 2 samples
```

Ticket 059 is working correctly — an unmeasured cost reads `not measured` rather than a fabricated
`$0.000`. **The gap is that nothing measures.**

## Root cause — and it is NOT ticket 053

`src/client/replay/runner.ts` contains **zero references to `usage`**. It prices with
`transport.costPerMinUsd` (`runner.ts:1346`), a single blended $/min that ticket 053's own acceptance
criteria describe as *"defaults to `0` on every transport and is configured NOWHERE"*. So
`costPerMinUsd > 0` is false and `attributeUtterances` (`:960`) writes `cost: null` for every
utterance of every run, in every arm.

**Meanwhile the realtime transport already reports usage.** `realtime.ts:667` does:

```ts
case 'response.done': {
  const response = msg.response as { usage?: unknown } | undefined;
  h.onUtteranceComplete?.({ utt: this.utt, usage: response?.usage });
```

And `priceRealtimeUsage` (`src/core/pricing.ts:418`) already prices exactly that shape — it is
called from `useSessionController.ts:519`, the **Live** path, and nowhere else. Live's footer prices
correctly for the same reason Replay does not.

So Arm A's cost is not a vendor limitation, an unimplemented protocol, or a deferred ticket. **The
number is already on the wire and the runner drops it on the floor.**

## What ticket 053 is, and what it is not

Ticket 053's header says "COMPLETE ON BRANCH, PARKED". **That is wrong.** `tdd/053` holds exactly two
commits — `stub(053)` (type additions to `core/types.ts`, `core/protocol.ts`,
`client/transport/types.ts`) and `test(053)` (four test files, 1218 lines). There is **no `feat`
commit and no implementation.** It is an unimplemented test lock, not merge-ready work.

053 remains the right ticket for the **cascade** stages (MT token usage, ElevenLabs character usage).
Note its own finding, which this ticket does not change:

> **`openai-tts` structurally cannot** report usage. `POST /v1/audio/speech` returns raw PCM and no
> usage, while `gpt-4o-mini-tts` bills audio-out TOKENS. **Arm B's cascade total stays `null` and
> that is the finding, not a gap.**

## Scope — the realtime half only

Wire the usage the transport already reports through to the Run's cost, using the `priceRealtimeUsage`
Live already uses. Do not touch the cascade stages; that is 053.

## Acceptance criteria

- [ ] `UtteranceCompletion` carries `usage` as a typed field the runner can read (the transport
      already sends it; the type may not admit it)
- [ ] The runner captures per-utterance `usage` into its buckets, keyed by the same `utt` as every
      other bucket, and `attributeUtterances` reads it
- [ ] A realtime run's per-utterance `cost` is `priceRealtimeUsage(usage, model)` — **the same
      function Live calls**, not a second pricing path
- [ ] The Run's total is the sum of its priced utterances, and `measuredCostSamples` counts them —
      so `cost measured on 15 of 15 samples` becomes possible for Arm A
- [ ] **A turn whose `response.done` omits usage prices `null` for THAT turn only**, and the run's
      denominator says so. `priceRealtimeUsage` already nulls per turn — preserve that, never
      fabricate a blended figure across turns.
- [ ] A run with **no** usage anywhere keeps `cost: null` and `0 of N` — today's behaviour, pinned as
      the control so the fix cannot invent a figure
- [ ] `pricingVersion` is still stamped exactly as ticket 059 requires — the stamp says a price
      SOURCE was consulted, and it is written for failed and null-cost runs too
- [ ] **Cascade is untouched.** Arms B and C keep `cost: null` until 053 is implemented; assert it,
      so this ticket cannot quietly half-price a cascade run through the blended path.
- [ ] `isAggregatableRun` stays the ONE gate — no cost gate beside it, and `n` does not move because
      a run gained or lost a price

## Out of scope

- Ticket 053's cascade metering (MT tokens, ElevenLabs characters) — a separate, larger piece.
- Removing `transport.costPerMinUsd`. 053's AC wants it replaced wholesale; doing that here would
  drag the cascade in. Leave it, and leave it unconfigured.
- Re-running the sweep. Stored runs carry no usage, so **cost stays `not measured` on today's data
  even after this lands** — a re-run is what fills it.
- `gpt-realtime-mini`'s missing published text/cached rates (documented in `RATE_CARD`), and the
  `realtime-cached-tokens-are-a-subset` assumption, which stays `verified: false` until confirmed
  against a live `response.done` — an operator task.

## Notes

- The honest headline after this lands is still an asymmetry, not a full cost table: **Arm A priced,
  Arm C priceable once 053 is implemented, Arm B never.** FINDINGS.md already states that as a
  controllability finding — *one provider tells you what you spent and the others do not* — and this
  ticket makes the first half of it real rather than aspirational.
