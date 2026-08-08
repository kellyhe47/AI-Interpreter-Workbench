/**
 * Ticket 032 — the aggregates read UTTERANCE RECORDS.
 *
 * The standing rule this file locks (README-v3-corpus): *the measured atom is
 * the utterance, not the Run.* A Run is the container that produced a set of
 * utterance records; any aggregate computed per-Run is wrong by construction
 * under a multi-utterance corpus — N comes out 4× too small and the
 * by-category table renders zero rows forever.
 *
 * This is the ticket where an error becomes a PUBLISHED WRONG NUMBER, so every
 * assertion below is chosen so the right answer and the plausible wrong answer
 * differ visibly:
 *
 *  - 60 samples per arm, not 15 (PRD §8's headline number)
 *  - 20 samples per Recording across 5 Runs — `runCount` 5, `n` 20; REPS AND
 *    UTTERANCES ARE NEVER CONFLATED, and "20 reps" is the single most dangerous
 *    confusion in this ticket
 *  - the gate is applied PER RECORD THROUGH ITS PARENT RUN — `isAggregatableRun`
 *    is unchanged and a record inside a manual / ad-hoc / failed / fixture Run
 *    reaches nothing
 *  - a failed utterance inside a COMPLETE Run is excluded from the figures and
 *    still counted in attempts (ticket 027's rule, one level down)
 *  - and, as labelled regression guards, a ledger with no manifest-backed run
 *    derives exactly what it derives today
 *
 * derive.test.ts is left UNTOUCHED on purpose: it is itself the backward
 * compatibility guard, and every one of its figures must stay green.
 */

import { describe, expect, it } from 'vitest';
import {
  RunLedger,
  isAggregatableRun,
  isAggregatableUtterance,
  runSamples,
  type Run,
  type RunUtterance,
} from '../../state/ledger';
import {
  deriveExperimentAggregates,
  groupByCategory,
  groupByRecording,
  type CategoryGroupRow,
} from './derive';
import {
  ADHOC_RECORDING_ID,
  CATEGORY_COST_PER_RUN,
  CLEAN_SWEEP_COST_PER_RUN,
  CORPUS_ARM_COST_USD,
  CORPUS_ARM_P50_MS,
  CORPUS_ARM_P95_MS,
  CORPUS_CATEGORY_COST_USD,
  CORPUS_CATEGORY_EXPECTATIONS,
  CORPUS_COST_PER_MINUTE_USD,
  CORPUS_DISTINCT_UTTERANCES,
  CORPUS_EXCLUSION_RECORDING_IDS,
  CORPUS_LAYOUT,
  CORPUS_RECORDING_COST_USD,
  CORPUS_RECORDING_EXPECTATIONS,
  CORPUS_RECORDING_IDS,
  CORPUS_REPS,
  CORPUS_RUNS_PER_RECORDING,
  CORPUS_RUN_COST_USD,
  CORPUS_RUN_COUNT,
  CORPUS_RUN_LEVEL_N,
  CORPUS_RUN_LEVEL_P50_MS,
  CORPUS_RUN_LEVEL_P95_MS,
  CORPUS_SAMPLES_PER_ARM,
  CORPUS_SAMPLES_PER_CATEGORY,
  CORPUS_SAMPLES_PER_RECORDING,
  CORPUS_UTTERANCE_COST_USD,
  CORPUS_VERSION,
  EXCLUDED_COST_USD,
  EXCLUDED_LATENCY_MS,
  FAILED_UTT_ATTEMPTED_SAMPLES,
  FAILED_UTT_CATEGORY,
  FAILED_UTT_CATEGORY_N,
  FAILED_UTT_CATEGORY_P50_MS,
  FAILED_UTT_CATEGORY_P95_MS,
  FAILED_UTT_COST_USD,
  FAILED_UTT_DISTINCT_UTTERANCES,
  FAILED_UTT_N,
  FAILED_UTT_RECORDING_ID,
  FAILED_UTT_RUN_COST_TOTAL_USD,
  T0,
  corpusLatencyMs,
  makeRecordingEntity,
  makeRunEntity,
  makeUtteranceRecord,
  runWithLatency,
  seedCategorySweep,
  seedCleanSweep,
  seedCorpusExclusionCases,
  seedCorpusSweep,
  seedExclusionCases,
  seedFailedUtteranceSweep,
  seedShortRepSweep,
} from './testRecords';

