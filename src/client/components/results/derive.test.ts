/**
 * Ticket 011 / 015 — unit tests for the Results derivation layer (no DOM).
 * These tests LOCK the design documented in derive.ts.
 */

import { describe, expect, it } from 'vitest';
import { armLabel } from '../../../core/arms';
import { COST_NOT_MEASURED_CELL } from '../../../core/pricing';
import { ENDPOINTING_MS } from '../../../core/protocol';
import { RunLedger, type LiveSession, type Run } from '../../state/ledger';
import {
  DIRECTION_NOT_RECORDED_CELL,
  PINNED_ENDPOINTING_MS,
  STT_UNCHANGED_CELL,
  deriveComparison,
  deriveExperimentAggregates,
  deriveLiveModel,
  formatDirection,
  formatMs,
  formatUsd,
  groupByCategory,
  groupByRecording,
  sttUnchangedBetween,
  type CategoryGroupRow,
  type ExclusionReason,
  type MetricRow,
  type RecordingGroupRow,
  type UtteranceCategory,
} from './derive';
import {
  ADHOC_RECORDING_ID,
  ARM_C_TRIPLE,
  CATEGORY_COST_PER_RUN,
  CATEGORY_RECORDING_IDS,
  CLEAN_RECORDING_ID,
  CLEAN_SWEEP_COST_PER_RUN,
  CORPUS_VERSION,
  EXCLUDED_LATENCY_MS,
  FAILED_RECORDING_ID,
  FIXTURE_RECORDING_ID,
  LIVE_A_COST,
  MANUAL_RECORDING_ID,
  RECORDING_DURATION_MS,
  SHORT_SWEEP_ALL_FIVE_P50_MS,
  SHORT_SWEEP_COMPLETED_REPS,
  SHORT_SWEEP_COST_PER_RUN,
  SHORT_SWEEP_INTENDED_REPS,
  SHORT_SWEEP_SURVIVING_P50_MS,
  SHORT_SWEEP_SURVIVING_P95_MS,
  T0,
  makeLiveSessionEntity,
  makeRecordingEntity,
  makeRunEntity,
  makeUnstampedRunEntity,
  makeUtteranceRecord,
  runWithLatency,
  seedCategorySweep,
  seedCleanSweep,
  seedComparisonSweep,
  seedExclusionCases,
  seedLiveSessions,
  seedShortRepSweep,
} from './testRecords';

describe('formatMs', () => {
  it('null → em dash (a missing figure is never rendered as 0)', () => {
    expect(formatMs(null)).toBe('—');
  });

  it('under 10 s → seconds with 2 decimals', () => {
    expect(formatMs(1020)).toBe('1.02 s');
    expect(formatMs(240)).toBe('0.24 s');
    expect(formatMs(9990)).toBe('9.99 s');
  });

  it('10 s and above → mm:ss with zero-padded seconds', () => {
    expect(formatMs(10_000)).toBe('0:10');
    expect(formatMs(65_000)).toBe('1:05');
    expect(formatMs(600_000)).toBe('10:00');
  });
});

describe('formatUsd', () => {
  it('null → em dash', () => {
    expect(formatUsd(null)).toBe('—');
  });

  it('formats to three decimals with a leading $', () => {
    expect(formatUsd(0.2)).toBe('$0.200');
    expect(formatUsd(0.04)).toBe('$0.040');
  });
});

function v2row(rows: MetricRow[], metric: 'p50' | 'p95' | 'cost'): MetricRow {
  const found = rows.find((r) => r.metric === metric);
  if (!found) throw new Error(`missing metric row: ${metric}`);
  return found;
}

function recordingRow(rows: RecordingGroupRow[], recordingId: string): RecordingGroupRow {
  const found = rows.find((r) => r.recordingId === recordingId);
  if (!found) throw new Error(`missing recording row: ${recordingId}`);
  return found;
}

describe('deriveExperimentAggregates — the ticket-010 gate, not a second one', () => {
  it('aggregates only sweep-origin, complete, named-arm, real runs', () => {
    const ledger = new RunLedger();
    seedCleanSweep(ledger);
    seedExclusionCases(ledger);
    const agg = deriveExperimentAggregates(ledger);

    expect(agg.empty).toBe(false);
    expect(Object.keys(agg.perArm)).toEqual(['B']);
    expect(agg.perArm['ad-hoc']).toBeUndefined();
    const b = agg.perArm['B']!;
    expect(b.n).toBe(5);
    // Every excluded run carries a 5 s latency and a $0.50 cost. If any of them
    // leaked, both of these move.
    expect(b.p50Ms).toBe(900);
    expect(b.p95Ms).toBe(1200);
    expect(b.costUsd).toBeCloseTo(5 * CLEAN_SWEEP_COST_PER_RUN, 10);
  });

  it('delegates to the ledger gate rather than reimplementing it', () => {
    const ledger = new RunLedger();
    seedCleanSweep(ledger);
    seedExclusionCases(ledger);
    seedShortRepSweep(ledger);
    const derived = deriveExperimentAggregates(ledger);
    const ledgerAgg = ledger.runAggregates();
    expect(Object.keys(derived.perArm).sort()).toEqual(Object.keys(ledgerAgg.perArm).sort());
    for (const [arm, entry] of Object.entries(ledgerAgg.perArm)) {
      const mine = derived.perArm[arm]!;
      expect({
        n: mine.n,
        p50Ms: mine.p50Ms,
        p95Ms: mine.p95Ms,
        costUsd: mine.costUsd,
        // TICKET 052 — the measured-cost denominator delegates too.
        measuredCostSamples: mine.provenance.measuredCostSamples,
      }).toEqual(entry);
    }
  });

  const EXCLUSION_CASES: Array<{
    reason: ExclusionReason;
    recordingId: string;
    arm: string;
    /** Whether the run still contributes a figure to the By-Recording row. */
    figuresInGrouping: boolean;
  }> = [
    // A legal triple that is no frozen arm — the DERIVED tag is 'ad-hoc' even
    // though the Run declares 'B'.
    { reason: 'ad-hoc', recordingId: ADHOC_RECORDING_ID, arm: 'ad-hoc', figuresInGrouping: true },
    { reason: 'manual', recordingId: MANUAL_RECORDING_ID, arm: 'B', figuresInGrouping: true },
    { reason: 'failed', recordingId: FAILED_RECORDING_ID, arm: 'B', figuresInGrouping: false },
    { reason: 'fixture', recordingId: FIXTURE_RECORDING_ID, arm: 'B', figuresInGrouping: false },
  ];

  it.each(EXCLUSION_CASES)(
    '$reason: excluded from the experiment aggregate, still listed by recording',
    ({ reason, recordingId, arm, figuresInGrouping }) => {
      const ledger = new RunLedger();
      seedCleanSweep(ledger);
      seedExclusionCases(ledger);

      // (a) excluded from the aggregate — the clean sweep's five samples are
      //     all that survive, so neither the count nor the percentiles move.
      const agg = deriveExperimentAggregates(ledger);
      expect(Object.keys(agg.perArm)).toEqual(['B']);
      expect(agg.perArm['B']!.n).toBe(5);
      expect(agg.perArm['B']!.p95Ms).toBe(1200);
      expect(agg.perArm['B']!.costUsd).toBeCloseTo(5 * CLEAN_SWEEP_COST_PER_RUN, 10);

      // (b) STILL PRESENT in the per-Recording grouping, marked with why.
      //     Dropping excluded runs entirely would satisfy (a) and break the
      //     secondary tab — ad-hoc runs appear nowhere else.
      const row = recordingRow(groupByRecording(ledger), recordingId);
      expect(row.arm).toBe(arm);
      expect(row.runCount).toBe(1);
      expect(row.excludedFromExperiments).toBe(true);
      expect(row.exclusionReasons).toContain(reason);
      if (figuresInGrouping) {
        expect(row.n).toBe(1);
        expect(row.p50Ms).toBe(EXCLUDED_LATENCY_MS);
      } else {
        // A failed run has no sample; a fixture-sourced one may never report a
        // number anywhere. Neither is rendered as a zero.
        expect(row.n).toBe(0);
        expect(row.p50Ms).toBeNull();
        expect(row.p95Ms).toBeNull();
      }
    },
  );
});

