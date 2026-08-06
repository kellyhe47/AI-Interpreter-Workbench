/**
 * Ticket 011 / 015 — shared entity builders for the Results-view tests.
 *
 * Test-only helper (imported by derive.test.ts and ResultsView.test.tsx).
 * Every latency is chosen so the nearest-rank percentile lands on a value
 * whose formatted string is exact and assertable, and every seeded figure is
 * exported so a test can compute the expectation instead of copying a literal.
 *
 * Fixture inventory:
 *   seedCleanSweep        — a clean multi-rep sweep (Arm B, 5 of 5)
 *   seedShortRepSweep     — 4 completed of 5 intended (Arm C, rep 3 failed)
 *   seedExclusionCases    — one Run per exclusion reason, each on its own
 *                           Recording so each gets its own grouping row
 *   seedCategorySweep     — categories DISTRIBUTED across two recordings
 *   seedComparisonSweep   — Arms A / B / C for exp1 and exp2
 *   seedLiveSessions      — LiveSessions only, never pooled with Runs
 */

import {
  DEFAULT_CASCADE_TRIPLE,
  REALTIME_MODEL,
  type ProviderTriple,
} from '../../../core/arms';
import type { LiveSession, Recording, RunLedger } from '../../state/ledger';
import type { AnnotatedRun, UtteranceCategory } from './derive';

/** 2026-01-05T12:00:00Z — makes every derived date assertion deterministic. */
export const T0 = Date.UTC(2026, 0, 5, 12, 0, 0);

/** Corpus version stamped on every v2 sample. */
export const CORPUS_VERSION = 'corpus-en-es-v2';

/** Every seeded Recording is this long, so cost-per-minute is exact. */
export const RECORDING_DURATION_MS = 6_000;

export const ARM_B_TRIPLE: ProviderTriple = { ...DEFAULT_CASCADE_TRIPLE };
export const ARM_C_TRIPLE: ProviderTriple = {
  ...DEFAULT_CASCADE_TRIPLE,
  tts: 'eleven_flash_v2_5',
};
/** Every stage is a legal menu choice, but the combination is no frozen arm. */
export const OFF_ARM_TRIPLE: ProviderTriple = {
  stt: 'gpt-4o-mini-transcribe',
  mt: 'claude-haiku-4-5',
  tts: 'eleven_multilingual_v2',
};

let entitySeq = 0;

export function resetEntitySeq(): void {
  entitySeq = 0;
}

export function makeRecordingEntity(overrides: Partial<Recording> = {}): Recording {
  entitySeq += 1;
  return {
    id: `rec-${entitySeq}`,
    label: `clip ${entitySeq}`,
    sourceLanguage: 'en',
    durationMs: RECORDING_DURATION_MS,
    speechEndMs: RECORDING_DURATION_MS - 400,
    origin: 'corpus',
    createdAt: T0 + entitySeq,
    ...overrides,
  };
}

/**
 * A Run that PASSES the ledger gate by default: Arm-B triple, sweep origin,
 * complete status, real providers. Every exclusion case is this minus one
 * thing, which is what makes the exclusion table honest.
 */
export function makeRunEntity(overrides: Partial<AnnotatedRun> = {}): AnnotatedRun {
  entitySeq += 1;
  return {
    id: `run-${entitySeq}`,
    recordingId: 'rec-1',
    architecture: 'cascade',
    providerTriple: { ...ARM_B_TRIPLE },
    modelSnapshots: { ...ARM_B_TRIPLE },
    armTag: 'B',
    origin: 'sweep',
    status: 'complete',
    timings: { speech_end: T0, audio_queued: T0 + 800 },
    transcripts: { source: 'hello', target: 'hola' },
    outputAudioPath: `runs/run-${entitySeq}.out.wav`,
    cost: 0.002,
    errors: [],
    createdAt: T0 + entitySeq,
    annotations: { utteranceId: 'u1', repIndex: 1, corpusVersion: CORPUS_VERSION },
    ...overrides,
  };
}

