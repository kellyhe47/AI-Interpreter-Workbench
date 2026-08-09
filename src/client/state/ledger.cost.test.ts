/**
 * TICKET 052 ROUND 2 — R2-1(b). `RunLedger.aggregates()` is the LIVE half of
 * the nullable-cost rule, and it was unguarded.
 *
 * The Replay twin (`runAggregates`) is pinned: mutating its measured-only
 * accumulate kills five tests. The LIVE one — the path the Live footer reads
 * every render, on the very screen this ticket was filed against — had none, so
 *
 *     if (r.costUnits !== null) { agg.costUsd = (agg.costUsd ?? 0) + r.costUnits;
 *                                agg.measuredCostRecords += 1; }
 *
 * could be replaced with an unconditional `(agg.costUsd ?? 0) + (r.costUnits ?? 0)`
 * and the whole suite stayed green. That mutation restores THE LITERAL DEFECT:
 * a cascade Live session — every `costUnits` null today by design, because MT
 * reports no usage — would once again aggregate to a confident `$0.00` and the
 * footer would render "this configuration is free".
 *
 * The two facts these tests keep apart, which the DOLLARS ALONE CANNOT:
 *   `null` + 0.02 + 0.01  ==  0 + 0.02 + 0.01  ==  0.03
 * Summing a missing cost as zero and skipping it produce the same total. Only
 * `costUsd === null` on the all-missing arm, and `measuredCostRecords` beside
 * `count` on the mixed one, tell an honest aggregate from a dishonest one.
 */

import { beforeEach, describe, expect, it } from 'vitest';

import { COST_NOT_MEASURED_CELL, formatCostUsd } from '../../core/pricing';
import type { UtteranceRecord } from '../../core/timing';
import { RunLedger } from './ledger';

let seq = 0;
let ledger: RunLedger;

beforeEach(() => {
  seq = 0;
  ledger = new RunLedger();
});

/** A REAL record (the realness rule must not filter it out) on Arm A. */
function record(costUnits: number | null, overrides: Partial<UtteranceRecord> = {}): UtteranceRecord {
  seq += 1;
  return {
    id: `utt-${seq}`,
    arm: 'A',
    mode: 'realtime',
    languagePair: 'EN↔ES',
    direction: 'EN→ES',
    sourcePartials: [],
    sourceFinal: 'hello',
    targetPartials: [],
    targetFinal: 'hola',
    audioState: 'ready',
    audioDurationMs: 900,
    timings: { server_speech_stopped: 1_000, audio_queued: 2_240 },
    speechEndSource: 'none',
    providers: { stt: 'gpt-realtime', mt: 'gpt-realtime', tts: 'gpt-realtime' },
    costUnits,
    corpusId: 'live-mic',
    runId: 'run-live',
    ...overrides,
  };
}

const armA = () => ledger.aggregates('run-live').perArm['A']!;

describe('R2-1b · an arm nobody could price reports NOT MEASURED, never $0.00', () => {
  it('reports costUsd null when every record was unpriced', () => {
    // The cascade Live session as it exists TODAY: MT reports no usage, so
    // `priceCascade` nulls the total and every record carries `costUnits: null`.
    for (const _ of [1, 2, 3]) ledger.append(record(null));
    const agg = armA();

    expect(agg.costUsd).toBeNull();
    expect(agg.measuredCostRecords).toBe(0);
    // The records are still real measurements of latency — the cost hole must
    // not evict them from the count.
    expect(agg.count).toBe(3);
  });

  it('renders as the not-measured cell through the ONE formatter', () => {
    ledger.append(record(null));
    expect(formatCostUsd(armA().costUsd)).toBe(COST_NOT_MEASURED_CELL);
    expect(formatCostUsd(armA().costUsd)).not.toMatch(/\$0(\.0*)?$/);
  });
});

