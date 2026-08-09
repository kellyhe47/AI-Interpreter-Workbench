/**
 * A REAL `runOnce` EXECUTION, for the two cases whose subject is the Run RECORD
 * the write path produces (11 — direction; 12 — retained output audio).
 *
 * These cases cannot be satisfied by handing `makeRunEntity` the fields they
 * assert: the DSL sets `outputAudioPath` by default and the question is whether
 * the PRODUCT writes it. So the Run under assertion is the one
 * `src/client/replay/runner.ts` actually POSTs, produced through the same
 * injected seams `runner.test.ts` uses — a fixture transport, an in-memory
 * recordings/runs client, and the pacer's clock seams.
 *
 * Nothing here is a second fixture DSL: it is the transport/clients bag the
 * runner requires in order to run at all.
 */

import { vi } from 'vitest';

import { SAMPLE_RATE } from '../../src/core/protocol';
import { readWav, writeWav } from '../../src/harness/wav';
import { FRAME_SAMPLES } from '../../src/client/replay/pacer';
import { ApiError, type RecordingsClient, type RunsClient } from '../../src/client/replay/recordingsClient';
import { runOnce, type RunOnceConfig, type RunnerDeps } from '../../src/client/replay/runner';
import { FixtureTransport, type FixtureScriptEvent } from '../../src/client/transport/fixture';
import type { Recording, Run } from '../../src/client/state/ledger';

const clip = (n: number): Int16Array =>
  Int16Array.from({ length: n }, (_, i) => ((i * 7919) % 65536) - 32768);

export const EVAL_RECORDING: Recording = {
  id: 'rec_msjjjc0m001',
  label: 'eval clip',
  sourceLanguage: 'en',
  durationMs: 100,
  speechEndMs: 60,
  origin: 'mic',
  createdAt: 1_000,
};

/** One well-formed cascade utterance: partials → final, deltas → final, audio. */
export function utteranceScript(): FixtureScriptEvent[] {
  return [
    { at: 10, type: 'sourceText', kind: 'partial', text: 'hel', utt: 0 },
    { at: 20, type: 'sourceText', kind: 'final', text: 'hello', utt: 0 },
    { at: 22, type: 'timing', event: 'vad_fired', utt: 0, t: 22, stage: 'stt' },
    { at: 24, type: 'timing', event: 'stt_final', utt: 0, t: 24, stage: 'stt' },
    { at: 26, type: 'targetText', kind: 'delta', text: 'ho', utt: 0 },
    { at: 26, type: 'timing', event: 'mt_first_token', utt: 0, t: 26, stage: 'mt' },
    { at: 28, type: 'timing', event: 'tts_first_byte', utt: 0, t: 28, stage: 'tts' },
    { at: 30, type: 'audio', pcm: clip(240), utt: 0 },
    { at: 34, type: 'targetText', kind: 'final', text: 'hola', utt: 0 },
    { at: 40, type: 'audio', pcm: clip(240), utt: 0 },
    { at: 90, type: 'utteranceComplete', record: { utt: 0 } },
  ];
}

export interface ReplayHarnessOptions {
  recording?: Partial<Recording>;
  /** Distinguishes ids across two runs executed in one case. */
  idPrefix?: string;
  /** Make the output-audio upload report NOTHING, as a server that stored none would. */
  uploadReportsNothing?: boolean;
}

export function makeReplayHarness(opts: ReplayHarnessOptions = {}) {
  const recording: Recording = { ...EVAL_RECORDING, ...opts.recording };
  const samples = clip(FRAME_SAMPLES * 5);
  const wav = writeWav(samples, SAMPLE_RATE);
  const posted: Run[] = [];
  let ids = 0;

  const recordings: RecordingsClient = {
    list: async () => [recording],
    get: async (id: string) => {
      if (id !== recording.id) throw new ApiError('recording-not-found', 404, 'no such recording');
      return recording;
    },
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
    // TICKET 056 — THE FAKE STORE REFUSES WHAT THE REAL ONE WOULD REFUSE.
    //
    // Reporting a path unconditionally is what made case 12 unable to fail for
    // any AUDIO reason: the runner could hand this seam a 16 kHz file, a stereo
    // file or an empty buffer and the case would still count a playable pair.
    // That is the ticket's own criterion ("every stored .out.wav header reads
    // 24000 Hz, 1 channel, 16-bit, so blind compare cannot tell the arms apart
    // by format") going unchecked at the one gate that claims to check it.
    //
    // So the bytes are PARSED, exactly as `POST /api/runs/:id/audio` parses
    // them before writing. `readWav` already refuses non-PCM, non-mono and
    // non-16-bit; the sample RATE is the one thing it reports rather than
    // enforces, so it is asserted here against the single source of truth.
    // A throw here is not a harness crash: `uploadOutputAudio` catches it,
    // pushes the reason onto `run.errors` and leaves `outputAudioPath` unset —
    // which is precisely the shape the case's `must_include` already tests.
    uploadAudio: async (id: string, wavBytes: Uint8Array) => {
      if (opts.uploadReportsNothing) {
        return { id, outputAudioPath: undefined as unknown as string, bytes: 0 };
      }
      const { samples, rate } = readWav(wavBytes);
      if (rate !== SAMPLE_RATE) {
        throw new Error(`stored output audio is ${rate} Hz, not ${SAMPLE_RATE} Hz`);
      }
      if (samples.length === 0) {
        throw new Error('stored output audio is empty — an empty WAV is not a playable artifact');
      }
      return { id, outputAudioPath: `runs/${id}.out.wav`, bytes: wavBytes.length };
    },
  };

  const deps: RunnerDeps = {
    recordings,
    runs,
    createTransport: (config: RunOnceConfig) =>
      new FixtureTransport({
        armId: 'fx',
        kind: config.architecture === 'realtime' ? 'realtime' : 'cascade',
        script: utteranceScript(),
      }),
    now: () => Date.now(),
    newId: () => `${opts.idPrefix ?? 'run-eval'}-${(ids += 1)}`,
  };

  return { recording, deps, posted };
}

/**
 * Executes one real run under fake timers (the pacer paces at 1x wall clock;
 * a real 100 ms clip would still cost 100 ms of suite time per case, and the
 * fixture script's `at` offsets are virtual).
 */
export async function runRealOnce(
  config: RunOnceConfig,
  opts: ReplayHarnessOptions = {},
): Promise<Run> {
  const harness = makeReplayHarness(opts);
  vi.useFakeTimers();
  try {
    const promise = runOnce({ recordingId: harness.recording.id, config, deps: harness.deps });
    await vi.runAllTimersAsync();
    const result = await promise;
    return result.run;
  } finally {
    vi.useRealTimers();
  }
}