/** Gate-passing Run whose perceived latency (audio_queued − speech_end) is `ms`. */
export function runWithLatency(ms: number, overrides: Partial<AnnotatedRun> = {}): AnnotatedRun {
  return makeRunEntity({ timings: { speech_end: T0, audio_queued: T0 + ms }, ...overrides });
}

export function makeLiveSessionEntity(overrides: Partial<LiveSession> = {}): LiveSession {
  entitySeq += 1;
  return {
    id: `live-${entitySeq}`,
    startedAt: T0,
    endedAt: T0 + 300_000,
    durationMs: 300_000,
    architecture: 'cascade',
    providerTriple: { ...ARM_B_TRIPLE },
    modelSnapshots: { ...ARM_B_TRIPLE },
    utterances: [],
    latency: { p50: null, p95: null, driftMinute1ToEnd: null },
    cost: { totalUsd: 0, perMinuteMinute1: null, perMinuteFinalMinute: null },
    stability: { utterancesCompleted: 0, disconnects: 0, heapStart: null, heapEnd: null },
    quality: { wer: null },
    ...overrides,
  };
}

/* ---------------------------------------------------------------- sweeps -- */

export const CLEAN_RECORDING_ID = 'rec-clean';
/** Arm B, 5 intended reps, 5 completed. p50 = 900, p95 = 1200 (nearest rank). */
export const CLEAN_SWEEP_LATENCIES = [700, 780, 900, 1000, 1200] as const;
export const CLEAN_SWEEP_COST_PER_RUN = 0.002;

/** A clean multi-rep sweep: 5 of 5 reps complete, nothing excluded. */
export function seedCleanSweep(ledger: RunLedger): void {
  ledger.appendRecording(
    makeRecordingEntity({ id: CLEAN_RECORDING_ID, label: 'clean sweep clip' }),
  );
  CLEAN_SWEEP_LATENCIES.forEach((ms, i) => {
    ledger.appendRun(
      runWithLatency(ms, {
        id: `run-clean-${i + 1}`,
        recordingId: CLEAN_RECORDING_ID,
        cost: CLEAN_SWEEP_COST_PER_RUN,
        annotations: {
          utteranceId: 'u1',
          category: 'short-reply',
          repIndex: i + 1,
          corpusVersion: CORPUS_VERSION,
        },
      }),
    );
  });
}

export const SHORT_RECORDING_ID = 'rec-short';
/** Arm C, 5 intended reps. Index 2 (rep 3, 1000 ms) FAILS. */
export const SHORT_SWEEP_LATENCIES = [800, 900, 1000, 1100, 1200] as const;
export const SHORT_SWEEP_FAILED_REP = 3;
export const SHORT_SWEEP_INTENDED_REPS = 5;
export const SHORT_SWEEP_COMPLETED_REPS = 4;
export const SHORT_SWEEP_COST_PER_RUN = 0.004;
/**
 * The four surviving samples, sorted: [800, 900, 1100, 1200].
 * Nearest rank over 4 → p50 = 900, p95 = 1200.
 * Aggregating all FIVE would give p50 = 1000 instead — the two answers differ,
 * which is what makes the actual-N assertion load-bearing.
 */
export const SHORT_SWEEP_SURVIVING_P50_MS = 900;
export const SHORT_SWEEP_SURVIVING_P95_MS = 1200;
export const SHORT_SWEEP_ALL_FIVE_P50_MS = 1000;

/**
 * A sweep that intended 5 reps and lost one. The failed Run carries COMPLETE
 * timings on purpose: an implementation that ignores `status` would happily
 * fold it into the percentiles, and the assertion has to catch that.
 */
