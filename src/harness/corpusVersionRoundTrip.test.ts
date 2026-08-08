/**
 * TICKET 033 — the corpus version, from the Recording to the rendered
 * provenance line. THE ROUND TRIP, END TO END (the shape ticket 028
 * established):
 *
 *   storage.createRecording({ corpusVersion })   the operator's corpus take
 *     -> createRunOnceExecutor -> runOnce        the real runner
 *       -> RunsClient.create                     the POST
 *         -> appendRun -> ledger.jsonl           the APPEND-ONLY stream
 *           -> readLedger -> hydrateLedger       read back off disk
 *             -> deriveExperimentAggregates      buildProvenance
 *
 * WHY IT REFUSES TO STUB THE MIDDLE. A unit test on `buildProvenance` passes
 * today against hand-written annotations that nothing in production ever
 * writes — which is exactly the shape of the defect: the field exists at both
 * ends and nothing carries it between them.
 *
 * WHY IT IS URGENT. `ledger.jsonl` is APPEND-ONLY. A Run written without a
 * corpus version can never be retro-fixed, so a re-cut of the corpus leaves two
 * corpora and no way to say which numbers came from which.
 *
 * THE SECOND HALF is the hazard: this ledger deliberately spans TWO corpus
 * versions, and the line must NAME BOTH. Picking the first would report one
 * version over evidence gathered from two.
 *
 * WHY IT LIVES IN src/harness: `src/client/**` may not import `src/server/**`
 * and the server program excludes the client, so this is the only place the two
 * halves meet.
 *
 * NO NETWORK, NO REAL PROVIDER: a FixtureTransport serves every run, and the
 * CONFIGURATION is the frozen Arm B recipe so the Runs derive a named arm.
 */
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { DEFAULT_CASCADE_TRIPLE, type ProviderTriple } from '../core/arms';
import { SAMPLE_RATE } from '../core/protocol';
import { createRunOnceExecutor } from '../client/batch/runner';
import { deriveExperimentAggregates } from '../client/components/results/derive';
import type { RecordingsClient, RunsClient } from '../client/replay/recordingsClient';
import type { RunOnceConfig, RunnerDeps } from '../client/replay/runner';
import { hydrateLedger } from '../client/state/hydrateLedger';
import { RunLedger, type Recording, type Run } from '../client/state/ledger';
import { FixtureTransport, type FixtureScriptEvent } from '../client/transport/fixture';
import { createStorage, type Storage } from '../server/storage/index';
import { writeWav } from './wav';

const ARM_B_TRIPLE: ProviderTriple = { ...DEFAULT_CASCADE_TRIPLE };

const ARM_B_CONFIG: RunOnceConfig = {
  architecture: 'cascade',
  providers: ARM_B_TRIPLE,
  languagePair: 'EN↔ES',
  direction: 'en→es',
  targetLanguage: 'Spanish',
};

const V1 = 'corpus-en-es-v1';
const V2 = 'corpus-en-es-v2';

const DURATION_MS = 100;
const SPEECH_END_MS = 60;
const LATENCY_MS = 80;

const ramp = (n: number): Int16Array =>
  Int16Array.from({ length: n }, (_, i) => ((i * 7919) % 65536) - 32768);

function script(): FixtureScriptEvent[] {
  const at = SPEECH_END_MS + LATENCY_MS;
  return [
    { at: 10, type: 'sourceText', kind: 'final', text: 'hello', utt: 0 },
    { at, type: 'audio', pcm: ramp(240), utt: 0 },
    { at: at + 2, type: 'targetText', kind: 'final', text: 'hola', utt: 0 },
    { at: at + 4, type: 'utteranceComplete', record: { utt: 0 } },
  ];
}

/**
 * The three takes this ledger is built from. The version-LESS one is in on
 * purpose: an undeclared version is silence, never a third version.
 */
const TAKES: { label: string; corpusVersion?: string }[] = [
  { label: 'v2 take', corpusVersion: V2 }, // FIRST, so "pick the first" renders v2
  { label: 'v1 take', corpusVersion: V1 },
  { label: 'undeclared take' },
];

let base: string;
let storage: Storage;
let ledger: RunLedger;
let recordings: Recording[];

