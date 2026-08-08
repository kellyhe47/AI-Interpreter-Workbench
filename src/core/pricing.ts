/**
 * TICKET 052 — THE PRICE SOURCE. Isomorphic TypeScript: no node, no DOM
 * (src/core is compiled by BOTH tsconfigs).
 *
 * THE FOUR RULES THIS MODULE EXISTS TO ENFORCE
 *
 * 1. THE RATE TABLE IS A DECLARED, VERSIONED CONTROL — `PRICING_VERSION`, the
 *    sibling of `CORPUS_VERSION` ('corpus-v1') and `WER_NORMALIZATION_VERSION`
 *    ('wer-norm-v1'). A vendor changing its rates must visibly RESTATE results,
 *    not silently move them, so the version is stamped onto every `CostResult`
 *    and disclosed in provenance.
 *
 * 2. THE BILLING SHAPES ARE NOT COLLAPSIBLE. Three genuinely different meters
 *    (PRD §5): token-billed (realtime, MT, OpenAI TTS), per-MINUTE (OpenAI STT)
 *    and per-CHARACTER (ElevenLabs). One blended $/min hides exactly the
 *    per-stage attribution Experiment 2 exists to produce. And INPUT AND OUTPUT
 *    ARE BILLED AT DIFFERENT RATES — 2× for `gpt-realtime` — so collapsing them
 *    into one token rate halves or doubles the figure depending on which way the
 *    traffic ran.
 *
 * 3. UNMEASURED IS NOT ZERO. A run whose cost cannot be computed yields an
 *    `UnmeasuredCost` (`usd: null`), which renders as `COST_NOT_MEASURED_CELL`
 *    and NEVER as `$0.00`. `$0.00` is a figure and it reads as "this
 *    configuration is free". Aggregates therefore sum MEASURED costs only and
 *    report how many of their samples carried one — a silent zero understates an
 *    arm, which is the same failure wearing a different hat.
 *
 * 4. THE ELEVENLABS 1k-CHARACTER MINIMUM IS MODELLED EXPLICITLY (PRD §5, "Known
 *    cost trap"). ElevenLabs bills a 1,000-character MINIMUM PER REQUEST, and
 *    Arm C streams translated text in CHUNKS. A model that multiplies total
 *    characters by the rate reports Arm C as cheap when it may be the most
 *    expensive arm in the study. So `per-character` usage is a LIST OF REQUESTS,
 *    never a total, and until the aggregate-vs-per-chunk question is settled
 *    against a real invoice the assumption is carried in `PRICING_ASSUMPTIONS`
 *    with `verified: false` and every Arm C figure is labelled unverified.
 */

import { REALTIME_MODEL } from './arms';

/* ------------------------------------------------------------ the control -- */

/**
 * The declared price-source version, stamped on every `CostResult`. Bump it
 * whenever a rate in `RATE_CARD` moves, so a restated figure is visible.
 */
export const PRICING_VERSION = 'pricing-v1';

/** How an unmeasurable cost renders. NEVER `$0.00`, never a bare blank. */
export const COST_NOT_MEASURED_CELL = 'not measured';

/**
 * PRD §5's known cost trap: ElevenLabs bills a 1,000-character MINIMUM per
 * request. Named here, in the pricing module, rather than buried in arithmetic.
 */
export const ELEVENLABS_MIN_CHARS_PER_REQUEST = 1000;

/* -------------------------------------------------------------- rate card -- */

/** The three meters. Deliberately not unifiable — see rule 2 above. */
export type BillingShape = 'token' | 'per-minute' | 'per-character';

/**
 * Token-billed. Input and output are SEPARATE rates, always.
 *
 * `inputPerMillionUsd` / `outputPerMillionUsd` are the AUDIO meters for the
 * realtime models and the only meters for the text-only ones — they are what
 * `priceStage` applies, and PRD §5 publishes exactly them.
 *
 * The optional fields below exist because the Realtime API's `response.done`
 * breaks ONE side into sub-meters that bill at genuinely different prices.
 * They are read only by `priceRealtimeUsage`, which is the only caller that
 * has the breakdown; `priceStage` never sees it and never guesses at one.
 */
