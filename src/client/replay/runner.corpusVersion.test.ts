/**
 * TICKET 033 — `corpusVersion` reaches the Run.
 *
 * THE DEFECT: ticket 030 persists `corpusVersion` on the Recording, but nothing
 * reads it. `runOnce` has the Recording in hand and drops the field, so
 * `annotations.corpusVersion` is undefined on every Run ever written and every
 * provenance line ends `corpus version unrecorded`.
 *
 * WHY IT IS TIME-SENSITIVE: the ledger is APPEND-ONLY. A Run written without a
 * corpus version cannot be retro-fixed, so a later re-cut of the corpus leaves
 * two corpora and no way to tell which numbers came from which. Every hour the
 * stamp is missing is measurement that can never be attributed.
 *
 * A MANUAL RUN COUNTS. Provenance is displayed for ad-hoc runs too, so the copy
 * happens in `runOnce` — where the Recording is — and NOT in the batch runner's
 * stamping wrapper the way `repIndex` (ticket 028) does, because a manual run
 * never passes through that wrapper.
 *
 * Virtual time throughout, fixture transport only: no network, no provider.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { DEFAULT_CASCADE_TRIPLE } from '../../core/arms';
import { SAMPLE_RATE } from '../../core/protocol';
import { writeWav } from '../../harness/wav';
import { createRunOnceExecutor } from '../batch/runner';
import type { Recording, Run } from '../state/ledger';
import { FixtureTransport, type FixtureScriptEvent } from '../transport/fixture';
import { FRAME_SAMPLES } from './pacer';
import type { RecordingsClient, RunsClient } from './recordingsClient';
import { runOnce, type RunOnceConfig, type RunnerDeps } from './runner';

const ramp = (n: number): Int16Array =>
  Int16Array.from({ length: n }, (_, i) => ((i * 7919) % 65536) - 32768);

const CORPUS_VERSION = 'corpus-en-es-v2';

const BASE_RECORDING: Recording = {
  id: 'rec-1',
  label: 'corpus take',
  sourceLanguage: 'en',
  durationMs: 100,
  speechEndMs: 60,
  origin: 'corpus',
  createdAt: 1_000,
};

const CASCADE_CONFIG: RunOnceConfig = {
  architecture: 'cascade',
  providers: DEFAULT_CASCADE_TRIPLE,
  languagePair: 'EN↔ES',
  direction: 'en→es',
  targetLanguage: 'Spanish',
};

/** A clean single-utterance timeline. */
function goodScript(): FixtureScriptEvent[] {
  return [
    { at: 20, type: 'sourceText', kind: 'final', text: 'hello', utt: 0 },
    { at: 80, type: 'audio', pcm: ramp(240), utt: 0 },
    { at: 84, type: 'targetText', kind: 'final', text: 'hola', utt: 0 },
    { at: 90, type: 'utteranceComplete', record: { utt: 0 } },
  ];
}

/** A lost stage: runOnce resolves 'failed' and STILL POSTs the Run. */
function failingScript(): FixtureScriptEvent[] {
  return [{ at: 20, type: 'error', message: 'tts stage timed out', opaque: false, stage: 'tts' }];
}

function makeHarness(opts: { recording?: Partial<Recording>; script?: FixtureScriptEvent[] } = {}) {
  const recording: Recording = { ...BASE_RECORDING, ...opts.recording };
  const wav = writeWav(ramp(FRAME_SAMPLES * 5), SAMPLE_RATE);
  const posted: Run[] = [];

  const recordings: RecordingsClient = {
    list: async () => [recording],
    get: async () => recording,
    getAudio: async () => wav,
    create: async () => recording,
    patchLabel: async () => recording,
    remove: async () => recording,
  };
  const runs: RunsClient = {
    create: async (run: Run) => {
      posted.push(run);
      return run;
    },
    list: async () => posted,
    getAudio: async () => new Uint8Array(0),
    // TICKET 045 — the output-audio upload seam; these suites produce no assertions on it.
    uploadAudio: async (id: string) => ({ id, outputAudioPath: `runs/${id}.out.wav`, bytes: 0 }),
  };
  const deps: RunnerDeps = {
    recordings,
    runs,
    createTransport: () =>
      new FixtureTransport({ armId: 'fx', kind: 'cascade', script: opts.script ?? goodScript() }),
    now: () => Date.now(),
    newId: () => 'run-1',
    // The trailing pad (see runner.ts TRAILING_PAD_MS) is paced in REAL time,
    // so leaving production's 1.5 s on for every case in this file would add
    // minutes of sleep to the suite. It is switched OFF here and asserted
    // explicitly, with the seam omitted, in the pad's own describe block —
    // where the DEFAULT is what is under test rather than ambient.
    trailingPadMs: 0,
  };

  return { recording, deps, posted };
}