function corpusLedger(): RunLedger {
  const ledger = new RunLedger();
  seedCorpusSweep(ledger);
  return ledger;
}

function categoryRow(
  rows: CategoryGroupRow[],
  category: string,
  arm: string = 'B',
): CategoryGroupRow {
  const found = rows.find((r) => r.category === category && r.arm === arm);
  if (!found) throw new Error(`missing category row: ${category} × ${arm}`);
  return found;
}

/* ============================================ the expansion helper itself == */

describe('runSamples — a Run expands into its measured atoms', () => {
  it('a Run with NO records yields exactly one sample, the Run-level one', () => {
    const run: Run = runWithLatency(900, { id: 'run-bare', cost: 0.002 });
    const samples = runSamples(run);
    expect(samples).toHaveLength(1);
    expect(samples[0]!.utterance).toBeUndefined();
    expect(samples[0]!.arm).toBe('B');
    expect(samples[0]!.latencyMs).toBe(900);
    expect(samples[0]!.cost).toBe(0.002);
    expect(samples[0]!.status).toBe('complete');
    expect(samples[0]!.category).toBeUndefined();
  });

  it('a manifest-backed Run yields one sample per record, and NOT the Run sample', () => {
    const ledger = corpusLedger();
    const run = ledger.getRuns(CORPUS_RECORDING_IDS[0])[0]!;
    const samples = runSamples(run);

    expect(samples).toHaveLength(4);
    expect(samples.every((s) => s.utterance !== undefined)).toBe(true);
    expect(samples.map((s) => s.utteranceId)).toEqual(['cu-1', 'cu-2', 'cu-3', 'cu-4']);
    expect(samples.map((s) => s.category)).toEqual([
      'short-reply',
      'long-compound',
      'numbers-dates',
      'proper-nouns',
    ]);
    // Each record's latency is its OWN pair of stamps, never the Run's
    // speech_end crossed with a record's audio_queued.
    expect(samples.map((s) => s.latencyMs)).toEqual([1, 2, 3, 4].map((k) => corpusLatencyMs(k, 1)));
    // The four splits sum back to the whole-clip Run cost EXACTLY.
    expect(samples.reduce((sum, s) => sum + (s.cost ?? 0), 0)).toBeCloseTo(CORPUS_RUN_COST_USD, 10);
    // The arm is the parent Run's derived tag on every record.
    expect(samples.every((s) => s.arm === 'B')).toBe(true);
  });

  it('a record with no output audio has a null latency and never a zero', () => {
    const ledger = new RunLedger();
    seedFailedUtteranceSweep(ledger);
    const run = ledger.getRuns(FAILED_UTT_RECORDING_ID)[1]!; // rep 2 — the failing one
    const failed = runSamples(run).find((s) => s.status === 'failed')!;
    expect(failed.latencyMs).toBeNull();
    expect(failed.utterance!.timings.audio_queued).toBeNull();
  });
});

/* ============================================== the record-level selector == */

describe('isAggregatableUtterance — the gate, applied through the parent Run', () => {
  const complete: RunUtterance = makeUtteranceRecord();
  const failed: RunUtterance = makeUtteranceRecord({
    status: 'failed',
    timings: { speech_end: T0, audio_queued: null },
    errors: ['no output audio'],
  });

  const PARENTS: Array<{ label: string; run: Run; runPasses: boolean }> = [
    { label: 'gate-passing sweep Run', run: makeRunEntity({ id: 'p-ok' }), runPasses: true },
    {
      label: 'manual-origin Run',
      run: makeRunEntity({ id: 'p-manual', origin: 'manual' }),
      runPasses: false,
    },
    {
      label: 'failed Run',
      run: makeRunEntity({ id: 'p-failed', status: 'failed' }),
      runPasses: false,
    },
    {
      label: 'fixture-sourced Run',
      run: makeRunEntity({
        id: 'p-fixture',
        modelSnapshots: { stt: 'fixture', mt: 'fixture', tts: 'fixture' },
      }),
      runPasses: false,
    },
    {
      label: 'ad-hoc (derived) Run',
      run: makeRunEntity({
        id: 'p-adhoc',
        providerTriple: { stt: 'gpt-4o-mini-transcribe', mt: 'claude-haiku-4-5', tts: 'eleven_multilingual_v2' },
        modelSnapshots: { stt: 'gpt-4o-mini-transcribe', mt: 'claude-haiku-4-5', tts: 'eleven_multilingual_v2' },
        armTag: 'B',
      }),
      runPasses: false,
    },
  ];

  it.each(PARENTS)(
    '$label: a COMPLETE record is aggregatable iff its parent Run is',
    ({ run, runPasses }) => {
      // isAggregatableRun is UNCHANGED — this ticket adds a selector beside it.
      expect(isAggregatableRun(run)).toBe(runPasses);
      expect(isAggregatableUtterance(run, complete)).toBe(runPasses);
    },
  );

  it.each(PARENTS)('$label: a FAILED record is never aggregatable', ({ run }) => {
    expect(isAggregatableUtterance(run, failed)).toBe(false);
  });

  it('with no record it is exactly isAggregatableRun', () => {
    for (const { run } of PARENTS) {
      expect(isAggregatableUtterance(run)).toBe(isAggregatableRun(run));
    }
  });
});