export interface TokenRate {
  shape: 'token';
  inputPerMillionUsd: number;
  outputPerMillionUsd: number;
  /** Text INPUT, when the vendor bills it apart from audio input. */
  textInputPerMillionUsd?: number;
  /** Text OUTPUT, when the vendor bills it apart from audio output. */
  textOutputPerMillionUsd?: number;
  /**
   * CACHED audio input. A DISCOUNT ON A SUBSET, never a surcharge: cached
   * tokens are already inside `audio_tokens`, so they are subtracted from the
   * full-price count and re-priced here. Adding them on top bills cached input
   * at MORE than uncached input, inverting the effect PRD §17 24b names as a
   * Large-impact confound — $0.40/M against $32/M is the entire point of
   * prompt caching.
   */
  cachedInputPerMillionUsd?: number;
  /** CACHED text input — the same subtract-then-re-price rule. */
  cachedTextInputPerMillionUsd?: number;
}

/** Per-minute of audio (OpenAI STT). */
export interface MinuteRate {
  shape: 'per-minute';
  perMinuteUsd: number;
}

/** Per-character, with a per-REQUEST floor (ElevenLabs). */
export interface CharacterRate {
  shape: 'per-character';
  perThousandCharsUsd: number;
  /** Characters billed for a request shorter than this. 0 = no floor. */
  minimumCharsPerRequest: number;
}

export type Rate = TokenRate | MinuteRate | CharacterRate;

/**
 * PRD §5 "Published rates", keyed by MODEL ID (the same ids `arms.ts` MENUS and
 * `models.ts` use). Verify at build time; the cost model computes from METERED
 * usage and never from a guess.
 */
export const RATE_CARD: Readonly<Record<string, Rate>> = Object.freeze({
  /* Arm A's pinned snapshot: $32/M audio-in, $64/M audio-out. The 2× is the
   * whole reason input and output are separate fields. */
  'gpt-realtime': {
    shape: 'token',
    inputPerMillionUsd: 32,
    outputPerMillionUsd: 64,
    // NOT FROM PRD §5, which publishes the audio meters only. These are
    // OpenAI's published `gpt-realtime` text and cached-input rates, named
    // HERE — in the versioned rate card — rather than left as bare constants
    // in a view, so a rate change restates results visibly like any other.
    textInputPerMillionUsd: 4,
    textOutputPerMillionUsd: 16,
    cachedInputPerMillionUsd: 0.4,
    cachedTextInputPerMillionUsd: 0.4,
  },
  /* Development only — never an arm. Priced so a dev run is not free either.
   * No text or cached sub-rates are declared: none is published in PRD §5 and
   * inventing one for a dev model would be a number nobody sourced. Text and
   * cached tokens therefore price at the audio meter here, which OVERSTATES a
   * dev run — the safe direction for a figure nothing reports. */
  'gpt-realtime-mini': { shape: 'token', inputPerMillionUsd: 10, outputPerMillionUsd: 20 },
  /* The cascade STT stage bills on WALL-CLOCK AUDIO, not tokens. */
  'gpt-4o-transcribe': { shape: 'per-minute', perMinuteUsd: 0.006 },
  /* The cascade MT stage. */
  'gpt-4o-mini': { shape: 'token', inputPerMillionUsd: 0.15, outputPerMillionUsd: 0.6 },
  /* Arm B's TTS stage. PRD §5 publishes an AUDIO-OUT rate only; a TTS stage
   * consumes text in and emits audio out, and inventing an input rate would be
   * a number nobody published. 0 here means "not billed", not "unknown". */
  'gpt-4o-mini-tts': { shape: 'token', inputPerMillionUsd: 0, outputPerMillionUsd: 12 },
  /* Arm C's TTS stage — the per-CHARACTER meter, with the 1k floor PER
   * REQUEST. See PRICING_ASSUMPTIONS: this floor is why Arm C's figure is
   * labelled unverified. */
  eleven_flash_v2_5: {
    shape: 'per-character',
    perThousandCharsUsd: 0.05,
    minimumCharsPerRequest: ELEVENLABS_MIN_CHARS_PER_REQUEST,
  },
} satisfies Record<string, Rate>);

/**
 * The rate for a model id, or undefined when the card does not price it.
 *
 * UNDEFINED IS THE HONEST ANSWER for a menu model PRD §5 publishes no rate for
 * (`gpt-4o-mini-transcribe`, `scribe_v2_realtime`, `claude-haiku-4-5`,
 * `eleven_multilingual_v2`). It becomes `unknown-model` → NOT MEASURED, never a
 * free stage — and inventing a price would be worse than saying nothing.
 */
export function rateFor(model: string): Rate | undefined {
  return Object.prototype.hasOwnProperty.call(RATE_CARD, model) ? RATE_CARD[model] : undefined;
}