describe('provenance — ACTUAL N, never intended N', () => {
  it('a 5-intended sweep that lost one rep reports 4 of 5 and computes over the 4', () => {
    const ledger = new RunLedger();
    seedShortRepSweep(ledger);
    const arm = deriveExperimentAggregates(ledger).perArm['C']!;

    // The number and the line agree, which is the whole point.
    expect(arm.n).toBe(SHORT_SWEEP_COMPLETED_REPS);
    expect(arm.provenance.completedReps).toBe(SHORT_SWEEP_COMPLETED_REPS);
    expect(arm.provenance.intendedReps).toBe(SHORT_SWEEP_INTENDED_REPS);

    // p50/p95 over the FOUR survivors. Folding the failed run back in would
    // give 1000 ms instead — the failed run carries complete timings on
    // purpose, so this assertion is the one that catches it.
    expect(arm.p50Ms).toBe(SHORT_SWEEP_SURVIVING_P50_MS);
    expect(arm.p50Ms).not.toBe(SHORT_SWEEP_ALL_FIVE_P50_MS);
    expect(arm.p95Ms).toBe(SHORT_SWEEP_SURVIVING_P95_MS);
    expect(arm.costUsd).toBeCloseTo(SHORT_SWEEP_COMPLETED_REPS * SHORT_SWEEP_COST_PER_RUN, 10);

    // Formatting is open; the counts inside the line are not.
    expect(arm.provenance.line).toContain(String(SHORT_SWEEP_COMPLETED_REPS));
    expect(arm.provenance.line).toContain(String(SHORT_SWEEP_INTENDED_REPS));
  });

  /**
   * TICKET 028 REGRESSION GUARD — expected to pass BEFORE the change as well.
   *
   * Every Run written before this ticket carries no annotations at all. Once
   * the sweep starts stamping `repIndex`, those older Runs must keep deriving
   * exactly what they derive today: the counts fall back to the gate-passing
   * run count, and no existing figure moves.
   */
  it('regression guard — Runs carrying NO annotations still derive today’s fallback', () => {
    const ledger = new RunLedger();
    ledger.appendRecording(makeRecordingEntity({ id: 'rec-bare' }));
    // Three gate-passing runs and one failed one, none of them annotated.
    [700, 900, 1200].forEach((ms, i) => {
      ledger.appendRun(
        runWithLatency(ms, { id: `run-bare-${i + 1}`, recordingId: 'rec-bare', annotations: undefined }),
      );
    });
    ledger.appendRun(
      runWithLatency(5_000, {
        id: 'run-bare-failed',
        recordingId: 'rec-bare',
        status: 'failed',
        errors: ['tts stage timed out'],
        annotations: undefined,
      }),
    );

    const arm = deriveExperimentAggregates(ledger).perArm['B']!;
    expect(arm.n).toBe(3);
    // No rep index anywhere, so both counts fall back to the ACTUAL count and
    // the line reads '3 of 3' — the pre-028 behaviour, unchanged.
    expect(arm.provenance.completedReps).toBe(3);
    expect(arm.provenance.intendedReps).toBe(3);
    expect(arm.provenance.line).toContain('3 of 3 reps completed');
    // ...and the figures beside it are the three survivors', not the four.
    expect(arm.p50Ms).toBe(900);
    expect(arm.p95Ms).toBe(1200);
  });

  it('carries the PRD §8 fields: utterances, reps, pinned endpointing, corpus version', () => {
    const ledger = new RunLedger();
    seedCategorySweep(ledger);
    const p = deriveExperimentAggregates(ledger).perArm['B']!.provenance;

    expect(p.utteranceCount).toBe(4);
    expect(p.completedReps).toBe(2);
    expect(p.intendedReps).toBe(2);
    expect(p.endpointingMs).toBe(ENDPOINTING_MS);
    expect(p.endpointingMs).toBe(PINNED_ENDPOINTING_MS);
    expect(p.corpusVersion).toBe(CORPUS_VERSION);

    expect(p.line).toContain(`endpointing pinned ${ENDPOINTING_MS} ms`);
    expect(p.line).toContain(CORPUS_VERSION);
  });
});

describe('groupByRecording — the navigation grouping, ad-hoc runs included', () => {
  function mixedLedger(): RunLedger {
    const ledger = new RunLedger();
    seedCleanSweep(ledger);
    seedExclusionCases(ledger);
    seedCategorySweep(ledger);
    return ledger;
  }

  it('returns exactly one row per (recording × configuration)', () => {
    const rows = groupByRecording(mixedLedger());
    // rec-clean, 4 exclusion recordings, rec-cat-1, rec-cat-2.
    expect(rows).toHaveLength(7);
    const keys = rows.map((r) => `${r.recordingId}|${r.configuration}`);
    expect(new Set(keys).size).toBe(keys.length);
    expect(rows.map((r) => r.recordingId).sort()).toEqual(
      [
        ADHOC_RECORDING_ID,
        CATEGORY_RECORDING_IDS[0],
        CATEGORY_RECORDING_IDS[1],
        CLEAN_RECORDING_ID,
        FAILED_RECORDING_ID,
        FIXTURE_RECORDING_ID,
        MANUAL_RECORDING_ID,
      ].sort(),
    );
  });

  it('a gate-passing group carries its figures and no exclusion reason', () => {
    const row = recordingRow(groupByRecording(mixedLedger()), CLEAN_RECORDING_ID);
    expect(row.recordingLabel).toBe('clean sweep clip');
    expect(row.arm).toBe('B');
    expect(row.origins).toEqual(['sweep']);
    expect(row.runCount).toBe(5);
    expect(row.failedCount).toBe(0);
    expect(row.n).toBe(5);
    expect(row.p50Ms).toBe(900);
    expect(row.p95Ms).toBe(1200);
    expect(row.costUsd).toBeCloseTo(5 * CLEAN_SWEEP_COST_PER_RUN, 10);
    expect(row.excludedFromExperiments).toBe(false);
    expect(row.exclusionReasons).toEqual([]);
  });

  it('a failed run is listed and counted, but contributes no sample', () => {
    const row = recordingRow(groupByRecording(mixedLedger()), FAILED_RECORDING_ID);
    expect(row.runCount).toBe(1);
    expect(row.failedCount).toBe(1);
    expect(row.n).toBe(0);
    expect(row.p50Ms).toBeNull();
  });

  it('an ad-hoc run appears here and nowhere else', () => {
    const ledger = mixedLedger();
    expect(deriveExperimentAggregates(ledger).perArm['ad-hoc']).toBeUndefined();
    expect(groupByCategory(ledger).some((r) => r.arm === 'ad-hoc')).toBe(false);
    const row = recordingRow(groupByRecording(ledger), ADHOC_RECORDING_ID);
    expect(row.arm).toBe('ad-hoc');
    // It was swept like any other run; what disqualifies it is the DERIVED tag.
    expect(row.origins).toEqual(['sweep']);
    expect(row.n).toBe(1);
    expect(row.p50Ms).toBe(EXCLUDED_LATENCY_MS);
  });
});

