/**
 * TICKET 034 — Results reads WER per arm and per category from the SCORES
 * STREAM.
 *
 * THE DEFECT: WER is one of four measured quality dimensions and was absent
 * entirely — every WER cell read `not yet measured` because nothing anywhere
 * produced a number. PRD §9 had the Spanish coworker read VERBATIM rather than
 * improvise SOLELY so a Spanish WER would exist.
 *
 * THE RULE THIS SUITE IS BUILT AROUND, stated once:
 *
 *   NOT APPLICABLE IS NOT ZERO.
 *
 * Cantonese is improvised from English prompt cards and carries no
 * `referenceText` (PRD §9). A WER of 0 is a PERFECT score, so rendering the
 * unscoreable arm as 0.0% would report it as the best arm in the study. It
 * reports `not applicable`, its `meanWer` is null, and its samples never touch
 * a mean.
 *
 * THE GATE IS THE SAME ONE LATENCY USES. `runSamples` + `isAggregatableUtterance`
 * through the parent Run, so a fixture, manual, ad-hoc or failed run contributes
 * no WER for exactly the reason it contributes no latency.
 */
import { beforeEach, describe, expect, it } from 'vitest';

import { REALTIME_MODEL } from '../../../core/arms';
import type { CorpusUtterance } from '../../../core/corpus';
import { scoreRunWer, type WerScore } from '../../../core/wer';
import { RunLedger } from '../../state/ledger';
import {
  WER_NOT_APPLICABLE_CELL,
  WER_NOT_MEASURED_CELL,
  deriveComparison,
  deriveWerByArm,
  deriveWerByCategory,
  formatWer,
  sttUnchangedBetween,
} from './derive';
import type { AnnotatedRun } from './derive';
import {
  ARM_B_TRIPLE,
  ARM_C_TRIPLE,
  CORPUS_VERSION,
  OFF_ARM_TRIPLE,
  T0,
  makeRecordingEntity,
  makeRunEntity,
  makeUtteranceRecord,
  resetEntitySeq,
} from './testRecords';

const SCORED_AT = 1_700_000_000_000;

/* --------------------------------------------------------------- fixtures -- */

/**
 * An EN/ES-style manifest: every utterance carries the verbatim script the
 * coworker read. Two utterances of DIFFERENT categories, per PRD §9.
 */
const SCRIPTED_MANIFEST: CorpusUtterance[] = [
  {
    id: 'u-1',
    index: 1,
    category: 'short-reply',
    trueSpeechEndMs: 1_000,
    referenceText: 'The quick brown fox.',
  },
  {
    id: 'u-2',
    index: 2,
    category: 'numbers-dates',
    trueSpeechEndMs: 2_000,
    referenceText: 'Take 250 mg twice.',
  },
];

/**
 * The CANTONESE manifest (PRD §9): improvised from English prompt cards, so
 * there is NO `referenceText` on any entry. This is the shape the whole ticket
 * turns on.
 */
const IMPROVISED_MANIFEST: CorpusUtterance[] = [
  { id: 'y-1', index: 1, category: 'short-reply', trueSpeechEndMs: 1_000 },
  { id: 'y-2', index: 2, category: 'disfluency', trueSpeechEndMs: 2_000 },
];

/** 1 substitution over 4 reference tokens: "fox" -> "ox". */
const HYP_U1_QUARTER = 'the quick brown ox';
/** 3 deletions over 4: only the first word survives. */
const HYP_U2_THREE_QUARTERS = 'take';

interface SeedOptions {
  runId: string;
  recordingId: string;
  manifest: CorpusUtterance[];
  /** utteranceId -> the run's source transcript. Absent means none captured. */
  hypotheses: Record<string, string>;
  run?: Partial<AnnotatedRun>;
  /** Per-record overrides, keyed by utteranceId (e.g. a failed record). */
  records?: Record<string, Partial<ReturnType<typeof makeUtteranceRecord>>>;
}

/**
 * Seeds ONE Recording + ONE manifest-backed Run and returns the Run, WITHOUT
 * scoring it — scoring is a separate, post-hoc pass, which is the architectural
 * point of the ticket.
 */