/* ------------------------------------------------------------ assumptions -- */

/**
 * A billing assumption the model makes that has NOT been confirmed against a
 * real invoice. Visible by construction: any model an unverified assumption
 * names produces `verified: false` on every cost it is part of.
 */
export interface PricingAssumption {
  id: string;
  /** Model ids this assumption applies to. */
  models: string[];
  /** Plain-language statement of what is assumed. */
  statement: string;
  /** True only once checked against a real invoice. */
  verified: boolean;
}

export const PRICING_ASSUMPTIONS: readonly PricingAssumption[] = Object.freeze([
  Object.freeze({
    id: 'elevenlabs-1k-minimum-per-request',
    models: ['eleven_flash_v2_5'],
    statement:
      'ElevenLabs bills a 1,000-character minimum PER REQUEST. Arm C streams translated ' +
      'text in chunks, so each chunk is modelled as its own billed request and a short ' +
      'chunk is charged at the 1,000-character floor. Whether the vendor aggregates a ' +
      "streamed turn into one request or bills each chunk has NOT been checked against a " +
      'real invoice, and the two answers differ by an order of magnitude.',
    verified: false,
  }),
  Object.freeze({
    id: 'realtime-cached-tokens-are-a-subset',
    models: ['gpt-realtime', 'gpt-realtime-mini'],
    statement:
      "The Realtime API's `response.done` reports `input_token_details.cached_tokens` " +
      'as a SUBSET of the tokens already counted in `audio_tokens` / `text_tokens`, ' +
      'broken down by modality in `cached_tokens_details`. The model therefore ' +
      'SUBTRACTS the cached count from the full-price count and re-prices it at the ' +
      'cached rate, rather than adding it on top. Adding it would bill cached input ' +
      'at MORE than uncached input and invert prompt caching entirely. This subset ' +
      'reading is taken from the published schema and has NOT been confirmed against ' +
      'a live `response.done` from this project, so every realtime figure is labelled ' +
      'unverified until it is.',
    verified: false,
  }),
]);

/** Assumptions bearing on a model id. */
export function assumptionsFor(model: string): PricingAssumption[] {
  return PRICING_ASSUMPTIONS.filter((a) => a.models.includes(model));
}

/**
 * False when any assumption bearing on the model is itself unverified.
 *
 * A model NOBODY has flagged is verified: the published rate is the rate. The
 * flag exists for a model whose BILLING SHAPE is in question, not for one whose
 * price merely came from a table.
 */
export function isVerifiedPricing(model: string): boolean {
  return assumptionsFor(model).every((a) => a.verified);
}

/* ------------------------------------------------------------ metered use -- */

/**
 * What a stage actually consumed, in the shape its vendor bills in.
 *
 * `per-character` carries `requestCharCounts` — ONE ENTRY PER REQUEST — and not
 * a total, because the 1k-char minimum applies per request. A total cannot
 * express the difference between one 1,200-char call and twelve 100-char ones,
 * and those two cost 12× apart.
 */
export type StageUsage =
  | { model: string; shape: 'token'; inputTokens: number; outputTokens: number }
  | { model: string; shape: 'per-minute'; audioMs: number }
  | { model: string; shape: 'per-character'; requestCharCounts: number[] };

/** Why a cost could not be computed. Each is a different fact. */
export type CostNotMeasuredReason =
  | 'no-usage-reported'
  | 'unknown-model'
  | 'shape-mismatch'
  | 'stage-unmeasured';

export interface MeasuredCost {
  measured: true;
  usd: number;
  pricingVersion: string;
  /** False when an unverified assumption fed the number (Arm C today). */
  verified: boolean;
}

export interface UnmeasuredCost {
  measured: false;
  /** NULL, never 0. */
  usd: null;
  reason: CostNotMeasuredReason;
  pricingVersion: string;
  verified: boolean;
}

export type CostResult = MeasuredCost | UnmeasuredCost;

function measured(usd: number, verified: boolean): MeasuredCost {
  return { measured: true, usd, pricingVersion: PRICING_VERSION, verified };
}

function unmeasured(reason: CostNotMeasuredReason, verified = true): UnmeasuredCost {
  return { measured: false, usd: null, reason, pricingVersion: PRICING_VERSION, verified };
}

/** A metered count, defensively: anything non-finite is 0 tokens, not NaN dollars. */
function count(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : 0;
}