describe('groupByCategory — grouped on the tag, not on the recording', () => {
  it('pools each category across the recordings it is distributed over', () => {
    const ledger = new RunLedger();
    seedCategorySweep(ledger);
    const rows = groupByCategory(ledger);

    expect(rows.map((r) => r.category).sort()).toEqual(['numbers-dates', 'short-reply']);
    expect(rows.every((r) => r.arm === 'B')).toBe(true);

    const numbers = rows.find((r) => r.category === 'numbers-dates')!;
    // Two recordings × two reps. Each recording holds only 2 of these, so an
    // n of 4 can only come from grouping on the tag.
    expect(numbers.n).toBe(4);
    expect(numbers.p50Ms).toBe(1300);
    expect(numbers.p95Ms).toBe(1600);
    expect(numbers.costUsd).toBeCloseTo(4 * CATEGORY_COST_PER_RUN, 10);

    const short = rows.find((r) => r.category === 'short-reply')!;
    expect(short.n).toBe(4);
    expect(short.p50Ms).toBe(760);
    expect(short.p95Ms).toBe(980);
  });

  it('produces a figure no per-recording grouping can produce', () => {
    const ledger = new RunLedger();
    seedCategorySweep(ledger);
    const categoryP50s = groupByCategory(ledger).map((r) => r.p50Ms);
    const recordingP50s = groupByRecording(ledger).map((r) => r.p50Ms);
    // rec-cat-1 → 760, rec-cat-2 → 980; numbers-dates → 1300.
    expect(recordingP50s.sort()).toEqual([760, 980]);
    expect(categoryP50s).toContain(1300);
    expect(recordingP50s).not.toContain(1300);
  });
});

describe('one ledger under every view — no second source of truth', () => {
  it('both groupings reconcile with the experiment aggregate', () => {
    const ledger = new RunLedger();
    seedCategorySweep(ledger);

    const agg = deriveExperimentAggregates(ledger).perArm['B']!;
    const ledgerAgg = ledger.runAggregates().perArm['B']!;
    // TICKET 052 — `measuredCostSamples` rides on the ledger aggregate beside
    // `costUsd`, and the derivation reports it through provenance; both are
    // compared so the delegation stays total.
    expect({
      n: agg.n,
      p50Ms: agg.p50Ms,
      p95Ms: agg.p95Ms,
      costUsd: agg.costUsd,
      measuredCostSamples: agg.provenance.measuredCostSamples,
    }).toEqual(ledgerAgg);

    const byRecording = groupByRecording(ledger).filter((r) => !r.excludedFromExperiments);
    expect(byRecording.reduce((sum, r) => sum + r.n, 0)).toBe(agg.n);
    expect(byRecording.reduce((sum, r) => sum + (r.costUsd ?? 0), 0)).toBeCloseTo(agg.costUsd!, 10);

    const byCategory = groupByCategory(ledger);
    expect(byCategory.reduce((sum, r) => sum + r.n, 0)).toBe(agg.n);
    expect(byCategory.reduce((sum, r) => sum + (r.costUsd ?? 0), 0)).toBeCloseTo(agg.costUsd!, 10);
  });
});

describe('deriveComparison — exp 1 and exp 2', () => {
  function comparisonLedger(): RunLedger {
    const ledger = new RunLedger();
    seedComparisonSweep(ledger);
    return ledger;
  }

  it('exp 1 (A vs B) compares latency and cost per audio minute', () => {
    const model = deriveComparison(comparisonLedger(), 'A', 'B')!;
    expect(model).not.toBeNull();
    expect(model.armA).toBe('A');
    expect(model.armB).toBe('B');

    const p50 = v2row(model.rows, 'p50');
    expect(p50.valueA).toBe('1.10 s');
    expect(p50.valueB).toBe('0.80 s');
    expect(p50.delta).toBe('-0.30 s');
    expect(p50.deltaTone).toBe('good');

    const p95 = v2row(model.rows, 'p95');
    expect(p95.valueA).toBe('1.20 s');
    expect(p95.valueB).toBe('0.90 s');

    // 3 runs × 6 s of audio = 0.3 min. A: $0.030 → $0.100/min. B: $0.006 → $0.020/min.
    const cost = v2row(model.rows, 'cost');
    expect(cost.valueA).toBe('$0.100');
    expect(cost.valueB).toBe('$0.020');
    expect(cost.delta).toBe('-$0.080');
    expect(cost.deltaTone).toBe('good');

    expect(model.provenanceA.completedReps).toBe(3);
    expect(model.provenanceB.completedReps).toBe(3);
  });

  it("exp 2's WER cell says the STT is unchanged rather than inventing a number", () => {
    expect(sttUnchangedBetween('B', 'C')).toBe(true);
    expect(sttUnchangedBetween('A', 'B')).toBe(false);

    const exp2 = deriveComparison(comparisonLedger(), 'B', 'C')!;
    expect(exp2.werCell).toBe(STT_UNCHANGED_CELL);
    expect(exp2.werCell).toContain('STT unchanged');
    // Only TTS differs between B and C, so there is no STT delta to report —
    // and therefore no digit in the cell.
    expect(exp2.werCell).not.toMatch(/\d/);

    const exp1 = deriveComparison(comparisonLedger(), 'A', 'B')!;
    expect(exp1.werCell).not.toBe(STT_UNCHANGED_CELL);
  });

  it('exp 2 latency and cost deltas are computed from the B and C samples', () => {
    const model = deriveComparison(comparisonLedger(), 'B', 'C')!;
    const p50 = v2row(model.rows, 'p50');
    expect(p50.valueA).toBe('0.80 s');
    expect(p50.valueB).toBe('0.85 s');
    expect(p50.delta).toBe('+0.05 s');
    expect(p50.deltaTone).toBe('bad');
    const cost = v2row(model.rows, 'cost');
    expect(cost.valueA).toBe('$0.020');
    expect(cost.valueB).toBe('$0.040');
    expect(cost.deltaTone).toBe('bad');
  });

  it('is null when either arm has no gate-passing samples', () => {
    const ledger = new RunLedger();
    seedCleanSweep(ledger); // Arm B only
    expect(deriveComparison(ledger, 'A', 'B')).toBeNull();
    expect(deriveComparison(ledger, 'B', 'C')).toBeNull();
  });
});

