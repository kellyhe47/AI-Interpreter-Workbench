/**
 * TICKET 052 — the cost model. There is none today: `costUnits: 0` is hardcoded
 * on both write paths and no pricing table exists anywhere, so every arm, every
 * run and every export reports `$0.00` — a FIGURE meaning "this configuration is
 * free", not "not measured".
 *
 * What these tests lock, in the ticket's own terms:
 *
 *  - AC1  a DECLARED, VERSIONED price source, stamped like `corpus-v1` /
 *         `wer-norm-v1` so a rate change visibly restates results
 *  - AC2  Arm A metered from what the provider reports (`response.done` usage),
 *         with INPUT AND OUTPUT PRICED SEPARATELY (2× for `gpt-realtime`)
 *  - AC3  cascade metered PER STAGE — three vendors, three rate cards
 *  - AC4  an uncomputable cost reports NOT MEASURED, never `$0.00`
 *  - AC6  aggregates sum real costs only; an unmeasured cost contributes
 *         nothing, not a silent zero
 *  - AC8  the ElevenLabs 1,000-character-per-request minimum is modelled
 *         EXPLICITLY and its unverified status is visible
 *  - AC9  `costPerMinUsd` is DERIVED (spend ÷ audio duration), and Live reports
 *         the cost SLOPE
 *
 * Nothing here asserts a dollar figure against a hardcoded copy of the same
 * figure: the expectations are either PRD §5's published rates (the external
 * source of truth, declared once at the top) or identities the model must
 * satisfy — 1M output tokens costs exactly 2× 1M input tokens; a split usage
 * costs exactly what its two halves cost apart; three 50-char requests cost
 * exactly 3× one floored request.
 */

import { describe, expect, it } from 'vitest';

import { ARMS, REALTIME_MODEL } from './arms';
import {
  COST_NOT_MEASURED_CELL,
  ELEVENLABS_MIN_CHARS_PER_REQUEST,
  PRICING_ASSUMPTIONS,
  PRICING_VERSION,
  assumptionsFor,
  costPerMinuteUsd,
  costSlope,
  formatCostUsd,
  isVerifiedPricing,
  priceCascade,
  priceRealtimeUsage,
  priceStage,
  rateFor,
  sumMeasuredCosts,
  type CostResult,
  type StageUsage,
} from './pricing';

/* --------------------------------------------------------------------------
 * PRD §5 "Published rates" — the EXTERNAL source of truth, transcribed once.
 * Do not invent prices; if a vendor moves one, this table and PRICING_VERSION
 * move together and the change is visible in every restated figure.
 * ----------------------------------------------------------------------- */

const MILLION = 1_000_000;

/** $/M tokens, input and output, for the token-billed models. */
const PUBLISHED_TOKEN_RATES: Array<{ model: string; inPerM: number; outPerM: number }> = [
  { model: 'gpt-realtime', inPerM: 32, outPerM: 64 },
  { model: 'gpt-realtime-mini', inPerM: 10, outPerM: 20 },
  { model: 'gpt-4o-mini', inPerM: 0.15, outPerM: 0.6 },
  // Audio OUT only; there is no published audio-in rate for the TTS model, and
  // a TTS stage consumes text in and emits audio out.
  { model: 'gpt-4o-mini-tts', inPerM: 0, outPerM: 12 },
];

/** $/minute of audio, for the per-minute-billed models. */
const PUBLISHED_MINUTE_RATES: Array<{ model: string; perMinute: number }> = [
  { model: 'gpt-4o-transcribe', perMinute: 0.006 },
];

/** $/1k characters, for the per-character-billed models. */
const PUBLISHED_CHARACTER_RATES: Array<{ model: string; perThousand: number }> = [
  { model: 'eleven_flash_v2_5', perThousand: 0.05 },
];