/** Price ONE stage from its metered usage. Absent usage → `no-usage-reported`. */
export function priceStage(usage: StageUsage | undefined): CostResult {
  if (usage === undefined || usage === null) return unmeasured('no-usage-reported');

  const rate = rateFor(usage.model);
  // A model the card does not price is NOT a free stage. Reporting 0 here is
  // exactly the `$0.00` failure this module exists to prevent.
  if (rate === undefined) return unmeasured('unknown-model');

  const verified = isVerifiedPricing(usage.model);

  // THE SHAPES ARE NOT INTERCHANGEABLE. Usage metered in the wrong meter for
  // the model is a stage nobody metered correctly, not a stage that cost 0.
  if (rate.shape !== usage.shape) return unmeasured('shape-mismatch', verified);

  if (usage.shape === 'token' && rate.shape === 'token') {
    // The two directions are priced APART and summed afterwards. Summing the
    // token counts first and applying one rate halves or doubles the figure.
    const usd =
      (count(usage.inputTokens) / 1_000_000) * rate.inputPerMillionUsd +
      (count(usage.outputTokens) / 1_000_000) * rate.outputPerMillionUsd;
    return measured(usd, verified);
  }

  if (usage.shape === 'per-minute' && rate.shape === 'per-minute') {
    return measured((count(usage.audioMs) / 60_000) * rate.perMinuteUsd, verified);
  }

  if (usage.shape === 'per-character' && rate.shape === 'per-character') {
    // NO REQUESTS RECORDED is not "the stage was free": a TTS stage that ran
    // made at least one request, so an empty list is a metering hole.
    if (usage.requestCharCounts.length === 0) return unmeasured('no-usage-reported', verified);
    // THE TRAP, modelled: the floor applies PER REQUEST, so twelve 100-char
    // chunks are twelve billed requests and not 1,200 billed characters.
    const billedChars = usage.requestCharCounts.reduce(
      (total, chars) => total + Math.max(count(chars), rate.minimumCharsPerRequest),
      0,
    );
    return measured((billedChars / 1000) * rate.perThousandCharsUsd, verified);
  }

  /* c8 ignore next -- unreachable: the shapes above are exhaustive. */
  return unmeasured('shape-mismatch', verified);
}

/* ---------------------------------------------------------------- realtime -- */

/**
 * The `response.done` usage envelope, as the Realtime API reports it. Read
 * structurally and defensively: an envelope missing the audio detail is
 * `no-usage-reported`, never a zero.
 */
export interface RealtimeUsage {
  input_token_details?: {
    audio_tokens?: number;
    text_tokens?: number;
    /**
     * A SUBSET of `audio_tokens` + `text_tokens`, not an addition — see the
     * `realtime-cached-tokens-are-a-subset` entry in PRICING_ASSUMPTIONS.
     */
    cached_tokens?: number;
    /** How the cached subset splits. Required whenever `cached_tokens` > 0. */
    cached_tokens_details?: { audio_tokens?: number; text_tokens?: number };
  };
  output_token_details?: { audio_tokens?: number; text_tokens?: number };
}

/**
 * Arm A's meter. AUDIO IN AND AUDIO OUT ARE PRICED SEPARATELY — `gpt-realtime`
 * bills output at 2× input — so this never sums the two token counts first.
 */
