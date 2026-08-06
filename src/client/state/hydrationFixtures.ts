/**
 * TICKET 019 — the server store QA actually POSTed, as data.
 *
 * Test-only helper (imported by hydrateLedger.test.ts,
 * ResultsView.hydration.test.tsx and App.hydration.test.tsx) so the three
 * suites argue about ONE store rather than three lookalikes.
 *
 * The four Runs are the ones from the F2 repro, verbatim:
 *
 *   run-b-sweep-1  armTag=B  origin=sweep   status=complete   -> GATE PASSES
 *   run-c-sweep-1  armTag=C  origin=sweep   status=complete   -> GATE PASSES
 *   run-failed-1   armTag=B  origin=sweep   status=failed     -> excluded, visible
 *   run-adhoc-1    armTag=B(stored) origin=manual complete    -> ad-hoc, excluded, visible
 *
 * plus one addition of our own — a fixture-sourced Run that would otherwise
 * pass the gate — because ticket 018's rule has to survive hydration too.
 *
 * Each Run sits on its OWN Recording (the seedExclusionCases rationale: one
 * (recording × configuration) grouping row each, so a row assertion is
 * unambiguous). Every excluded Run carries FULL timings and a fat cost, so an
 * implementation that leaks one past the gate moves a rendered number visibly.
 */

import type { AnnotatedRun } from '../components/results/derive';
import {
  ARM_B_TRIPLE,
  ARM_C_TRIPLE,
  CORPUS_VERSION,
  EXCLUDED_COST_USD,
  EXCLUDED_LATENCY_MS,
  OFF_ARM_TRIPLE,
  RECORDING_DURATION_MS,
  T0,
} from '../components/results/testRecords';
import type { LedgerHydrationSource } from './hydrateLedger';
import type { Recording, Run } from './ledger';

export const SERVER_RECORDING_IDS = {
  b: 'rec-server-b',
  c: 'rec-server-c',
  failed: 'rec-server-failed',
  adhoc: 'rec-server-adhoc',
  fixture: 'rec-server-fixture',
} as const;

export const RUN_IDS = {
  bSweep: 'run-b-sweep-1',
  cSweep: 'run-c-sweep-1',
  failed: 'run-failed-1',
  adhoc: 'run-adhoc-1',
  fixture: 'run-fixture-1',
} as const;

/** One sample per arm, so p50 === p95 === the sample and the math is exact. */
export const B_SWEEP_LATENCY_MS = 800;
export const C_SWEEP_LATENCY_MS = 850;
export const B_SWEEP_COST_USD = 0.002;
export const C_SWEEP_COST_USD = 0.004;

export const RECORDING_LABELS = {
  [SERVER_RECORDING_IDS.b]: 'server arm B clip',
  [SERVER_RECORDING_IDS.c]: 'server arm C clip',
  [SERVER_RECORDING_IDS.failed]: 'server failed clip',
  [SERVER_RECORDING_IDS.adhoc]: 'server ad-hoc clip',
  [SERVER_RECORDING_IDS.fixture]: 'server fixture clip',
} as const;

function recording(id: string, label: string): Recording {
  return {
    id,
    label,
    sourceLanguage: 'en',
    durationMs: RECORDING_DURATION_MS,
    speechEndMs: RECORDING_DURATION_MS - 400,
    origin: 'corpus',
    createdAt: T0,
  };
}

function run(overrides: Partial<AnnotatedRun> & Pick<AnnotatedRun, 'id'>): AnnotatedRun {
  return {
    recordingId: SERVER_RECORDING_IDS.b,
    architecture: 'cascade',
    providerTriple: { ...ARM_B_TRIPLE },
    modelSnapshots: { ...ARM_B_TRIPLE },
    armTag: 'B',
    origin: 'sweep',
    status: 'complete',
    timings: { speech_end: T0, audio_queued: T0 + EXCLUDED_LATENCY_MS },
    transcripts: { source: 'hello', target: 'hola' },
    outputAudioPath: `runs/${overrides.id}.out.wav`,
    cost: EXCLUDED_COST_USD,
    errors: [],
    createdAt: T0 + 1,
    annotations: {
      utteranceId: 'u1',
      category: 'short-reply',
      repIndex: 1,
      corpusVersion: CORPUS_VERSION,
    },
    ...overrides,
  };
}