/** Which meter each PRD-priced model bills on. The three are NOT unifiable. */
const PUBLISHED_SHAPES: Array<{ model: string; shape: string }> = [
  ...PUBLISHED_TOKEN_RATES.map((r) => ({ model: r.model, shape: 'token' })),
  ...PUBLISHED_MINUTE_RATES.map((r) => ({ model: r.model, shape: 'per-minute' })),
  ...PUBLISHED_CHARACTER_RATES.map((r) => ({ model: r.model, shape: 'per-character' })),
];

/* ------------------------------------------------------------- test helpers -- */

/** Unwrap a cost that MUST be measured, failing loudly (never silently 0). */
function usdOf(cost: CostResult): number {
  expect(cost.measured).toBe(true);
  expect(cost.usd).not.toBeNull();
  return cost.usd as number;
}

function tokens(model: string, inputTokens: number, outputTokens: number): StageUsage {
  return { model, shape: 'token', inputTokens, outputTokens };
}

/** Floating-point-safe money comparison — rates like 0.15/M are not exact. */
function expectUsd(actual: number, expected: number): void {
  expect(actual).toBeCloseTo(expected, 10);
}

/* ================================================================ AC1 ===== */

describe('AC1 · the price source is declared and versioned', () => {
  it('carries a pricing version, the sibling of corpus-v1 / wer-norm-v1', () => {
    expect(PRICING_VERSION).toBe('pricing-v1');
  });

  it('stamps the version onto every cost it produces, measured or not', () => {
    const measured = priceStage(tokens('gpt-realtime', MILLION, 0));
    const unmeasured = priceStage(undefined);
    expect(measured.pricingVersion).toBe(PRICING_VERSION);
    expect(unmeasured.pricingVersion).toBe(PRICING_VERSION);
  });

  it('prices every stage model of every frozen arm — a menu entry with no rate is not free', () => {
    // Derived from ARMS rather than listed, so an arm gaining a stage whose
    // rate nobody added fails HERE rather than reporting that stage as free.
    const armModels = new Set<string>();
    for (const arm of ARMS) {
      if (arm.config.architecture === 'realtime') {
        armModels.add(arm.config.realtimeModel ?? REALTIME_MODEL);
        continue;
      }
      const triple = arm.config.providers!;
      armModels.add(triple.stt);
      armModels.add(triple.mt);
      armModels.add(triple.tts);
    }
    for (const model of armModels) {
      expect(rateFor(model), `no published rate for arm model "${model}"`).toBeDefined();
    }
  });

  it('refuses to price a model it does not know — unpriced is UNMEASURED, never free', () => {
    const cost = priceStage(tokens('some-model-nobody-priced', MILLION, MILLION));
    expect(cost.measured).toBe(false);
    expect(cost.usd).toBeNull();
    expect(cost).toMatchObject({ reason: 'unknown-model' });
  });
});

/* ================================================================ AC2 ===== */

