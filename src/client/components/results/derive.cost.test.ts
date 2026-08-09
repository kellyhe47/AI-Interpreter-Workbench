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

/* -------------------------------------------------------------------------
 * TICKET 059 — THE CONSUMERS OF A STORED ZERO.
 *
 * 052's own round-2 review named the pattern: "the module is solid, its
 * consumers are untested." `pricing.ts` is correct and heavily pinned; the
 * derivation that reads a STORED figure forward is not. The three Runs in
 * `data/runs/` carry `"cost": 0` on the Run and on every utterance record, from
 * a build with no cost model at all, and `costFromStored(0)` hands the By
 * Recording table a MEASUREMENT — which is why the COST column renders `$0.000`
 * on both complete rows today.
 *
 * `LiveSession` already solves exactly this with a `pricingVersion` stamp that
 * `liveCostOf` reads as the discriminator. `Run` gets the same stamp, and these
 * assertions are about what the DERIVATION does with it — including, first, what
 * it must NOT do: collapse a measured zero into an absence.
 * ---------------------------------------------------------------------- */

import { PRICING_VERSION, formatCostUsd } from '../../../core/pricing';
import { groupByCategory, type CategoryGroupRow } from './derive';
import { makeUnstampedRunEntity, type StampedRun } from './testRecords';

/**
 * TICKET 059 — the By Recording row with its cost DENOMINATOR attached, as a
 * widening of today's shape. `$0.06 over 2 of 3 samples` and `$0.06 over 3 of 3`
 * are different claims and the dollars cannot tell them apart — the same
 * disclosure the experiment card's provenance line and the Live footer carry.
 */
type CostDenominatorRow = CostGroupRow & { measuredCostSamples?: number };

const REC_STAMPED = 'rec-stamped-zero';
const REC_UNSTAMPED = 'rec-unstamped-zero';