export function priceRealtimeUsage(usage: unknown, model: string = REALTIME_MODEL): CostResult {
  if (usage === null || typeof usage !== 'object') return unmeasured('no-usage-reported');
  const u = usage as RealtimeUsage;

  // AT LEAST ONE metered number, or the envelope told us nothing. `{}` and
  // `{ input_token_details: {} }` are both "no usage reported" — not a turn
  // that consumed nothing.
  const fields = [
    u.input_token_details?.audio_tokens,
    u.input_token_details?.text_tokens,
    u.output_token_details?.audio_tokens,
    u.output_token_details?.text_tokens,
  ];
  if (!fields.some((v) => typeof v === 'number' && Number.isFinite(v))) {
    return unmeasured('no-usage-reported');
  }

  const rate = rateFor(model);
  if (rate === undefined) return unmeasured('unknown-model');
  if (rate.shape !== 'token') return unmeasured('shape-mismatch', isVerifiedPricing(model));

  const verified = isVerifiedPricing(model);
  const inDetails = u.input_token_details;

  const audioIn = count(inDetails?.audio_tokens);
  const textIn = count(inDetails?.text_tokens);
  const cachedTotal = count(inDetails?.cached_tokens);
  const cachedDetails = inDetails?.cached_tokens_details;

  // A CACHED COUNT WITH NO BREAKDOWN CANNOT BE PRICED. Cached audio and cached
  // text are re-priced from different meters, so a lump `cached_tokens` with no
  // `cached_tokens_details` leaves the split unknown — and falling back to the
  // additive form (the bug this replaces) would bill cached input at 80× the
  // cached rate. Unmeasured is the honest answer.
  if (cachedTotal > 0 && cachedDetails === undefined) {
    return unmeasured('shape-mismatch', verified);
  }

  const cachedAudioIn = Math.min(count(cachedDetails?.audio_tokens), audioIn);
  const cachedTextIn = Math.min(count(cachedDetails?.text_tokens), textIn);

  // Sub-meters fall back to the model's headline input rate when the card
  // declares none — never to 0, which would make text free.
  const textInRate = rate.textInputPerMillionUsd ?? rate.inputPerMillionUsd;
  const textOutRate = rate.textOutputPerMillionUsd ?? rate.outputPerMillionUsd;
  const cachedAudioRate = rate.cachedInputPerMillionUsd ?? rate.inputPerMillionUsd;
  const cachedTextRate = rate.cachedTextInputPerMillionUsd ?? textInRate;

  // THE CACHED SUBSET IS SUBTRACTED, THEN RE-PRICED. Every term below is a
  // disjoint slice of the reported counts, so no token is billed twice.
  const usd =
    ((audioIn - cachedAudioIn) * rate.inputPerMillionUsd +
      cachedAudioIn * cachedAudioRate +
      (textIn - cachedTextIn) * textInRate +
      cachedTextIn * cachedTextRate +
      count(u.output_token_details?.audio_tokens) * rate.outputPerMillionUsd +
      count(u.output_token_details?.text_tokens) * textOutRate) /
    1_000_000;

  return measured(usd, verified);
}

/* ----------------------------------------------------------------- cascade -- */

export interface CascadeStageUsages {
  stt?: StageUsage;
  mt?: StageUsage;
  tts?: StageUsage;
}

/**
 * Three vendors, three rate cards. `perStage` is the ATTRIBUTION — without it a
 * cost difference between Arm B and Arm C cannot be pinned to the TTS swap,
 * which is the whole question of Experiment 2.
 */
export interface CascadeCost {
  perStage: { stt: CostResult; mt: CostResult; tts: CostResult };
  /** Measured only when EVERY stage is measured; otherwise `stage-unmeasured`. */
  total: CostResult;
}

export function priceCascade(usages: CascadeStageUsages): CascadeCost {
  const perStage = {
    stt: priceStage(usages.stt),
    mt: priceStage(usages.mt),
    tts: priceStage(usages.tts),
  };
  const stages = [perStage.stt, perStage.mt, perStage.tts];

  // UNVERIFIED IS CONTAGIOUS UPWARD. A total containing Arm C's TTS stage is
  // itself unverified, or the label would be escapable by aggregation.
  const verified = stages.every((s) => s.verified);

  // A total is measured only when EVERY stage is. Summing the two stages that
  // WERE metered would report a cascade run as cheaper than it was, which is
  // the arm-understating cousin of `$0.00`. The per-stage attribution survives
  // the hole either way — that is what `perStage` is for.
  const hole = stages.some((s) => !s.measured);
  const total: CostResult = hole
    ? unmeasured('stage-unmeasured', verified)
    : measured(
        stages.reduce((sum, s) => sum + (s.usd ?? 0), 0),
        verified,
      );

  return { perStage, total };
}

/* -------------------------------------------------------------- derivation -- */

/**
 * PRD §8: cost per minute = METERED SPEND ÷ AUDIO DURATION. Derived here and
 * never stored independently, so it cannot drift from the spend it came from.
 * Null for an unmeasured cost and for a zero/absent duration — never 0.
 */
export function costPerMinuteUsd(cost: CostResult, audioDurationMs: number): number | null {
  if (!cost.measured || cost.usd === null) return null;
  if (!Number.isFinite(audioDurationMs) || audioDurationMs <= 0) return null;
  return cost.usd / (audioDurationMs / 60_000);
}

/**
 * PRD §8's Live-only COST SLOPE: $/min in minute 1 against $/min in the final
 * minute. Realtime replays the accumulated conversation each turn, so the cost
 * per minute CLIMBS — the climb is the finding for Arm A, and a ≤1-minute clip
 * cannot show it.
 */