describe('deriveLiveModel — LiveSessions only, never mixed with Runs', () => {
  it('builds one column per arm from the sessions themselves', () => {
    const ledger = new RunLedger();
    seedLiveSessions(ledger);
    const model = deriveLiveModel(ledger);

    expect(model.empty).toBe(false);
    expect(model.columns.map((c) => c.arm).sort()).toEqual(['A', 'B']);

    const a = model.columns.find((c) => c.arm === 'A')!;
    expect(a.label).toBe(armLabel('A'));
    expect(a.sessions).toBe(1);
    expect(a.p50Ms).toBe(1100);
    expect(a.p95Ms).toBe(1200);
    expect(a.costPerMinuteMinute1).toBe(LIVE_A_COST.perMinuteMinute1);
    expect(a.costPerMinuteFinalMinute).toBe(LIVE_A_COST.perMinuteFinalMinute);
    expect(a.utterancesCompleted).toBe(3);
    expect(a.disconnects).toBe(1);
    // PRD §7: there is no reference text in Live, so WER is always null.
    expect(a.wer).toBeNull();

    const b = model.columns.find((c) => c.arm === 'B')!;
    expect(b.p50Ms).toBe(700);
    expect(b.disconnects).toBe(0);
  });

  it('is unmoved by Runs in the same ledger', () => {
    const ledger = new RunLedger();
    seedLiveSessions(ledger);
    const before = deriveLiveModel(ledger);
    seedComparisonSweep(ledger);
    seedShortRepSweep(ledger);
    seedExclusionCases(ledger);
    expect(deriveLiveModel(ledger)).toEqual(before);
  });

  it('is empty for a ledger that holds only Runs', () => {
    const ledger = new RunLedger();
    seedComparisonSweep(ledger);
    // TICKET 064 — the model gained `sessionsWithoutContextPolicy`, and this
    // exact-shape assertion is kept exact: a ledger with no LiveSession at all
    // has nothing to disclose, so the count is 0 and not merely absent.
    expect(deriveLiveModel(ledger)).toEqual({
      columns: [],
      empty: true,
      sessionsWithoutContextPolicy: 0,
    });
  });
});

describe('empty states — no zeros masquerading as measurements', () => {
  it('every v2 derivation has an explicit empty state on an empty ledger', () => {
    const ledger = new RunLedger();
    expect(deriveExperimentAggregates(ledger)).toEqual({ perArm: {}, empty: true });
    expect(groupByRecording(ledger)).toEqual([]);
    expect(groupByCategory(ledger)).toEqual([]);
    expect(deriveComparison(ledger, 'A', 'B')).toBeNull();
    expect(deriveLiveModel(ledger)).toEqual({
      columns: [],
      empty: true,
      sessionsWithoutContextPolicy: 0,
    });
  });

  it('a fixture-sourced ledger aggregates to the same explicit empty state', () => {
    const ledger = new RunLedger();
    ledger.appendRecording(makeRecordingEntity({ id: FIXTURE_RECORDING_ID }));
    ledger.appendRun(
      runWithLatency(1_000, {
        recordingId: FIXTURE_RECORDING_ID,
        modelSnapshots: { stt: 'fixture', mt: 'fixture', tts: 'fixture' },
      }),
    );
    expect(deriveExperimentAggregates(ledger)).toEqual({ perArm: {}, empty: true });
    expect(groupByCategory(ledger)).toEqual([]);
    // ...but it is still navigable, carrying no figure of its own.
    const row = recordingRow(groupByRecording(ledger), FIXTURE_RECORDING_ID);
    expect(row.n).toBe(0);
    expect(row.p50Ms).toBeNull();
    expect(row.excludedFromExperiments).toBe(true);
  });
});

describe('no hardcoded figures — every number comes from the records', () => {
  function sweptLedger(latencies: number[], costPerRun: number): RunLedger {
    const ledger = new RunLedger();
    ledger.appendRecording(makeRecordingEntity({ id: 'rec-param' }));
    latencies.forEach((ms, i) => {
      ledger.appendRun(
        runWithLatency(ms, {
          id: `run-param-${i + 1}`,
          recordingId: 'rec-param',
          cost: costPerRun,
          annotations: {
            utteranceId: 'u1',
            category: 'disfluency',
            repIndex: i + 1,
            corpusVersion: CORPUS_VERSION,
          },
        }),
      );
    });
    return ledger;
  }

  it('two differently seeded ledgers derive different figures', () => {
    const base = [700, 780, 900, 1000, 1200];
    const one = deriveExperimentAggregates(sweptLedger(base, 0.002)).perArm['B']!;
    const two = deriveExperimentAggregates(
      sweptLedger(
        base.map((ms) => ms * 2),
        0.004,
      ),
    ).perArm['B']!;

    expect(one.p50Ms).toBe(900);
    expect(two.p50Ms).toBe(1800);
    expect(one.p95Ms).toBe(1200);
    expect(two.p95Ms).toBe(2400);
    expect(one.costUsd).toBeCloseTo(0.01, 10);
    expect(two.costUsd).toBeCloseTo(0.02, 10);
    expect(one.p50Ms).not.toBe(two.p50Ms);
    expect(one.costUsd).not.toBe(two.costUsd);
  });

  it('cost per audio minute tracks the Recording duration it is normalized by', () => {
    // 5 runs × 6 s of audio = 0.5 min; 5 × $0.002 = $0.010 → $0.020 / min.
    const ledger = sweptLedger([700, 780, 900, 1000, 1200], 0.002);
    const arm = deriveExperimentAggregates(ledger).perArm['B']!;
    const minutes = (5 * RECORDING_DURATION_MS) / 60_000;
    expect(arm.costPerMinuteUsd).toBeCloseTo(arm.costUsd! / minutes, 10);
    expect(arm.costPerMinuteUsd).toBeCloseTo(0.02, 10);
  });
});

/* ============================== TICKET 061 — direction is part of the key == */

/**
 * TICKET 061 — EN→YUE AND YUE→EN ARE SEPARATE CLAIMS (PRD §7), AND THE
 * ASYMMETRY BETWEEN THEM IS THE FINDING.
 *
 * `groupByCategory` keys on `${category}|${arm}`, so two samples that differ
 * ONLY in the direction they ran land in the same row and are averaged into a
 * single number. That number is a claim about no language in particular: it
 * says "Arm B does short replies in 1.5 s" over a population that was half
 * Spanish and half Cantonese, and it makes the one comparison the corpus was
 * built to support — the two ends of a pair against each other —
 * unrepresentable in the table PRD §8 calls "where the heterogeneity lives".
 *
 * The row identity these tests require is what ResultsView's React key and its
 * `data-` attributes have to be built from; a split that the row cannot report
 * is a split the rendered table cannot show (see ResultsView.category.test.tsx).
 */