function seedRun(ledger: RunLedger, opts: SeedOptions): AnnotatedRun {
  resetEntitySeq();
  ledger.appendRecording(
    makeRecordingEntity({
      id: opts.recordingId,
      utterances: opts.manifest,
      corpusVersion: CORPUS_VERSION,
    }),
  );
  const run = makeRunEntity({
    id: opts.runId,
    recordingId: opts.recordingId,
    annotations: { repIndex: 1, corpusVersion: CORPUS_VERSION },
    utterances: opts.manifest.map((entry) =>
      makeUtteranceRecord({
        utteranceId: entry.id,
        index: entry.index,
        category: entry.category,
        timings: { speech_end: T0, audio_queued: T0 + 800 },
        transcripts: { source: opts.hypotheses[entry.id], target: 'target text' },
        ...(opts.records?.[entry.id] ?? {}),
      }),
    ),
    ...opts.run,
  });
  ledger.appendRun(run);
  return run;
}

/** The post-hoc pass: score a seeded Run against its manifest and append. */
function scoreInto(
  ledger: RunLedger,
  run: AnnotatedRun,
  manifest: CorpusUtterance[],
  scoredAt = SCORED_AT,
): WerScore[] {
  const scores = scoreRunWer(run, manifest, scoredAt);
  for (const score of scores) ledger.appendWerScore(score);
  return scores;
}

let ledger: RunLedger;

beforeEach(() => {
  resetEntitySeq();
  ledger = new RunLedger();
});

/* ============================================================== formatting = */

describe('ticket 034 — formatWer', () => {
  it('AC4: a WER renders as a percentage to one decimal', () => {
    expect(formatWer(0)).toBe('0.0%');
    expect(formatWer(0.25)).toBe('25.0%');
    expect(formatWer(1)).toBe('100.0%');
    // Never clamped: a hypothesis longer than the reference exceeds 100%.
    expect(formatWer(2)).toBe('200.0%');
  });

  it('AC3: null renders as an em dash, NEVER as 0.0%', () => {
    expect(formatWer(null)).toBe('—');
    expect(formatWer(null)).not.toBe('0.0%');
  });
});

/* ================================================== WER per arm, happy path = */

describe('ticket 034 — deriveWerByArm reads the scores stream', () => {
  it('AC4: an arm reports the MEAN of its scored samples', () => {
    const run = seedRun(ledger, {
      runId: 'run-b-1',
      recordingId: 'rec-en-1',
      manifest: SCRIPTED_MANIFEST,
      hypotheses: { 'u-1': HYP_U1_QUARTER, 'u-2': HYP_U2_THREE_QUARTERS },
    });
    scoreInto(ledger, run, SCRIPTED_MANIFEST);

    const arm = deriveWerByArm(ledger).B!;
    expect(arm.scored).toBe(2);
    expect(arm.notApplicable).toBe(0);
    expect(arm.unscored).toBe(0);
    // (0.25 + 0.75) / 2.
    expect(arm.meanWer).toBeCloseTo(0.5, 10);
    expect(arm.cell).toBe('50.0%');
  });

  it('AC1: a score attaches to the (runId, utteranceId) ATOM, not to the Run', () => {
    const run = seedRun(ledger, {
      runId: 'run-b-1',
      recordingId: 'rec-en-1',
      manifest: SCRIPTED_MANIFEST,
      hypotheses: { 'u-1': HYP_U1_QUARTER, 'u-2': HYP_U2_THREE_QUARTERS },
    });
    scoreInto(ledger, run, SCRIPTED_MANIFEST);

    // Two utterances of ONE Run produce TWO independent scores with two
    // different numbers. A Run-level WER could not represent this at all.
    expect(ledger.getWerScore('run-b-1', 'u-1')!.wer).toBeCloseTo(0.25, 10);
    expect(ledger.getWerScore('run-b-1', 'u-2')!.wer).toBeCloseTo(0.75, 10);
    expect(ledger.getWerScore('run-b-1', 'u-nope')).toBeUndefined();
    expect(ledger.getWerScore('run-other', 'u-1')).toBeUndefined();
  });

  it('AC4: samples with NO score are `unscored` and report `not yet measured`', () => {
    seedRun(ledger, {
      runId: 'run-b-1',
      recordingId: 'rec-en-1',
      manifest: SCRIPTED_MANIFEST,
      hypotheses: { 'u-1': HYP_U1_QUARTER, 'u-2': HYP_U2_THREE_QUARTERS },
    });
    // NO scoring pass has been run.

    const arm = deriveWerByArm(ledger).B!;
    expect(arm.scored).toBe(0);
    expect(arm.unscored).toBe(2);
    expect(arm.meanWer).toBeNull();
    expect(arm.cell).toBe(WER_NOT_MEASURED_CELL);
    // The two nulls are DIFFERENT facts and must not render the same.
    expect(arm.cell).not.toBe(WER_NOT_APPLICABLE_CELL);
  });

  it('AC4: a Run carrying NO utterance records contributes no WER at all', () => {
    // WER is keyed by (runId, utteranceId); a record-less Run has no
    // utteranceId to key by, so it is not a WER-bearing atom.
    resetEntitySeq();
    ledger.appendRecording(makeRecordingEntity({ id: 'rec-plain' }));
    ledger.appendRun(makeRunEntity({ id: 'run-plain', recordingId: 'rec-plain' }));

    expect(deriveWerByArm(ledger)).toEqual({});
  });
});