/** Four `complete` records each storing a `0` — the shape of 7acb0cc9. */
function zeroCostRecords() {
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

/** Two rows differing ONLY in whether their Run declared a price source. */
function seedStampedAndUnstampedZeroRuns(): void {
  ledger.appendRecording(makeRecordingEntity({ id: REC_STAMPED, label: 'stamped clip' }));
  ledger.appendRecording(makeRecordingEntity({ id: REC_UNSTAMPED, label: 'unstamped clip' }));
  ledger.appendRun(
    makeRunEntity({
      id: 'run-stamped-zero',
      recordingId: REC_STAMPED,
      cost: 0,
      utterances: zeroCostRecords(),
    }),
  );
  ledger.appendRun(
    makeUnstampedRunEntity({
      id: 'run-unstamped-zero',
      recordingId: REC_UNSTAMPED,
      cost: 0,
      utterances: zeroCostRecords(),
    }),
  );
}

function rowFor(recordingId: string): CostDenominatorRow {
  const row = (groupByRecording(ledger) as unknown as CostDenominatorRow[]).find(
    (r) => r.recordingId === recordingId,
  );
  expect(row, `no By Recording row for ${recordingId}`).toBeDefined();
  return row!;
}

describe('TICKET 059 · a measured 0 and an unpriced 0 are different rows', () => {
  it('the two fixtures differ only in the price-source stamp', () => {
    // THE PREMISE, ASSERTED — otherwise the opposite verdicts below could be
    // coming from any other difference between the two fixtures.
    seedStampedAndUnstampedZeroRuns();
    const runs = ledger.getRuns() as StampedRun[];
    const stamped = runs.find((r) => r.id === 'run-stamped-zero')!;
    const unstamped = runs.find((r) => r.id === 'run-unstamped-zero')!;

    expect(stamped.pricingVersion).toBe(PRICING_VERSION);
    expect(Object.keys(unstamped)).not.toContain('pricingVersion');
    expect(stamped.cost).toBe(0);
    expect(unstamped.cost).toBe(0);
  });

  it('a Run written TODAY whose measured cost really is 0 still reports $0.000', () => {
    // THE HALF THAT KEEPS THE FIX FROM DEGENERATING INTO "0 MEANS ABSENT".
    // Mapping every zero to `not measured` passes every other assertion in this
    // ticket and fails here — a configuration that really did cost nothing has
    // to be able to say so.
    seedStampedAndUnstampedZeroRuns();
    const row = rowFor(REC_STAMPED);

    expect(row.n).toBe(4);
    expect(row.costUsd).toBe(0);
    expect(row.costUsd).not.toBeNull();
    expect(row.costCell).toBe('$0.000');
    expect(row.costCell).not.toBe(COST_NOT_MEASURED_CELL);
    // Through the ONE formatter, never a second one invented for this row.
    expect(row.costCell).toBe(formatCostUsd(row.costUsd));
  });

  it('a Run with NO price source reports not measured, never $0.000', () => {
    seedStampedAndUnstampedZeroRuns();
    const row = rowFor(REC_UNSTAMPED);

    expect(row.n).toBe(4);
    expect(row.costUsd).toBeNull();
    expect(row.costCell).toBe(COST_NOT_MEASURED_CELL);
    expect(row.costCell).not.toContain('$0.000');
  });

  it('the by-category rows follow the same rule — one vocabulary, both tables', () => {
    // `groupByCategory` reads the same records through the same `costOf`. A gate
    // applied per-surface would leave one of these two tables saying the run was
    // free while the other says nobody priced it.
    // Keyed on (category × arm × direction), so the two must sit on DIFFERENT
    // arms to be two rows at all — the stamp is the only difference that bears
    // on the cost.
    ledger.appendRecording(makeRecordingEntity({ id: REC_STAMPED, label: 'stamped clip' }));
    ledger.appendRecording(makeRecordingEntity({ id: REC_UNSTAMPED, label: 'unstamped clip' }));
    ledger.appendRun(
      makeRunEntity({ id: 'run-cat-b', recordingId: REC_STAMPED, cost: 0, utterances: zeroCostRecords() }),
    );
    ledger.appendRun(
      makeUnstampedRunEntity({
        id: 'run-cat-c',
        recordingId: REC_UNSTAMPED,
        providerTriple: { ...ARM_C_TRIPLE },
        modelSnapshots: { ...ARM_C_TRIPLE },
        armTag: 'C',
        cost: 0,
        utterances: zeroCostRecords(),
      }),
    );

    const rows = groupByCategory(ledger) as unknown as Array<CategoryGroupRow & { costCell: string }>;
    const cellByArm = new Map(rows.map((r) => [r.arm, r.costCell]));

    expect(cellByArm.get('B')).toBe('$0.000');
    expect(cellByArm.get('C')).toBe(COST_NOT_MEASURED_CELL);
  });
});

describe('TICKET 059 · the By Recording row discloses its cost denominator', () => {
  it('reports 0 measured of its samples when the Run declared no price source', () => {
    // The experiment card's provenance line and the Live footer both carry
    // `measured of total`; this row is the one place on the screen that does
    // not, and the money alone cannot supply it — summing a missing cost as 0
    // and skipping it produce the SAME total.
    seedStampedAndUnstampedZeroRuns();
    const row = rowFor(REC_UNSTAMPED);

    expect(row.measuredCostSamples).toBe(0);
    expect(row.n).toBe(4);
  });

  it('reports a full denominator for the stamped row', () => {
    seedStampedAndUnstampedZeroRuns();
    const row = rowFor(REC_STAMPED);

    expect(row.measuredCostSamples).toBe(4);
    expect(row.measuredCostSamples).toBe(row.n);
  });

  it('reports the honest denominator on a PARTIALLY priced row', () => {
    // The case both a `null` total and a full denominator would misreport.
    ledger.appendRecording(makeRecordingEntity({ id: 'rec-mixed', label: 'mixed clip' }));
    ledger.appendRun(
      makeRunEntity({
        id: 'run-mixed',
        recordingId: 'rec-mixed',
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
    const row = rowFor('rec-mixed');

    expect(row.n).toBe(2);
    expect(row.measuredCostSamples).toBe(1);
    expect(row.costUsd).toBeCloseTo(MEASURED_A, 10);
  });
});
