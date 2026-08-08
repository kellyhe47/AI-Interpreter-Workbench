/**
 * TICKET 052 ROUND 2 — R2-7 / R2-8a. The malformed-envelope edges of the cost
 * model, where a metering FAULT can quietly become a measured FREE turn.
 *
 * `pricing.realtime.test.ts` pins the well-formed cached-token arithmetic. This
 * file pins what happens when the envelope is INTERNALLY INCONSISTENT or
 * carries a nonsense count — the cases where the existing code returns
 * `measured: true, usd: 0` or silently full-prices a slice it was told was
 * cached. Every one of them ends as the same wrong claim: "this turn was free",
 * which is the `$0.00` this whole ticket exists to delete, arriving through the
 * back door of a bad input rather than a missing model.
 *
 * THE RULE, in both directions:
 *   - `cached_tokens` and `cached_tokens_details` DISAGREEING is a fault in the
 *     report, not a licence to price the remainder at full rate. Refuse.
 *   - A NEGATIVE count is not "zero of that thing". It is a number nobody can
 *     act on, so the field is UNREPORTED and the envelope is judged without it.
 *   - An empty `requestCharCounts` on a TTS stage that ran is a metering HOLE.
 *     A synthesis stage that produced audio made at least one request.
 */

import { describe, expect, it } from 'vitest';

import { REALTIME_MODEL } from './arms';
import { RATE_CARD, priceRealtimeUsage, priceStage, type CostResult, type TokenRate } from './pricing';

const RT = RATE_CARD[REALTIME_MODEL] as TokenRate;

/** Unwrap a cost that MUST be measured. */
function usdOf(cost: CostResult): number {
  expect(cost.measured).toBe(true);
  return cost.usd as number;
}

function expectUnmeasured(cost: CostResult, reason: string): void {
  expect(cost.measured).toBe(false);
  expect(cost.usd).toBeNull();
  expect(cost).toMatchObject({ reason });
}

describe('R2-7 · a cached breakdown that contradicts its own total is REFUSED', () => {
  it('does not discount when cached_tokens says 0 but the details claim 600k', () => {
    // The details are the only thing the arithmetic reads today, so this
    // envelope applies a $0.40/M discount to 600k tokens the envelope's own
    // total says were never cached — an 80x under-bill from a self-contradiction.
    const cost = priceRealtimeUsage(
      {
        input_token_details: {
          audio_tokens: 1_000_000,
          cached_tokens: 0,
          cached_tokens_details: { audio_tokens: 600_000 },
        },
        output_token_details: { audio_tokens: 0 },
      },
      REALTIME_MODEL,
    );
    expectUnmeasured(cost, 'shape-mismatch');
  });

  it('does not silently full-price the remainder when the details under-report', () => {
    // cached_tokens: 600k, details summing to 100k. The 500k difference is
    // priced at $32/M today with nothing said about it — a confident number
    // built on an envelope that disagrees with itself.
    const cost = priceRealtimeUsage(
      {
        input_token_details: {
          audio_tokens: 1_000_000,
          text_tokens: 0,
          cached_tokens: 600_000,
          cached_tokens_details: { audio_tokens: 100_000, text_tokens: 0 },
        },
        output_token_details: { audio_tokens: 0 },
      },
      REALTIME_MODEL,
    );
    expectUnmeasured(cost, 'shape-mismatch');
  });

  it('still prices an envelope whose details agree with its total', () => {
    // The control. Refusing a mismatch must not refuse the well-formed case,
    // or the guard would delete the measurement it exists to protect.
    const cost = priceRealtimeUsage(
      {
        input_token_details: {
          audio_tokens: 1_000_000,
          text_tokens: 0,
          cached_tokens: 600_000,
          cached_tokens_details: { audio_tokens: 600_000, text_tokens: 0 },
        },
        output_token_details: { audio_tokens: 0, text_tokens: 0 },
      },
      REALTIME_MODEL,
    );
    // Disjoint slices, derived from the card: 400k uncached + 600k cached.
    const expected =
      (400_000 * RT.inputPerMillionUsd + 600_000 * (RT.cachedInputPerMillionUsd ?? 0)) / 1_000_000;
    expect(usdOf(cost)).toBeCloseTo(expected, 10);
  });
});

describe('R2-7 · a negative count is UNREPORTED, never a measured free turn', () => {
  it('refuses an envelope whose only numbers are negative', () => {
    // `measured: true, usd: 0` here is the worst possible answer: a malformed
    // count becomes the claim that the turn cost nothing.
    const cost = priceRealtimeUsage(
      {
        input_token_details: { audio_tokens: -5 },
        output_token_details: { audio_tokens: -1 },
      },
      REALTIME_MODEL,
    );
    expectUnmeasured(cost, 'no-usage-reported');
  });

  it('prices the fields that ARE reported when one of them is nonsense', () => {
    const cost = priceRealtimeUsage(
      {
        input_token_details: { audio_tokens: -5 },
        output_token_details: { audio_tokens: 250_000 },
      },
      REALTIME_MODEL,
    );
    // The negative input is dropped, not clamped into a discount and not
    // allowed to drag the total below the output it definitely owes.
    expect(usdOf(cost)).toBeCloseTo((250_000 * RT.outputPerMillionUsd) / 1_000_000, 10);
    expect(usdOf(cost)).toBeGreaterThan(0);
  });

  it('never returns a negative dollar figure', () => {
    const cost = priceRealtimeUsage(
      {
        input_token_details: { audio_tokens: -1_000_000, text_tokens: -1_000_000 },
        output_token_details: { audio_tokens: 1_000 },
      },
      REALTIME_MODEL,
    );
    expect(usdOf(cost)).toBeGreaterThan(0);
  });
});

describe('R2-8a · an empty request list is a metering HOLE, not a free stage', () => {
  it('reports NOT MEASURED for a per-character stage with no recorded requests', () => {
    // A TTS stage that ran made at least one request. Zero recorded requests
    // means nobody counted them — and `measured(0)` would publish Arm C, the
    // arm the 1k-char floor may make the most expensive in the study, as free.
    expectUnmeasured(
      priceStage({ model: 'eleven_flash_v2_5', shape: 'per-character', requestCharCounts: [] }),
      'no-usage-reported',
    );
  });

  it('prices a single recorded request', () => {
    // The control: the guard above must not swallow a real one-request turn.
    const cost = priceStage({
      model: 'eleven_flash_v2_5',
      shape: 'per-character',
      requestCharCounts: [1_200],
    });
    expect(usdOf(cost)).toBeGreaterThan(0);
  });
});