/* ========================= NOT APPLICABLE IS NOT ZERO — the load-bearing test */

describe('ticket 034 — Cantonese reports `not applicable`, NEVER 0', () => {
  beforeEach(() => {
    const run = seedRun(ledger, {
      runId: 'run-yue-1',
      recordingId: 'rec-yue-1',
      manifest: IMPROVISED_MANIFEST,
      hypotheses: { 'y-1': '你好嗎', 'y-2': '唔該晒' },
    });
    scoreInto(ledger, run, IMPROVISED_MANIFEST);
  });

  it('AC3: the arm cell says `not applicable` and contains no digit', () => {
    const arm = deriveWerByArm(ledger).B!;

    expect(arm.cell).toBe(WER_NOT_APPLICABLE_CELL);
    expect(arm.cell).toBe('not applicable');
    // A ZERO WER IS A PERFECT SCORE. Any digit here would be a fabricated
    // measurement of an arm with nothing to measure against.
    expect(arm.cell).not.toMatch(/\d/);
    expect(arm.cell).not.toBe('0.0%');
  });

  it('AC3: meanWer is null — never 0 — and nothing is counted as scored', () => {
    const arm = deriveWerByArm(ledger).B!;

    expect(arm.meanWer).toBeNull();
    expect(arm.meanWer).not.toBe(0);
    expect(arm.scored).toBe(0);
    expect(arm.notApplicable).toBe(2);
    expect(arm.unscored).toBe(0);
  });

  it('AC3: the stored scores themselves are null with a named reason', () => {
    for (const utteranceId of ['y-1', 'y-2']) {
      const score = ledger.getWerScore('run-yue-1', utteranceId)!;
      expect(score.wer).toBeNull();
      expect(score.wer).not.toBe(0);
      expect(score.notApplicableReason).toBe('no-reference-text');
    }
  });

  it('AC3: a not-applicable sample NEVER drags a real mean toward 0', () => {
    // The mixed case is the dangerous one: an arm with one real score and one
    // unscoreable utterance must report the real score, not its average with a
    // phantom zero.
    const mixed = new RunLedger();
    const run = seedRun(mixed, {
      runId: 'run-mixed',
      recordingId: 'rec-mixed',
      manifest: [SCRIPTED_MANIFEST[0]!, IMPROVISED_MANIFEST[1]!],
      hypotheses: { 'u-1': HYP_U1_QUARTER, 'y-2': '唔該晒' },
    });
    scoreInto(mixed, run, [SCRIPTED_MANIFEST[0]!, IMPROVISED_MANIFEST[1]!]);

    const arm = deriveWerByArm(mixed).B!;
    expect(arm.scored).toBe(1);
    expect(arm.notApplicable).toBe(1);
    // 0.25 alone. Averaging in a 0 would give 0.125 — a better-looking, wrong
    // number, which is the exact failure class this project exists to prevent.
    expect(arm.meanWer).toBeCloseTo(0.25, 10);
    expect(arm.cell).toBe('25.0%');
  });
});

/* ============================== the realness rule and the aggregation gate == */

