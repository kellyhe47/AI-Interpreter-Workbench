/**
 * TICKET 028 — the repetition index, from the sweep to the rendered provenance
 * line. THE ROUND TRIP, END TO END:
 *
 *   startBatch + createRunOnceExecutor      the real batch runner
 *     -> RunsClient.create                  the POST
 *       -> createStorage().appendRun        runs/<id>.json + ledger.jsonl
 *         -> readLedger()                   read back off disk
 *           -> hydrateLedger -> RunLedger   the one client store
 *             -> deriveExperimentAggregates / ResultsView
 *
 * A unit test on `buildProvenance` alone already passes today (its fixtures
 * hand-write the annotations nothing in production ever writes), which is
 * exactly why this file exists and why it refuses to stub the middle.
 *
 * WHY IT LIVES IN src/harness. `src/client/**` may not import `src/server/**`,
 * and the server program excludes the client — so neither side can host a test
 * that drives both. `src/harness` is compiled by tsconfig.json and already
 * imports both (`exportResults.ts` reads the real store; `bench.test.ts` reads
 * the client ledger), which makes it the only place the two halves meet.
 *
 * THE LOAD-BEARING ASSERTION is `4 of 5 reps completed` beside a p50 computed
 * over those 4. With `repIndex` dropped on the floor, `intendedReps` falls back
 * to `completedReps` and the denominator is structurally incapable of exceeding
 * the numerator: a sweep that lost reps reports as clean. Arm B rides along in
 * the same render as the control — five clean reps must read `5 of 5`, never
 * `6 of 6`, because the warmup is an EXTRA execution and not one of them.
 *
 * NO NETWORK, NO REAL PROVIDER: a FixtureTransport serves every run. The
 * CONFIGURATIONS are the frozen Arm B and Arm C recipes, so the Runs derive
 * named arms and pass the ledger gate — the fixture is the wire, never the
 * recipe.
 *
 * @vitest-environment jsdom
 */

import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createElement } from 'react';
import { cleanup, render } from '@testing-library/react';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';

import { DEFAULT_CASCADE_TRIPLE, type ProviderTriple } from '../core/arms';
import { SAMPLE_RATE } from '../core/protocol';
import {
  createRunOnceExecutor,
  startBatch,
  type BatchConfiguration,
  type BatchExecutor,
  type BatchHandle,
  type BatchSummary,
} from '../client/batch/runner';
import { deriveExperimentAggregates, formatMs } from '../client/components/results/derive';
import type { RecordingsClient, RunsClient } from '../client/replay/recordingsClient';
import type { RunOnceConfig, RunnerDeps } from '../client/replay/runner';
import { hydrateLedger } from '../client/state/hydrateLedger';
import { RunLedger, isAggregatableRun, type Recording, type Run } from '../client/state/ledger';
import { FixtureTransport, type FixtureScriptEvent } from '../client/transport/fixture';
import ResultsView from '../client/views/ResultsView';
import { createStorage, type Storage } from '../server/storage/index';
import { writeWav } from './wav';

/* ------------------------------------------------------------- the matrix -- */

const ARM_B_TRIPLE: ProviderTriple = { ...DEFAULT_CASCADE_TRIPLE };
const ARM_C_TRIPLE: ProviderTriple = { ...DEFAULT_CASCADE_TRIPLE, tts: 'eleven_flash_v2_5' };

const CONFIGURATIONS: BatchConfiguration[] = [
  {
    id: 'B',
    config: {
      architecture: 'cascade',
      providers: ARM_B_TRIPLE,
      languagePair: 'EN↔ES',
      direction: 'en→es',
      targetLanguage: 'Spanish',
    } satisfies RunOnceConfig,
  },
  {
    id: 'C',
    config: {
      architecture: 'cascade',
      providers: ARM_C_TRIPLE,
      languagePair: 'EN↔ES',
      direction: 'en→es',
      targetLanguage: 'Spanish',
    } satisfies RunOnceConfig,
  },
];

const REPS = 5;
const DURATION_MS = 100;
const SPEECH_END_MS = 60;

/**
 * Perceived latency (audio_queued − speech_end) per retained rep, in ms. The
 * fixture answers at `SPEECH_END_MS + latency`, so these land exactly.
 *
 *   B  5 of 5 survive  → sorted [70, 75, 80, 85, 90], nearest-rank p50 = 80
 *   C  rep 3 FAILS     → sorted [ 80,  90, 110, 120], nearest-rank p50 = 90
 *      folding the lost rep back in would give 100 instead, so the p50 beside
 *      the line is what proves the line and the number agree.
 */
const LATENCIES: Record<string, readonly number[]> = {
  B: [70, 75, 80, 85, 90],
  C: [80, 90, 100, 110, 120],
};
const B_P50_MS = 80;
const C_SURVIVING_P50_MS = 90;
const C_ALL_FIVE_P50_MS = 100;