describe('AC2 · billing shapes and directions are never collapsed', () => {
  it.each(PUBLISHED_SHAPES)('$model bills on the $shape meter', ({ model, shape }) => {
    expect(rateFor(model)?.shape).toBe(shape);
  });

  it.each(PUBLISHED_TOKEN_RATES)(
    '$model prices 1M input tokens at $inPerM and 1M output tokens at $outPerM',
    ({ model, inPerM, outPerM }) => {
      expectUsd(usdOf(priceStage(tokens(model, MILLION, 0))), inPerM);
      expectUsd(usdOf(priceStage(tokens(model, 0, MILLION))), outPerM);
    },
  );

  it('prices gpt-realtime output at exactly 2x input — collapsing the two halves or doubles the figure', () => {
    const inputOnly = usdOf(priceStage(tokens(REALTIME_MODEL, MILLION, 0)));
    const outputOnly = usdOf(priceStage(tokens(REALTIME_MODEL, 0, MILLION)));
    // The identity, not the literals: a single blended token rate makes these
    // two equal, and the ratio is what says the direction of traffic matters.
    expect(inputOnly).not.toBe(outputOnly);
    expectUsd(outputOnly / inputOnly, 2);
  });

  it('prices a mixed turn as its two halves priced apart', () => {
    const mixed = usdOf(priceStage(tokens(REALTIME_MODEL, 400_000, 900_000)));
    const halves =
      usdOf(priceStage(tokens(REALTIME_MODEL, 400_000, 0))) +
      usdOf(priceStage(tokens(REALTIME_MODEL, 0, 900_000)));
    expectUsd(mixed, halves);
    // A model that summed the token counts first and applied ONE rate would
    // land on one of these instead, and both are wrong.
    const inRate = PUBLISHED_TOKEN_RATES.find((r) => r.model === REALTIME_MODEL)!;
    expect(mixed).not.toBeCloseTo((1_300_000 / MILLION) * inRate.inPerM, 6);
    expect(mixed).not.toBeCloseTo((1_300_000 / MILLION) * inRate.outPerM, 6);
  });

  it.each(PUBLISHED_MINUTE_RATES)(
    '$model bills per minute of audio, linearly in duration',
    ({ model, perMinute }) => {
      const oneMinute = usdOf(priceStage({ model, shape: 'per-minute', audioMs: 60_000 }));
      const twoMinutes = usdOf(priceStage({ model, shape: 'per-minute', audioMs: 120_000 }));
      expectUsd(oneMinute, perMinute);
      expectUsd(twoMinutes, oneMinute * 2);
    },
  );

  it('rejects usage metered in the wrong shape for the model', () => {
    // Handing the per-minute STT model a token count is not a zero-cost stage;
    // it is a stage nobody metered correctly.
    const cost = priceStage(tokens('gpt-4o-transcribe', 10_000, 10_000));
    expect(cost.measured).toBe(false);
    expect(cost.usd).toBeNull();
    expect(cost).toMatchObject({ reason: 'shape-mismatch' });
  });
});

describe('AC2 · Arm A is metered from what the provider reports', () => {
  /** The `response.done` envelope, as the Realtime API sends it. */
  const usage = {
    input_token_details: { audio_tokens: 500_000, text_tokens: 0 },
    output_token_details: { audio_tokens: 250_000, text_tokens: 0 },
  };

  it('prices audio-in and audio-out from response.done at their own rates', () => {
    const cost = priceRealtimeUsage(usage, REALTIME_MODEL);
    const expected =
      usdOf(priceStage(tokens(REALTIME_MODEL, 500_000, 0))) +
      usdOf(priceStage(tokens(REALTIME_MODEL, 0, 250_000)));
    expectUsd(usdOf(cost), expected);
  });

  it('does not treat the two directions as interchangeable', () => {
    const asSent = usdOf(priceRealtimeUsage(usage, REALTIME_MODEL));
    const reversed = usdOf(
      priceRealtimeUsage(
        {
          input_token_details: { audio_tokens: 250_000 },
          output_token_details: { audio_tokens: 500_000 },
        },
        REALTIME_MODEL,
      ),
    );
    // Same 750k tokens, opposite direction. Under one blended rate these are
    // equal; under the published 2x split the reversed turn costs more.
    expect(reversed).toBeGreaterThan(asSent);
  });

  it('reports NOT MEASURED when response.done carried no usage', () => {
    for (const absent of [undefined, null, {}, { input_token_details: {} }]) {
      const cost = priceRealtimeUsage(absent, REALTIME_MODEL);
      expect(cost.measured, JSON.stringify(absent)).toBe(false);
      expect(cost.usd).toBeNull();
      expect(cost).toMatchObject({ reason: 'no-usage-reported' });
    }
  });
});

/* ================================================================ AC3 ===== */

