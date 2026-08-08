/**
 * Ticket 011 / 015 — unit tests for the Results derivation layer (no DOM).
 * These tests LOCK the design documented in derive.ts.
 */

import { describe, expect, it } from 'vitest';
import { armLabel } from '../../../core/arms';
import { RunLedger } from '../../state/ledger';
import {
  PINNED_ENDPOINTING_MS,
  STT_UNCHANGED_CELL,
  deriveComparison,
  deriveExperimentAggregates,
  deriveLiveModel,
  formatMs,
  formatUsd,
  groupByCategory,
  groupByRecording,
  sttUnchangedBetween,
  type ExclusionReason,
  type MetricRow,
  type RecordingGroupRow,
} from './derive';
import {
  ADHOC_RECORDING_ID,
  CATEGORY_COST_PER_RUN,
  CATEGORY_RECORDING_IDS,
  CLEAN_RECORDING_ID,
  CLEAN_SWEEP_COST_PER_RUN,
  CORPUS_VERSION,
  EXCLUDED_LATENCY_MS,
  FAILED_RECORDING_ID,
  FIXTURE_RECORDING_ID,
  LIVE_A_COST,
  LIVE_A_DRIFT_MS,
  MANUAL_RECORDING_ID,
  RECORDING_DURATION_MS,
  SHORT_SWEEP_ALL_FIVE_P50_MS,
  SHORT_SWEEP_COMPLETED_REPS,
  SHORT_SWEEP_COST_PER_RUN,
  SHORT_SWEEP_INTENDED_REPS,
  SHORT_SWEEP_SURVIVING_P50_MS,
  SHORT_SWEEP_SURVIVING_P95_MS,
  makeRecordingEntity,
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
    expect(p.endpointingMs).toBe(500);
    expect(p.endpointingMs).toBe(PINNED_ENDPOINTING_MS);
    expect(p.corpusVersion).toBe(CORPUS_VERSION);

    expect(p.line).toContain('500');
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
    expect(a.driftMinute1ToEndMs).toBe(LIVE_A_DRIFT_MS);
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
    expect(deriveLiveModel(ledger)).toEqual({ columns: [], empty: true });
  });
});

describe('empty states — no zeros masquerading as measurements', () => {
  it('every v2 derivation has an explicit empty state on an empty ledger', () => {
    const ledger = new RunLedger();
    expect(deriveExperimentAggregates(ledger)).toEqual({ perArm: {}, empty: true });
    expect(groupByRecording(ledger)).toEqual([]);
    expect(groupByCategory(ledger)).toEqual([]);
    expect(deriveComparison(ledger, 'A', 'B')).toBeNull();
    expect(deriveLiveModel(ledger)).toEqual({ columns: [], empty: true });
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
