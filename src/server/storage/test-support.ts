/**
 * Test-only helpers for the storage suite (ticket 002).
 *
 * Every storage test runs against a fresh `mkdtemp` base directory so nothing
 * is ever written into the repo.
 */
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { WER_NORMALIZATION_VERSION } from '../../core/wer';
import type { BlindComparison, LiveSession, NewRecording, Run, WerScore } from './types';

/** Relative paths of the normative layout (PRD §7). */
export const LAYOUT = {
  recordingJson: (base: string, id: string) =>
    path.join(base, 'recordings', `${id}.json`),
  recordingWav: (base: string, id: string) =>
    path.join(base, 'recordings', `${id}.wav`),
  runJson: (base: string, id: string) => path.join(base, 'runs', `${id}.json`),
  runWav: (base: string, id: string) => path.join(base, 'runs', `${id}.out.wav`),
  ledger: (base: string) => path.join(base, 'ledger.jsonl'),
  /**
   * Ticket 023 — blind comparisons get their OWN append-only file, NOT a line
   * in ledger.jsonl: `readLedger()` is typed `Run[]` and is read as runs by
   * exportResults, so a comparison sharing that file would be counted as a run.
   */
  comparisons: (base: string) => path.join(base, 'comparisons.jsonl'),
  /**
   * Ticket 041 — LiveSessions get their OWN append-only file for exactly the
   * reason comparisons do: `ledger.jsonl` is typed `Run[]` and is unioned into
   * the exported run set, so a session sharing it would be counted in
   * `totals.runs` and derived into an arm.
   */
  liveSessions: (base: string) => path.join(base, 'live-sessions.jsonl'),
  /**
   * Ticket 034 — post-hoc WER scores get their OWN append-only file, for the
   * same reason again: a score sharing ledger.jsonl would be read as a Run and
   * counted in `totals.runs`.
   */
  werScores: (base: string) => path.join(base, 'wer-scores.jsonl'),
};

export async function makeTempBase(): Promise<string> {
  return fs.mkdtemp(path.join(os.tmpdir(), 'wb-storage-'));
}

export async function removeTempBase(dir: string): Promise<void> {
  await fs.rm(dir, { recursive: true, force: true });
}

export async function exists(p: string): Promise<boolean> {
  try {
    await fs.stat(p);
    return true;
  } catch {
    return false;
  }
}

/** Deterministic pseudo-WAV bytes — the store must treat them as opaque. */
export function wavBytes(seed = 1, length = 64): Uint8Array {
  const out = new Uint8Array(length);
  for (let i = 0; i < length; i += 1) out[i] = (seed * 37 + i * 13) % 256;
  return out;
}

export function newRecording(overrides: Partial<NewRecording> = {}): NewRecording {
  return {
    label: 'clip one',
    sourceLanguage: 'en',
    durationMs: 4200,
    speechEndMs: 3800,
    origin: 'mic',
    ...overrides,
  };
}

/** Ticket 023 — a complete, well-formed BlindComparison (PRD §10). */
export function makeBlindComparison(
  overrides: Partial<BlindComparison> = {},
): BlindComparison {
  return {
    id: 'cmp-1',
    recordingId: 'rec-1',
    runIds: ['run-a', 'run-b'],
    order: ['run-b', 'run-a'],
    evaluatorLanguage: 'es',
    scores: {
      A: { adequacy: 4, fluency: 5 },
      B: { adequacy: 2, fluency: 3 },
    },
    createdAt: 1_700_000_000_000,
    revealedAt: 1_700_000_000_500,
    ...overrides,
  };
}

/**
 * Ticket 041 — a complete, REAL, non-empty LiveSession (PRD §7). Cascade on
 * Arm B's frozen triple with two measured utterances, so the default record
 * both passes the realness rule and is aggregatable; the zero-utterance and
 * fixture cases are built by overriding.
 */