/* ============================================== PRD §8's headline: 60 of N == */

describe('deriveExperimentAggregates — 3 recordings × 4 utterances × 5 reps = 60', () => {
  it('reports 60 samples for the arm, not the 15 Runs that produced them', () => {
    const ledger = corpusLedger();
    const arm = deriveExperimentAggregates(ledger).perArm['B']!;

    expect(ledger.getRuns()).toHaveLength(CORPUS_RUN_COUNT);
    expect(arm.n).toBe(CORPUS_SAMPLES_PER_ARM);
    expect(arm.n).not.toBe(CORPUS_RUN_LEVEL_N);
    // 60 = 15 Runs × 4 records; 75 would mean the Run-level sample was counted
    // ALONGSIDE its records.
    expect(arm.n).not.toBe(CORPUS_RUN_COUNT + CORPUS_SAMPLES_PER_ARM);
  });

  it('computes p50/p95 over the records, and the per-Run answer differs in both', () => {
    const arm = deriveExperimentAggregates(corpusLedger()).perArm['B']!;
    expect(arm.p50Ms).toBe(CORPUS_ARM_P50_MS);
    expect(arm.p95Ms).toBe(CORPUS_ARM_P95_MS);
    expect(arm.p50Ms).not.toBe(CORPUS_RUN_LEVEL_P50_MS);
    expect(arm.p95Ms).not.toBe(CORPUS_RUN_LEVEL_P95_MS);
  });

  it('splitting a Run into records moves no money: the same total, per minute too', () => {
    const arm = deriveExperimentAggregates(corpusLedger()).perArm['B']!;
    expect(arm.costUsd).toBeCloseTo(CORPUS_ARM_COST_USD, 10);
    expect(arm.costUsd).toBeCloseTo(CORPUS_RUN_COUNT * CORPUS_RUN_COST_USD, 10);
    expect(arm.costUsd).toBeCloseTo(CORPUS_SAMPLES_PER_ARM * CORPUS_UTTERANCE_COST_USD, 10);
    // The clip is PLAYED ONCE PER RUN, so the audio denominator is unchanged.
    // Counting each record's audio as a whole clip would quarter this.
    expect(arm.costPerMinuteUsd).toBeCloseTo(CORPUS_COST_PER_MINUTE_USD, 10);
  });

  it('still delegates to the ledger gate — one aggregate, not a second one', () => {
    const ledger = corpusLedger();
    const derived = deriveExperimentAggregates(ledger).perArm['B']!;
    const fromLedger = ledger.runAggregates().perArm['B']!;
    expect({
      n: derived.n,
      p50Ms: derived.p50Ms,
      p95Ms: derived.p95Ms,
      costUsd: derived.costUsd,
      // TICKET 052 — the measured-cost denominator delegates too.
      measuredCostSamples: derived.provenance.measuredCostSamples,
    }).toEqual(fromLedger);
  });
});

/* ==================================================== §8: 20 per Recording == */