/** The Recordings behind the four repro Runs, in server listing order. */
export const SERVER_RECORDINGS: readonly Recording[] = [
  recording(SERVER_RECORDING_IDS.b, RECORDING_LABELS[SERVER_RECORDING_IDS.b]),
  recording(SERVER_RECORDING_IDS.c, RECORDING_LABELS[SERVER_RECORDING_IDS.c]),
  recording(SERVER_RECORDING_IDS.failed, RECORDING_LABELS[SERVER_RECORDING_IDS.failed]),
  recording(SERVER_RECORDING_IDS.adhoc, RECORDING_LABELS[SERVER_RECORDING_IDS.adhoc]),
];

/** A fifth Recording, so the fixture Run lands in its OWN grouping row. */
export const FIXTURE_RECORDING: Recording = recording(
  SERVER_RECORDING_IDS.fixture,
  RECORDING_LABELS[SERVER_RECORDING_IDS.fixture],
);

/** The four Runs from the repro, in the order the server returns them. */
export const SERVER_RUNS: readonly AnnotatedRun[] = [
  run({
    id: RUN_IDS.bSweep,
    timings: { speech_end: T0, audio_queued: T0 + B_SWEEP_LATENCY_MS },
    cost: B_SWEEP_COST_USD,
  }),
  run({
    id: RUN_IDS.cSweep,
    recordingId: SERVER_RECORDING_IDS.c,
    providerTriple: { ...ARM_C_TRIPLE },
    modelSnapshots: { ...ARM_C_TRIPLE },
    armTag: 'C',
    timings: { speech_end: T0, audio_queued: T0 + C_SWEEP_LATENCY_MS },
    cost: C_SWEEP_COST_USD,
  }),
  // Real information — still listed, never a latency sample (PRD §12).
  run({
    id: RUN_IDS.failed,
    recordingId: SERVER_RECORDING_IDS.failed,
    status: 'failed',
    errors: ['tts stage timed out'],
  }),
  // Declared 'B', but the triple is no frozen arm: DERIVED beats DECLARED, and
  // its origin is 'manual' as well — either clause alone keeps it out.
  run({
    id: RUN_IDS.adhoc,
    recordingId: SERVER_RECORDING_IDS.adhoc,
    providerTriple: { ...OFF_ARM_TRIPLE },
    modelSnapshots: { ...OFF_ARM_TRIPLE },
    armTag: 'B',
    origin: 'manual',
  }),
];

/**
 * Ticket 018's rule on the Run path, after hydration: sweep-origin, complete,
 * derived Arm B — it would pass the gate if its TTS snapshot were not fixture.
 */
export const FIXTURE_RUN: AnnotatedRun = run({
  id: RUN_IDS.fixture,
  recordingId: SERVER_RECORDING_IDS.fixture,
  modelSnapshots: { ...ARM_B_TRIPLE, tts: 'fixture' },
});

export interface StaticHydrationSource {
  source: LedgerHydrationSource;
  /** How each listing was called, so a test can pin "unfiltered runs.list()". */
  calls: { recordings: number; runs: Array<string | undefined> };
}

/** An injected source that resolves immediately with the given store. */
export function staticHydrationSource(
  recordings: readonly Recording[] = SERVER_RECORDINGS,
  runs: readonly Run[] = SERVER_RUNS,
): StaticHydrationSource {
  const calls: StaticHydrationSource['calls'] = { recordings: 0, runs: [] };
  return {
    calls,
    source: {
      recordings: {
        list: async (): Promise<Recording[]> => {
          calls.recordings += 1;
          return recordings.map((r) => ({ ...r }));
        },
      },
      runs: {
        list: async (recordingId?: string): Promise<Run[]> => {
          calls.runs.push(recordingId);
          return runs.map((r) => ({ ...r }));
        },
      },
    },
  };
}