export interface CostSlope {
  minute1UsdPerMin: number | null;
  finalMinuteUsdPerMin: number | null;
  /** final − minute 1. Null when either end is unavailable. */
  slopeUsdPerMin: number | null;
}

/** `minuteCosts[i]` is the spend WITHIN minute i+1. Fewer than 2 → no slope. */
export function costSlope(minuteCosts: CostResult[]): CostSlope {
  const usdOrNull = (cost: CostResult | undefined): number | null =>
    cost !== undefined && cost.measured ? cost.usd : null;

  const minute1UsdPerMin = usdOrNull(minuteCosts[0]);

  // A ≤1-minute clip cannot show the climb (PRD §8). NULL, never 0 — a zero
  // slope is the claim that the cost curve is FLAT, which is the finding this
  // measurement exists to test.
  if (minuteCosts.length < 2) {
    return { minute1UsdPerMin, finalMinuteUsdPerMin: null, slopeUsdPerMin: null };
  }

  const finalMinuteUsdPerMin = usdOrNull(minuteCosts[minuteCosts.length - 1]);
  const slopeUsdPerMin =
    minute1UsdPerMin === null || finalMinuteUsdPerMin === null
      ? null
      : finalMinuteUsdPerMin - minute1UsdPerMin;

  return { minute1UsdPerMin, finalMinuteUsdPerMin, slopeUsdPerMin };
}

/* ------------------------------------------------------------- aggregation -- */

/**
 * The sum of an aggregate's costs, with its own denominator attached.
 *
 * An unmeasured cost contributes NOTHING — not a zero. `measured` is how many
 * of `total` carried a figure, which is what the provenance line discloses; a
 * sum that cannot say this understates the arm silently.
 */
export interface CostSum {
  /** Null when NOTHING was measured — never 0. */
  usd: number | null;
  measured: number;
  total: number;
}

export function sumMeasuredCosts(costs: Array<CostResult | null | undefined>): CostSum {
  let usd = 0;
  let measuredCount = 0;
  for (const cost of costs) {
    if (cost === null || cost === undefined) continue;
    if (!cost.measured || cost.usd === null) continue;
    usd += cost.usd;
    measuredCount += 1;
  }
  // NULL when nothing was measured — never 0. The denominator is what makes
  // "contributed nothing" distinguishable from "contributed a zero".
  return { usd: measuredCount === 0 ? null : usd, measured: measuredCount, total: costs.length };
}

/**
 * How many decimals a figure needs to stay honest. A cascade utterance costs
 * fractions of a cent, and `toFixed(2)` renders it as `$0.00` — the very string
 * this ticket exists to delete. So the precision follows the magnitude, and a
 * non-zero spend never renders as a zero.
 */
function formatAmountUsd(usd: number): string {
  const abs = Math.abs(usd);
  if (abs >= 1) return usd.toFixed(2);
  if (abs >= 0.001 || abs === 0) return usd.toFixed(3);
  return usd.toFixed(6);
}

/**
 * THE ONE FORMATTER. Every surface that shows a cost — the Live footer, the
 * Replay listing, Results and the export — routes through this, so no view can
 * invent a `$0.00` for a figure nobody measured.
 */
/**
 * A STORED figure re-entering the model (AC5: the reported cost is read back,
 * never recomputed at display time). `null`/`undefined` is UNMEASURED — never a
 * zero — so a stored hole and a computed hole aggregate identically.
 *
 * `verified` is true here because the flag travels with the RATE CARD, not with
 * a number already written to the ledger: nothing on a stored figure says which
 * assumptions produced it. Arm C's unverified label is applied where the figure
 * is COMPUTED (`priceCascade`), which is the only place that knows.
 */
export function costFromStored(usd: number | null | undefined): CostResult {
  if (typeof usd !== 'number' || !Number.isFinite(usd)) return unmeasured('no-usage-reported');
  return measured(usd, true);
}

export function formatCostUsd(cost: CostResult | number | null | undefined): string {
  if (cost === null || cost === undefined) return COST_NOT_MEASURED_CELL;
  if (typeof cost === 'number') {
    return Number.isFinite(cost) ? `$${formatAmountUsd(cost)}` : COST_NOT_MEASURED_CELL;
  }
  if (!cost.measured || cost.usd === null) return COST_NOT_MEASURED_CELL;
  return `$${formatAmountUsd(cost.usd)}`;
}