describe('groupByRecording — 20 samples across 5 Runs, and never 20 reps', () => {
  it.each(CORPUS_RECORDING_EXPECTATIONS)(
    '$recordingId aggregates its 20 samples (4 utterances × 5 reps)',
    ({ recordingId, p50Ms, p95Ms }) => {
      const rows = groupByRecording(corpusLedger());
      const row = rows.find((r) => r.recordingId === recordingId)!;
      expect(row).toBeDefined();

      // THE CONFUSION THIS PINS: five Runs produced twenty samples. A row that
      // reads runCount 20 has silently renamed utterances as reps.
      expect(row.runCount).toBe(CORPUS_RUNS_PER_RECORDING);
      expect(row.runCount).toBe(CORPUS_REPS);
      expect(row.n).toBe(CORPUS_SAMPLES_PER_RECORDING);
      expect(row.n).not.toBe(row.runCount);

      expect(row.p50Ms).toBe(p50Ms);
      expect(row.p95Ms).toBe(p95Ms);
      expect(row.costUsd).toBeCloseTo(CORPUS_RECORDING_COST_USD, 10);
      expect(row.failedCount).toBe(0);
      expect(row.excludedFromExperiments).toBe(false);
    },
  );

  it('the three rows reconcile with the arm aggregate', () => {
    const ledger = corpusLedger();
    const arm = deriveExperimentAggregates(ledger).perArm['B']!;
    const rows = groupByRecording(ledger);
    expect(rows).toHaveLength(CORPUS_RECORDING_IDS.length);
    expect(arm.n).toBe(CORPUS_SAMPLES_PER_ARM);
    expect(rows.reduce((sum, r) => sum + r.n, 0)).toBe(arm.n);
    expect(rows.reduce((sum, r) => sum + (r.costUsd ?? 0), 0)).toBeCloseTo(arm.costUsd!, 10);
  });
});

/* ================================== §8: the by-category table finally fills == */

describe('groupByCategory — one row per (category × arm), non-empty at last', () => {
  it('returns all six PRD §9 categories for a ledger of manifest-backed runs', () => {
    const rows = groupByCategory(corpusLedger());
    expect(rows.length).toBeGreaterThan(0);
    expect(rows).toHaveLength(CORPUS_CATEGORY_EXPECTATIONS.length);
    expect(rows.map((r) => r.category)).toEqual(
      CORPUS_CATEGORY_EXPECTATIONS.map((e) => e.category),
    );
    expect(rows.every((r) => r.arm === 'B')).toBe(true);
    // One row per (category × arm) — no key appears twice.
    const keys = rows.map((r) => `${r.category}|${r.arm}`);
    expect(new Set(keys).size).toBe(keys.length);
  });

  it.each(CORPUS_CATEGORY_EXPECTATIONS)(
    '$category pools its 10 samples across the two recordings it is spread over',
    ({ category, p50Ms, p95Ms }) => {
      const ledger = corpusLedger();
      const row = categoryRow(groupByCategory(ledger), category);

      expect(row.n).toBe(CORPUS_SAMPLES_PER_CATEGORY);
      expect(row.p50Ms).toBe(p50Ms);
      expect(row.p95Ms).toBe(p95Ms);
      expect(row.costUsd).toBeCloseTo(CORPUS_CATEGORY_COST_USD, 10);

      // PRD §9: the tag is distributed, never grouped — this category's two
      // utterances sit on two DIFFERENT recordings, so no per-recording row
      // could have produced this figure.
      const homes = new Set(
        CORPUS_LAYOUT.filter((u) => u.category === category).map((u) => u.recordingId),
      );
      expect(homes.size).toBe(2);
      // Its 10 samples are split 5/5 over those two recordings, so no single
      // per-recording row holds the sample set this figure is computed over.
      expect(groupByRecording(ledger).every((r) => r.n === CORPUS_SAMPLES_PER_RECORDING)).toBe(
        true,
      );
    },
  );

  it('the six rows reconcile with the arm aggregate', () => {
    const ledger = corpusLedger();
    const arm = deriveExperimentAggregates(ledger).perArm['B']!;
    const rows = groupByCategory(ledger);
    expect(rows.reduce((sum, r) => sum + r.n, 0)).toBe(arm.n);
    expect(rows.reduce((sum, r) => sum + (r.costUsd ?? 0), 0)).toBeCloseTo(arm.costUsd!, 10);
  });
});

/* ======================================== the gate, one level down, in situ == */

