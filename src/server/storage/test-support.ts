/**
 * Test-only helpers for the storage suite (ticket 002).
 *
 * Every storage test runs against a fresh `mkdtemp` base directory so nothing
 * is ever written into the repo.
 */
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import type { BlindComparison, NewRecording, Run } from './types';

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