beforeAll(async () => {
  base = await fs.mkdtemp(path.join(os.tmpdir(), 'wb-corpusversion-'));
  storage = createStorage(base);

  const wav = writeWav(ramp(SAMPLE_RATE / 20), SAMPLE_RATE); // 50 ms
  recordings = [];
  for (const take of TAKES) {
    recordings.push(
      await storage.createRecording(
        {
          label: take.label,
          sourceLanguage: 'en',
          durationMs: DURATION_MS,
          speechEndMs: SPEECH_END_MS,
          origin: 'corpus',
          ...(take.corpusVersion === undefined ? {} : { corpusVersion: take.corpusVersion }),
        },
        wav,
      ),
    );
  }

  let nextId = 0;
  let current: Recording = recordings[0]!;
  const recordingsClient: RecordingsClient = {
    list: async () => recordings,
    // The client fetches the Recording the runner is about to replay — the one
    // place `corpusVersion` is available at run time.
    get: async (id: string) => recordings.find((r) => r.id === id)!,
    getAudio: async () => wav,
    create: async () => current,
    patchLabel: async () => current,
    remove: async () => current,
  };
  // THE POST: straight into the real store, which appends one ledger.jsonl line.
  const runsClient: RunsClient = {
    create: async (run: Run) => storage.appendRun(run),
    list: async () => storage.listRuns(),
    getAudio: async () => new Uint8Array(0),
    // TICKET 045 — the output-audio upload seam; these suites produce no assertions on it.
    uploadAudio: async (id: string) => ({ id, outputAudioPath: `runs/${id}.out.wav`, bytes: 0 }),
  };
  const deps: RunnerDeps = {
    recordings: recordingsClient,
    runs: runsClient,
    createTransport: () =>
      new FixtureTransport({ armId: 'B', kind: 'cascade', script: script() }),
    now: () => Date.now(),
    newId: () => `run-${++nextId}`,
  };

  const execute = createRunOnceExecutor(deps);
  let repIndex = 0;
  for (const recording of recordings) {
    current = recording;
    repIndex += 1;
    await execute({
      recordingId: recording.id,
      configId: 'B',
      config: ARM_B_CONFIG,
      repIndex,
      attempt: 1,
      warmup: false,
      origin: 'sweep',
      signal: new AbortController().signal,
    });
  }

  // READ BACK OFF DISK — from ledger.jsonl, the append-only stream the stamp
  // has to survive, not from the JSON sidecars.
  ledger = new RunLedger();
  await hydrateLedger(ledger, {
    recordings: { list: () => storage.listRecordings() },
    runs: { list: () => storage.readLedger() },
  });
}, 60_000);

afterAll(async () => {
  await fs.rm(base, { recursive: true, force: true });
});

describe('ticket 033 — the stamp survives runner → POST → ledger.jsonl → read back', () => {
  it('every persisted line carries the corpus version of the Recording it replayed', async () => {
    const persisted = await storage.readLedger();

    expect(persisted).toHaveLength(3);
    expect(
      persisted.map((r) => (r as Run).annotations?.corpusVersion ?? null),
    ).toEqual([V2, V1, null]);
  });

  it('the stamp rides beside repIndex, not instead of it', async () => {
    const persisted = (await storage.readLedger()) as unknown as Run[];

    expect(persisted.map((r) => r.annotations?.repIndex)).toEqual([1, 2, 3]);
  });

  it('the hydrated ledger carries it into the client store', () => {
    const runs = ledger.getRuns();

    expect(runs.map((r) => r.annotations?.corpusVersion ?? null)).toEqual([V2, V1, null]);
  });
});

describe('ticket 033 — the rendered provenance line names EVERY version behind it', () => {
  it('the aggregate spanning v1 and v2 names BOTH, sorted, and never just one', () => {
    const arm = deriveExperimentAggregates(ledger).perArm['B']!;

    expect(arm.provenance.corpusVersions).toEqual([V1, V2]);
    expect(arm.provenance.line).toContain(`${V1}, ${V2}`);
    // "pick the first" would render v2 alone over evidence from two corpora.
    expect(arm.provenance.line).not.toContain('corpus version unrecorded');
    expect(arm.provenance.corpusVersion).toBeNull();
  });

  it('all three runs are still IN the figure — the mixed ledger is labelled, not refused', () => {
    const arm = deriveExperimentAggregates(ledger).perArm['B']!;

    expect(arm.n).toBe(3);
    // Real timers, so the fixture's latency lands within a few ms of the
    // scripted one. What matters is that it is a real figure over all three.
    expect(arm.p50Ms).toBeGreaterThanOrEqual(LATENCY_MS);
    expect(arm.p50Ms).toBeLessThan(LATENCY_MS + 50);
  });
});
