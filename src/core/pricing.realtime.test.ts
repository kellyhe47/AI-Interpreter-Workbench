/**
 * TICKET 052, round 2 — the Realtime `response.done` SUB-METERS.
 *
 * `pricing.test.ts` (locked) pins the audio meters and the 2× input/output
 * identity. It does NOT reach the two sub-meters `response.done` also reports,
 * and those are where the bug this file was written for lived:
 *
 *  - CACHED INPUT IS A DISCOUNT ON A SUBSET, NOT A SURCHARGE. The meter this
 *    replaces added `cached_tokens × $0.40/M` ON TOP of the same tokens already
 *    counted in `audio_tokens × $32/M`, billing cached input at $32.40/M —
 *    MORE than uncached input. That inverts prompt caching, which PRD §17 24b
 *    names as a Large-impact confound precisely because $0.40/M against $32/M
 *    is a two-order-of-magnitude difference in the direction of the finding.
 *
 *  - TEXT IS BILLED APART FROM AUDIO on both sides.
 *
 * EVERY ASSERTION HERE IS AN ABSOLUTE DOLLAR FIGURE for a known token count,
 * deliberately: a ratio test survives every rate in the card being wrong by the
 * same factor, and the rates are the one thing a cost model cannot derive.
 */

import { describe, expect, it } from 'vitest';

import { REALTIME_MODEL } from './arms';
import {
  PRICING_ASSUMPTIONS,
  assumptionsFor,
  isVerifiedPricing,
  priceRealtimeUsage,
  type CostResult,
} from './pricing';

const MILLION = 1_000_000;

function usdOf(cost: CostResult): number {
  expect(cost.measured).toBe(true);
  return cost.usd as number;
}

function expectUsd(actual: number, expected: number): void {
  expect(actual).toBeCloseTo(expected, 10);
}

describe('the published gpt-realtime meters, as absolute dollars', () => {
  it('bills 1M audio-in at $32 and 1M audio-out at $64', () => {
    expectUsd(
      usdOf(priceRealtimeUsage({ input_token_details: { audio_tokens: MILLION } }, REALTIME_MODEL)),
      32,
    );
    expectUsd(
      usdOf(priceRealtimeUsage({ output_token_details: { audio_tokens: MILLION } }, REALTIME_MODEL)),
      64,
    );
  });

  it('bills 1M text-in at $4 and 1M text-out at $16 — NOT at the audio rate', () => {
    const textIn = usdOf(
      priceRealtimeUsage({ input_token_details: { text_tokens: MILLION } }, REALTIME_MODEL),
    );
    const textOut = usdOf(
      priceRealtimeUsage({ output_token_details: { text_tokens: MILLION } }, REALTIME_MODEL),
    );
    expectUsd(textIn, 4);
    expectUsd(textOut, 16);
    // A model that folded text into the audio meter lands on 32 / 64 instead.
    expect(textIn).not.toBeCloseTo(32, 6);
    expect(textOut).not.toBeCloseTo(64, 6);
  });
});

describe('cached input is a DISCOUNT on a subset, never a surcharge', () => {
  /** 1M audio-in, of which 600k came from cache. */
  const partlyCached = {
    input_token_details: {
      audio_tokens: MILLION,
      cached_tokens: 600_000,
      cached_tokens_details: { audio_tokens: 600_000, text_tokens: 0 },
    },
  };

  it('re-prices the cached slice at $0.40/M and the rest at $32/M', () => {
    // 400k × $32/M + 600k × $0.40/M = 12.80 + 0.24
    expectUsd(usdOf(priceRealtimeUsage(partlyCached, REALTIME_MODEL)), 13.04);
  });

  it('makes a cached turn CHEAPER than the identical uncached turn', () => {
    // THE INVERTED BUG, stated as the thing it broke. The old meter added the
    // cached term on top and produced $32.24 — dearer than the $32 uncached
    // turn, i.e. caching reported as a cost INCREASE.
    const uncached = usdOf(
      priceRealtimeUsage({ input_token_details: { audio_tokens: MILLION } }, REALTIME_MODEL),
    );
    const cached = usdOf(priceRealtimeUsage(partlyCached, REALTIME_MODEL));
    expect(cached).toBeLessThan(uncached);
    expect(cached).not.toBeCloseTo(32.24, 6);
  });

  it('never bills a token twice — a fully cached turn costs exactly the cached rate', () => {
    const fully = priceRealtimeUsage(
      {
        input_token_details: {
          audio_tokens: MILLION,
          cached_tokens: MILLION,
          cached_tokens_details: { audio_tokens: MILLION },
        },
      },
      REALTIME_MODEL,
    );
    expectUsd(usdOf(fully), 0.4);
  });

  it('splits the cached subset across its own modalities', () => {
    // 1M audio (200k cached) + 1M text (500k cached):
    //   800k×32/M + 200k×0.4/M + 500k×4/M + 500k×0.4/M
    //   = 25.6 + 0.08 + 2 + 0.2
    const cost = priceRealtimeUsage(
      {
        input_token_details: {
          audio_tokens: MILLION,
          text_tokens: MILLION,
          cached_tokens: 700_000,
          cached_tokens_details: { audio_tokens: 200_000, text_tokens: 500_000 },
        },
      },
      REALTIME_MODEL,
    );
    expectUsd(usdOf(cost), 27.88);
  });

  it('reports NOT MEASURED when a cached count arrives with no breakdown', () => {
    // Cached audio and cached text re-price from different meters, so a lump
    // count leaves the split unknown. Falling back to the additive form is what
    // produced the 80× overbill; unmeasured is the honest answer.
    const cost = priceRealtimeUsage(
      { input_token_details: { audio_tokens: MILLION, cached_tokens: 600_000 } },
      REALTIME_MODEL,
    );
    expect(cost.measured).toBe(false);
    expect(cost.usd).toBeNull();
    expect(cost).toMatchObject({ reason: 'shape-mismatch' });
  });
});

describe('the subset reading is declared UNVERIFIED until a live response confirms it', () => {
  it('names the assumption against the realtime models, visibly', () => {
    const assumptions = assumptionsFor(REALTIME_MODEL);
    expect(assumptions.length).toBeGreaterThan(0);
    expect(PRICING_ASSUMPTIONS).toEqual(expect.arrayContaining(assumptions));
    const text = assumptions.map((a) => a.statement).join(' ');
    expect(text.toLowerCase()).toContain('cached');
    expect(text.toLowerCase()).toMatch(/subset/);
    expect(assumptions.some((a) => !a.verified)).toBe(true);
  });

  it('labels every realtime figure unverified while the assumption stands', () => {
    expect(isVerifiedPricing(REALTIME_MODEL)).toBe(false);
    const cost = priceRealtimeUsage(
      { input_token_details: { audio_tokens: 1000 } },
      REALTIME_MODEL,
    );
    expect(cost.verified).toBe(false);
  });
});
