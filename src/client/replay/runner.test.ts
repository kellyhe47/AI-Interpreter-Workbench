/**
 * Ticket 008 — runOnce acceptance tests.
 *
 * Everything runs on VIRTUAL time (vi.useFakeTimers + setSystemTime(0)): the
 * pacer and the fixture transport both schedule through the faked globals, so
 * a full second of 1x replay costs no real time.
 *
 * THE LOAD-BEARING TEST is `pacing`: it asserts the SCHEDULE, not the frame
 * count. An implementation that dumps the clip into the transport in one go
 * still yields 480-sample frames and a completed Run — and every latency
 * number it produces is fiction (PRD §7, §17 19d). Frame k must land at
 * ~k * 20 ms.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { DEFAULT_CASCADE_TRIPLE, REALTIME_MODEL, deriveArmTag } from '../../core/arms';
import { SAMPLE_RATE } from '../../core/protocol';
import { writeWav } from '../../harness/wav';
import { isRealRun, runArmTag, type Recording, type Run } from '../state/ledger';
import {
  FIXTURE_PROVIDERS,
  FixtureTransport,
  createReplayFixtureTransport,
  type FixtureScriptEvent,
} from '../transport/fixture';
import type { TransportConfig, TransportKind } from '../transport/types';
import { FRAME_MS, FRAME_SAMPLES } from './pacer';
import { ApiError, type RecordingsClient, type RunsClient } from './recordingsClient';
import { runOnce, type RunOnceConfig, type RunnerDeps } from './runner';

/** Distinct sample values, so frame content is falsifiable. */
const ramp = (n: number): Int16Array =>
  Int16Array.from({ length: n }, (_, i) => ((i * 7919) % 65536) - 32768);