export function seedShortRepSweep(ledger: RunLedger): void {
  ledger.appendRecording(
    makeRecordingEntity({ id: SHORT_RECORDING_ID, label: 'short-rep clip' }),
  );
  SHORT_SWEEP_LATENCIES.forEach((ms, i) => {
    const rep = i + 1;
    const failed = rep === SHORT_SWEEP_FAILED_REP;
    ledger.appendRun(
      runWithLatency(ms, {
        id: `run-short-${rep}`,
        recordingId: SHORT_RECORDING_ID,
        providerTriple: { ...ARM_C_TRIPLE },
        modelSnapshots: { ...ARM_C_TRIPLE },
        armTag: 'C',
        status: failed ? 'failed' : 'complete',
        errors: failed ? ['tts stage timed out'] : [],
        cost: SHORT_SWEEP_COST_PER_RUN,
        annotations: {
          utteranceId: 'u1',
          category: 'numbers-dates',
          repIndex: rep,
          corpusVersion: CORPUS_VERSION,
        },
      }),
    );
  });
}

/* ----------------------------------------------------------- exclusions -- */

export const ADHOC_RECORDING_ID = 'rec-adhoc';
export const MANUAL_RECORDING_ID = 'rec-manual';
export const FAILED_RECORDING_ID = 'rec-failed';
export const FIXTURE_RECORDING_ID = 'rec-fixture';

export const ADHOC_RUN_ID = 'run-adhoc';
export const MANUAL_RUN_ID = 'run-manual';
export const FAILED_RUN_ID = 'run-failed';
export const FIXTURE_RUN_ID = 'run-fixture';

/** Latency each exclusion-case Run would contribute if it were not excluded. */
export const EXCLUDED_LATENCY_MS = 5_000;
export const EXCLUDED_COST_USD = 0.5;

/**
 * One Run per exclusion reason, each on its OWN Recording so each lands in its
 * own (recording × configuration) grouping row. Every one of them carries full
 * timings and a fat cost, so an implementation that leaks one into the
 * aggregate moves a number visibly.
 */
export function seedExclusionCases(ledger: RunLedger): void {
  ledger.appendRecording(makeRecordingEntity({ id: ADHOC_RECORDING_ID, label: 'ad-hoc clip' }));
  ledger.appendRecording(makeRecordingEntity({ id: MANUAL_RECORDING_ID, label: 'manual clip' }));
  ledger.appendRecording(makeRecordingEntity({ id: FAILED_RECORDING_ID, label: 'failed clip' }));
  ledger.appendRecording(
    makeRecordingEntity({ id: FIXTURE_RECORDING_ID, label: 'fixture clip' }),
  );

  const base = {
    cost: EXCLUDED_COST_USD,
    annotations: {
      utteranceId: 'u1',
      category: 'proper-nouns' as UtteranceCategory,
      repIndex: 1,
      corpusVersion: CORPUS_VERSION,
    },
  };

  // (1) DERIVED tag is 'ad-hoc' — a legal triple that is no frozen arm.
  ledger.appendRun(
    runWithLatency(EXCLUDED_LATENCY_MS, {
      ...base,
      id: ADHOC_RUN_ID,
      recordingId: ADHOC_RECORDING_ID,
      providerTriple: { ...OFF_ARM_TRIPLE },
      modelSnapshots: { ...OFF_ARM_TRIPLE },
      // Declared 'B' on purpose: the declared tag must never be believed.
      armTag: 'B',
    }),
  );

  // (2) origin 'manual' — no counterbalancing, no warmup discard.
  ledger.appendRun(
    runWithLatency(EXCLUDED_LATENCY_MS, {
      ...base,
      id: MANUAL_RUN_ID,
      recordingId: MANUAL_RECORDING_ID,
      origin: 'manual',
    }),
  );

  // (3) status 'failed' — real information, but not a latency sample.
  ledger.appendRun(
    runWithLatency(EXCLUDED_LATENCY_MS, {
      ...base,
      id: FAILED_RUN_ID,
      recordingId: FAILED_RECORDING_ID,
      status: 'failed',
      errors: ['stt stage disconnected'],
    }),
  );

  // (4) fixture-sourced — a fixture model snapshot trips the realness rule
  //     while leaving the DERIVED arm tag at 'B', so the reason is unambiguous.
  ledger.appendRun(
    runWithLatency(EXCLUDED_LATENCY_MS, {
      ...base,
      id: FIXTURE_RUN_ID,
      recordingId: FIXTURE_RECORDING_ID,
      modelSnapshots: { ...ARM_B_TRIPLE, tts: 'fixture' },
    }),
  );
}

