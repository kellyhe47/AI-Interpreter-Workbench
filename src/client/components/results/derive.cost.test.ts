/**
 * TICKET 052 — cost in the RESULTS derivation layer.
 *
 * `src/core/pricing.test.ts` locks the model; this file locks what the reported
 * figures do with an UNMEASURED one. Three acceptance criteria live here:
 *
 *  - AC4  a run whose cost cannot be computed reports NOT MEASURED in Results,
 *         never `$0.00`
 *  - AC6  aggregates sum REAL costs only — an unmeasured cost must not
 *         contribute a silent zero, which understates the arm exactly as
 *         `$0.00` misstates the run
 *  - AC7  the provenance line discloses how many runs in an aggregate carry a
 *         MEASURED cost, the way it already discloses N and completed reps
 *
 * WHY THE PROVENANCE COUNT IS THE LOAD-BEARING ONE. In JavaScript, summing a
 * missing cost as a zero and skipping it produce the SAME dollar total, so the
 * money alone cannot tell an honest aggregate from a dishonest one. The
 * denominator can: `$0.06 over 2 of 3 samples` and `$0.06 over 3 of 3` are
 * different claims, and only one of them is true. That is the same reason
 * `completedReps` / `intendedReps` exist beside `n`, and the same reason
 * `WerAggregate` counts `scored` / `notApplicable` / `unscored` apart.
 *
 * WIRING THIS TEST REQUIRES (ticket 051 owns `src/client/state/ledger.ts`):
 *   - `Run.cost` and `RunUtterance.cost` become `number | null`; `null` is the
 *     unmeasured cost, and it is NOT the same fact as `0`.
 *   - `RunSample.cost` becomes `number | null` and `runAggregates()` reports
 *     `costUsd: number | null` plus `measuredCostSamples`.
 *   - `deriveExperimentAggregates` surfaces `costUsd: number | null`,
 *     `costCell` (through `formatCostUsd`) and `provenance.measuredCostSamples`.
 * The casts below exist only because those widenings have not landed yet.
 */

import { beforeEach, describe, expect, it } from 'vitest';

import { COST_NOT_MEASURED_CELL } from '../../../core/pricing';
import { RunLedger } from '../../state/ledger';
import {
  deriveExperimentAggregates,
  groupByRecording,
  type ExperimentArmAggregate,
  type Provenance,
  type RecordingGroupRow,
} from './derive';
import {
  ARM_C_TRIPLE,
  RECORDING_DURATION_MS,
  makeRecordingEntity,
  makeRunEntity,
  resetEntitySeq,
} from './testRecords';

/* -------------------------------------------------------------------------
 * The 052 shape, expressed as a widening of today's. Reading through these
 * keeps the file type-checking against the pre-052 declarations while the
 * assertions fail at runtime, which is exactly what a red test should do.
 * ---------------------------------------------------------------------- */

/** How many of the aggregate's samples carried a MEASURED cost. */
type CostProvenance = Provenance & { measuredCostSamples?: number };

type CostAggregate = Omit<ExperimentArmAggregate, 'costUsd' | 'provenance'> & {
  costUsd: number | null;
  /** Rendered through the ONE formatter; `not measured`, never `$0.00`. */
  costCell?: string;
  provenance: CostProvenance;
};

type CostGroupRow = Omit<RecordingGroupRow, 'costUsd'> & {
  costUsd: number | null;
  costCell?: string;
};

/** An unmeasured stored cost, until `Run.cost` is widened to `number | null`. */
const UNMEASURED = null as unknown as number;

const MEASURED_A = 0.011;
const MEASURED_B = 0.022;

const RECORDING_ID = 'rec-cost';

let ledger: RunLedger;

function armBAggregate(): CostAggregate {
  const agg = deriveExperimentAggregates(ledger).perArm['B'];
  expect(agg, 'Arm B should be in the aggregates').toBeDefined();
  return agg as unknown as CostAggregate;
}

beforeEach(() => {
  resetEntitySeq();
  ledger = new RunLedger();
  ledger.appendRecording(makeRecordingEntity({ id: RECORDING_ID, label: 'cost clip' }));
});

/** Three gate-passing Arm-B runs; the third was never metered. */
function seedPartiallyMeteredSweep(): void {
  [MEASURED_A, MEASURED_B, UNMEASURED].forEach((cost, i) => {
    ledger.appendRun(
      makeRunEntity({
        id: `run-cost-${i + 1}`,
        recordingId: RECORDING_ID,
        cost,
        annotations: { utteranceId: `u${i + 1}`, repIndex: i + 1 },
      }),
    );
  });
}

describe('AC6 · an unmeasured cost contributes nothing, not a silent zero', () => {
  it('sums only the samples that were actually metered', () => {
    seedPartiallyMeteredSweep();
    const agg = armBAggregate();
    expect(agg.costUsd).toBeCloseTo(MEASURED_A + MEASURED_B, 10);
  });

  it('reports null — never 0 — when NOTHING in the arm was metered', () => {
    // The `$0.00` failure one level up. An arm of three unmetered runs is not
    // an arm that cost nothing; it is an arm nobody priced.
    for (const i of [1, 2, 3]) {
      ledger.appendRun(
        makeRunEntity({
          id: `run-blank-${i}`,
          recordingId: RECORDING_ID,
          cost: UNMEASURED,
          annotations: { utteranceId: `u${i}`, repIndex: i },
        }),
      );
    }
    const agg = armBAggregate();
    expect(agg.costUsd).toBeNull();
    // Derived from the total, so it cannot survive the total being absent.
    expect(agg.costPerMinuteUsd).toBeNull();
  });

  it('normalizes per audio minute from the MEASURED spend alone', () => {
    seedPartiallyMeteredSweep();
    const agg = armBAggregate();
    // Three gate-passing runs over the same recording. The numerator counts two
    // samples; the denominator is the audio actually replayed.
    const audioMinutes = (3 * RECORDING_DURATION_MS) / 60_000;
    expect(agg.costPerMinuteUsd).toBeCloseTo((MEASURED_A + MEASURED_B) / audioMinutes, 10);
  });

  it('leaves the sample count and the latency figures untouched', () => {
    // An unmetered run is still a latency measurement. Cost is one axis of
    // three (PRD §8) and a hole in one must not evict the other two.
    seedPartiallyMeteredSweep();
    const agg = armBAggregate();
    expect(agg.n).toBe(3);
    expect(agg.p50Ms).not.toBeNull();
  });
});