describe('ticket 034 — the gate applies to WER exactly as it does to latency', () => {
  /** Each case is a gate-passing Run minus ONE thing. */
  const excluded: Array<{ reason: string; run: Partial<AnnotatedRun> }> = [
    { reason: 'manual origin — no counterbalancing, no warmup discard', run: { origin: 'manual' } },
    { reason: 'failed status', run: { status: 'failed' } },
    {
      reason: 'ad-hoc configuration — a triple that is no frozen arm',
      run: { providerTriple: { ...OFF_ARM_TRIPLE }, modelSnapshots: { ...OFF_ARM_TRIPLE } },
    },
    {
      reason: 'fixture-sourced providers',
      run: {
        providerTriple: { stt: 'fixture', mt: 'fixture', tts: 'fixture' },
        modelSnapshots: { stt: 'fixture', mt: 'fixture', tts: 'fixture' },
      },
    },
    {
      reason: 'fixture-sourced model snapshot',
      run: { modelSnapshots: { ...ARM_B_TRIPLE, mt: 'fixture' } },
    },
    {
      reason: 'a placeholder recording',
      run: { recordingId: 'placeholder-1' },
    },
  ];

  it.each(excluded)('AC5: $reason contributes NO WER', ({ run: overrides }) => {
    const isolated = new RunLedger();
    const run = seedRun(isolated, {
      runId: 'run-excluded',
      recordingId: (overrides.recordingId as string | undefined) ?? 'rec-en-1',
      manifest: SCRIPTED_MANIFEST,
      hypotheses: { 'u-1': HYP_U1_QUARTER, 'u-2': HYP_U2_THREE_QUARTERS },
      run: overrides,
    });
    // The scores ARE written — ticket 018's rule is about REPORTING, not
    // writing, and the record of a fixture run's WER is real dev data.
    scoreInto(isolated, run, SCRIPTED_MANIFEST);
    expect(isolated.getWerScores()).toHaveLength(2);

    // …and reach no figure at all.
    expect(deriveWerByArm(isolated)).toEqual({});
    expect(deriveWerByCategory(isolated)).toEqual([]);
  });

  it('AC5: a FAILED RECORD inside a COMPLETE Run contributes no WER either', () => {
    // Ticket 027's rule one level down: the record produced no output audio, so
    // it is not a measurement — of latency OR of transcription quality.
    const run = seedRun(ledger, {
      runId: 'run-partial',
      recordingId: 'rec-en-1',
      manifest: SCRIPTED_MANIFEST,
      hypotheses: { 'u-1': HYP_U1_QUARTER, 'u-2': HYP_U2_THREE_QUARTERS },
      records: { 'u-2': { status: 'failed', timings: { speech_end: T0, audio_queued: null } } },
    });
    scoreInto(ledger, run, SCRIPTED_MANIFEST);

    const arm = deriveWerByArm(ledger).B!;
    expect(arm.scored).toBe(1);
    expect(arm.meanWer).toBeCloseTo(0.25, 10);
    // The failed record's 0.75 is written to the stream and excluded from the
    // figure, exactly like its (absent) latency.
    expect(ledger.getWerScore('run-partial', 'u-2')!.wer).toBeCloseTo(0.75, 10);
  });

  it('AC5: a score naming a Run the ledger does not hold reaches nothing', () => {
    seedRun(ledger, {
      runId: 'run-b-1',
      recordingId: 'rec-en-1',
      manifest: SCRIPTED_MANIFEST,
      hypotheses: { 'u-1': HYP_U1_QUARTER, 'u-2': HYP_U2_THREE_QUARTERS },
    });
    ledger.appendWerScore({
      runId: 'run-that-does-not-exist',
      utteranceId: 'u-1',
      wer: 0,
      referenceText: 'anything',
      hypothesisText: 'anything',
      normalizationVersion: 'wer-norm-v1',
      scoredAt: SCORED_AT,
    });

    // Derivations walk RUNS and look scores up, never the other way round: an
    // orphan score cannot open a row or move a figure.
    const arm = deriveWerByArm(ledger).B!;
    expect(arm.scored).toBe(0);
    expect(arm.unscored).toBe(2);
  });
});

/* ================================================== WER by utterance category */