describe('TICKET 061 — groupByCategory splits on direction, never pools two of them', () => {
  const CATEGORY: UtteranceCategory = 'numbers-dates';

  /** A gate-passing Arm-B run of one direction, with a distinguishable latency. */
  function directedRun(direction: string, latencyMs: number, id: string) {
    return runWithLatency(latencyMs, {
      id,
      recordingId: 'rec-dir',
      languagePair: direction.includes('yue') ? 'EN↔YUE' : 'EN↔ES',
      direction,
      annotations: {
        utteranceId: 'u1',
        category: CATEGORY,
        repIndex: 1,
        corpusVersion: CORPUS_VERSION,
      },
    });
  }

  function ledgerOf(...runs: ReturnType<typeof directedRun>[]): RunLedger {
    const ledger = new RunLedger();
    ledger.appendRecording(makeRecordingEntity({ id: 'rec-dir', label: 'direction clip' }));
    for (const run of runs) ledger.appendRun(run);
    return ledger;
  }

  /** The row shape the split requires: identity has to include the direction. */
  type DirectedRow = CategoryGroupRow & { direction?: string };

  it('TWO rows where one appeared before: same category, same arm, different direction', () => {
    const ledger = ledgerOf(
      directedRun('en→es', 1_000, 'run-dir-es'),
      directedRun('en→yue', 2_000, 'run-dir-yue'),
    );
    const rows = groupByCategory(ledger) as DirectedRow[];

    // Today: ONE row, n = 2, a single percentile over two languages.
    expect(rows).toHaveLength(2);
    expect(rows.map((r) => r.n)).toEqual([1, 1]);
    expect(rows.every((r) => r.category === CATEGORY)).toBe(true);
    expect(rows.every((r) => r.arm === 'B')).toBe(true);

    // The asymmetry is the finding, so each direction keeps its own figure.
    const es = rows.find((r) => r.direction === 'en→es');
    const yue = rows.find((r) => r.direction === 'en→yue');
    expect(es).toBeDefined();
    expect(yue).toBeDefined();
    expect(es!.p50Ms).toBe(1_000);
    expect(yue!.p50Ms).toBe(2_000);
  });

  it('row identity is unique on (category, arm, direction) — the DOM key can be built from it', () => {
    const ledger = ledgerOf(
      directedRun('en→es', 1_000, 'run-dir-es'),
      directedRun('en→yue', 2_000, 'run-dir-yue'),
    );
    const rows = groupByCategory(ledger) as DirectedRow[];

    // Stated first, so the set comparisons below can never be satisfied by a
    // single row trivially agreeing with itself.
    expect(rows).toHaveLength(2);

    const oldKeys = rows.map((r) => `${r.category}|${r.arm}`);
    const newKeys = rows.map((r) => `${r.category}|${r.arm}|${r.direction}`);
    // The point of the ticket, stated as a collision: today's key cannot tell
    // the two rows apart, so React would key both children identically.
    expect(new Set(oldKeys).size).toBe(1);
    expect(new Set(newKeys).size).toBe(2);
  });

  it('GUARD: same direction still POOLS — the split is on direction, not on the Run', () => {
    const ledger = ledgerOf(
      directedRun('en→es', 1_000, 'run-dir-a'),
      directedRun('en→es', 2_000, 'run-dir-b'),
    );
    const rows = groupByCategory(ledger) as DirectedRow[];

    expect(rows).toHaveLength(1);
    expect(rows[0]!.n).toBe(2);
    // Nearest rank over [1000, 2000]: p50 = 1000, p95 = 2000.
    expect(rows[0]!.p50Ms).toBe(1_000);
    expect(rows[0]!.p95Ms).toBe(2_000);
  });

  it('GUARD: splitting creates and loses no samples — the rows still sum to the arm', () => {
    const ledger = ledgerOf(
      directedRun('en→es', 1_000, 'run-dir-es'),
      directedRun('en→yue', 2_000, 'run-dir-yue'),
    );
    const rows = groupByCategory(ledger);
    const agg = deriveExperimentAggregates(ledger).perArm['B']!;

    // Named so the conservation check cannot pass on today's single pooled row.
    expect(rows).toHaveLength(2);
    expect(rows.reduce((sum, r) => sum + r.n, 0)).toBe(agg.n);
    expect(rows.reduce((sum, r) => sum + (r.costUsd ?? 0), 0)).toBeCloseTo(agg.costUsd!, 10);
  });
});

/* ========== TICKET 061 follow-up — an unrecorded direction is not a blank == */

/**
 * ABSENCE IS NOT A BLANK. `groupByCategory` used to coerce a missing direction
 * with `run.direction ?? ''`, and `''` is a VALUE, not an absence: it renders
 * as an empty table cell that reads "this row has no direction column" rather
 * than "this run never recorded one", and it collides React keys built from
 * `${category}|${arm}|${direction}`.
 *
 * The rule is the repo's standing one, one level over from `formatWer`'s
 * `'—'` and `WER_NOT_MEASURED_CELL`: the DERIVATION decides the cell, in one
 * place, so no view can invent a blank — or a zero — for something nobody
 * recorded.
 *
 * `isAggregatableRun` already rejects a Run that recorded no direction, so no
 * ledger can produce such a ROW. That is precisely why the absence branch has
 * to be pinned here, on the function itself: it is the only reachable seam,
 * and an unpinned branch is how `''` got in.
 */
describe('formatDirection — a direction nobody recorded reads as not recorded', () => {
  it('renders the not-recorded literal for undefined and for the empty string', () => {
    expect(formatDirection(undefined)).toBe(DIRECTION_NOT_RECORDED_CELL);
    expect(formatDirection('')).toBe(DIRECTION_NOT_RECORDED_CELL);
  });

  it('the literal is neither empty, nor a zero, nor a language', () => {
    expect(DIRECTION_NOT_RECORDED_CELL.trim()).not.toBe('');
    expect(DIRECTION_NOT_RECORDED_CELL).not.toBe('0');
    expect(DIRECTION_NOT_RECORDED_CELL).not.toMatch(/→/);
  });

  it('renders a recorded direction verbatim — it is a readout, not a translation', () => {
    expect(formatDirection('en→yue')).toBe('en→yue');
    expect(formatDirection('yue→en')).toBe('yue→en');
  });

  it('every row groupByCategory builds carries the cell already rendered', () => {
    const ledger = new RunLedger();
    ledger.appendRecording(makeRecordingEntity({ id: 'rec-cell', label: 'direction cell clip' }));
    for (const [direction, pair, latencyMs, id] of [
      ['en→es', 'EN↔ES', 1_000, 'run-cell-es'],
      ['en→yue', 'EN↔YUE', 2_000, 'run-cell-yue'],
    ] as const) {
      ledger.appendRun(
        runWithLatency(latencyMs, {
          id,
          recordingId: 'rec-cell',
          languagePair: pair,
          direction,
          annotations: {
            utteranceId: 'u1',
            category: 'numbers-dates',
            repIndex: 1,
            corpusVersion: CORPUS_VERSION,
          },
        }),
      );
    }
    const rows = groupByCategory(ledger);
    expect(rows.map((r) => r.directionCell)).toEqual(['en→es', 'en→yue']);
    for (const row of rows) expect(row.directionCell).toBe(formatDirection(row.direction));
  });
});

/* ===================== TICKET 055b — the two tables use the SAME predicate == */

/**
 * TICKET 055b, ADVERSARIAL ROUND — `derive.ts`'s HALF OF THE RULE.
 *
 * `groupByRecording` and `groupByCategory` each filter their percentile pool
 * with `isMeasuredLatencyMs`, and the comments beside both lines claim that
 * this row and the experiment card "cannot disagree about what counts as a
 * latency (PRD §8)". Revert either filter to `ms !== null` and the whole suite
 * and every golden eval stay green — the claim is asserted by comment only.
 *
 * The NEGATIVE case never reaches these lines: `refuseClockInversion` stores
 * such a run `failed`, so `derive.ts:880`'s `status === 'complete'` filter drops
 * it before the pool is built. THE REACHABLE CASE IS A 0 ms SAMPLE. It is not
 * an inversion, so the run stays `complete` and arrives here intact — and it is
 * not a latency either, so the two tables must drop it exactly as
 * `runAggregates` does. A table that kept it would publish a p50 the experiment
 * card contradicts, over a sample nothing measured.
 */