describe('a record inside an excluded Run reaches no aggregate', () => {
  function pollutedLedger(): RunLedger {
    const ledger = corpusLedger();
    seedCorpusExclusionCases(ledger);
    return ledger;
  }

  it('the arm figures are byte-identical with and without the excluded runs', () => {
    const clean = deriveExperimentAggregates(corpusLedger()).perArm['B']!;
    const polluted = deriveExperimentAggregates(pollutedLedger()).perArm['B']!;
    expect({
      n: polluted.n,
      p50Ms: polluted.p50Ms,
      p95Ms: polluted.p95Ms,
      costUsd: polluted.costUsd,
    }).toEqual({ n: clean.n, p50Ms: clean.p50Ms, p95Ms: clean.p95Ms, costUsd: clean.costUsd });
    expect(polluted.n).toBe(CORPUS_SAMPLES_PER_ARM);
  });

  it('the by-category table is unmoved — each of the four excluded runs carries 4 records', () => {
    const clean = groupByCategory(corpusLedger());
    const polluted = groupByCategory(pollutedLedger());
    expect(clean).toHaveLength(CORPUS_CATEGORY_EXPECTATIONS.length);
    expect(polluted).toEqual(clean);
    expect(polluted.some((r) => r.arm === 'ad-hoc')).toBe(false);
    // The excluded records are loud on purpose: 5.00 s and $0.500 each.
    expect(polluted.some((r) => r.p50Ms === EXCLUDED_LATENCY_MS)).toBe(false);
    expect(polluted.some((r) => r.p95Ms === EXCLUDED_LATENCY_MS)).toBe(false);
    expect(polluted.some((r) => (r.costUsd ?? 0) > EXCLUDED_COST_USD)).toBe(false);
  });

  it.each(Object.entries(CORPUS_EXCLUSION_RECORDING_IDS))(
    '%s: still listed by recording, marked with why, contributing to nothing',
    (reason, recordingId) => {
      const rows = groupByRecording(pollutedLedger());
      const row = rows.find((r) => r.recordingId === recordingId)!;
      expect(row).toBeDefined();
      expect(row.runCount).toBe(1);
      expect(row.excludedFromExperiments).toBe(true);
      expect(row.exclusionReasons as string[]).toContain(reason);
      // Ad-hoc and manual runs still carry their own figures in this listing —
      // that is where they are visible at all — but a failed or fixture-sourced
      // Run reports nothing, and its RECORDS do not resurrect it.
      if (reason === 'failed' || reason === 'fixture') {
        expect(row.n).toBe(0);
        expect(row.p50Ms).toBeNull();
        expect(row.p95Ms).toBeNull();
      } else {
        expect(row.n).toBe(4);
        expect(row.p50Ms).toBe(EXCLUDED_LATENCY_MS);
      }
    },
  );
});

/* ====================== 027's rule one level down: failed ≠ never attempted == */

describe('a failed utterance inside a complete Run', () => {
  function failedUtteranceLedger(): RunLedger {
    const ledger = new RunLedger();
    seedFailedUtteranceSweep(ledger);
    return ledger;
  }

  it('does NOT fail its Run — all five Runs stay complete and gate-passing', () => {
    const runs = failedUtteranceLedger().getRuns(FAILED_UTT_RECORDING_ID);
    expect(runs).toHaveLength(CORPUS_REPS);
    expect(runs.every((r) => r.status === 'complete')).toBe(true);
    expect(runs.every(isAggregatableRun)).toBe(true);
    expect(runs.flatMap((r) => r.utterances ?? []).filter((u) => u.status === 'failed')).toHaveLength(
      2,
    );
  });

  it('is excluded from the figures but still counted in attempts', () => {
    const arm = deriveExperimentAggregates(failedUtteranceLedger()).perArm['B']!;
    expect(arm.n).toBe(FAILED_UTT_N);
    expect(arm.provenance.attemptedSamples).toBe(FAILED_UTT_ATTEMPTED_SAMPLES);
    expect(arm.provenance.attemptedSamples - arm.n).toBe(2);
    // …and the utterance itself is still one of the four the arm covered.
    expect(arm.provenance.utteranceCount).toBe(FAILED_UTT_DISTINCT_UTTERANCES);
  });

  it('contributes no cost either — the figure is over what was measured', () => {
    const arm = deriveExperimentAggregates(failedUtteranceLedger()).perArm['B']!;
    expect(arm.costUsd).toBeCloseTo(FAILED_UTT_COST_USD, 10);
    expect(arm.costUsd).not.toBeCloseTo(FAILED_UTT_RUN_COST_TOTAL_USD, 10);
  });

  it('shrinks only its OWN category row, and never lands there as a zero', () => {
    const row = categoryRow(groupByCategory(failedUtteranceLedger()), FAILED_UTT_CATEGORY);
    expect(row.n).toBe(FAILED_UTT_CATEGORY_N);
    expect(row.p50Ms).toBe(FAILED_UTT_CATEGORY_P50_MS);
    expect(row.p95Ms).toBe(FAILED_UTT_CATEGORY_P95_MS);
    // The three untouched categories keep all five of their reps.
    const others = groupByCategory(failedUtteranceLedger()).filter(
      (r) => r.category !== FAILED_UTT_CATEGORY,
    );
    expect(others).toHaveLength(3);
    expect(others.every((r) => r.n === CORPUS_REPS)).toBe(true);
  });

  it('the Recording row lists five complete Runs and eighteen samples', () => {
    const row = groupByRecording(failedUtteranceLedger())[0]!;
    expect(row.runCount).toBe(CORPUS_REPS);
    // A failed UTTERANCE is not a failed RUN; the failure count is about Runs.
    expect(row.failedCount).toBe(0);
    expect(row.n).toBe(FAILED_UTT_N);
  });
});