describe('ticket 034 — deriveWerByCategory groups on the tag, never the recording', () => {
  it('AC4: one row per (category × derived arm), each with its own mean', () => {
    const run = seedRun(ledger, {
      runId: 'run-b-1',
      recordingId: 'rec-en-1',
      manifest: SCRIPTED_MANIFEST,
      hypotheses: { 'u-1': HYP_U1_QUARTER, 'u-2': HYP_U2_THREE_QUARTERS },
    });
    scoreInto(ledger, run, SCRIPTED_MANIFEST);

    const rows = deriveWerByCategory(ledger);
    expect(rows.map((r) => [r.category, r.arm])).toEqual([
      ['short-reply', 'B'],
      ['numbers-dates', 'B'],
    ]);
    expect(rows[0]!.meanWer).toBeCloseTo(0.25, 10);
    expect(rows[0]!.cell).toBe('25.0%');
    // The numbers-dates row is the one the category exists for: `250` in the
    // script against a hypothesis that dropped it.
    expect(rows[1]!.meanWer).toBeCloseTo(0.75, 10);
    expect(rows[1]!.cell).toBe('75.0%');
  });

  it('AC3: a category whose utterances have no script reports `not applicable`', () => {
    const run = seedRun(ledger, {
      runId: 'run-yue-1',
      recordingId: 'rec-yue-1',
      manifest: IMPROVISED_MANIFEST,
      hypotheses: { 'y-1': '你好嗎', 'y-2': '唔該晒' },
    });
    scoreInto(ledger, run, IMPROVISED_MANIFEST);

    for (const row of deriveWerByCategory(ledger)) {
      expect(row.meanWer).toBeNull();
      expect(row.cell).toBe(WER_NOT_APPLICABLE_CELL);
      expect(row.cell).not.toMatch(/\d/);
      expect(row.notApplicable).toBe(1);
    }
  });

  it('AC4: rows are keyed on the PAIR, so two arms give two rows per category', () => {
    const b = seedRun(ledger, {
      runId: 'run-b-1',
      recordingId: 'rec-en-1',
      manifest: [SCRIPTED_MANIFEST[0]!],
      hypotheses: { 'u-1': HYP_U1_QUARTER },
    });
    scoreInto(ledger, b, SCRIPTED_MANIFEST);

    const c = seedRun(ledger, {
      runId: 'run-c-1',
      recordingId: 'rec-en-2',
      manifest: [SCRIPTED_MANIFEST[0]!],
      hypotheses: { 'u-1': 'the quick brown fox' },
      run: { providerTriple: { ...ARM_C_TRIPLE }, modelSnapshots: { ...ARM_C_TRIPLE } },
    });
    scoreInto(ledger, c, SCRIPTED_MANIFEST);

    const rows = deriveWerByCategory(ledger).filter((r) => r.category === 'short-reply');
    expect(rows.map((r) => r.arm).sort()).toEqual(['B', 'C']);
    expect(rows.find((r) => r.arm === 'B')!.meanWer).toBeCloseTo(0.25, 10);
    expect(rows.find((r) => r.arm === 'C')!.meanWer).toBe(0);
    // A real 0 and a `not applicable` must be distinguishable on sight.
    expect(rows.find((r) => r.arm === 'C')!.cell).toBe('0.0%');
  });
});

/* ============================================= re-scoring: last write wins == */

describe('ticket 034 — re-scoring is LAST-WRITE-WINS on read, history survives', () => {
  it('AC6: a re-score moves the figure and the earlier score stays in the store', () => {
    const run = seedRun(ledger, {
      runId: 'run-b-1',
      recordingId: 'rec-en-1',
      manifest: SCRIPTED_MANIFEST,
      hypotheses: { 'u-1': HYP_U1_QUARTER, 'u-2': HYP_U2_THREE_QUARTERS },
    });
    scoreInto(ledger, run, SCRIPTED_MANIFEST);
    expect(deriveWerByArm(ledger).B!.meanWer).toBeCloseTo(0.5, 10);

    // A corpus re-cut: u-2's script is corrected and the atom is re-scored.
    const corrected: CorpusUtterance[] = [
      SCRIPTED_MANIFEST[0]!,
      { ...SCRIPTED_MANIFEST[1]!, referenceText: 'Take.' },
    ];
    scoreInto(ledger, run, corrected, SCORED_AT + 1_000);

    // Read collapses to the LAST score per (runId, utteranceId): 0.25 and 0.
    expect(deriveWerByArm(ledger).B!.meanWer).toBeCloseTo(0.125, 10);
    expect(ledger.getWerScore('run-b-1', 'u-2')!.wer).toBe(0);
    expect(ledger.getWerScore('run-b-1', 'u-2')!.scoredAt).toBe(SCORED_AT + 1_000);

    // APPEND-ONLY: nothing was rewritten. All four lines are still stored.
    const history = ledger.getWerScores();
    expect(history).toHaveLength(4);
    expect(history[1]!.wer).toBeCloseTo(0.75, 10);
    expect(history[1]!.scoredAt).toBe(SCORED_AT);
  });

  it('AC6: a re-score to `not applicable` un-scores the atom rather than zeroing it', () => {
    const run = seedRun(ledger, {
      runId: 'run-b-1',
      recordingId: 'rec-en-1',
      manifest: [SCRIPTED_MANIFEST[0]!],
      hypotheses: { 'u-1': HYP_U1_QUARTER },
    });
    scoreInto(ledger, run, SCRIPTED_MANIFEST);
    expect(deriveWerByArm(ledger).B!.cell).toBe('25.0%');

    // The script turns out never to have existed for this utterance.
    scoreInto(
      ledger,
      run,
      [{ ...SCRIPTED_MANIFEST[0]!, referenceText: undefined }],
      SCORED_AT + 1,
    );

    const arm = deriveWerByArm(ledger).B!;
    expect(arm.meanWer).toBeNull();
    expect(arm.scored).toBe(0);
    expect(arm.notApplicable).toBe(1);
    expect(arm.cell).toBe(WER_NOT_APPLICABLE_CELL);
  });
});