describe('R2-1b · a partially priced arm discloses its denominator', () => {
  it('sums only the priced records and counts them apart from `count`', () => {
    ledger.append(record(0.02));
    ledger.append(record(null));
    ledger.append(record(0.01));

    const agg = armA();
    expect(agg.costUsd).toBeCloseTo(0.03, 10);
    // THE ASSERTION THE DOLLARS CANNOT MAKE. `0.03` is what BOTH an honest and
    // a silently-zeroing implementation report; `2` against `3` is not.
    expect(agg.measuredCostRecords).toBe(2);
    expect(agg.count).toBe(3);
  });

  it('is not moved by the ORDER the hole arrives in', () => {
    // A guard written as "stop accumulating at the first null" would pass the
    // test above and fail here.
    ledger.append(record(null));
    ledger.append(record(0.02));
    ledger.append(record(0.01));

    const agg = armA();
    expect(agg.costUsd).toBeCloseTo(0.03, 10);
    expect(agg.measuredCostRecords).toBe(2);
  });

  it('counts a genuine zero as MEASURED — 0 and null are different facts', () => {
    // A stage that really did cost nothing is a measurement. Folding it into
    // the same bucket as "nobody priced this" would lose the distinction this
    // whole ticket is about, in the other direction.
    ledger.append(record(0));
    ledger.append(record(null));

    const agg = armA();
    expect(agg.costUsd).toBe(0);
    expect(agg.measuredCostRecords).toBe(1);
  });
});

/* -------------------------------------------------------------------------
 * TICKET 059 — THE RUN SIDE OF THE SAME RULE, AND THE HALF THAT KEEPS IT HONEST.
 *
 * 052 R2 gave `LiveSession` a `pricingVersion` stamp and made `liveCostOf` read
 * it as THE DISCRIMINATOR: a session with no stamp priced nothing, whatever
 * zeros its utterances carry. That is the only reason the Live footer reads
 * `session not measured` today.
 *
 * `Run` has no stamp, so the three Runs in `data/runs/` — `"cost": 0` on the Run
 * and on all four utterance records of each complete one, written by a build
 * with no cost model at all — come back through `costFromStored(0)` as
 * MEASUREMENTS, and every Run-fed surface renders `$0.000`.
 *
 * THE POINT OF THIS BLOCK IS THE PAIR, NOT THE ZERO. A fix that reads every `0`
 * as "unmeasured" deletes the distinction from the other side: zero IS a
 * measurement, and a configuration that really did cost nothing has to be able
 * to say so. The two fixtures below are IDENTICAL IN EVERY STORED FIELD BUT
 * ONE, and they must produce OPPOSITE answers — that is the whole assertion.
 * ---------------------------------------------------------------------- */

import { PRICING_VERSION } from '../../core/pricing';
import { runSamples, type Run, type RunUtterance } from './ledger';
import {
  makeRunEntity,
  makeUnstampedRunEntity,
  resetEntitySeq,
} from '../components/results/testRecords';

/** TICKET 059 — the `Run` shape with the stamp, as a widening of today's. */
type StampedRun = Run & { pricingVersion?: string };

/** Four `complete` records each carrying a stored `0` — 7acb0cc9's shape. */
function zeroCostRecords(): RunUtterance[] {
  return [1, 2, 3, 4].map((i) => ({
    utteranceId: `u${i}`,
    index: i,
    category: 'short-reply' as const,
    timings: { speech_end: 0, audio_queued: 700 + i },
    transcripts: {},
    cost: 0,
    status: 'complete' as const,
    errors: [],
  }));
}

/** The pair, built from the same seq so every other field is byte-identical. */
function costZeroPair(overrides: Parameters<typeof makeRunEntity>[0] = {}): {
  stamped: Run;
  unstamped: Run;
} {
  resetEntitySeq();
  const stamped = makeRunEntity({ cost: 0, ...overrides });
  resetEntitySeq();
  const unstamped = makeUnstampedRunEntity({ cost: 0, ...overrides });
  return { stamped, unstamped };
}

