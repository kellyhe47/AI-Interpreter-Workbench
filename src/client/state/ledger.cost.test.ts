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
