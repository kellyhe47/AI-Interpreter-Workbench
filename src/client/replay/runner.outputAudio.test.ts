/**
 * TICKET 045 — runOnce must UPLOAD the output audio it already computes.
 *
 * The read path (GET /api/runs/:id/audio, RunsList's play control) has existed
 * since ticket 003/013; the write path never did, so every real run's play
 * button 404s. These tests pin the write path at the runner seam.
 *
 * ORDER IS LOAD-BEARING: the audio is uploaded FIRST and the Run is POSTed
 * SECOND, carrying the `outputAudioPath` the upload reported. The ledger is
 * append-only and there is no PATCH for a Run, so a Run POSTed before the
 * upload could never be corrected when the upload failed — it would sit in the
 * history promising audio that does not exist, and the play control (which
 * gates on exactly that field, ticket 045's RunsList change) would offer a
 * button that 404s. Uploading first makes `outputAudioPath` a REPORT rather
 * than a PROMISE.
 *
 * NOTE ON THE TICKET: 045's first acceptance criterion says the audio is
 * uploaded "after the Run is POSTed". That ordering cannot satisfy the ticket's
 * own later criteria (an upload failure must not leave a Run misdescribing
 * itself, and the play control must gate on audio actually existing), so it is
 * inverted here deliberately.
 *
 * SCOPE IS CASCADE — the `onAudio` path. Arm A's audio arrives on the WebRTC
 * media track and never reaches `onAudio` at all; ticket 046 captures it through
 * a separate transport seam (`takeOutputAudio`) and is pinned in
 * replayArmA.test.ts. Nothing here fakes that seam, so the "produced no audio"
 * case below stays what it always was: a transport that yielded no samples by
 * EITHER route uploads nothing.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { DEFAULT_CASCADE_TRIPLE } from '../../core/arms';
import { SAMPLE_RATE } from '../../core/protocol';
import { readWav, writeWav } from '../../harness/wav';
import type { Recording, Run } from '../state/ledger';
import { FixtureTransport, type FixtureScriptEvent } from '../transport/fixture';
import { FRAME_SAMPLES } from './pacer';
import type { RecordingsClient, RunAudioUpload, RunsClient } from './recordingsClient';
import {
  CAPTURE_GATE_NEVER_OPENED,
  runOnce,
  type RunOnceConfig,
  type RunnerDeps,
} from './runner';

const ramp = (n: number): Int16Array =>
  Int16Array.from({ length: n }, (_, i) => ((i * 7919) % 65536) - 32768);

const RECORDING: Recording = {
  id: 'rec-1',
  label: 'clip one',
  sourceLanguage: 'en',
  durationMs: 100,
  speechEndMs: 60,
  origin: 'mic',
  createdAt: 1_000,
};

const CASCADE_CONFIG: RunOnceConfig = {
  architecture: 'cascade',
  providers: DEFAULT_CASCADE_TRIPLE,
  languagePair: 'EN↔ES',
  direction: 'en→es',
  targetLanguage: 'Spanish',
};

/** Two output chunks — enough that concatenation order is falsifiable. */
const CHUNK_A = ramp(240);
const CHUNK_B = Int16Array.from(ramp(240), (v) => -v);

function scriptWithAudio(): FixtureScriptEvent[] {
  return [
    { at: 20, type: 'sourceText', kind: 'final', text: 'hello', utt: 0 },
    { at: 30, type: 'audio', pcm: CHUNK_A, utt: 0 },
    { at: 34, type: 'targetText', kind: 'final', text: 'hola', utt: 0 },
    { at: 40, type: 'audio', pcm: CHUNK_B, utt: 0 },
    { at: 90, type: 'utteranceComplete', record: { utt: 0 } },
  ];
}

/** A cascade run that loses its TTS stage AFTER emitting one chunk. */
function scriptFailingAfterAudio(): FixtureScriptEvent[] {
  return [
    { at: 20, type: 'sourceText', kind: 'final', text: 'hello', utt: 0 },
    { at: 30, type: 'audio', pcm: CHUNK_A, utt: 0 },
    { at: 40, type: 'error', message: 'stage timed out', opaque: false, stage: 'tts' },
  ];
}

/** A run that produced no output audio at all — today's Arm A shape. */
function scriptWithoutAudio(): FixtureScriptEvent[] {
  return [
    { at: 20, type: 'sourceText', kind: 'final', text: 'hello', utt: 0 },
    { at: 34, type: 'targetText', kind: 'final', text: 'hola', utt: 0 },
    { at: 90, type: 'utteranceComplete', record: { utt: 0 } },
  ];
}