describe('AC3 · cascade is metered per stage, not blended', () => {
  const sttUsage: StageUsage = {
    model: 'gpt-4o-transcribe',
    shape: 'per-minute',
    audioMs: 30_000,
  };
  const mtUsage: StageUsage = tokens('gpt-4o-mini', 400, 120);
  const openAiTtsUsage: StageUsage = tokens('gpt-4o-mini-tts', 0, 3_000);
  const elevenTtsUsage: StageUsage = {
    model: 'eleven_flash_v2_5',
    shape: 'per-character',
    requestCharCounts: [120, 140, 160],
  };

  it('reports one cost per stage, each priced on its own vendor rate card', () => {
    const cost = priceCascade({ stt: sttUsage, mt: mtUsage, tts: openAiTtsUsage });
    expectUsd(usdOf(cost.perStage.stt), usdOf(priceStage(sttUsage)));
    expectUsd(usdOf(cost.perStage.mt), usdOf(priceStage(mtUsage)));
    expectUsd(usdOf(cost.perStage.tts), usdOf(priceStage(openAiTtsUsage)));
    // The three are genuinely different numbers; a blended model that divided
    // one total three ways would make them equal.
    const three = [cost.perStage.stt, cost.perStage.mt, cost.perStage.tts].map(usdOf);
    expect(new Set(three).size).toBe(3);
  });

  it('totals to the sum of its stages', () => {
    const cost = priceCascade({ stt: sttUsage, mt: mtUsage, tts: openAiTtsUsage });
    const summed =
      usdOf(cost.perStage.stt) + usdOf(cost.perStage.mt) + usdOf(cost.perStage.tts);
    expectUsd(usdOf(cost.total), summed);
  });

  it('attributes an Arm B / Arm C difference to the TTS stage alone', () => {
    // Experiment 2's entire question. Swapping ONLY the TTS stage must move the
    // TTS number and the total, and must leave STT and MT byte-identical.
    const armB = priceCascade({ stt: sttUsage, mt: mtUsage, tts: openAiTtsUsage });
    const armC = priceCascade({ stt: sttUsage, mt: mtUsage, tts: elevenTtsUsage });

    expectUsd(usdOf(armC.perStage.stt), usdOf(armB.perStage.stt));
    expectUsd(usdOf(armC.perStage.mt), usdOf(armB.perStage.mt));
    expect(usdOf(armC.perStage.tts)).not.toBeCloseTo(usdOf(armB.perStage.tts), 8);

    const stageDelta = usdOf(armC.perStage.tts) - usdOf(armB.perStage.tts);
    const totalDelta = usdOf(armC.total) - usdOf(armB.total);
    expectUsd(totalDelta, stageDelta);
  });

  it('does not invent a total when a stage was never metered', () => {
    const cost = priceCascade({ stt: sttUsage, mt: undefined, tts: openAiTtsUsage });
    expect(cost.total.measured).toBe(false);
    expect(cost.total.usd).toBeNull();
    expect(cost.total).toMatchObject({ reason: 'stage-unmeasured' });
    // Attribution survives the hole: the stages that WERE metered still report.
    expect(cost.perStage.stt.measured).toBe(true);
    expect(cost.perStage.tts.measured).toBe(true);
    expect(cost.perStage.mt.measured).toBe(false);
  });
});

/* ================================================================ AC8 ===== */