/* ======================================= the exp1 / exp2 comparison WER cell */

describe('ticket 034 — deriveComparison.werCell reads the stream', () => {
  /** Arm A is realtime; arms B and C are cascade and share an STT stage. */
  function seedArm(
    target: RunLedger,
    arm: 'A' | 'B' | 'C',
    hypothesis: string,
  ): void {
    const realtime = arm === 'A';
    const triple = arm === 'C' ? ARM_C_TRIPLE : ARM_B_TRIPLE;
    const run = seedRun(target, {
      runId: `run-${arm}`,
      recordingId: `rec-${arm}`,
      manifest: [SCRIPTED_MANIFEST[0]!],
      hypotheses: { 'u-1': hypothesis },
      run: {
        architecture: realtime ? 'realtime' : 'cascade',
        providerTriple: realtime ? undefined : { ...triple },
        modelSnapshots: realtime ? { realtime: REALTIME_MODEL } : { ...triple },
        armTag: arm,
      },
    });
    scoreInto(target, run, SCRIPTED_MANIFEST);
  }

  it('AC4: exp 1 (A vs B) renders the mean-WER delta from the scored stream', () => {
    expect(sttUnchangedBetween('A', 'B')).toBe(false);
    seedArm(ledger, 'A', 'the quick brown ox'); // 0.25
    seedArm(ledger, 'B', 'the quick brown fox'); // 0.00

    const exp1 = deriveComparison(ledger, 'A', 'B')!;
    // B - A = 0 - 0.25 = -25.0%.
    expect(exp1.werCell).toBe('-25.0%');
  });

  it('AC4: exp 2 (B vs C) still says the STT is unchanged, scores or not', () => {
    expect(sttUnchangedBetween('B', 'C')).toBe(true);
    seedArm(ledger, 'B', 'the quick brown ox');
    seedArm(ledger, 'C', 'the quick brown fox');

    const exp2 = deriveComparison(ledger, 'B', 'C')!;
    // The transcript is byte-identical by construction, so there is no delta
    // to report — and therefore no digit in the cell.
    expect(exp2.werCell).toBe('— (STT unchanged)');
    expect(exp2.werCell).not.toMatch(/\d/);
  });

  it('AC3: a delta needs TWO numbers — an unscoreable arm gives an em dash', () => {
    seedArm(ledger, 'A', 'the quick brown ox');
    // Arm B's utterance has no script at all.
    const b = seedRun(ledger, {
      runId: 'run-B',
      recordingId: 'rec-B',
      manifest: IMPROVISED_MANIFEST,
      hypotheses: { 'y-1': '你好嗎', 'y-2': '唔該晒' },
    });
    scoreInto(ledger, b, IMPROVISED_MANIFEST);

    const exp1 = deriveComparison(ledger, 'A', 'B')!;
    expect(exp1.werCell).toBe('—');
    expect(exp1.werCell).not.toMatch(/\d/);
    // The PER-ARM cell is where the two nulls are told apart.
    expect(deriveWerByArm(ledger).B!.cell).toBe(WER_NOT_APPLICABLE_CELL);
  });
});