describe('TICKET 055b — a 0 ms sample is dropped from every percentile, by whichever path', () => {
  const ZERO_RECORDING_ID = 'rec-zero-ms';
  const ZERO_CATEGORY: UtteranceCategory = 'short-reply';

  /** Four gate-passing Arm-B runs on one recording: 0, 500, 900 and 1200 ms. */
  const LATENCIES_MS = [0, 500, 900, 1200] as const;

  /**
   * Nearest-rank over the THREE that survive — sorted [500, 900, 1200]:
   *   p50 = sorted[ceil(0.50·3) − 1] = sorted[1] = 900
   *   p95 = sorted[ceil(0.95·3) − 1] = sorted[2] = 1200
   * Keeping the 0 gives sorted [0, 500, 900, 1200] and
   *   p50 = sorted[ceil(0.50·4) − 1] = sorted[1] = 500 — the arithmetic these
   * tests exist to forbid, and the one figure that separates the two pools.
   */
  const SURVIVING_P50_MS = 900;
  const SURVIVING_P95_MS = 1_200;
  const POOLED_WITH_ZERO_P50_MS = 500;

  function zeroLedger(): RunLedger {
    const ledger = new RunLedger();
    ledger.appendRecording(
      makeRecordingEntity({ id: ZERO_RECORDING_ID, label: 'zero-ms clip' }),
    );
    LATENCIES_MS.forEach((ms, i) => {
      ledger.appendRun(
        runWithLatency(ms, {
          id: `run-zero-${i}`,
          recordingId: ZERO_RECORDING_ID,
          annotations: {
            utteranceId: 'u1',
            category: ZERO_CATEGORY,
            repIndex: i + 1,
            corpusVersion: CORPUS_VERSION,
          },
        }),
      );
    });
    return ledger;
  }

  it('the premise: the 0 ms run is stored COMPLETE and does reach these tables', () => {
    const ledger = zeroLedger();
    // Not refused at write time — a zero is not an inversion — so the filter
    // under test is the only thing that can drop it.
    expect(ledger.getRuns().map((r) => r.status)).toEqual([
      'complete',
      'complete',
      'complete',
      'complete',
    ]);
    const row = recordingRow(groupByRecording(ledger), ZERO_RECORDING_ID);
    expect(row.runCount).toBe(4);
    expect(row.failedCount).toBe(0);
  });

  it('groupByRecording drops it from the percentile pool, exactly as runAggregates does', () => {
    const ledger = zeroLedger();
    const row = recordingRow(groupByRecording(ledger), ZERO_RECORDING_ID);

    expect(row.p50Ms).toBe(SURVIVING_P50_MS);
    expect(row.p95Ms).toBe(SURVIVING_P95_MS);
    // Named explicitly, because this is the figure `ms !== null` would print.
    expect(row.p50Ms).not.toBe(POOLED_WITH_ZERO_P50_MS);

    // `n` on this row counts the COMPLETE records the group produced, not the
    // percentile pool — the 0 ms sample is still listed, which is what makes
    // the drop visible rather than silent. The aggregate's `n` is the pool.
    expect(row.n).toBe(4);
  });

  it('groupByCategory drops it too — one predicate, not one per table', () => {
    const ledger = zeroLedger();
    const rows = groupByCategory(ledger);
    expect(rows).toHaveLength(1);
    const row = rows[0]!;
    expect(row.category).toBe(ZERO_CATEGORY);

    expect(row.p50Ms).toBe(SURVIVING_P50_MS);
    expect(row.p95Ms).toBe(SURVIVING_P95_MS);
    expect(row.p50Ms).not.toBe(POOLED_WITH_ZERO_P50_MS);
  });

  it('the two rows and the experiment card report ONE figure — PRD §8', () => {
    const ledger = zeroLedger();
    const card = deriveExperimentAggregates(ledger).perArm['B']!;

    // The aggregate drops the 0 from the numerator AND the denominator, so its
    // own `n` is the three that were measured.
    expect(card.n).toBe(3);
    expect(card.p50Ms).toBe(SURVIVING_P50_MS);
    expect(card.p95Ms).toBe(SURVIVING_P95_MS);

    // THE CLAIM the comments make: no table may disagree with the card about
    // what counted as a latency.
    const byRecording = recordingRow(groupByRecording(ledger), ZERO_RECORDING_ID);
    const byCategory = groupByCategory(ledger)[0]!;
    expect(byRecording.p50Ms).toBe(card.p50Ms);
    expect(byRecording.p95Ms).toBe(card.p95Ms);
    expect(byCategory.p50Ms).toBe(card.p50Ms);
    expect(byCategory.p95Ms).toBe(card.p95Ms);
  });
});

/* ====== TICKET 055a — PROVENANCE REPORTS ACTUAL N, AND KEEPS ITS DENOMINATOR ==
 *
 * Golden eval `04-provenance-reports-actual-n.json`: a sweep that INTENDED 3
 * reps, 2 rows in the ledger, 1 POST the store never acknowledged. The line
 * must read `2 of 3 reps completed` and never `2 of 2` — AGENTS.md names this
 * failure verbatim: "the denominator silently falls back to the numerator and
 * every line reads a clean N of N."
 *
 * TODAY'S MECHANISM IS NOT ENOUGH, AND batch/runner.ts:436-439 SAYS SO:
 *   "KNOWN RESIDUAL — the rendered provenance still reads '2 of 2' rather than
 *    '2 of 3' for a lost rep, because `intendedReps` is distinct `repIndex`
 *    over sweep ROWS and this rep has none."
 * A rep whose row never landed leaves NOTHING in the ledger, so no derivation
 * over the surviving rows can recover the 3. The sweep's own PLAN is the only
 * evidence that survives, and it survives only if the rows CARRY it — the same
 * decision `annotations.corpusVersion` already embodies ("COPIED, NOT LOOKED UP
 * LATER", ledger.ts:221-231).
 *
 * THE FIELD NAME BELOW IS THIS TICKET'S PROPOSAL, NOT A DISCOVERY.
 * `annotations.intendedReps` — the retained rep count the sweep DECLARED
 * (`BatchOptions.reps`, already surfaced as `BatchConfigSummary.intendedReps`),
 * stamped on every row by `createRunOnceExecutor` exactly where it already
 * stamps `repIndex`. It is read here through a narrow local cast so no
 * production type moves before the implementation does.
 *
 * IT IS A FLOOR, NEVER A CEILING (second test): a declaration can only ever
 * RAISE the denominator. Letting it lower one would hand a stale plan the power
 * to hide a rep that demonstrably ran — the same "N of N" dishonesty from the
 * other direction.
 * ========================================================================== */

/** The sweep's DECLARED retained rep count, stamped on every row it writes. */
type SweepPlanAnnotations = { repIndex?: number; corpusVersion?: string; intendedReps?: number };