/* ------------------------------------------------------------ categories -- */

export const CATEGORY_RECORDING_IDS = ['rec-cat-1', 'rec-cat-2'] as const;

/**
 * PRD §9: categories are DISTRIBUTED across recordings, never grouped. Each of
 * the two recordings holds both categories, so a per-category figure cannot be
 * reconstructed from any per-recording figure.
 *
 * numbers-dates pooled → [1200, 1300, 1500, 1600], p50 = 1300, p95 = 1600
 * short-reply   pooled → [ 700,  760,  900,  980], p50 =  760, p95 =  980
 * rec-cat-1     pooled → [ 700,  760, 1200, 1300], p50 =  760
 * rec-cat-2     pooled → [ 900,  980, 1500, 1600], p50 =  980
 */
export const CATEGORY_SAMPLES: ReadonlyArray<{
  recordingId: string;
  category: UtteranceCategory;
  utteranceId: string;
  repIndex: number;
  latencyMs: number;
}> = [
  { recordingId: 'rec-cat-1', category: 'numbers-dates', utteranceId: 'u1', repIndex: 1, latencyMs: 1200 },
  { recordingId: 'rec-cat-1', category: 'numbers-dates', utteranceId: 'u1', repIndex: 2, latencyMs: 1300 },
  { recordingId: 'rec-cat-1', category: 'short-reply', utteranceId: 'u2', repIndex: 1, latencyMs: 700 },
  { recordingId: 'rec-cat-1', category: 'short-reply', utteranceId: 'u2', repIndex: 2, latencyMs: 760 },
  { recordingId: 'rec-cat-2', category: 'numbers-dates', utteranceId: 'u3', repIndex: 1, latencyMs: 1500 },
  { recordingId: 'rec-cat-2', category: 'numbers-dates', utteranceId: 'u3', repIndex: 2, latencyMs: 1600 },
  { recordingId: 'rec-cat-2', category: 'short-reply', utteranceId: 'u4', repIndex: 1, latencyMs: 900 },
  { recordingId: 'rec-cat-2', category: 'short-reply', utteranceId: 'u4', repIndex: 2, latencyMs: 980 },
];

export const CATEGORY_COST_PER_RUN = 0.002;

/** All Arm B, all gate-passing. Two recordings × two categories × two reps. */
export function seedCategorySweep(ledger: RunLedger): void {
  for (const id of CATEGORY_RECORDING_IDS) {
    ledger.appendRecording(makeRecordingEntity({ id, label: `${id} clip` }));
  }
  CATEGORY_SAMPLES.forEach((s, i) => {
    ledger.appendRun(
      runWithLatency(s.latencyMs, {
        id: `run-cat-${i + 1}`,
        recordingId: s.recordingId,
        cost: CATEGORY_COST_PER_RUN,
        annotations: {
          utteranceId: s.utteranceId,
          category: s.category,
          repIndex: s.repIndex,
          corpusVersion: CORPUS_VERSION,
        },
      }),
    );
  });
}

/* ----------------------------------------------------------- comparisons -- */

export const COMPARISON_RECORDING_IDS = {
  A: 'rec-cmp-a',
  B: 'rec-cmp-b',
  C: 'rec-cmp-c',
} as const;

/**
 * Three reps per arm on a 6 s Recording each, so cost per audio minute is
 * exact: 3 × 6000 ms = 0.3 min.
 *   A  p50 1100 / p95 1200 · 3 × $0.010 = $0.030 → $0.100 / min
 *   B  p50  800 / p95  900 · 3 × $0.002 = $0.006 → $0.020 / min
 *   C  p50  850 / p95  950 · 3 × $0.004 = $0.012 → $0.040 / min
 */