/* ========================================== provenance: reps ≠ utterances == */

describe('provenance — utteranceCount is real, and reps are not utterances', () => {
  it('reports 12 distinct utterances and 5 of 5 reps, never 60 and never 20', () => {
    const p = deriveExperimentAggregates(corpusLedger()).perArm['B']!.provenance;

    expect(p.utteranceCount).toBe(CORPUS_DISTINCT_UTTERANCES);
    // The pre-032 fallback keyed on recordingId and would report 3.
    expect(p.utteranceCount).not.toBe(CORPUS_RECORDING_IDS.length);
    expect(p.completedReps).toBe(CORPUS_REPS);
    expect(p.intendedReps).toBe(CORPUS_REPS);
    expect(p.attemptedSamples).toBe(CORPUS_SAMPLES_PER_ARM);
    expect(p.corpusVersion).toBe(CORPUS_VERSION);

    // The rendered line: exact wording is open, the counts in it are not.
    expect(p.line).toContain(`${CORPUS_DISTINCT_UTTERANCES} utterances`);
    expect(p.line).toContain(`${CORPUS_REPS} of ${CORPUS_REPS} reps completed`);
    // 4 utterances × 5 reps must NEVER render as 20 reps — nor as 60.
    expect(p.line).not.toMatch(/\b20 (of |reps)/);
    // TICKET 052 — the line now legitimately names the SAMPLE count in its
    // cost-denominator clause ('cost measured on 60 of 60 samples'), so the
    // guard is narrowed to the thing it was written to catch: 60 being
    // reported as a REP or an UTTERANCE count.
    expect(p.line).not.toMatch(/\b60 (of \d+ )?(reps|utterances)/);
    expect(p.line).not.toMatch(/\b12 (of |reps)/);
  });

  it('a lost rep still reads as a lost rep once records exist', () => {
    const ledger = corpusLedger();
    // A sixth attempted rep on one recording that failed outright: the Run
    // carries NO records (031's segmentation rule), and it must move the
    // denominator without touching the numerator.
    ledger.appendRun(
      makeRunEntity({
        id: 'run-corpus-lost',
        recordingId: CORPUS_RECORDING_IDS[0],
        status: 'failed',
        errors: ['segmentation: expected 4 utterances, observed 3'],
        cost: CORPUS_RUN_COST_USD,
        annotations: { repIndex: CORPUS_REPS + 1, corpusVersion: CORPUS_VERSION },
        utterances: undefined,
      }),
    );

    const arm = deriveExperimentAggregates(ledger).perArm['B']!;
    expect(arm.n).toBe(CORPUS_SAMPLES_PER_ARM);
    expect(arm.provenance.completedReps).toBe(CORPUS_REPS);
    expect(arm.provenance.intendedReps).toBe(CORPUS_REPS + 1);
    expect(arm.provenance.line).toContain(`${CORPUS_REPS} of ${CORPUS_REPS + 1} reps completed`);
  });
});

/* ================================================= backward compatibility == */