describe('AC7 · provenance discloses how many samples carry a measured cost', () => {
  it('counts the measured samples against the total', () => {
    seedPartiallyMeteredSweep();
    const { provenance, n } = armBAggregate();
    // THE ASSERTION THE DOLLARS CANNOT MAKE: summing a missing cost as 0 and
    // skipping it give the same total, so only this number tells them apart.
    expect(provenance.measuredCostSamples).toBe(2);
    expect(n).toBe(3);
  });

  it('says so in the rendered line, beside N and the completed reps', () => {
    seedPartiallyMeteredSweep();
    const { provenance } = armBAggregate();
    expect(provenance.line).toMatch(/2\s*(of|\/)\s*3/);
    expect(provenance.line.toLowerCase()).toContain('cost');
  });

  it('discloses a fully metered arm as fully metered', () => {
    [MEASURED_A, MEASURED_B].forEach((cost, i) => {
      ledger.appendRun(
        makeRunEntity({
          id: `run-full-${i + 1}`,
          recordingId: RECORDING_ID,
          cost,
          annotations: { utteranceId: `u${i + 1}`, repIndex: i + 1 },
        }),
      );
    });
    const { provenance, n } = armBAggregate();
    expect(provenance.measuredCostSamples).toBe(n);
  });
});

describe('AC4 · Results renders an unmeasured cost as NOT MEASURED', () => {
  it('renders the aggregate cell as not measured, never as zero dollars', () => {
    ledger.appendRun(
      makeRunEntity({ id: 'run-nc', recordingId: RECORDING_ID, cost: UNMEASURED }),
    );
    const agg = armBAggregate();
    expect(agg.costCell).toBe(COST_NOT_MEASURED_CELL);
    expect(agg.costCell).not.toMatch(/\$0(\.0*)?$/);
  });

  it('renders a measured aggregate as dollars', () => {
    ledger.appendRun(
      makeRunEntity({ id: 'run-mc', recordingId: RECORDING_ID, cost: MEASURED_A }),
    );
    const agg = armBAggregate();
    expect(agg.costCell).toMatch(/^\$\d/);
  });

  it('carries the same rule into the per-Recording listing', () => {
    // The Replay listing reads this grouping. The same run that reports
    // `not measured` in the aggregates cannot report `$0.00` one tab over.
    ledger.appendRun(
      makeRunEntity({
        id: 'run-listing',
        recordingId: RECORDING_ID,
        providerTriple: { ...ARM_C_TRIPLE },
        modelSnapshots: { ...ARM_C_TRIPLE },
        armTag: 'C',
        cost: UNMEASURED,
      }),
    );
    const rows = groupByRecording(ledger) as unknown as CostGroupRow[];
    const row = rows.find((r) => r.arm === 'C');
    expect(row).toBeDefined();
    expect(row!.costUsd).toBeNull();
    expect(row!.costCell).toBe(COST_NOT_MEASURED_CELL);
  });
});

describe('AC5 · the reported cost is the STORED one, read back verbatim', () => {
  it('moves when the stored figure moves — nothing is recomputed at display time', () => {
    ledger.appendRun(
      makeRunEntity({ id: 'run-stored', recordingId: RECORDING_ID, cost: MEASURED_A }),
    );
    const first = armBAggregate();
    expect(first.costUsd).toBeCloseTo(MEASURED_A, 10);

    ledger.appendRun(
      makeRunEntity({
        id: 'run-stored-2',
        recordingId: RECORDING_ID,
        cost: MEASURED_B,
        annotations: { utteranceId: 'u2', repIndex: 2 },
      }),
    );
    const second = armBAggregate();
    expect(second.costUsd).toBeCloseTo(MEASURED_A + MEASURED_B, 10);
  });

  it('splits a Run cost across its utterance records without moving money', () => {
    // Ticket 031's rule with a hole in it: an unmeasured record contributes
    // nothing, and the measured ones still sum to what the Run carries.
    ledger.appendRun(
      makeRunEntity({
        id: 'run-split',
        recordingId: RECORDING_ID,
        cost: MEASURED_A,
        utterances: [
          {
            utteranceId: 'u1',
            index: 1,
            category: 'short-reply',
            timings: { speech_end: 0, audio_queued: 700 },
            transcripts: {},
            cost: MEASURED_A,
            status: 'complete',
            errors: [],
          },
          {
            utteranceId: 'u2',
            index: 2,
            category: 'short-reply',
            timings: { speech_end: 0, audio_queued: 900 },
            transcripts: {},
            cost: UNMEASURED,
            status: 'complete',
            errors: [],
          },
        ],
      }),
    );
    const agg = armBAggregate();
    expect(agg.n).toBe(2);
    expect(agg.costUsd).toBeCloseTo(MEASURED_A, 10);
    expect(agg.provenance.measuredCostSamples).toBe(1);
  });
});