export function makeLiveSession(overrides: Partial<LiveSession> = {}): LiveSession {
  const triple = { stt: 'gpt-4o-transcribe', mt: 'gpt-4o-mini', tts: 'gpt-4o-mini-tts' };
  return {
    id: 'live-1',
    startedAt: 1_700_000_000_000,
    endedAt: 1_700_000_300_000,
    durationMs: 300_000,
    architecture: 'cascade',
    providerTriple: { ...triple },
    contextPolicy: 'n/a',
    modelSnapshots: { ...triple },
    utterances: [
      { id: 'lu-1', timings: { speech_end: 0, audio_queued: 700 }, costUsd: 0.01 },
      { id: 'lu-2', timings: { speech_end: 0, audio_queued: 900 }, costUsd: 0.01 },
    ],
    latency: { p50: 700, p95: 900, driftMinute1ToEnd: 40 },
    cost: { totalUsd: 0.02, perMinuteMinute1: 0.004, perMinuteFinalMinute: 0.005 },
    stability: { utterancesCompleted: 2, disconnects: 0, heapStart: 18, heapEnd: 21 },
    quality: { wer: null },
    ...overrides,
  };
}

/** Ticket 041 — the operator's empty take: stored, never aggregated. */
export function makeEmptyLiveSession(overrides: Partial<LiveSession> = {}): LiveSession {
  return makeLiveSession({
    id: 'live-empty',
    utterances: [],
    latency: { p50: null, p95: null, driftMinute1ToEnd: null },
    cost: { totalUsd: 0, perMinuteMinute1: null, perMinuteFinalMinute: null },
    stability: { utterancesCompleted: 0, disconnects: 0, heapStart: null, heapEnd: null },
    ...overrides,
  });
}

/**
 * Ticket 034 — a complete, SCORED WER record: a real number against a real
 * reference. The `not applicable` case is built by `makeNotApplicableWerScore`,
 * deliberately as a separate helper so no test can produce it by forgetting a
 * field.
 */
export function makeWerScore(overrides: Partial<WerScore> = {}): WerScore {
  return {
    runId: 'run-1',
    utteranceId: 'u-1',
    wer: 0.25,
    referenceText: 'The quick brown fox.',
    hypothesisText: 'the quick brown ox',
    normalizationVersion: WER_NORMALIZATION_VERSION,
    scoredAt: 1_700_000_000_000,
    ...overrides,
  };
}

/**
 * Ticket 034 — the Cantonese case (PRD §9): improvised from English prompt
 * cards, so there is NO written script and no reference to score against.
 * `wer` is null with a named reason and is NEVER 0 — a zero WER is a perfect
 * score, which is the worst possible way to render "no reference".
 */
export function makeNotApplicableWerScore(overrides: Partial<WerScore> = {}): WerScore {
  return makeWerScore({
    runId: 'run-yue',
    utteranceId: 'u-yue-1',
    wer: null,
    notApplicableReason: 'no-reference-text',
    referenceText: null,
    hypothesisText: '\u4f60\u597d\u55ce',
    ...overrides,
  });
}

export function makeRun(overrides: Partial<Run> = {}): Run {
  return {
    id: 'run-1',
    recordingId: 'rec-1',
    architecture: 'cascade',
    providerTriple: { stt: 'gpt-4o-transcribe', mt: 'gpt-4o-mini', tts: 'gpt-4o-mini-tts' },
    modelSnapshots: { stt: 'gpt-4o-transcribe', mt: 'gpt-4o-mini', tts: 'gpt-4o-mini-tts' },
    armTag: 'B',
    origin: 'manual',
    status: 'complete',
    timings: { endToEnd: 1234, stt: 300 },
    transcripts: { source: 'hello world', target: 'hola mundo' },
    outputAudioPath: 'runs/run-1.out.wav',
    cost: 0.0021,
    errors: [],
    createdAt: 1_700_000_000_000,
    ...overrides,
  };
}
