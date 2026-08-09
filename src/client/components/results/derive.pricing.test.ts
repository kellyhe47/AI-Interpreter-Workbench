/**
 * TICKET 052 ROUND 2 — R2-5(a), R2-5(b), R2-4 (Results Live) and R2-8(d).
 *
 * Three of this ticket's own acceptance criteria shipped as DEAD CODE: the
 * module exists, its consumers do not.
 *
 *  - R2-5(a) `pricing-v1` reaches `exportResults` and nothing else. `Provenance`
 *    has no `pricingVersion` and the rendered line names `corpus-v1` while
 *    saying nothing about the rate source. A vendor moving a price would
 *    restate the committed bundle and silently move the screen — which is the
 *    exact failure the versioned-control discipline exists to prevent, and the
 *    reason `corpus-v1` and `wer-norm-v1` are stamped the way they are.
 *
 *  - R2-5(b) `PRICING_ASSUMPTIONS`, `assumptionsFor`, `isVerifiedPricing` and
 *    `CostResult.verified` appear ONLY in `pricing.ts` and its own tests.
 *    `verified` is discarded at every call site, so NO SURFACE CAN EVER SAY
 *    "unverified" — including the ElevenLabs 1k-char floor, which the ticket
 *    says must label Arm C's figure, and the realtime cached-token subset
 *    reading, which exists precisely to warn a reader.
 *
 *    THE FLAG IS DERIVED FROM THE ARM'S RECIPE, not from the stored number.
 *    `costFromStored` cannot know which assumptions produced a figure already
 *    written to the ledger — but the ARM knows which models it pins, and
 *    `assumptionsFor` knows what is unverified about them. Arm B is all-OpenAI
 *    token/minute meters with nothing flagged; Arm C carries the ElevenLabs
 *    floor; Arm A carries the cached-token subset reading.
 *
 *  - R2-4 (Results half) the Live card names sessions, utterances, the anchor
 *    and WER — and no cost denominator, though `priceRealtimeUsage` returns
 *    null per turn whenever a `response.done` omits usage.
 *
 *  - R2-8(d) `data/live-sessions.jsonl`'s eight stored sessions carry
 *    `cost.totalUsd: 0` from before this ticket existed. Read back naively that
 *    is a MEASURED zero — eight sessions asserting the configuration was free.
 *
 * WIRING THESE ASSERTIONS NEED (all in `derive.ts` / `ledger.ts`):
 *   Provenance          + pricingVersion: string
 *   ExperimentArmAggregate + costVerified: boolean, costAssumptions: string[]
 *   LiveArmColumn       + costTotalUsd: number | null, costUtterances: number,
 *                         measuredCostUtterances: number
 *   LiveSessionUtterance.costUsd widens to `number | null`
 * The local widening types below exist only because those have not landed.
 */

import { beforeEach, describe, expect, it } from 'vitest';

import { PRICING_VERSION, assumptionsFor } from '../../../core/pricing';
import { RunLedger, type LiveSession, type LiveSessionUtterance } from '../../state/ledger';
import {
  deriveExperimentAggregates,
  deriveLiveModel,
  type ExperimentArmAggregate,
  type LiveArmColumn,
  type Provenance,
} from './derive';
import {
  ARM_C_TRIPLE,
  RECORDING_DURATION_MS,
  makeLiveSessionEntity,
  makeRecordingEntity,
  makeRunEntity,
  resetEntitySeq,
} from './testRecords';

/* --------------------------------------------------- the 052 R2 shape ----- */

type PricedProvenance = Provenance & { pricingVersion?: string };

type PricedAggregate = Omit<ExperimentArmAggregate, 'provenance'> & {
  provenance: PricedProvenance;
  /** False when an UNVERIFIED assumption bears on any stage this arm pins. */
  costVerified?: boolean;
  /** The ids of the assumptions behind the label, so it is not a bare flag. */
  costAssumptions?: string[];
};

type PricedLiveColumn = LiveArmColumn & {
  costTotalUsd?: number | null;
  costUtterances?: number;
  measuredCostUtterances?: number;
};

/** A LiveSession utterance whose cost may be unmeasured. */
function liveUtterance(id: string, costUsd: number | null): LiveSessionUtterance {
  return {
    id,
    timings: { server_speech_stopped: 1_000, audio_queued: 2_240 },
    costUsd: costUsd as unknown as number,
  };
}

const REALTIME_SNAPSHOT = { realtime: 'gpt-realtime' };

/** A REAL, aggregatable realtime LiveSession carrying the given utterances. */
function realtimeSession(
  utterances: LiveSessionUtterance[],
  cost: Partial<LiveSession['cost']> = {},
): LiveSession {
  return makeLiveSessionEntity({
    architecture: 'realtime',
    providerTriple: undefined,
    modelSnapshots: { ...REALTIME_SNAPSHOT },
    utterances,
    stability: {
      utterancesCompleted: utterances.length,
      disconnects: 0,
    },
    cost: { totalUsd: 0, perMinuteMinute1: null, perMinuteFinalMinute: null, ...cost },
  });
}

let ledger: RunLedger;

beforeEach(() => {
  resetEntitySeq();
  ledger = new RunLedger();
});

function armAggregate(arm: string): PricedAggregate {
  const agg = deriveExperimentAggregates(ledger).perArm[arm];
  expect(agg, `arm ${arm} should be in the aggregates`).toBeDefined();
  return agg as unknown as PricedAggregate;
}