export const COMPARISON_LATENCIES = {
  A: [1000, 1100, 1200],
  B: [700, 800, 900],
  C: [750, 850, 950],
} as const;

export const COMPARISON_COST_PER_RUN = { A: 0.01, B: 0.002, C: 0.004 } as const;

export function seedComparisonSweep(ledger: RunLedger): void {
  for (const arm of ['A', 'B', 'C'] as const) {
    const recordingId = COMPARISON_RECORDING_IDS[arm];
    ledger.appendRecording(makeRecordingEntity({ id: recordingId, label: `arm ${arm} clip` }));
    COMPARISON_LATENCIES[arm].forEach((ms, i) => {
      const cascade = arm !== 'A';
      const triple = arm === 'B' ? ARM_B_TRIPLE : ARM_C_TRIPLE;
      ledger.appendRun(
        runWithLatency(ms, {
          id: `run-cmp-${arm}-${i + 1}`,
          recordingId,
          architecture: cascade ? 'cascade' : 'realtime',
          providerTriple: cascade ? { ...triple } : undefined,
          modelSnapshots: cascade ? { ...triple } : { realtime: REALTIME_MODEL },
          armTag: arm,
          cost: COMPARISON_COST_PER_RUN[arm],
          annotations: {
            utteranceId: 'u1',
            category: 'long-compound',
            repIndex: i + 1,
            corpusVersion: CORPUS_VERSION,
          },
        }),
      );
    });
  }
}

/* --------------------------------------------------------- live sessions -- */

/**
 * One session per arm. Each session's declared latency percentiles agree with
 * the nearest-rank percentiles over its own utterances, so the assertion holds
 * whichever of the two an implementation reads.
 *   Arm A  utterances [1000, 1100, 1200] → p50 1100 / p95 1200
 *   Arm B  utterances [ 600,  700,  800] → p50  700 / p95  800
 */
export const LIVE_A_LATENCIES = [1000, 1100, 1200] as const;
export const LIVE_B_LATENCIES = [600, 700, 800] as const;
export const LIVE_A_DRIFT_MS = 250;
export const LIVE_B_DRIFT_MS = 40;
export const LIVE_A_COST = { totalUsd: 0.9, perMinuteMinute1: 0.12, perMinuteFinalMinute: 0.3 };
export const LIVE_B_COST = { totalUsd: 0.2, perMinuteMinute1: 0.04, perMinuteFinalMinute: 0.041 };

function liveUtterances(latencies: readonly number[], costEach: number) {
  return latencies.map((ms, i) => ({
    id: `lu-${i + 1}`,
    timings: { speech_end: 0, audio_queued: ms },
    costUsd: costEach,
  }));
}

export function seedLiveSessions(ledger: RunLedger): void {
  ledger.appendLiveSession(
    makeLiveSessionEntity({
      id: 'live-arm-a',
      architecture: 'realtime',
      providerTriple: undefined,
      modelSnapshots: { realtime: REALTIME_MODEL },
      utterances: liveUtterances(LIVE_A_LATENCIES, 0.3),
      latency: { p50: 1100, p95: 1200, driftMinute1ToEnd: LIVE_A_DRIFT_MS },
      cost: { ...LIVE_A_COST },
      stability: { utterancesCompleted: 3, disconnects: 1, heapStart: 20, heapEnd: 44 },
      quality: { wer: null, subjectiveNotes: 'one drop at minute 4' },
    }),
  );
  ledger.appendLiveSession(
    makeLiveSessionEntity({
      id: 'live-arm-b',
      architecture: 'cascade',
      providerTriple: { ...ARM_B_TRIPLE },
      modelSnapshots: { ...ARM_B_TRIPLE },
      utterances: liveUtterances(LIVE_B_LATENCIES, 0.06),
      latency: { p50: 700, p95: 800, driftMinute1ToEnd: LIVE_B_DRIFT_MS },
      cost: { ...LIVE_B_COST },
      stability: { utterancesCompleted: 3, disconnects: 0, heapStart: 18, heapEnd: 21 },
      quality: { wer: null },
    }),
  );
}
