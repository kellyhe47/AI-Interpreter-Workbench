/**
 * Ticket 013 — unit tests for the Results derivation layer (no DOM).
 * These tests LOCK the design documented in derive.ts.
 */

import { describe, expect, it } from 'vitest';
import { RunLedger } from '../../state/ledger';
import {
  deriveResultsModel,
  formatMs,
  formatUsd,
  type MetricRow,
  type MetricSlug,
  type ResultsModel,
} from './derive';
import {
  BENCHMARK_RUN_ID,
  COVERAGE_RUN_ID,
  STABILITY_RUN_ID,
  SWAP_RUN_ID,
  T0,
  cascadeTimings,
  makeRecord,
  realtimeTimings,
  seedBenchmarkRun,
  seedCoverageRun,
  seedFixtureRun,
  seedProviderSwapRun,
  seedStabilityRun,
} from './testRecords';

function row(card: { rows: MetricRow[] }, metric: MetricSlug): MetricRow {
  const found = card.rows.find((r) => r.metric === metric);
  if (!found) throw new Error(`missing metric row: ${metric}`);
  return found;
}

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

describe('deriveResultsModel — empty and fixture-only ledgers', () => {
  it('empty ledger → hasRuns false, no cards, no ledger rows', () => {
    const model = deriveResultsModel(new RunLedger());
    expect(model.hasRuns).toBe(false);
    expect(model.exp1).toBeUndefined();
    expect(model.exp2).toBeUndefined();
    expect(model.stability).toBeUndefined();
    expect(model.coverage).toBeUndefined();
    expect(model.ledgerRows).toEqual([]);
  });

  it('fixture/placeholder-only ledger derives the same model as an empty one', () => {
    const ledger = new RunLedger();
    seedFixtureRun(ledger);
    // The realness rule is delegated to the ledger, not re-decided here.
    expect(ledger.hasRuns).toBe(false);
    const model = deriveResultsModel(ledger);
    expect(model).toEqual(deriveResultsModel(new RunLedger()));
    expect(model.hasRuns).toBe(false);
    expect(model.ledgerRows).toEqual([]);
  });
});