/** Arm C's rep 3 loses its TTS stage on both attempts. */
const LOST_CONFIG = 'C';
const LOST_REP = 3;

/** A fat outlier, so a warmup that leaked into a figure would be unmissable. */
const WARMUP_LATENCY_MS = 900;

const ramp = (n: number): Int16Array =>
  Int16Array.from({ length: n }, (_, i) => ((i * 7919) % 65536) - 32768);

/** The fixture timeline one execution answers with. */
function scriptFor(configId: string, repIndex: number): FixtureScriptEvent[] {
  if (configId === LOST_CONFIG && repIndex === LOST_REP) {
    // A lost stage: runOnce RESOLVES this as status 'failed' and still POSTs it.
    return [{ at: 20, type: 'error', message: 'tts stage timed out', opaque: false, stage: 'tts' }];
  }
  const latency =
    repIndex === 0 ? WARMUP_LATENCY_MS : (LATENCIES[configId]![repIndex - 1] as number);
  const at = SPEECH_END_MS + latency;
  return [
    { at: 10, type: 'sourceText', kind: 'final', text: 'hello', utt: 0 },
    { at, type: 'audio', pcm: ramp(240), utt: 0 },
    { at: at + 2, type: 'targetText', kind: 'final', text: 'hola', utt: 0 },
    { at: at + 4, type: 'utteranceComplete', record: { utt: 0 } },
  ];
}

/* -------------------------------------------------------------- the sweep -- */

let base: string;
let storage: Storage;
let recording: Recording;
let ledger: RunLedger;
let summary: BatchSummary;

/** Advances virtual time until the batch settles. Never waits on real time. */
async function drain(handle: BatchHandle): Promise<BatchSummary> {
  let settled = false;
  void handle.done.then(
    () => {
      settled = true;
    },
    () => {
      settled = true;
    },
  );
  for (let i = 0; i < 2_000 && !settled; i++) {
    await vi.advanceTimersByTimeAsync(50);
  }
  return handle.done;
}

/**
 * Drives the REAL sweep against the REAL store. The only seam is the transport
 * factory (a fixture) and the audio bytes (read once, before the clock is
 * faked, so no filesystem read happens inside virtual time).
 */
async function sweep(wav: Uint8Array): Promise<BatchSummary> {
  let nextId = 0;
  /** The cell currently executing — the runs are strictly sequential. */
  let cell = { configId: '', repIndex: 0 };

  const recordings: RecordingsClient = {
    list: async () => [recording],
    get: async () => recording,
    getAudio: async () => wav,
    create: async () => recording,
    patchLabel: async () => recording,
    remove: async () => recording,
  };
  // THE POST. Every Run the sweep produces goes to the real store, which
  // writes runs/<id>.json and appends one line to ledger.jsonl.
  const runs: RunsClient = {
    create: async (run: Run) => storage.appendRun(run),
    list: async () => storage.listRuns(),
    getAudio: async () => new Uint8Array(0),
  };
  const deps: RunnerDeps = {
    recordings,
    runs,
    createTransport: () =>
      new FixtureTransport({
        armId: cell.configId,
        kind: 'cascade',
        script: scriptFor(cell.configId, cell.repIndex),
      }),
    now: () => Date.now(),
    newId: () => `run-${++nextId}`,
  };

  const inner = createRunOnceExecutor(deps);
  const execute: BatchExecutor = async (request) => {
    cell = { configId: request.configId, repIndex: request.repIndex };
    return inner(request);
  };

  return drain(
    startBatch({
      recordingIds: [recording.id],
      configurations: CONFIGURATIONS,
      reps: REPS,
      runTimeoutMs: 600_000,
      deps: { execute, now: () => Date.now() },
    }),
  );
}

beforeAll(async () => {
  base = await fs.mkdtemp(path.join(os.tmpdir(), 'wb-repindex-'));
  storage = createStorage(base);

  const wav = writeWav(ramp(SAMPLE_RATE / 20), SAMPLE_RATE); // 50 ms of audio
  recording = await storage.createRecording(
    {
      label: 'round-trip clip',
      sourceLanguage: 'en',
      durationMs: DURATION_MS,
      speechEndMs: SPEECH_END_MS,
      origin: 'corpus',
    },
    wav,
  );

  vi.useFakeTimers();
  vi.setSystemTime(0);
  try {
    summary = await sweep(wav);
  } finally {
    vi.useRealTimers();
  }

  // READ BACK OFF DISK, into the one client store every screen reads.
  ledger = new RunLedger();
  await hydrateLedger(ledger, {
    recordings: { list: () => storage.listRecordings() },
    // ledger.jsonl is the append-only stream this ticket's envelope has to
    // survive — so the read-back comes from there, not from the JSON sidecars.
    runs: { list: () => storage.readLedger() },
  });
}, 60_000);