describe('AC8 · the ElevenLabs 1,000-character-per-request minimum', () => {
  const RATE_PER_THOUSAND = PUBLISHED_CHARACTER_RATES[0]!.perThousand;
  const MODEL = PUBLISHED_CHARACTER_RATES[0]!.model;

  function chars(requestCharCounts: number[]): StageUsage {
    return { model: MODEL, shape: 'per-character', requestCharCounts };
  }

  it('names the minimum as a visible constant, not as buried arithmetic', () => {
    expect(ELEVENLABS_MIN_CHARS_PER_REQUEST).toBe(1000);
  });

  it('bills a short request at the floor, not at its character count', () => {
    expectUsd(usdOf(priceStage(chars([50]))), RATE_PER_THOUSAND);
  });

  it('bills a long request at its actual characters', () => {
    // Above the floor there is no rounding up to the next thousand.
    expectUsd(usdOf(priceStage(chars([2_500]))), 2.5 * RATE_PER_THOUSAND);
  });

  it('applies the floor PER REQUEST — chunked streaming costs a multiple of the naive character count', () => {
    // THE TRAP. Arm C streams translated text in chunks. Twelve 100-char chunks
    // are twelve billed requests, not 1,200 billed characters.
    const chunked = usdOf(priceStage(chars(Array<number>(12).fill(100))));
    const oneShot = usdOf(priceStage(chars([1_200])));

    expectUsd(chunked, 12 * RATE_PER_THOUSAND);
    expectUsd(chunked / oneShot, 10);
    // A model that multiplied TOTAL characters by the rate reports the same
    // 1,200 characters for both, and Arm C comes out 10x too cheap.
    expect(chunked).not.toBeCloseTo(oneShot, 8);
  });

  it('is declared as an UNVERIFIED assumption until checked against a real invoice', () => {
    const assumptions = assumptionsFor(MODEL);
    expect(assumptions.length).toBeGreaterThan(0);
    expect(assumptions.some((a) => !a.verified)).toBe(true);
    expect(PRICING_ASSUMPTIONS).toEqual(expect.arrayContaining(assumptions));
    // The statement has to SAY what is assumed; an unlabelled flag teaches the
    // reader nothing about why the figure is provisional.
    const text = assumptions.map((a) => a.statement).join(' ');
    expect(text).toMatch(/1,?000|minimum/i);
    expect(text).toMatch(/request|chunk/i);
  });

  it('labels every Arm C cost figure unverified, and every Arm B one verified', () => {
    expect(isVerifiedPricing(MODEL)).toBe(false);
    expect(isVerifiedPricing('gpt-4o-mini-tts')).toBe(true);

    const armC = priceCascade({
      stt: { model: 'gpt-4o-transcribe', shape: 'per-minute', audioMs: 30_000 },
      mt: tokens('gpt-4o-mini', 400, 120),
      tts: chars([300, 300]),
    });
    const armB = priceCascade({
      stt: { model: 'gpt-4o-transcribe', shape: 'per-minute', audioMs: 30_000 },
      mt: tokens('gpt-4o-mini', 400, 120),
      tts: tokens('gpt-4o-mini-tts', 0, 3_000),
    });
    // Unverified is CONTAGIOUS upward: a total containing an unverified stage
    // is itself unverified, or the label is escapable by aggregation.
    expect(armC.perStage.tts.verified).toBe(false);
    expect(armC.total.verified).toBe(false);
    expect(armB.total.verified).toBe(true);
  });
});

/* ================================================================ AC9 ===== */

describe('AC9 · cost per minute is derived, and Live reports the slope', () => {
  const spend = (): CostResult => priceStage(tokens(REALTIME_MODEL, MILLION, MILLION));

  it('divides metered spend by audio duration', () => {
    const total = usdOf(spend());
    expectUsd(costPerMinuteUsd(spend(), 120_000)!, total / 2);
    expectUsd(costPerMinuteUsd(spend(), 30_000)!, total * 2);
  });

  it('returns null — never 0 — for an unmeasured spend or an unknown duration', () => {
    expect(costPerMinuteUsd(priceStage(undefined), 60_000)).toBeNull();
    expect(costPerMinuteUsd(spend(), 0)).toBeNull();
  });

  it('reports the climb from minute 1 to the final minute', () => {
    // Realtime replays the accumulated conversation each turn, so the per-minute
    // cost CLIMBS. The climb is the finding for Arm A.
    const minutes = [
      priceStage(tokens(REALTIME_MODEL, 100_000, 100_000)),
      priceStage(tokens(REALTIME_MODEL, 200_000, 200_000)),
      priceStage(tokens(REALTIME_MODEL, 400_000, 400_000)),
    ];
    const slope = costSlope(minutes);
    expectUsd(slope.minute1UsdPerMin!, usdOf(minutes[0]!));
    expectUsd(slope.finalMinuteUsdPerMin!, usdOf(minutes[2]!));
    expectUsd(slope.slopeUsdPerMin!, usdOf(minutes[2]!) - usdOf(minutes[0]!));
    expect(slope.slopeUsdPerMin!).toBeGreaterThan(0);
  });

  it('reports no slope for a clip too short to show one', () => {
    // PRD §8: a <=1-minute clip accumulates almost no conversation context, so
    // it cannot show the climb. Null, not 0 — 0 would claim a flat cost curve.
    const slope = costSlope([priceStage(tokens(REALTIME_MODEL, 100_000, 100_000))]);
    expect(slope.slopeUsdPerMin).toBeNull();
    expect(slope.finalMinuteUsdPerMin).toBeNull();
  });
});