describe('deriveResultsModel — exp1 (track 1 benchmark run)', () => {
  function benchmarkModel(): { ledger: RunLedger; model: ResultsModel } {
    const ledger = new RunLedger();
    seedBenchmarkRun(ledger);
    return { ledger, model: deriveResultsModel(ledger) };
  }

  it('is present with realtime as column A and cascade-openai as column B', () => {
    const { model } = benchmarkModel();
    expect(model.hasRuns).toBe(true);
    expect(model.exp1).toBeDefined();
    expect(model.exp1!.armA).toBe('realtime');
    expect(model.exp1!.armB).toBe('cascade-openai');
  });

  it('has the seven rows in the locked order with the locked labels', () => {
    const { model } = benchmarkModel();
    expect(model.exp1!.rows.map((r) => [r.metric, r.label])).toEqual([
      ['p50', 'p50 latency'],
      ['p95', 'p95 latency'],
      ['cost', 'cost per min'],
      ['wer', 'word error rate'],
      ['adequacy', 'adequacy 1–5'],
      ['fluency', 'fluency 1–5'],
      ['intervals', 'observable intervals'],
    ]);
  });

  it('latency cells come from ledger.aggregates, formatted by formatMs', () => {
    const { ledger, model } = benchmarkModel();
    const agg = ledger.aggregates(BENCHMARK_RUN_ID).perArm;
    const p50 = row(model.exp1!, 'p50');
    expect(p50.valueA).toBe(formatMs(agg['realtime']!.p50Ms));
    expect(p50.valueA).toBe('1.02 s');
    expect(p50.valueB).toBe(formatMs(agg['cascade-openai']!.p50Ms));
    expect(p50.valueB).toBe('0.78 s');
    const p95 = row(model.exp1!, 'p95');
    expect(p95.valueA).toBe('1.40 s');
    expect(p95.valueB).toBe('1.00 s');
  });

  it('latency deltas are signed B−A and tone good when cascade is faster', () => {
    const { model } = benchmarkModel();
    const p50 = row(model.exp1!, 'p50');
    expect(p50.delta).toBe('-0.24 s');
    expect(p50.deltaTone).toBe('good');
    const p95 = row(model.exp1!, 'p95');
    expect(p95.delta).toBe('-0.40 s');
    expect(p95.deltaTone).toBe('good');
  });

  it('cost per min = costUsd normalized by audio minutes; negative delta is good', () => {
    const { model } = benchmarkModel();
    const cost = row(model.exp1!, 'cost');
    // realtime: 4 × $0.01 over 4 × 3000 ms = $0.04 / 0.2 min
    expect(cost.valueA).toBe('$0.200');
    // cascade: 4 × $0.002 over 4 × 3000 ms
    expect(cost.valueB).toBe('$0.040');
    expect(cost.delta).toBe('-$0.160');
    expect(cost.deltaTone).toBe('good');
  });

  it('wer / adequacy / fluency render — with neutral tone when absent from records', () => {
    const { model } = benchmarkModel();
    for (const metric of ['wer', 'adequacy', 'fluency'] as const) {
      const r = row(model.exp1!, metric);
      expect(r.valueA).toBe('—');
      expect(r.valueB).toBe('—');
      expect(r.delta).toBe('—');
      expect(r.deltaTone).toBe('neutral');
    }
  });

  it('observable intervals: 3 for the fully-timed realtime arm, 5 for cascade, neutral delta', () => {
    const { model } = benchmarkModel();
    const r = row(model.exp1!, 'intervals');
    expect(r.valueA).toBe('3');
    expect(r.valueB).toBe('5');
    expect(r.delta).toBe('—');
    expect(r.deltaTone).toBe('neutral');
  });

  it('annotated records populate wer and score rows with means and directional tones', () => {
    const ledger = new RunLedger();
    const seed = [
      { arm: 'realtime', mode: 'realtime' as const, wer: 0.14, adequacy: 3, fluency: 3 },
      { arm: 'realtime', mode: 'realtime' as const, wer: 0.1, adequacy: 3, fluency: 3 },
      { arm: 'cascade-openai', mode: 'cascade' as const, wer: 0.11, adequacy: 4, fluency: 5 },
      { arm: 'cascade-openai', mode: 'cascade' as const, wer: 0.09, adequacy: 4, fluency: 5 },
    ];
    seed.forEach((s, i) => {
      ledger.append(
        makeRecord({
          id: `an-${s.arm}-u${i}#rep1`,
          arm: s.arm,
          mode: s.mode,
          runId: BENCHMARK_RUN_ID,
          providers:
            s.mode === 'realtime'
              ? { stt: 'openai-realtime', mt: 'openai-realtime', tts: 'openai-realtime' }
              : { stt: 'openai', mt: 'openai', tts: 'openai' },
          timings:
            s.mode === 'realtime'
              ? realtimeTimings(T0 + i * 10_000, 1000)
              : cascadeTimings(T0 + i * 10_000, 900),
          annotations: { wer: s.wer, adequacy: s.adequacy, fluency: s.fluency },
        }),
      );
    });
    const model = deriveResultsModel(ledger);
    const wer = row(model.exp1!, 'wer');
    expect(wer.valueA).toBe('12.0%');
    expect(wer.valueB).toBe('10.0%');
    expect(wer.delta).toBe('-2.0%');
    expect(wer.deltaTone).toBe('good'); // lower WER is better
    const adequacy = row(model.exp1!, 'adequacy');
    expect(adequacy.valueA).toBe('3.0');
    expect(adequacy.valueB).toBe('4.0');
    expect(adequacy.delta).toBe('+1.0');
    expect(adequacy.deltaTone).toBe('good'); // higher score is better
    const fluency = row(model.exp1!, 'fluency');
    expect(fluency.delta).toBe('+2.0');
    expect(fluency.deltaTone).toBe('good');
  });

  it('provenance is built from the run itself, with the pinned controls stated verbatim', () => {
    const { model } = benchmarkModel();
    expect(model.exp1!.provenance).toBe(
      'EN↔ES · 2 utterances × 2 runs · endpointing pinned 500 ms · turn-final trigger · corpus-es-en-v1 · run run-001',
    );
  });
});