/** Runs to completion under virtual time. */
async function drain<T>(promise: Promise<T>): Promise<T> {
  let settled = false;
  void promise.then(
    () => {
      settled = true;
    },
    () => {
      settled = true;
    },
  );
  for (let i = 0; i < 500 && !settled; i++) await vi.advanceTimersByTimeAsync(20);
  return promise;
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(0);
  (globalThis as Record<string, unknown>).AudioContext = vi.fn();
});

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  delete (globalThis as Record<string, unknown>).AudioContext;
});

describe('ticket 033 — runOnce copies the Recording corpusVersion onto the Run', () => {
  it('a MANUAL run of a corpus Recording persists annotations.corpusVersion', async () => {
    const h = makeHarness({ recording: { corpusVersion: CORPUS_VERSION } });

    const result = await drain(
      runOnce({ recordingId: h.recording.id, config: CASCADE_CONFIG, deps: h.deps }),
    );

    // The run that reached the store — the append-only record, the only copy
    // that can ever be cited.
    expect(h.posted).toHaveLength(1);
    expect(h.posted[0]!.annotations?.corpusVersion).toBe(CORPUS_VERSION);
    // ...and the run handed back to the caller, which the Replay view renders.
    expect(result.run.annotations?.corpusVersion).toBe(CORPUS_VERSION);
    // A manual run really is manual: this is not the sweep path.
    expect(result.run.origin).toBe('manual');
  });

  it('REGRESSION GUARD: a Recording WITHOUT a corpusVersion declares none', async () => {
    // The honest fallback stays. Inventing a default here would put a version
    // the corpus never had into an append-only ledger.
    const h = makeHarness();

    const result = await drain(
      runOnce({ recordingId: h.recording.id, config: CASCADE_CONFIG, deps: h.deps }),
    );

    expect(h.posted[0]!.annotations?.corpusVersion).toBeUndefined();
    expect(result.run.annotations?.corpusVersion).toBeUndefined();
  });

  it('a FAILED run carries it too — a failure is stored evidence like any other', async () => {
    const h = makeHarness({
      recording: { corpusVersion: CORPUS_VERSION },
      script: failingScript(),
    });

    const result = await drain(
      runOnce({ recordingId: h.recording.id, config: CASCADE_CONFIG, deps: h.deps }),
    );

    expect(result.run.status).toBe('failed');
    expect(h.posted).toHaveLength(1);
    expect(h.posted[0]!.annotations?.corpusVersion).toBe(CORPUS_VERSION);
  });
});

describe('ticket 033 — the sweep envelope carries BOTH annotations', () => {
  it('repIndex (028) and corpusVersion (033) ride the same envelope, neither clobbering the other', async () => {
    // createRunOnceExecutor spreads `run.annotations` before stamping repIndex,
    // so a corpusVersion written by runOnce must survive the wrapper.
    const h = makeHarness({ recording: { corpusVersion: CORPUS_VERSION } });
    const execute = createRunOnceExecutor(h.deps);

    const result = await drain(
      execute({
        recordingId: h.recording.id,
        configId: 'B',
        config: CASCADE_CONFIG,
        repIndex: 3,
        // TICKET 055a — the sweep's declared rep count rides the request beside
        // the executed one. Required, so no sweep path can forget the
        // denominator; the assertions below are unchanged.
        intendedReps: 5,
        attempt: 1,
        warmup: false,
        origin: 'sweep',
        signal: new AbortController().signal,
      }),
    );

    // TICKET 055a — a THIRD annotation now rides the same envelope (the sweep's
    // declared rep count), and the assertion is widened rather than loosened:
    // the corpusVersion runOnce wrote still has to survive the wrapper, which is
    // what this test is for.
    const expected = { repIndex: 3, corpusVersion: CORPUS_VERSION, intendedReps: 5 };
    expect(h.posted).toHaveLength(1);
    expect(h.posted[0]!.annotations).toEqual(expected);
    expect(h.posted[0]!.origin).toBe('sweep');
    expect(result.run.annotations).toEqual(expected);
  });
});