/* =========================================================== AC4 · AC6 ===== */

describe('AC4 · an uncomputable cost reports NOT MEASURED, never $0.00', () => {
  it('formats an unmeasured cost as the not-measured cell', () => {
    const unmeasured = priceStage(undefined);
    expect(formatCostUsd(unmeasured)).toBe(COST_NOT_MEASURED_CELL);
    expect(formatCostUsd(null)).toBe(COST_NOT_MEASURED_CELL);
  });

  it('never renders an unmeasured cost as any kind of zero dollars', () => {
    for (const cost of [
      priceStage(undefined),
      priceRealtimeUsage({}, REALTIME_MODEL),
      priceCascade({ stt: undefined, mt: undefined, tts: undefined }).total,
    ]) {
      const rendered = formatCostUsd(cost);
      expect(rendered).not.toMatch(/^\$0(\.0*)?$/);
      expect(rendered).not.toContain('$');
      expect(rendered).toBe(COST_NOT_MEASURED_CELL);
    }
  });

  it('still renders a measured figure as dollars', () => {
    const measured = priceStage(tokens(REALTIME_MODEL, MILLION, 0));
    expect(formatCostUsd(measured)).toMatch(/^\$\d/);
    expect(formatCostUsd(measured)).not.toBe(COST_NOT_MEASURED_CELL);
  });
});

describe('AC6 · aggregates sum real costs only', () => {
  const a = (): CostResult => priceStage(tokens('gpt-4o-mini', MILLION, 0));
  const b = (): CostResult => priceStage(tokens('gpt-4o-mini', 0, MILLION));
  const unmeasured = (): CostResult => priceStage(undefined);

  it('sums the measured costs and says how many there were', () => {
    const sum = sumMeasuredCosts([a(), b()]);
    expectUsd(sum.usd!, usdOf(a()) + usdOf(b()));
    expect(sum.measured).toBe(2);
    expect(sum.total).toBe(2);
  });

  it('an unmeasured cost contributes nothing and is DISCLOSED, not silently zeroed', () => {
    const sum = sumMeasuredCosts([a(), unmeasured(), b(), null]);
    // The dollars alone cannot distinguish "contributed nothing" from
    // "contributed a zero" — the denominator is what makes it honest.
    expectUsd(sum.usd!, usdOf(a()) + usdOf(b()));
    expect(sum.measured).toBe(2);
    expect(sum.total).toBe(4);
  });

  it('reports null — never 0 — when nothing in the set was measured', () => {
    const sum = sumMeasuredCosts([unmeasured(), null, undefined]);
    expect(sum.usd).toBeNull();
    expect(sum.measured).toBe(0);
    expect(sum.total).toBe(3);
    expect(formatCostUsd(sum.usd)).toBe(COST_NOT_MEASURED_CELL);
  });

  it('does not let an unmeasured member understate the arm it belongs to', () => {
    // The same failure as `$0.00` one level up: three samples of which one was
    // never metered must not report the mean of three when two were measured.
    const withHole = sumMeasuredCosts([a(), a(), unmeasured()]);
    const withoutHole = sumMeasuredCosts([a(), a()]);
    expectUsd(withHole.usd!, withoutHole.usd!);
    expect(withHole.measured).toBe(withoutHole.measured);
    expect(withHole.total).not.toBe(withoutHole.total);
  });
});