describe('REGRESSION GUARD — runs with no utterances[] aggregate exactly as today', () => {
  it('a clean 5-rep sweep of bare Runs derives its pre-032 figures unchanged', () => {
    const ledger = new RunLedger();
    seedCleanSweep(ledger);
    const arm = deriveExperimentAggregates(ledger).perArm['B']!;
    expect(arm.n).toBe(5);
    expect(arm.p50Ms).toBe(900);
    expect(arm.p95Ms).toBe(1200);
    expect(arm.costUsd).toBeCloseTo(5 * CLEAN_SWEEP_COST_PER_RUN, 10);
    expect(arm.provenance.completedReps).toBe(5);
    expect(arm.provenance.intendedReps).toBe(5);
    // With no records the attempted count is simply the gate-passing Runs.
    expect(arm.provenance.attemptedSamples).toBe(5);
  });

  it('NO FIGURE MOVES for a ledger that has no manifest-backed run at all', () => {
    const ledger = new RunLedger();
    seedCleanSweep(ledger);
    seedShortRepSweep(ledger);
    seedCategorySweep(ledger);
    seedExclusionCases(ledger);
    expect(ledger.getRuns().every((r) => r.utterances === undefined)).toBe(true);

    const perArm = deriveExperimentAggregates(ledger).perArm;
    expect(Object.keys(perArm).sort()).toEqual(['B', 'C']);
    // Arm B: the clean sweep's 5 plus the category sweep's 8.
    expect(perArm['B']!.n).toBe(13);
    expect(perArm['C']!.n).toBe(4);
    expect(perArm['C']!.p50Ms).toBe(900);
    expect(perArm['C']!.p95Ms).toBe(1200);

    // The by-category grouping keeps reading annotations.category for Runs
    // that carry no records — its pre-032 figures are untouched.
    const categories = groupByCategory(ledger);
    expect(categories.map((r) => `${r.category}|${r.arm}`)).toEqual([
      'short-reply|B',
      'numbers-dates|C',
      'numbers-dates|B',
    ]);
    const numbers = categoryRow(categories, 'numbers-dates', 'B');
    expect(numbers.n).toBe(4);
    expect(numbers.p50Ms).toBe(1300);
    expect(numbers.p95Ms).toBe(1600);
    expect(numbers.costUsd).toBeCloseTo(4 * CATEGORY_COST_PER_RUN, 10);

    // …and the excluded runs are still listed, with their reasons.
    const adhoc = groupByRecording(ledger).find((r) => r.recordingId === ADHOC_RECORDING_ID)!;
    expect(adhoc.arm).toBe('ad-hoc');
    expect(adhoc.n).toBe(1);
    expect(adhoc.p50Ms).toBe(EXCLUDED_LATENCY_MS);
  });

  it('a bare Run and a manifest-backed Run in one arm each contribute exactly once', () => {
    const ledger = new RunLedger();
    ledger.appendRecording(makeRecordingEntity({ id: 'rec-mixed' }));
    ledger.appendRun(
      runWithLatency(2_000, {
        id: 'run-mixed-bare',
        recordingId: 'rec-mixed',
        cost: 0.002,
        annotations: { repIndex: 1, corpusVersion: CORPUS_VERSION },
      }),
    );
    ledger.appendRun(
      makeRunEntity({
        id: 'run-mixed-manifest',
        recordingId: 'rec-mixed',
        cost: CORPUS_RUN_COST_USD,
        timings: { speech_end: T0, audio_queued: T0 + 2_000 },
        annotations: { repIndex: 2, corpusVersion: CORPUS_VERSION },
        utterances: [1, 2, 3, 4].map((index) =>
          makeUtteranceRecord({
            utteranceId: `mx-${index}`,
            index,
            category: 'disfluency',
            timings: { speech_end: T0, audio_queued: T0 + 100 * index },
          }),
        ),
      }),
    );

    const arm = deriveExperimentAggregates(ledger).perArm['B']!;
    // 1 bare sample + 4 records. Never 2 (per-Run), never 6 (double-counted).
    expect(arm.n).toBe(5);
    expect(arm.costUsd).toBeCloseTo(0.002 + CORPUS_RUN_COST_USD, 10);
    expect(arm.provenance.utteranceCount).toBe(5); // 'u1' + the four record ids
    expect(arm.provenance.completedReps).toBe(2);
  });
});