describe('TICKET 059 · the STAMP is the discriminator, and the VALUE is not', () => {
  it('the two fixtures differ in exactly one field: the price source', () => {
    // THE PREMISE, ASSERTED. Without this the opposite outcomes below could be
    // coming from any other difference the builder happened to introduce.
    const { stamped, unstamped } = costZeroPair();

    expect((stamped as StampedRun).pricingVersion).toBe(PRICING_VERSION);
    expect(Object.keys(unstamped)).not.toContain('pricingVersion');
    expect(stamped.cost).toBe(0);
    expect(unstamped.cost).toBe(0);
    expect({ ...stamped, pricingVersion: undefined }).toEqual({
      ...unstamped,
      pricingVersion: undefined,
    });
  });

  it('a STAMPED run whose measured cost really is 0 still reports a measurement', () => {
    // THE MOST IMPORTANT ASSERTION IN THE TICKET. A fix that maps every `0` to
    // "not measured" fails here, and it must: `0` and `null` are different
    // facts in BOTH directions.
    const { stamped } = costZeroPair();
    const samples = runSamples(stamped);

    expect(samples).toHaveLength(1);
    expect(samples[0]!.cost).toBe(0);
    expect(samples[0]!.cost).not.toBeNull();
  });

  it('an UNSTAMPED run priced nothing, whatever zero it stored', () => {
    const { unstamped } = costZeroPair();
    const samples = runSamples(unstamped);

    expect(samples).toHaveLength(1);
    expect(samples[0]!.cost).toBeNull();
  });

  it('carries the same verdict down to the utterance records — the measured atom', () => {
    // 7acb0cc9 and dbeb6d94 store `"cost": 0` on the RECORDS as well as on the
    // Run, and the records are what every aggregate actually sums. A stamp
    // honoured only at Run level leaves both screens exactly where they were.
    const { stamped, unstamped } = costZeroPair({ utterances: zeroCostRecords() });

    expect(runSamples(stamped).map((s) => s.cost)).toEqual([0, 0, 0, 0]);
    expect(runSamples(unstamped).map((s) => s.cost)).toEqual([null, null, null, null]);
  });

  it('leaves latency, status and the sample count alone on both sides', () => {
    // A cost hole is one axis of three (PRD §8) and must not evict the other
    // two — the same rule 052 already holds for a null cost.
    const { stamped, unstamped } = costZeroPair({ utterances: zeroCostRecords() });

    for (const run of [stamped, unstamped]) {
      const samples = runSamples(run);
      expect(samples).toHaveLength(4);
      expect(samples.every((s) => s.status === 'complete')).toBe(true);
      expect(samples.map((s) => s.latencyMs)).toEqual([701, 702, 703, 704]);
    }
  });
});

describe('TICKET 059 · runAggregates reads the stamp, not the zero', () => {
  it('an unstamped arm reports costUsd null and a 0 denominator, with n untouched', () => {
    const { unstamped } = costZeroPair();
    const agg = new RunLedger();
    agg.appendRun(unstamped);
    const armB = agg.runAggregates().perArm['B']!;

    expect(armB.costUsd).toBeNull();
    // THE ASSERTION THE DOLLARS CANNOT MAKE: `null` and `0` are the same total
    // as far as a reader of the money is concerned, and `0 of 1` is not.
    expect(armB.measuredCostSamples).toBe(0);
    expect(armB.n).toBe(1);
  });

  it('a stamped arm whose spend really is 0 reports 0 over a FULL denominator', () => {
    const { stamped } = costZeroPair();
    const agg = new RunLedger();
    agg.appendRun(stamped);
    const armB = agg.runAggregates().perArm['B']!;

    expect(armB.costUsd).toBe(0);
    expect(armB.costUsd).not.toBeNull();
    expect(armB.measuredCostSamples).toBe(1);
    expect(armB.n).toBe(1);
  });

  it('does not let an unstamped run drag a stamped arm total to null', () => {
    // The mixed case. An unmeasured cost contributes NOTHING — it does not
    // contribute a zero, and it does not veto the figures it sits beside.
    resetEntitySeq();
    const agg = new RunLedger();
    agg.appendRun(makeRunEntity({ id: 'run-priced', cost: 0.02 }));
    agg.appendRun(
      makeUnstampedRunEntity({
        id: 'run-unstamped',
        cost: 0,
        annotations: { utteranceId: 'u2', repIndex: 2 },
      }),
    );
    const armB = agg.runAggregates().perArm['B']!;

    expect(armB.costUsd).toBeCloseTo(0.02, 10);
    expect(armB.measuredCostSamples).toBe(1);
    expect(armB.n).toBe(2);
  });
});