const PLAN_RECORDING_ID = 'rec-plan-sweep';

/** One row of a sweep that DECLARED `declared` reps and is writing rep `rep`. */
function planRow(rep: number, ms: number, declared: number, overrides: Partial<Run> = {}): Run {
  const annotations: SweepPlanAnnotations = {
    repIndex: rep,
    corpusVersion: CORPUS_VERSION,
    intendedReps: declared,
  };
  return runWithLatency(ms, {
    id: `run-plan-${rep}`,
    recordingId: PLAN_RECORDING_ID,
    cost: 0.002,
    annotations,
    ...overrides,
  });
}

describe('TICKET 055a — a rep whose row never landed stays in the DENOMINATOR', () => {
  /** Golden eval 04's `given`, exactly: 3 intended, 2 rows, 1 POST unacknowledged. */
  const DECLARED_REPS = 3;
  const LANDED = [800, 1000] as const;

  function lossyLedger(): RunLedger {
    const ledger = new RunLedger();
    ledger.appendRecording(makeRecordingEntity({ id: PLAN_RECORDING_ID }));
    // Rep 3 ran. Its POST went unacknowledged, so it has NO row here — that is
    // the whole scenario, and it is why the plan has to ride the rows that did
    // land.
    LANDED.forEach((ms, i) => ledger.appendRun(planRow(i + 1, ms, DECLARED_REPS)));
    return ledger;
  }

  it('renders `2 of 3 reps completed`, never `2 of 2`', () => {
    const arm = deriveExperimentAggregates(lossyLedger()).perArm['B']!;

    // latency_samples: the two rows that landed. The lost rep adds no sample —
    // the denominator that must survive is the REP count, not `n`.
    expect(arm.n).toBe(2);
    expect(arm.p50Ms).toBe(800);

    expect(arm.provenance.completedReps).toBe(2);
    expect(arm.provenance.intendedReps).toBe(DECLARED_REPS);
    expect(arm.provenance.line).toContain('2 of 3 reps completed');

    // Asserted against the REP CLAUSE alone, exactly as the golden runner does:
    // ticket 052's `cost measured on 2 of 2 samples` is a different and
    // legitimately-`2 of 2` figure on the same line.
    const repsClause = /\d+ of \d+ reps completed/.exec(arm.provenance.line)?.[0] ?? '';
    expect(repsClause).not.toBe('2 of 2 reps completed');
    expect(repsClause).not.toBe('3 of 3 reps completed');
  });

  it('the declaration is a FLOOR: it can never shrink a denominator the rows prove', () => {
    // A stale plan says 3; four reps demonstrably ran (one of them failed).
    const ledger = new RunLedger();
    ledger.appendRecording(makeRecordingEntity({ id: PLAN_RECORDING_ID }));
    [800, 900, 1100].forEach((ms, i) => ledger.appendRun(planRow(i + 1, ms, DECLARED_REPS)));
    ledger.appendRun(
      planRow(4, 5_000, DECLARED_REPS, { status: 'failed', errors: ['tts stage timed out'] }),
    );

    const arm = deriveExperimentAggregates(ledger).perArm['B']!;
    expect(arm.n).toBe(3);
    expect(arm.provenance.completedReps).toBe(3);
    // 4, from the rows — NOT the declared 3, which would delete a rep that ran.
    expect(arm.provenance.intendedReps).toBe(4);
    expect(arm.provenance.line).toContain('3 of 4 reps completed');
  });

  /**
   * THE TWO HALVES OF THIS TICKET PULL IN OPPOSITE DIRECTIONS, so this is
   * asserted rather than assumed: 055a's other half REMOVES unsynced
   * LiveSessions from every aggregate, and a fix that reached for "anything the
   * server did not acknowledge is out" would take the rep denominator with it.
   * LiveSessions and Runs share a ledger and nothing else.
   */
  it('the unsynced-LiveSession work must not shrink the rep denominator', () => {
    const ledger = lossyLedger();
    const before = deriveExperimentAggregates(ledger).perArm['B']!.provenance;

    for (const id of ['live-unsynced-1', 'live-unsynced-2']) {
      // Narrow local cast at the assertion site: `syncState` is this ticket's
      // proposed field and does not exist on `LiveSession` yet.
      const session: LiveSession & { syncState: string } = {
        ...makeLiveSessionEntity({ id }),
        syncState: 'unsynced',
      };
      ledger.appendLiveSession(session);
    }

    const after = deriveExperimentAggregates(ledger).perArm['B']!.provenance;
    expect(after).toEqual(before);
    expect(after.intendedReps).toBe(DECLARED_REPS);
    expect(after.line).toContain('2 of 3 reps completed');
  });
});

/* ===== TICKET 055a — HOW THE FLOOR IS GATHERED ACROSS THE ARM'S ROWS ========
 *
 * The block above proves the floor exists. It cannot prove HOW it is collected,
 * because every row in it declares the SAME value, so `max`, `min`, `first` and
 * `last` are indistinguishable and so are `attempted` and `gatePassing`. Both
 * substitutions are silent regressions of the headline defect:
 *
 *   min ACROSS ROWS — the ledger is APPEND-ONLY and spans sweeps, so one row
 *   written before this field existed drags the whole arm's floor to zero and
 *   the line falls straight back to `N of N`.
 *
 *   gatePassing INSTEAD OF attempted — the plan then survives only on rows that
 *   COMPLETED, so an arm whose declaring rows all failed loses the denominator
 *   in exactly the sweep that most needs it.
 *
 * Both tests below hold the floor's SOURCE to one row, so nothing else in the
 * arm can supply the answer.
 * ========================================================================== */

/** A row from BEFORE this ticket: `repIndex` and a corpus version, no plan. */
function preTicketRow(rep: number, ms: number, overrides: Partial<Run> = {}): Run {
  const annotations: SweepPlanAnnotations = { repIndex: rep, corpusVersion: CORPUS_VERSION };
  return runWithLatency(ms, {
    id: `run-pre055a-${rep}`,
    recordingId: PLAN_RECORDING_ID,
    cost: 0.002,
    annotations,
    ...overrides,
  });
}

describe('TICKET 055a — the floor is the HIGHEST declaration, over EVERY attempted row', () => {
  it('a row that predates the field does not drag the arm’s floor to zero', () => {
    const ledger = new RunLedger();
    ledger.appendRecording(makeRecordingEntity({ id: PLAN_RECORDING_ID }));
    // Rep 1 was written before `intendedReps` existed; rep 2 by a sweep that
    // declared 3. Rep 3 ran and its POST was never acknowledged. Taking the
    // LOWEST declaration across the arm reads rep 1 as a declaration of nothing.
    ledger.appendRun(preTicketRow(1, 800));
    ledger.appendRun(planRow(2, 1_000, 3));

    const arm = deriveExperimentAggregates(ledger).perArm['B']!;
    expect(arm.n).toBe(2);
    expect(arm.provenance.completedReps).toBe(2);
    expect(arm.provenance.intendedReps).toBe(3);
    expect(arm.provenance.line).toContain('2 of 3 reps completed');
  });

  it('the plan survives on a row that FAILED — the floor reads attempted, not gate-passing', () => {
    const ledger = new RunLedger();
    ledger.appendRecording(makeRecordingEntity({ id: PLAN_RECORDING_ID }));
    // The two rows behind the figures predate the field. The ONLY row carrying
    // the sweep's plan is rep 3, which failed — so it is attempted and not
    // gate-passing, and it is the only thing that knows 5 reps were intended.
    ledger.appendRun(preTicketRow(1, 800));
    ledger.appendRun(preTicketRow(2, 1_000));
    ledger.appendRun(
      planRow(3, 5_000, 5, { status: 'failed', errors: ['tts stage timed out'] }),
    );

    const arm = deriveExperimentAggregates(ledger).perArm['B']!;
    // The failed row is no measurement, exactly as before: it moves n nowhere.
    expect(arm.n).toBe(2);
    expect(arm.provenance.completedReps).toBe(2);
    // 5 — the declaration — not the 3 the surviving rep indices can prove.
    expect(arm.provenance.intendedReps).toBe(5);
    expect(arm.provenance.line).toContain('2 of 5 reps completed');
  });
});