describe('deriveResultsModel — exp2 (track 2 provider swap)', () => {
  it('is absent when only one cascade provider config exists', () => {
    const ledger = new RunLedger();
    seedBenchmarkRun(ledger);
    expect(deriveResultsModel(ledger).exp2).toBeUndefined();
  });

  it('appears when a run holds two cascade provider configs, never pooled with track 1', () => {
    const ledger = new RunLedger();
    seedBenchmarkRun(ledger);
    seedProviderSwapRun(ledger);
    const model = deriveResultsModel(ledger);
    expect(model.exp2).toBeDefined();
    expect(model.exp2!.armA).toBe('cascade-openai');
    expect(model.exp2!.armB).toBe('cascade-elevenlabs');
    expect(model.exp2!.provenance).toContain('not pooled with track 1');
    expect(model.exp2!.provenance).toContain(SWAP_RUN_ID);
    // Figures come from run-002 alone: p50 of [800, 900] = 800, not pooled
    // with run-001's cascade latencies.
    const p50 = row(model.exp2!, 'p50');
    expect(p50.valueA).toBe('0.80 s');
    expect(p50.valueB).toBe('0.90 s');
    expect(p50.delta).toBe('+0.10 s');
    expect(p50.deltaTone).toBe('bad'); // swap arm is slower
    const cost = row(model.exp2!, 'cost');
    expect(cost.deltaTone).toBe('bad'); // and pricier
  });
});

describe('deriveResultsModel — stability and coverage', () => {
  it('stability is absent without a stability-marked run, present with one', () => {
    const ledger = new RunLedger();
    seedBenchmarkRun(ledger);
    expect(deriveResultsModel(ledger).stability).toBeUndefined();
    seedStabilityRun(ledger);
    const model = deriveResultsModel(ledger);
    expect(model.stability).toEqual({ runId: STABILITY_RUN_ID, count: 3 });
  });

  it('coverage is absent without stage-annotated coverage records, present with a matrix', () => {
    const ledger = new RunLedger();
    seedBenchmarkRun(ledger);
    expect(deriveResultsModel(ledger).coverage).toBeUndefined();
    seedCoverageRun(ledger);
    const model = deriveResultsModel(ledger);
    expect(model.coverage).toBeDefined();
    expect(model.coverage!.stages).toEqual(['intake', 'discharge']);
    expect(model.coverage!.arms).toEqual(['cascade-openai']);
    expect(model.coverage!.counts['intake']!['cascade-openai']).toBe(2);
    expect(model.coverage!.counts['discharge']!['cascade-openai']).toBe(1);
  });
});

describe('deriveResultsModel — ledger rows', () => {
  it('one row per REAL run, first-appended order, with derived fields', () => {
    const ledger = new RunLedger();
    seedBenchmarkRun(ledger);
    seedProviderSwapRun(ledger);
    seedStabilityRun(ledger);
    seedCoverageRun(ledger);
    seedFixtureRun(ledger); // must NOT get a row
    const rows = deriveResultsModel(ledger).ledgerRows;
    expect(rows.map((r) => r.runId)).toEqual([
      BENCHMARK_RUN_ID,
      SWAP_RUN_ID,
      STABILITY_RUN_ID,
      COVERAGE_RUN_ID,
    ]);
    const benchmark = rows[0]!;
    expect(benchmark.experiment).toBe('benchmark');
    expect(benchmark.configuration).toBe('realtime vs cascade-openai');
    expect(benchmark.pair).toBe('EN↔ES');
    expect(benchmark.n).toBe(8);
    expect(benchmark.date).toBe(new Date(T0).toISOString().slice(0, 10));
    expect(rows[1]!.experiment).toBe('benchmark');
    expect(rows[1]!.configuration).toBe('cascade-openai vs cascade-elevenlabs');
    expect(rows[2]!.experiment).toBe('stability');
    expect(rows[3]!.experiment).toBe('coverage');
  });

  it('date falls back to — when no record carries a speech_end', () => {
    const ledger = new RunLedger();
    ledger.append(
      makeRecord({
        id: 'nd-u1#rep1',
        arm: 'cascade-openai',
        mode: 'cascade',
        runId: 'run-009',
        timings: {},
      }),
    );
    const rows = deriveResultsModel(ledger).ledgerRows;
    expect(rows).toHaveLength(1);
    expect(rows[0]!.date).toBe('—');
  });
});