/** One gate-passing Run for `arm`, on its own recording. */
function seedArm(arm: 'B' | 'C'): void {
  const recordingId = `rec-${arm}`;
  ledger.appendRecording(
    makeRecordingEntity({ id: recordingId, durationMs: RECORDING_DURATION_MS }),
  );
  const triple = arm === 'C' ? { ...ARM_C_TRIPLE } : undefined;
  ledger.appendRun(
    makeRunEntity({
      id: `run-${arm}`,
      recordingId,
      cost: 0.01,
      ...(triple ? { providerTriple: triple, modelSnapshots: triple, armTag: arm } : {}),
    }),
  );
}

/* ================================================================ R2-5a ==== */

describe('R2-5a · the declared price source is in the provenance, not just the bundle', () => {
  it('stamps the pricing version on every arm aggregate', () => {
    seedArm('B');
    expect(armAggregate('B').provenance.pricingVersion).toBe(PRICING_VERSION);
  });

  it('names the rate source in the rendered line, beside the corpus version', () => {
    // The line already names `corpus-v1` and the pinned endpointing. A cost
    // figure whose rate table is unnamed is the same kind of claim the corpus
    // clause exists to prevent.
    seedArm('B');
    expect(armAggregate('B').provenance.line).toContain(PRICING_VERSION);
  });
});

/* ================================================================ R2-5b ==== */

describe('R2-5b · a figure resting on an unverified assumption SAYS SO', () => {
  it('labels Arm C unverified — the 1k-character floor has never met an invoice', () => {
    // Arm C's TTS stage is `eleven_flash_v2_5`, and the per-request floor is
    // the assumption that could make it the most expensive arm in the study.
    seedArm('C');
    const agg = armAggregate('C');
    expect(agg.costVerified).toBe(false);
    expect(agg.costAssumptions).toContain('elevenlabs-1k-minimum-per-request');
    expect(agg.provenance.line.toLowerCase()).toContain('unverified');
  });

  it('does not label Arm B unverified — nothing about its meters is in question', () => {
    // A flag that is always on teaches nothing. This is the assertion that
    // makes the Arm C label informative rather than decorative.
    seedArm('B');
    const agg = armAggregate('B');
    expect(agg.costVerified).toBe(true);
    expect(agg.costAssumptions).toEqual([]);
    expect(agg.provenance.line.toLowerCase()).not.toContain('unverified');
  });

  it('draws the label from the SAME assumption store the module publishes', () => {
    // Not a second hardcoded list: a newly flagged model must move the screen
    // without anyone editing the derivation.
    seedArm('C');
    const declared = assumptionsFor('eleven_flash_v2_5').map((a) => a.id);
    expect(declared.length).toBeGreaterThan(0);
    for (const id of declared) expect(armAggregate('C').costAssumptions).toContain(id);
  });
});

/* ========================================================= R2-4 (Results) == */

describe('R2-4 · the Live card carries a cost denominator too', () => {
  it('counts the utterances that were priced against the utterances there were', () => {
    ledger.appendLiveSession(
      realtimeSession([
        liveUtterance('u1', 0.02),
        liveUtterance('u2', null),
        liveUtterance('u3', 0.01),
      ]),
    );
    const column = deriveLiveModel(ledger).columns[0] as PricedLiveColumn;
    expect(column).toBeDefined();
    expect(column.costUtterances).toBe(3);
    expect(column.measuredCostUtterances).toBe(2);
    expect(column.costTotalUsd).toBeCloseTo(0.03, 10);
  });

  it('reports a wholly unpriced arm as NOT MEASURED, never as a zero', () => {
    ledger.appendLiveSession(realtimeSession([liveUtterance('u1', null), liveUtterance('u2', null)]));
    const column = deriveLiveModel(ledger).columns[0] as PricedLiveColumn;
    expect(column.costTotalUsd).toBeNull();
    expect(column.measuredCostUtterances).toBe(0);
  });
});

/* ================================================================ R2-8d ==== */

describe('R2-8d · a pre-052 stored session does not read back as a measured $0.00', () => {
  it('ignores the legacy cost.totalUsd of a session whose utterances carry no price', () => {
    // The eight sessions in `data/live-sessions.jsonl` were written before a
    // cost model existed. Their `totalUsd: 0` is the ABSENCE of a measurement
    // wearing a measurement's shape, and reading it forward publishes eight
    // takes asserting the configuration was free.
    ledger.appendLiveSession(
      realtimeSession([liveUtterance('u1', null), liveUtterance('u2', null)], { totalUsd: 0 }),
    );
    const column = deriveLiveModel(ledger).columns[0] as PricedLiveColumn;
    expect(column.costTotalUsd).toBeNull();
    expect(column.measuredCostUtterances).toBe(0);
  });

  it('still reports a session whose utterances WERE priced', () => {
    // The control: reinterpreting the legacy zero must not delete a real one.
    ledger.appendLiveSession(
      realtimeSession([liveUtterance('u1', 0.05)], { totalUsd: 0.05 }),
    );
    const column = deriveLiveModel(ledger).columns[0] as PricedLiveColumn;
    expect(column.costTotalUsd).toBeCloseTo(0.05, 10);
    expect(column.measuredCostUtterances).toBe(1);
  });
});