interface HarnessOptions {
  script?: FixtureScriptEvent[];
  /** Make the upload endpoint reject. */
  uploadError?: Error;
  /**
   * ROUND 2 (R2-6) — give the transport a ticket-046 capture path TOO, so the
   * runner's `audioChunks.length === 0` fallback condition has something to be
   * wrong about. The reviewer replaced that condition with `if (true)` and the
   * whole suite stayed green: no test ever gave a transport BOTH routes.
   */
  capturedOutput?: Int16Array;
  /** ROUND 4 (R4-2) — how the transport's teardown fails, if at all. */
  stopFails?: 'throw' | 'reject';
}

/** Everything cascade's data-channel path is plus a 046-style media tap. */
class DualSourceTransport extends FixtureTransport {
  constructor(
    opts: ConstructorParameters<typeof FixtureTransport>[0],
    private readonly captured: Int16Array,
  ) {
    super(opts);
  }
  takeOutputAudio(): Int16Array {
    return this.captured;
  }
}

/** A marker no cascade chunk contains, so its presence is unambiguous. */
const TAP_SAMPLES = Int16Array.from([31_001, -31_002, 31_003]);

/**
 * ROUND 4 (R4-2) — a transport whose teardown fails, in each of the two shapes.
 *
 * `closeTransport` guards a close that REJECTS (`.catch`) and a close that HANGS
 * (the race), but the CALL `transport.stop()` is evaluated at the call site,
 * outside both. A close that throws SYNCHRONOUSLY — a mock, an older or patched
 * implementation, an AudioContext method that throws on a closed device —
 * therefore rejects `runOnce`, stores no Run and loses the measurement: exactly
 * the trade the surrounding comments refuse twice.
 */
class FailingStopTransport extends FixtureTransport {
  constructor(
    opts: ConstructorParameters<typeof FixtureTransport>[0],
    private readonly mode: 'throw' | 'reject',
  ) {
    super(opts);
  }
  override stop(): void | Promise<void> {
    super.stop();
    if (this.mode === 'throw') throw new Error('AudioContext.close threw');
    return Promise.reject(new Error('AudioContext.close rejected'));
  }
}

function makeHarness(opts: HarnessOptions = {}) {
  const wav = writeWav(ramp(FRAME_SAMPLES * 5), SAMPLE_RATE);
  /** Every mutating client call, in order — this is how ordering is pinned. */
  const calls: string[] = [];
  const uploads: { id: string; wav: Uint8Array }[] = [];
  const posted: Run[] = [];

  const recordings: RecordingsClient = {
    list: async () => [RECORDING],
    get: async () => RECORDING,
    getAudio: async () => wav,
    create: async () => RECORDING,
    patchLabel: async () => RECORDING,
    remove: async () => RECORDING,
  };

  const runs: RunsClient = {
    create: async (run: Run) => {
      calls.push('create');
      posted.push(run);
      return run;
    },
    list: async () => posted,
    getAudio: async () => new Uint8Array(0),
    uploadAudio: async (id: string, wavBytes: Uint8Array): Promise<RunAudioUpload> => {
      calls.push('uploadAudio');
      if (opts.uploadError) throw opts.uploadError;
      uploads.push({ id, wav: wavBytes });
      return { id, outputAudioPath: `runs/${id}.out.wav`, bytes: wavBytes.length };
    },
  };

  const deps: RunnerDeps = {
    recordings,
    runs,
    createTransport: () => {
      const transportOpts = {
        armId: 'fx',
        kind: 'cascade' as const,
        script: opts.script ?? scriptWithAudio(),
      };
      if (opts.stopFails !== undefined) {
        return new FailingStopTransport(transportOpts, opts.stopFails);
      }
      return opts.capturedOutput === undefined
        ? new FixtureTransport(transportOpts)
        : new DualSourceTransport(transportOpts, opts.capturedOutput);
    },
    now: () => Date.now(),
    newId: () => 'run-1',
  };

  return { deps, calls, uploads, posted };
}

type Harness = ReturnType<typeof makeHarness>;

function start(h: Harness, signal?: AbortSignal) {
  return runOnce({ recordingId: RECORDING.id, config: CASCADE_CONFIG, deps: h.deps, signal });
}

let audioContextSpy: ReturnType<typeof vi.fn>;

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(0);
  audioContextSpy = vi.fn();
  (globalThis as Record<string, unknown>).AudioContext = audioContextSpy;
  (globalThis as Record<string, unknown>).webkitAudioContext = audioContextSpy;
});

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  delete (globalThis as Record<string, unknown>).AudioContext;
  delete (globalThis as Record<string, unknown>).webkitAudioContext;
});

