/**
 * TICKET 052 — THE PRICE SOURCE. Isomorphic TypeScript: no node, no DOM
 * (src/core is compiled by BOTH tsconfigs).
 *
 * STUB ONLY. Every function below throws; the shapes exist so the locked tests
 * compile. The implementer fills them in.
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

function notImplemented(name: string): never {
  throw new Error(`pricing.${name} is not implemented (ticket 052)`);
}

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

/** Token-billed. Input and output are SEPARATE rates, always. */
export interface TokenRate {
  shape: 'token';
  inputPerMillionUsd: number;
  outputPerMillionUsd: number;
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
export const RATE_CARD: Readonly<Record<string, Rate>> = {};

/** The rate for a model id, or undefined when the card does not price it. */
export function rateFor(_model: string): Rate | undefined {
  return notImplemented('rateFor');
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

export const PRICING_ASSUMPTIONS: readonly PricingAssumption[] = [];

/** Assumptions bearing on a model id. */
export function assumptionsFor(_model: string): PricingAssumption[] {
  return notImplemented('assumptionsFor');
}

/** False when any assumption bearing on the model is itself unverified. */
export function isVerifiedPricing(_model: string): boolean {
  return notImplemented('isVerifiedPricing');
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

/** Price ONE stage from its metered usage. Absent usage → `no-usage-reported`. */
export function priceStage(_usage: StageUsage | undefined): CostResult {
  return notImplemented('priceStage');
}

/* ---------------------------------------------------------------- realtime -- */

/**
 * The `response.done` usage envelope, as the Realtime API reports it. Read
 * structurally and defensively: an envelope missing the audio detail is
 * `no-usage-reported`, never a zero.
 */
export interface RealtimeUsage {
  input_token_details?: { audio_tokens?: number; text_tokens?: number };
  output_token_details?: { audio_tokens?: number; text_tokens?: number };
}

/**
 * Arm A's meter. AUDIO IN AND AUDIO OUT ARE PRICED SEPARATELY — `gpt-realtime`
 * bills output at 2× input — so this never sums the two token counts first.
 */
export function priceRealtimeUsage(_usage: unknown, _model?: string): CostResult {
  return notImplemented('priceRealtimeUsage');
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

export function priceCascade(_usages: CascadeStageUsages): CascadeCost {
  return notImplemented('priceCascade');
}

/* -------------------------------------------------------------- derivation -- */

/**
 * PRD §8: cost per minute = METERED SPEND ÷ AUDIO DURATION. Derived here and
 * never stored independently, so it cannot drift from the spend it came from.
 * Null for an unmeasured cost and for a zero/absent duration — never 0.
 */
export function costPerMinuteUsd(_cost: CostResult, _audioDurationMs: number): number | null {
  return notImplemented('costPerMinuteUsd');
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
export function costSlope(_minuteCosts: CostResult[]): CostSlope {
  return notImplemented('costSlope');
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

export function sumMeasuredCosts(_costs: Array<CostResult | null | undefined>): CostSum {
  return notImplemented('sumMeasuredCosts');
}

/**
 * THE ONE FORMATTER. Every surface that shows a cost — the Live footer, the
 * Replay listing, Results and the export — routes through this, so no view can
 * invent a `$0.00` for a figure nobody measured.
 */
export function formatCostUsd(_cost: CostResult | number | null | undefined): string {
  return notImplemented('formatCostUsd');
}