const RECORDING: Recording = {
  id: 'rec-1',
  label: 'clip one',
  sourceLanguage: 'en',
  durationMs: 100,
  // Deliberately NOT where a waveform analysis of `ramp` would put it: the
  // clip is full-scale end to end, so any re-derivation lands near durationMs.
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

const REALTIME_CONFIG: RunOnceConfig = {
  architecture: 'realtime',
  realtimeModel: REALTIME_MODEL,
  languagePair: 'EN↔ES',
  direction: 'en→es',
  targetLanguage: 'Spanish',
};

/** A well-formed cascade utterance: partials -> final, deltas -> final, audio. */
function utteranceScript(): FixtureScriptEvent[] {
  return [
    { at: 10, type: 'sourceText', kind: 'partial', text: 'hel', utt: 0 },
    { at: 20, type: 'sourceText', kind: 'final', text: 'hello', utt: 0 },
    { at: 22, type: 'timing', event: 'vad_fired', utt: 0, t: 22, stage: 'stt' },
    { at: 24, type: 'timing', event: 'stt_final', utt: 0, t: 24, stage: 'stt' },
    { at: 26, type: 'targetText', kind: 'delta', text: 'ho', utt: 0 },
    { at: 26, type: 'timing', event: 'mt_first_token', utt: 0, t: 26, stage: 'mt' },
    { at: 28, type: 'timing', event: 'tts_first_byte', utt: 0, t: 28, stage: 'tts' },
    { at: 30, type: 'audio', pcm: ramp(240), utt: 0 },
    { at: 34, type: 'targetText', kind: 'final', text: 'hola', utt: 0 },
    { at: 40, type: 'audio', pcm: ramp(240), utt: 0 },
    { at: 90, type: 'utteranceComplete', record: { utt: 0 } },
  ];
}

interface HarnessOptions {
  recording?: Partial<Recording>;
  samples?: Int16Array;
  script?: FixtureScriptEvent[];
  kind?: TransportKind;
  /** Make GET /audio fail, i.e. an unplayable Recording. */
  audioError?: ApiError;
  /** Swap in the replay fixture transport (or anything else). */
  transportFactory?: (recording: Recording) => FixtureTransport;
}

function makeHarness(opts: HarnessOptions = {}) {
  const recording: Recording = { ...RECORDING, ...opts.recording };
  const samples = opts.samples ?? ramp(FRAME_SAMPLES * 5); // 5 frames / 100 ms
  const wav = writeWav(samples, SAMPLE_RATE);

  const getCalls: string[] = [];
  const audioCalls: string[] = [];
  const posted: Run[] = [];
  const transports: FixtureTransport[] = [];
  const transportConfigs: RunOnceConfig[] = [];
  const startConfigs: TransportConfig[] = [];
  /** Virtual time at which each paced frame reached the transport. */
  const sendTimes: number[] = [];
  let stops = 0;

  const recordings: RecordingsClient = {
    list: async () => [recording],
    get: async (id: string) => {
      getCalls.push(id);
      if (id !== recording.id) throw new ApiError('recording-not-found', 404, 'no such recording');
      return recording;
    },
    getAudio: async (id: string) => {
      audioCalls.push(id);
      if (opts.audioError) throw opts.audioError;
      return wav;
    },
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
  };

  const createTransport = (config: RunOnceConfig): FixtureTransport => {
    transportConfigs.push(config);
    const transport =
      opts.transportFactory?.(recording) ??
      new FixtureTransport({
        armId: 'fx',
        kind: opts.kind ?? (config.architecture === 'realtime' ? 'realtime' : 'cascade'),
        script: opts.script ?? utteranceScript(),
      });
    transports.push(transport);

    const send = transport.sendAudio.bind(transport);
    vi.spyOn(transport, 'sendAudio').mockImplementation((pcm: Int16Array) => {
      sendTimes.push(Date.now());
      send(pcm);
    });
    const start = transport.start.bind(transport);
    vi.spyOn(transport, 'start').mockImplementation(async (cfg: TransportConfig) => {
      startConfigs.push(cfg);
      await start(cfg);
    });
    const stop = transport.stop.bind(transport);
    vi.spyOn(transport, 'stop').mockImplementation(() => {
      stops++;
      stop();
    });
    return transport;
  };

  const deps: RunnerDeps = {
    recordings,
    runs,
    createTransport,
    now: () => Date.now(),
    newId: () => 'run-1',
  };

  return {
    recording,
    samples,
    deps,
    getCalls,
    audioCalls,
    posted,
    transports,
    transportConfigs,
    startConfigs,
    sendTimes,
    get stops() {
      return stops;
    },
  };
}

type Harness = ReturnType<typeof makeHarness>;

function start(h: Harness, config: RunOnceConfig = CASCADE_CONFIG, signal?: AbortSignal) {
  return runOnce({ recordingId: h.recording.id, config, deps: h.deps, signal });
}

let audioContextSpy: ReturnType<typeof vi.fn>;

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(0);
  // Nothing may autoplay: an AudioContext must never be constructed by a run.
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

describe('runOnce — pacing (the load-bearing criterion)', () => {
  it('feeds the transport 480-sample frames on the 20 ms schedule, not one buffer', async () => {
    const h = makeHarness({ samples: ramp(SAMPLE_RATE / 2) }); // 0.5 s => 25 frames
    const done = start(h);

    // A dump would already have delivered all 25 frames at virtual time 0.
    await vi.advanceTimersByTimeAsync(0);
    expect(h.sendTimes.length).toBe(1);
    await vi.advanceTimersByTimeAsync(FRAME_MS);
    expect(h.sendTimes.length).toBe(2);
    await vi.advanceTimersByTimeAsync(FRAME_MS * 3);
    expect(h.sendTimes.length).toBe(5);

    await vi.advanceTimersByTimeAsync(1000);
    await done;

    const frames = h.transports[0]!.received;
    expect(frames).toHaveLength(25);
    for (const frame of frames) expect(frame.length).toBe(FRAME_SAMPLES);
    // THE assertion: frame k arrived at ~k * 20 ms of wall clock.
    expect(h.sendTimes).toHaveLength(25);
    for (let k = 0; k < h.sendTimes.length; k++) {
      expect(Math.abs(h.sendTimes[k]! - k * FRAME_MS)).toBeLessThanOrEqual(1);
    }
    // ...and the last frame is a clip-length after the first, not ~0 ms.
    expect(h.sendTimes.at(-1)! - h.sendTimes[0]!).toBeGreaterThanOrEqual(24 * FRAME_MS - 1);
    // Sample content survives the framing, in order.
    const flat = frames.flatMap((f) => Array.from(f));
    expect(flat).toEqual(Array.from(h.samples));
  });

  it('fetches the recording audio exactly once per run', async () => {
    const h = makeHarness();
    const done = start(h);
    await vi.advanceTimersByTimeAsync(500);
    await done;
    expect(h.audioCalls).toEqual([h.recording.id]);
  });
});

// ---------------------------------------------------------------------------

describe('runOnce — the produced Run', () => {
  async function runHappy(h: Harness, config: RunOnceConfig = CASCADE_CONFIG) {
    const done = start(h, config);
    await vi.advanceTimersByTimeAsync(1000);
    return done;
  }

  it('carries recordingId, architecture, providerTriple, modelSnapshots, timings, transcripts, cost, createdAt', async () => {
    const h = makeHarness();
    const { run } = await runHappy(h);

    expect(run.id).toBe('run-1');
    expect(run.recordingId).toBe('rec-1');
    expect(run.architecture).toBe('cascade');
    expect(run.providerTriple).toEqual(DEFAULT_CASCADE_TRIPLE);
    // A cascade run's snapshot is its triple — the ledger reads model ids here.
    expect(run.modelSnapshots).toMatchObject({ ...DEFAULT_CASCADE_TRIPLE });
    expect(run.transcripts).toEqual({ source: 'hello', target: 'hola' });
    expect(typeof run.cost).toBe('number');
    expect(run.cost).toBeGreaterThanOrEqual(0);
    expect(typeof run.createdAt).toBe('number');
    expect(run.errors).toEqual([]);

    // Stage timings arrive from the transport's marks, verbatim.
    expect(run.timings).toMatchObject({
      vad_fired: 22,
      stt_final: 24,
      mt_first_token: 26,
      tts_first_byte: 28,
    });
    expect(typeof run.timings.speech_end).toBe('number');
    expect(typeof run.timings.audio_queued).toBe('number');

    // It is the same record that was POSTed and stored.
    expect(h.posted).toHaveLength(1);
    expect(h.posted[0]).toEqual(run);
  });

  it("origin is 'manual' and status is 'complete' on the happy path", async () => {
    const h = makeHarness();
    const { run } = await runHappy(h);
    expect(run.origin).toBe('manual');
    expect(run.status).toBe('complete');
    // The transport is shut down once the run is over.
    expect(h.stops).toBeGreaterThanOrEqual(1);
  });

  it('starts the transport with the run configuration', async () => {
    const h = makeHarness();
    await runHappy(h);
    expect(h.transportConfigs).toHaveLength(1);
    expect(h.transportConfigs[0]).toMatchObject({
      architecture: 'cascade',
      providers: DEFAULT_CASCADE_TRIPLE,
    });
    expect(h.startConfigs).toHaveLength(1);
    expect(h.startConfigs[0]).toMatchObject({
      languagePair: 'EN↔ES',
      direction: 'en→es',
      targetLanguage: 'Spanish',
      providers: DEFAULT_CASCADE_TRIPLE,
    });
  });

  const armCases: {
    label: string;
    config: RunOnceConfig;
    expected: 'A' | 'B' | 'C' | 'ad-hoc';
  }[] = [
    {
      label: "Arm B's triple with a bogus caller-supplied armTag 'A'",
      config: { ...CASCADE_CONFIG, armTag: 'A' },
      expected: 'B',
    },
    {
      label: "an off-arm triple with a caller-supplied armTag 'B'",
      config: {
        ...CASCADE_CONFIG,
        providers: { stt: 'gpt-4o-transcribe', mt: 'gpt-4o-mini', tts: 'eleven_multilingual_v2' },
        armTag: 'B',
      },
      expected: 'ad-hoc',
    },
    {
      label: "Arm C's triple, no caller tag at all",
      config: {
        ...CASCADE_CONFIG,
        providers: { stt: 'gpt-4o-transcribe', mt: 'gpt-4o-mini', tts: 'eleven_flash_v2_5' },
      },
      expected: 'C',
    },
  ];

  it.each(armCases)('armTag is DERIVED: $label -> $expected', async ({ config, expected }) => {
    const h = makeHarness();
    const { run } = await runHappy(h, config);
    expect(run.armTag).toBe(expected);
    expect(run.armTag).toBe(deriveArmTag(config));
    // The ledger re-derives from the record and must agree.
    expect(runArmTag(run)).toBe(expected);
  });
});

// ---------------------------------------------------------------------------

describe('runOnce — realtime model snapshot (Arm A must be reachable)', () => {
  it("a run configured with REALTIME_MODEL snapshots 'gpt-realtime' and derives Arm A", async () => {
    const h = makeHarness({ kind: 'realtime' });
    const done = start(h, REALTIME_CONFIG);
    await vi.advanceTimersByTimeAsync(1000);
    const { run } = await done;

    expect(run.architecture).toBe('realtime');
    expect(run.modelSnapshots.realtime).toBe('gpt-realtime');
    expect(run.armTag).toBe('A');
    expect(runArmTag(run)).toBe('A');
    // The model reaches the transport factory from the RUN CONFIG — the
    // transport's own 'gpt-realtime-mini' dev default is never relied on.
    expect(h.transportConfigs[0]).toMatchObject({ realtimeModel: REALTIME_MODEL });
  });

  it("the mini dev model snapshots verbatim and stays 'ad-hoc' (a cheap run is not evidence)", async () => {
    const h = makeHarness({ kind: 'realtime' });
    const done = start(h, { ...REALTIME_CONFIG, realtimeModel: 'gpt-realtime-mini' });
    await vi.advanceTimersByTimeAsync(1000);
    const { run } = await done;

    expect(run.modelSnapshots.realtime).toBe('gpt-realtime-mini');
    expect(run.armTag).toBe('ad-hoc');
  });
});

// ---------------------------------------------------------------------------

describe('runOnce — speech end comes from the Recording', () => {
  it('t0 is the Recording\'s speechEndMs, identical across two runs at different wall clocks', async () => {
    const first = makeHarness();
    const p1 = start(first);
    await vi.advanceTimersByTimeAsync(1000);
    const r1 = await p1;

    // A completely different wall clock for the second run.
    vi.setSystemTime(100_000);
    const second = makeHarness();
    const p2 = start(second);
    await vi.advanceTimersByTimeAsync(1000);
    const r2 = await p2;

    expect(r1.speechEndMs).toBe(RECORDING.speechEndMs);
    expect(r2.speechEndMs).toBe(RECORDING.speechEndMs);
    // Absolute anchors differ; the derived speech end offset does not.
    expect(r2.t0).not.toBe(r1.t0);
    expect(r1.run.timings.speech_end! - r1.t0).toBe(RECORDING.speechEndMs);
    expect(r2.run.timings.speech_end! - r2.t0).toBe(RECORDING.speechEndMs);
  });

  it('a transport-sent speech_end mark never overrides the Recording value', async () => {
    const script: FixtureScriptEvent[] = [
      ...utteranceScript(),
      { at: 12, type: 'timing', event: 'speech_end', utt: 0, t: 9999, stage: 'stt' },
    ];
    const h = makeHarness({ script });
    const done = start(h);
    await vi.advanceTimersByTimeAsync(1000);
    const result = await done;

    expect(result.run.timings.speech_end).not.toBe(9999);
    expect(result.run.timings.speech_end! - result.t0).toBe(RECORDING.speechEndMs);
  });

  it('a Recording whose speechEndMs contradicts its waveform still wins', async () => {
    // Full-scale samples throughout: any waveform re-derivation would land at
    // ~durationMs, not at the stored 25 ms.
    const h = makeHarness({
      samples: Int16Array.from({ length: FRAME_SAMPLES * 5 }, () => 32000),
      recording: { speechEndMs: 25 },
    });
    const done = start(h);
    await vi.advanceTimersByTimeAsync(1000);
    const result = await done;

    expect(result.speechEndMs).toBe(25);
    expect(result.run.timings.speech_end! - result.t0).toBe(25);
  });
});

// ---------------------------------------------------------------------------

describe('runOnce — nothing autoplays', () => {
  it('buffers the output audio, reports it ready, and never constructs an AudioContext', async () => {
    const h = makeHarness();
    const done = start(h);
    await vi.advanceTimersByTimeAsync(1000);
    const result = await done;

    expect(audioContextSpy).not.toHaveBeenCalled();
    expect(result.outputAudio).toBeInstanceOf(Int16Array);
    // Two 240-sample chunks from the script, concatenated in arrival order.
    expect(result.outputAudio.length).toBe(480);
    expect(Array.from(result.outputAudio.subarray(0, 240))).toEqual(Array.from(ramp(240)));
    expect(result.audioReady).toBe(true);
  });

  it('stamps audio_queued when the FIRST sample is decoded and queued', async () => {
    const h = makeHarness();
    const done = start(h);
    await vi.advanceTimersByTimeAsync(1000);
    const result = await done;

    // The script's first audio event is at 30 ms; the second at 40 ms.
    expect(result.run.timings.audio_queued! - result.t0).toBe(30);
  });
});

// ---------------------------------------------------------------------------

describe('runOnce — failure and cancellation', () => {
  it('a transport error mid-run yields status failed + the stage, is still POSTed, and resolves', async () => {
    const script: FixtureScriptEvent[] = [
      { at: 10, type: 'sourceText', kind: 'partial', text: 'hel', utt: 0 },
      { at: 30, type: 'error', message: 'TTS provider 503', opaque: false, stage: 'tts' },
    ];
    const h = makeHarness({ script });

    const done = start(h);
    await vi.advanceTimersByTimeAsync(1000);
    const result = await done; // resolves — never throws

    expect(result.run.status).toBe('failed');
    expect(result.run.errors.length).toBeGreaterThanOrEqual(1);
    const joined = result.run.errors.join(' | ');
    expect(joined).toContain('TTS provider 503');
    expect(joined).toContain('tts'); // the failing stage is recorded
    // Stored like any other run (PRD §12) — a failure is real information.
    expect(h.posted).toHaveLength(1);
    expect(h.posted[0]!.status).toBe('failed');
    expect(h.posted[0]).toEqual(result.run);
  });

  it('cancelling in flight stops pacing promptly and POSTs no complete Run', async () => {
    const h = makeHarness({ samples: ramp(SAMPLE_RATE) }); // 1 s => 50 frames
    const controller = new AbortController();
    const done = start(h, CASCADE_CONFIG, controller.signal);

    await vi.advanceTimersByTimeAsync(100); // 6 frames
    expect(h.sendTimes.length).toBe(6);

    controller.abort();
    await vi.advanceTimersByTimeAsync(40); // within two frame slots
    const afterCancel = h.sendTimes.length;
    expect(afterCancel).toBeLessThanOrEqual(7);

    await vi.advanceTimersByTimeAsync(2000);
    const result = await done;

    expect(h.sendTimes.length).toBe(afterCancel); // nothing leaked out later
    expect(result.cancelled).toBe(true);
    expect(h.posted.some((r) => r.status === 'complete')).toBe(false);
    expect(h.stops).toBeGreaterThanOrEqual(1);
  });

  it('an unplayable Recording blocks the run BEFORE it starts', async () => {
    const h = makeHarness({
      audioError: new ApiError('recording-audio-missing', 404, 'audio is gone'),
    });

    const err: unknown = await start(h).then(
      () => null,
      (e: unknown) => e,
    );
    await vi.advanceTimersByTimeAsync(1000);

    expect(err).toBeInstanceOf(ApiError);
    expect((err as ApiError).code).toBe('recording-audio-missing');
    // Nothing started: no transport, no frames, no Run row.
    expect(h.transports).toHaveLength(0);
    expect(h.startConfigs).toHaveLength(0);
    expect(h.sendTimes).toHaveLength(0);
    expect(h.posted).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------

describe('runOnce — a fixture-driven run can never become evidence', () => {
  it('a run through the replay fixture transport fails the ledger realness rule', async () => {
    const h = makeHarness({
      transportFactory: (recording) => createReplayFixtureTransport({ recording }),
    });
    const done = start(h, { ...CASCADE_CONFIG, providers: FIXTURE_PROVIDERS });
    await vi.advanceTimersByTimeAsync(5000);
    const { run } = await done;

    expect(run.status).toBe('complete');
    expect(isRealRun(run)).toBe(false);
  });

  it('the same run through real providers IS real (the rule is not vacuous)', async () => {
    const h = makeHarness();
    const done = start(h);
    await vi.advanceTimersByTimeAsync(1000);
    const { run } = await done;
    expect(isRealRun(run)).toBe(true);
  });
});