/* ====== 059 FOLLOW-UP — the by-category row's cost DENOMINATOR, asserted ==== */

/**
 * A FIELD NO ASSERTION TOUCHES IS NOT A DISCLOSURE, IT IS A COMMENT WITH A TYPE.
 *
 * `CategoryGroupRow.measuredCostSamples` was COMPUTED (the `costOf` spread in
 * `groupByCategory`), DECLARED (`derive.ts`, "the same disclosure
 * `RecordingGroupRow` carries") and read by NOBODY: setting it to a wrong number
 * left the whole suite green, and the By Category table rendered the cost cell
 * with no denominator beside it. That is the R2-8(c) pattern `ResultsView.cost
 * .test.tsx`'s own header condemns — computed, pinned, rendered nowhere — with
 * the "pinned" half missing too.
 *
 * The rule underneath it is 052 AC7's: `$0.002` over 1 of 2 samples and `$0.002`
 * over 2 of 2 are DIFFERENT CLAIMS, and the money cannot tell them apart —
 * summing a missing cost as 0 and skipping it produce the SAME total. Only the
 * denominator can. So it is pinned in two places, exactly as the direction cell
 * is: the FIGURE here, and the cell an operator actually reads in
 * `ResultsView.category.test.tsx`.
 *
 * And it reports ACTUAL, never intended: a denominator that collapses onto its
 * own numerator reports every table as fully priced.
 */
describe('groupByCategory — the cost denominator, in the SAME vocabulary as By Recording', () => {
  const REC_PARTIAL = 'rec-cat-partial';
  const REC_UNSTAMPED = 'rec-cat-unstamped';

  /**
   * Two by-category rows that differ ONLY in how much of them was priced.
   * They sit on different ARMS because the row key is (category × arm ×
   * direction), so one category over two arms is the only way to get two rows
   * that a single `costOf` call cannot have produced together.
   *
   *   arm B — stamped, one record priced of two   → 1 of 2
   *   arm C — NO price source at all, both stored → 0 of 2
   */
  function mixedPricingLedger(): RunLedger {
    const ledger = new RunLedger();
    ledger.appendRecording(makeRecordingEntity({ id: REC_PARTIAL, label: 'partly priced clip' }));
    ledger.appendRecording(makeRecordingEntity({ id: REC_UNSTAMPED, label: 'unstamped clip' }));

    const records = (costs: Array<number | null>) =>
      costs.map((cost, i) =>
        makeUtteranceRecord({
          utteranceId: `u${i + 1}`,
          index: i + 1,
          category: 'short-reply',
          timings: { speech_end: T0, audio_queued: T0 + 700 + i },
          cost,
        }),
      );

    ledger.appendRun(
      makeRunEntity({
        id: 'run-cat-partial',
        recordingId: REC_PARTIAL,
        cost: 0.002,
        utterances: records([0.002, null]),
      }),
    );
    ledger.appendRun(
      makeUnstampedRunEntity({
        id: 'run-cat-unstamped',
        recordingId: REC_UNSTAMPED,
        providerTriple: { ...ARM_C_TRIPLE },
        modelSnapshots: { ...ARM_C_TRIPLE },
        armTag: 'C',
        cost: 0.002,
        utterances: records([0.002, 0.002]),
      }),
    );
    return ledger;
  }

  const rowForArm = (ledger: RunLedger, arm: string): CategoryGroupRow => {
    const row = groupByCategory(ledger).find((r) => r.arm === arm);
    expect(row, `no by-category row for arm ${arm}`).toBeDefined();
    return row!;
  };

  it('a fully priced row reports its WHOLE denominator', () => {
    const ledger = new RunLedger();
    seedCategorySweep(ledger);
    const rows = groupByCategory(ledger);
    expect(rows).toHaveLength(2);

    for (const row of rows) {
      // Stated as a literal as well as against `n`: `measuredCostSamples === n`
      // alone is satisfied by a field that simply IS `n`, which is the collapse
      // the standing rule forbids.
      expect(row.n).toBe(4);
      expect(row.measuredCostSamples).toBe(4);
      expect(row.measuredCostSamples).toBe(row.n);
      expect(row.costUsd).toBeCloseTo(4 * CATEGORY_COST_PER_RUN, 10);
    }
  });

  it('a row whose Run declared NO price source reports 0 — and n beside it is untouched', () => {
    // An unpriced run is not an unrun run: the samples still count, only the
    // dollars are absent.
    const row = rowForArm(mixedPricingLedger(), 'C');

    expect(row.n).toBe(2);
    expect(row.measuredCostSamples).toBe(0);
    expect(row.costUsd).toBeNull();
    expect(row.costCell).toBe(COST_NOT_MEASURED_CELL);
  });

  it('a PARTIALLY priced row reports the honest denominator, never its own n', () => {
    // The case both a null total and a full denominator would misreport: the
    // dollars are real, and they are real over HALF the row.
    const row = rowForArm(mixedPricingLedger(), 'B');

    expect(row.n).toBe(2);
    expect(row.measuredCostSamples).toBe(1);
    expect(row.measuredCostSamples).not.toBe(row.n);
    expect(row.costUsd).toBeCloseTo(0.002, 10);
  });

  it('reports the SAME denominator the By Recording row does — one fact, not two', () => {
    // The two tables read the same records through the same `costOf`. A
    // denominator that disagreed between them would be the second vocabulary
    // `derive.ts:476` says it exists to prevent.
    const ledger = mixedPricingLedger();
    const byRecording = groupByRecording(ledger);
    const denominatorFor = (recordingId: string): [number, number] => {
      const row = byRecording.find((r) => r.recordingId === recordingId)!;
      return [row.measuredCostSamples, row.n];
    };

    expect([rowForArm(ledger, 'B').measuredCostSamples, rowForArm(ledger, 'B').n]).toEqual(
      denominatorFor(REC_PARTIAL),
    );
    expect([rowForArm(ledger, 'C').measuredCostSamples, rowForArm(ledger, 'C').n]).toEqual(
      denominatorFor(REC_UNSTAMPED),
    );
    // Not vacuous: the two rows disagree with EACH OTHER, so a constant cannot
    // satisfy both sides.
    expect(denominatorFor(REC_PARTIAL)).not.toEqual(denominatorFor(REC_UNSTAMPED));
  });
});