afterAll(async () => {
  await fs.rm(base, { recursive: true, force: true });
});

afterEach(cleanup);

/* ------------------------------------------------------------- assertions -- */

function cell(card: string, metric: string, col: string): string {
  const found = document.querySelector(
    `[data-card="${card}"] [data-metric="${metric}"] [data-col="${col}"]`,
  );
  if (!found) throw new Error(`missing cell: ${card}/${metric}/${col}`);
  return (found.textContent ?? '').trim();
}

describe('ticket 028 — repIndex survives runner → POST → ledger.jsonl → read back', () => {
  it('the sweep ran as planned: 5 retained reps per configuration, Arm C losing rep 3', () => {
    expect(summary.status).toBe('complete');
    expect(summary.configurations).toEqual([
      { configId: 'B', intendedReps: 5, completedReps: 5 },
      { configId: 'C', intendedReps: 5, completedReps: 4 },
    ]);
    expect(summary.failures.map((f) => `${f.configId}|${f.repIndex}`)).toEqual([
      `${LOST_CONFIG}|${LOST_REP}`,
    ]);
  });

  it('every persisted Run carries the index it was executed as', async () => {
    const persisted = await storage.readLedger();
    // 2 configurations × (1 warmup + 5 reps), plus the single retry of C rep 3.
    expect(persisted).toHaveLength(13);

    // The counterbalanced execution order, in ledger-append order: both
    // warmups, then A→B on odd reps and B→A on even ones, with rep 3 of Arm C
    // written twice — once per attempt. NOT ONE line may arrive without its
    // index; that is the whole defect.
    expect(persisted.map((r) => `${r.armTag}${r.annotations?.repIndex}`)).toEqual([
      'B0',
      'C0',
      'B1',
      'C1',
      'C2',
      'B2',
      'B3',
      'C3',
      'C3',
      'C4',
      'B4',
      'B5',
      'C5',
    ]);
  });

  it('the warmup persists as repIndex 0, origin manual, and STILL fails the gate', async () => {
    const persisted = (await storage.readLedger()) as unknown as Run[];
    const warmups = persisted.filter((r) => r.annotations?.repIndex === 0);

    expect(warmups).toHaveLength(2); // one per configuration
    for (const warmup of warmups) {
      expect(warmup.origin).toBe('manual');
      // The annotation is data, never a second route into the aggregate.
      expect(isAggregatableRun(warmup)).toBe(false);
    }
    // The warmup ids the summary reported are exactly those runs.
    expect(summary.discarded.map((d) => d.runId).sort()).toEqual(
      warmups.map((r) => r.id).sort(),
    );
  });

  it('the read-back ledger derives 4 of 5 for Arm C and 5 of 5 for Arm B', () => {
    const perArm = deriveExperimentAggregates(ledger).perArm;

    // Arm C: one rep lost. The denominator now comes from the rep indices the
    // sweep ATTEMPTED, so it can finally exceed the numerator.
    expect(perArm['C']!.n).toBe(4);
    expect(perArm['C']!.provenance.completedReps).toBe(4);
    expect(perArm['C']!.provenance.intendedReps).toBe(5);

    // Arm B: clean. Five retained reps read 5 of 5 — the warmup is an EXTRA
    // execution, so it must not turn this into 6 of 6.
    expect(perArm['B']!.n).toBe(5);
    expect(perArm['B']!.provenance.completedReps).toBe(5);
    expect(perArm['B']!.provenance.intendedReps).toBe(5);
  });
});

describe('ticket 028 — the rendered provenance line and the figure beside it agree', () => {
  it('Results renders "4 of 5 reps completed" for Arm C and "5 of 5" for Arm B', () => {
    render(createElement(ResultsView, { ledger }));

    const line = document.querySelector('[data-provenance="exp2"]')?.textContent ?? '';
    expect(line).toContain('5 of 5 reps completed');
    expect(line).toContain('4 of 5 reps completed');
  });

  it('the p50 beside the 4-of-5 line is computed over the FOUR survivors', () => {
    render(createElement(ResultsView, { ledger }));

    // Arm C is column b of experiment 2; Arm B is column a.
    expect(cell('exp2', 'p50', 'b')).toBe(formatMs(C_SURVIVING_P50_MS));
    // Folding the lost rep back in would read 0.10 s. It must not.
    expect(cell('exp2', 'p50', 'b')).not.toBe(formatMs(C_ALL_FIVE_P50_MS));
    expect(cell('exp2', 'p50', 'a')).toBe(formatMs(B_P50_MS));
    // ...and the discarded warmup's fat latency reaches no figure at all.
    expect(document.querySelector('[data-results-tab]')?.textContent ?? '').not.toContain(
      formatMs(WARMUP_LATENCY_MS),
    );
  });
});