// ---------------------------------------------------------------------------

describe('runOnce — the output audio is UPLOADED, not merely returned', () => {
  it('uploads a 24 kHz mono PCM16 WAV of exactly the buffered output, before POSTing the Run', async () => {
    const h = makeHarness();
    const done = start(h);
    await vi.advanceTimersByTimeAsync(1000);
    const result = await done;

    expect(h.uploads).toHaveLength(1);
    expect(h.uploads[0]!.id).toBe(result.run.id);
    // Upload FIRST, POST SECOND — see the header.
    expect(h.calls).toEqual(['uploadAudio', 'create']);

    const decoded = readWav(h.uploads[0]!.wav);
    expect(decoded.rate).toBe(SAMPLE_RATE);
    expect(SAMPLE_RATE).toBe(24_000);
    // The exact samples the run buffered, in arrival order — mono PCM16.
    expect(Array.from(decoded.samples)).toEqual(Array.from(result.outputAudio));
    expect(Array.from(decoded.samples)).toEqual([...CHUNK_A, ...CHUNK_B]);
    expect(result.audioReady).toBe(true);

    // Nothing sounded: uploading is not playing.
    expect(audioContextSpy).not.toHaveBeenCalled();
  });

  it('the POSTed Run carries the reported outputAudioPath and NO audio bytes', async () => {
    const h = makeHarness();
    const done = start(h);
    await vi.advanceTimersByTimeAsync(1000);
    const result = await done;

    const run = h.posted[0]!;
    // The path is the value the SERVER reported, not one the client invented.
    expect(run.outputAudioPath).toBe(`runs/${run.id}.out.wav`);
    expect(result.run.outputAudioPath).toBe(run.outputAudioPath);

    // ...and the record itself stays a metadata record. `appendRun` writes this
    // whole object as ONE LINE of the append-only ledger.
    const serialized = JSON.stringify(run);
    expect(serialized.length).toBeLessThan(2048);
    const audioBase64 = btoa(
      String.fromCharCode(...new Uint8Array(h.uploads[0]!.wav.subarray(0, 96))),
    );
    expect(serialized).not.toContain(audioBase64.slice(0, 64));
  });

  it('a CANCELLED run uploads nothing and POSTs nothing', async () => {
    const h = makeHarness();
    const controller = new AbortController();
    const done = start(h, controller.signal);
    await vi.advanceTimersByTimeAsync(40);
    controller.abort();
    await vi.advanceTimersByTimeAsync(1000);
    const result = await done;

    expect(result.cancelled).toBe(true);
    expect(h.calls).toEqual([]);
    expect(h.uploads).toEqual([]);
    expect(h.posted).toEqual([]);
  });

  it('a FAILED run still uploads the audio it produced — partial audio is diagnostic', async () => {
    const h = makeHarness({ script: scriptFailingAfterAudio() });
    const done = start(h);
    await vi.advanceTimersByTimeAsync(1000);
    const result = await done;

    expect(result.run.status).toBe('failed');
    expect(h.calls).toEqual(['uploadAudio', 'create']);
    expect(Array.from(readWav(h.uploads[0]!.wav).samples)).toEqual(Array.from(CHUNK_A));
    expect(h.posted[0]!.outputAudioPath).toBe(`runs/${result.run.id}.out.wav`);
  });

  it('a run that produced NO audio uploads nothing and claims no outputAudioPath', async () => {
    const h = makeHarness({ script: scriptWithoutAudio() });
    const done = start(h);
    await vi.advanceTimersByTimeAsync(1000);
    const result = await done;

    expect(result.audioReady).toBe(false);
    // No empty upload: an empty runs/<id>.out.wav would make GET /audio answer
    // 200-with-silence instead of the honest 404.
    expect(h.calls).toEqual(['create']);
    expect(h.uploads).toEqual([]);
    expect(h.posted[0]!.outputAudioPath).toBeUndefined();
    expect(result.run.outputAudioPath).toBeUndefined();

    // ROUND 3 (R3-7) — and NO capture diagnostic. Cascade has no capture path at
    // all, so `outputAudioStats()` is absent rather than `{ 0, 0 }`: ABSENT is
    // not a symptom. A runner that read a missing seam as "saw a track, admitted
    // nothing" would stamp this line on every cascade run that fell silent.
    expect(result.run.errors.some((e) => e.startsWith(CAPTURE_GATE_NEVER_OPENED))).toBe(false);
    expect(result.run.errors).toEqual([]);
  });

  it('a DECODED sample always wins: a transport with both routes uploads only onAudio (R2-6)', async () => {
    // TICKET 046's capture is a FALLBACK for the arm whose audio never reaches
    // `onAudio` at all. `runner.ts`'s `audioChunks.length === 0` guard is what
    // makes that true, and it was unpinned: replacing it with `if (true)` left
    // the suite green, because no test ever handed a transport BOTH routes.
    // Cascade must stay byte-for-byte what it was.
    const h = makeHarness({ capturedOutput: TAP_SAMPLES });
    const done = start(h);
    await vi.advanceTimersByTimeAsync(1000);
    const result = await done;

    expect(Array.from(result.outputAudio)).toEqual([...CHUNK_A, ...CHUNK_B]);
    const uploaded = Array.from(readWav(h.uploads[0]!.wav).samples);
    expect(uploaded).toEqual([...CHUNK_A, ...CHUNK_B]);
    for (const marker of TAP_SAMPLES) expect(uploaded).not.toContain(marker);
  });

  it('the fallback is REACHED when the data channel produced nothing (R2-6, control)', async () => {
    // The mirror of the test above: same transport shape, same tap samples, and
    // the ONLY difference is that no `onAudio` chunk arrived. If this were to
    // fail, the guard above would be passing by being unreachable.
    const h = makeHarness({ script: scriptWithoutAudio(), capturedOutput: TAP_SAMPLES });
    const done = start(h);
    await vi.advanceTimersByTimeAsync(1000);
    const result = await done;

    expect(Array.from(result.outputAudio)).toEqual(Array.from(TAP_SAMPLES));
    expect(Array.from(readWav(h.uploads[0]!.wav).samples)).toEqual(Array.from(TAP_SAMPLES));
  });

  it('a transport whose stop() THROWS SYNCHRONOUSLY still stores the run (round 4, R4-2)', async () => {
    // `closeTransport` guards a rejecting close and a hanging one, but the CALL
    // is outside both guards, so a synchronous throw propagates straight out of
    // `runOnce` — no Run POSTed, no audio uploaded, the measurement gone. That is
    // the trade the comments around it refuse twice: giving up on a CONTEXT must
    // never cost the RUN.
    const h = makeHarness({ stopFails: 'throw' });
    const done = start(h);
    await vi.advanceTimersByTimeAsync(1000);
    // runOnce RESOLVES — it does not reject.
    const result = await done;

    expect(result.run.status).toBe('complete');
    // The measurement survived intact...
    expect(result.run.timings.audio_queued).not.toBeNull();
    // ...and so did everything downstream of the close.
    expect(h.calls).toEqual(['uploadAudio', 'create']);
    expect(Array.from(readWav(h.uploads[0]!.wav).samples)).toEqual([...CHUNK_A, ...CHUNK_B]);
    expect(h.posted).toHaveLength(1);
    expect(result.run.outputAudioPath).toBe(`runs/${result.run.id}.out.wav`);
  });

  it('a transport whose stop() REJECTS is already safe — the other half of the same guard', async () => {
    // The companion, and the reason the two are different code paths: a rejected
    // promise is caught inside `closeTransport`, a synchronous throw never
    // reaches it. Both must end the same way.
    const h = makeHarness({ stopFails: 'reject' });
    const done = start(h);
    await vi.advanceTimersByTimeAsync(1000);
    const result = await done;

    expect(result.run.status).toBe('complete');
    expect(h.calls).toEqual(['uploadAudio', 'create']);
    expect(result.run.outputAudioPath).toBe(`runs/${result.run.id}.out.wav`);
    // A close that failed is not the run's business: it says nothing about it.
    expect(result.run.errors).toEqual([]);
  });

  it('an upload failure does NOT fail the Run — the measurement is still recorded', async () => {
    const h = makeHarness({ uploadError: new Error('HTTP 500') });
    const done = start(h);
    await vi.advanceTimersByTimeAsync(1000);
    // runOnce RESOLVES: the measurement is the valuable artifact.
    const result = await done;

    expect(h.calls).toEqual(['uploadAudio', 'create']);
    expect(h.posted).toHaveLength(1);
    // Still a complete run — the pipeline did its job; the store did not.
    expect(result.run.status).toBe('complete');
    // ...and it does NOT claim audio that is not there, so the play control
    // stays absent rather than offering a button that 404s.
    expect(result.run.outputAudioPath).toBeUndefined();
    // The failure is SURFACED rather than swallowed: it rides the run's own
    // errors into the append-only ledger.
    expect(result.run.errors.some((e) => e.startsWith('output audio upload failed'))).toBe(true);
    expect(h.posted[0]!.errors).toEqual(result.run.errors);
    // The audio is still in hand for this session, even though the store lost it.
    expect(result.audioReady).toBe(true);
  });
});
