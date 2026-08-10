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
import type { CorpusUtterance } from '../../core/corpus';
import { ENDPOINTING_MS, SAMPLE_RATE } from '../../core/protocol';
import { writeWav } from '../../harness/wav';
import {
  isAggregatableRun,
  isAggregatableUtterance,
  isRealRun,
  runArmTag,
  runSamples,
  type Recording,
  type Run,
  type RunUtterance,
} from '../state/ledger';
import {
  FIXTURE_PROVIDERS,
  FixtureTransport,
  createReplayFixtureTransport,
  type FixtureScriptEvent,
} from '../transport/fixture';
import type { TransportConfig, TransportKind } from '../transport/types';
import { FRAME_MS, FRAME_SAMPLES } from './pacer';
import { ApiError, type RecordingsClient, type RunsClient } from './recordingsClient';
import {
  RUN_COMPLETION_TIMED_OUT,
  RUN_COMPLETION_TIMEOUT_MS,
  SEGMENTATION_IDLE_MS,
  SEGMENTATION_SETTLE_MS,
  TRAILING_PAD_MS,
  abandonedRunStub,
  runOnce,
  type RunOnceConfig,
  type RunnerDeps,
} from './runner';

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
    // TICKET 045 — the output-audio upload seam; these suites produce no assertions on it.
    uploadAudio: async (id: string) => ({ id, outputAudioPath: `runs/${id}.out.wav`, bytes: 0 }),
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
    // The trailing pad (see runner.ts TRAILING_PAD_MS) is paced in REAL time,
    // so leaving production's 1.5 s on for every case in this file would add
    // minutes of sleep to the suite. It is switched OFF here and asserted
    // explicitly, with the seam omitted, in the pad's own describe block —
    // where the DEFAULT is what is under test rather than ambient.
    trailingPadMs: 0,
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
    // TICKET 052 — the fixture transport declares no rate, so the run's cost is
    // NOT MEASURED. `null`, never 0: a 0 would report the run as free.
    expect(run.cost).toBeNull();
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

// ---------------------------------------------------------------------------
// TICKET 031 — per-utterance measurement.
//
// A PRD §9 corpus Recording is a <=45 s take holding ~4 utterances of
// deliberately DIFFERENT categories, so one Recording is not one utterance.
// The measured atom is the utterance; the Run is the container that produced a
// set of them. Every transport event already carries `utt` — the runner must
// BUCKET by it, never flatten.
//
// The load-bearing rules pinned below:
//  - each utterance's speech_end is t0 + manifest[i].trueSpeechEndMs, from the
//    MANIFEST, never the Recording-level speechEndMs and never VAD;
//  - a segmentation count that disagrees with the manifest is a RUN-LEVEL
//    failure with a named reason and NO partial attribution.
// ---------------------------------------------------------------------------

/**
 * The manifest is deliberately supplied OUT of array order: `CorpusUtterance.index`
 * carries the ordering (see core/corpus.ts), the array position does not.
 */
/**
 * TICKET 055b — THE ANCHORS MOVED, AND THE FIXTURE IS WHY.
 *
 * They were 200 / 400 / 600 / 800 against a script whose answers sound at
 * 130 / 230 / 330 / 430, i.e. EVERY utterance of this fixture answered before
 * its own speech had ended (−70 / −170 / −270 / −370 ms). That is the same
 * physically impossible pairing run 7acb0cc9 stored, so the fixture could not
 * be used to state the rule that forbids it. Lowering the anchors by 100 ms
 * each puts every answer 30 ms AFTER its anchor and moves nothing else: the
 * out-of-index order below, the distinctness of the four, and their disagreement
 * with `CORPUS_RECORDING.speechEndMs` are all preserved.
 */
const MANIFEST: CorpusUtterance[] = [
  { id: 'u-2', index: 2, category: 'numbers-dates', trueSpeechEndMs: 200, referenceText: 'two' },
  { id: 'u-1', index: 1, category: 'short-reply', trueSpeechEndMs: 100, referenceText: 'one' },
  { id: 'u-4', index: 4, category: 'disfluency', trueSpeechEndMs: 400 },
  { id: 'u-3', index: 3, category: 'long-compound', trueSpeechEndMs: 300, referenceText: 'three' },
];

/** 60 USD/min over a 1000 ms clip => a Run cost of exactly 1, easy to split. */
const CORPUS_COST_PER_MIN = 60;

/**
 * A corpus Recording. `speechEndMs` (900) matches NO manifest entry, so any
 * utterance anchored on the Recording instead of on its own manifest offset is
 * caught by the anchoring assertions rather than passing by coincidence.
 */
const CORPUS_RECORDING: Partial<Recording> = {
  origin: 'corpus',
  durationMs: 1000,
  speechEndMs: 900,
  utterances: MANIFEST,
  corpusVersion: 'corpus-v1',
};

interface CorpusScriptOptions {
  /** How many utterances the TRANSPORT segments the clip into. */
  count?: number;
  /** These utts emit no output audio at all. */
  silentUtts?: number[];
  /** Gap between consecutive utterance answers. Default 100 ms. */
  stepMs?: number;
  extra?: FixtureScriptEvent[];
}

/** Utterance u answers on the [100 + step*u, 150 + step*u] ms window. */
function corpusScript(opts: CorpusScriptOptions = {}): FixtureScriptEvent[] {
  const count = opts.count ?? 4;
  const step = opts.stepMs ?? 100;
  const silent = new Set(opts.silentUtts ?? []);
  const events: FixtureScriptEvent[] = [];
  for (let utt = 0; utt < count; utt++) {
    const base = 100 + utt * step;
    events.push(
      { at: base, type: 'sourceText', kind: 'partial', text: `src ${utt} partial`, utt },
      { at: base + 5, type: 'sourceText', kind: 'final', text: `src ${utt}`, utt },
      { at: base + 10, type: 'timing', event: 'stt_final', utt, t: base + 10, stage: 'stt' },
      { at: base + 20, type: 'timing', event: 'tts_first_byte', utt, t: base + 20, stage: 'tts' },
      { at: base + 25, type: 'targetText', kind: 'final', text: `tgt ${utt}`, utt },
      { at: base + 50, type: 'utteranceComplete', record: { utt } },
    );
    if (!silent.has(utt)) {
      events.push(
        { at: base + 30, type: 'audio', pcm: ramp(240), utt },
        { at: base + 40, type: 'audio', pcm: ramp(240), utt },
      );
    }
  }
  return [...events, ...(opts.extra ?? [])];
}

function corpusHarness(opts: CorpusScriptOptions & { recording?: Partial<Recording> } = {}) {
  const script = corpusScript(opts);
  return makeHarness({
    recording: { ...CORPUS_RECORDING, ...opts.recording },
    transportFactory: () =>
      new FixtureTransport({
        armId: 'fx',
        kind: 'cascade',
        script,
        costPerMinUsd: CORPUS_COST_PER_MIN,
      }),
  });
}

/** Runs to completion on virtual time; every corpus script settles well inside 2 s. */
async function runCorpus(h: Harness) {
  const done = start(h);
  await vi.advanceTimersByTimeAsync(2000);
  return done;
}

function utterancesOf(run: Run): RunUtterance[] {
  expect(run.utterances).toBeDefined();
  return run.utterances!;
}

// ---------------------------------------------------------------------------

describe('runOnce — a Run is a container of utterance records (ticket 031)', () => {
  it('a 4-utterance Recording produces 4 RunUtterances in MANIFEST order, not array order', async () => {
    const h = corpusHarness();
    const { run } = await runCorpus(h);

    const utterances = utterancesOf(run);
    expect(utterances).toHaveLength(4);
    expect(utterances.map((u) => u.index)).toEqual([1, 2, 3, 4]);
    expect(utterances.map((u) => u.utteranceId)).toEqual(['u-1', 'u-2', 'u-3', 'u-4']);
    expect(utterances.map((u) => u.category)).toEqual([
      'short-reply',
      'numbers-dates',
      'long-compound',
      'disfluency',
    ]);
    // The container is what gets POSTed, records and all.
    expect(h.posted).toHaveLength(1);
    expect(h.posted[0]!.utterances).toEqual(utterances);
  });

  it('the run does NOT end at the first utterance boundary — all four are measured', async () => {
    const h = corpusHarness();
    const { run } = await runCorpus(h);
    // Pre-031 the run finished at utt 0's completion (150 ms) and utterances
    // 2..4 were never delivered at all.
    expect(run.status).toBe('complete');
    expect(utterancesOf(run)).toHaveLength(4);
    expect(utterancesOf(run)[3]!.transcripts.target).toBe('tgt 3');
  });
});

// ---------------------------------------------------------------------------

describe('runOnce — per-utterance anchoring comes from the MANIFEST (ticket 031)', () => {
  const anchorCases = [
    { index: 1, utteranceId: 'u-1', trueSpeechEndMs: 100 },
    { index: 2, utteranceId: 'u-2', trueSpeechEndMs: 200 },
    { index: 3, utteranceId: 'u-3', trueSpeechEndMs: 300 },
    { index: 4, utteranceId: 'u-4', trueSpeechEndMs: 400 },
  ];

  it.each(anchorCases)(
    'utterance $index ($utteranceId) speech_end is t0 + $trueSpeechEndMs',
    async ({ index, trueSpeechEndMs }) => {
      const h = corpusHarness();
      const { run, t0 } = await runCorpus(h);

      const utterance = utterancesOf(run).find((u) => u.index === index)!;
      expect(utterance.timings.speech_end).toBe(t0 + trueSpeechEndMs);
      // The mutation check the ticket calls for: the Recording-level anchor
      // (900) must NEVER be what an utterance reports.
      expect(utterance.timings.speech_end).not.toBe(t0 + CORPUS_RECORDING.speechEndMs!);
    },
  );

  it('every utterance has a DISTINCT anchor — none of them share the Recording anchor', async () => {
    const h = corpusHarness();
    const { run, t0 } = await runCorpus(h);
    const anchors = utterancesOf(run).map((u) => u.timings.speech_end);
    expect(anchors).toEqual([t0 + 100, t0 + 200, t0 + 300, t0 + 400]);
    expect(new Set(anchors).size).toBe(4);
  });

  it('a transport-sent speech_end is STILL discarded, per utterance and run-wide', async () => {
    const h = corpusHarness({
      extra: [
        { at: 130, type: 'timing', event: 'speech_end', utt: 0, t: 9999, stage: 'stt' },
        { at: 230, type: 'timing', event: 'speech_end', utt: 1, t: 8888, stage: 'stt' },
      ],
    });
    const { run, t0 } = await runCorpus(h);

    const utterances = utterancesOf(run);
    expect(utterances[0]!.timings.speech_end).toBe(t0 + 100);
    expect(utterances[1]!.timings.speech_end).toBe(t0 + 200);
    // TICKET 055b — run-wide too, and the run-wide anchor is now the LAST
    // record's (the envelope speaks for one utterance). 9999 and 8888 are
    // neither, which is what this test is about.
    expect(run.timings.speech_end).toBe(t0 + 400);
    expect(run.timings.speech_end).not.toBe(9999);
    expect(run.timings.speech_end).not.toBe(8888);
  });
});

// ---------------------------------------------------------------------------

describe('runOnce — marks and audio are BUCKETED by utt, never flattened (ticket 031)', () => {
  it("utterance 1's stt_final survives utterance 2 arriving", async () => {
    const h = corpusHarness();
    const { run } = await runCorpus(h);

    const utterances = utterancesOf(run);
    expect(utterances.map((u) => u.timings.stt_final)).toEqual([110, 210, 310, 410]);
    expect(utterances.map((u) => u.timings.tts_first_byte)).toEqual([120, 220, 320, 420]);
    // Four distinct values where the pre-031 flat map held exactly one.
    expect(new Set(utterances.map((u) => u.timings.stt_final)).size).toBe(4);
  });

  it("audio_queued is PER UTTERANCE — utterance 2 never reports utterance 1's first audio", async () => {
    const h = corpusHarness();
    const { run, t0 } = await runCorpus(h);

    const queued = utterancesOf(run).map((u) => u.timings.audio_queued);
    expect(queued).toEqual([t0 + 130, t0 + 230, t0 + 330, t0 + 430]);
    expect(queued[1]).not.toBe(queued[0]);
  });

  it('transcripts are per utterance (final wins, exactly as at run level)', async () => {
    const h = corpusHarness();
    const { run } = await runCorpus(h);

    expect(utterancesOf(run).map((u) => u.transcripts)).toEqual([
      { source: 'src 0', target: 'tgt 0' },
      { source: 'src 1', target: 'tgt 1' },
      { source: 'src 2', target: 'tgt 2' },
      { source: 'src 3', target: 'tgt 3' },
    ]);
  });

  it('an utterance that produced no output audio is status failed with a null audio_queued', async () => {
    const h = corpusHarness({ silentUtts: [2] });
    const { run } = await runCorpus(h);

    const utterances = utterancesOf(run);
    expect(utterances[2]!.timings.audio_queued).toBeNull();
    expect(utterances[2]!.status).toBe('failed');
    expect(utterances[2]!.errors).toEqual(['no output audio']);
    // Its neighbours are untouched, and the RUN itself is complete: the
    // segmentation agreed with the manifest and no stage was lost.
    expect(utterances.map((u) => u.status)).toEqual([
      'complete',
      'complete',
      'failed',
      'complete',
    ]);
    expect(utterances[1]!.errors).toEqual([]);
    expect(run.status).toBe('complete');
  });
});

// ---------------------------------------------------------------------------

describe('runOnce — per-utterance cost (ticket 031)', () => {
  it('splits the Run cost across the manifest spans and sums back to it exactly', async () => {
    const h = corpusHarness();
    const { run } = await runCorpus(h);

    // Spans: 0->100, 100->200, 200->300, 300->1000 (the last absorbs the tail).
    // At 60 USD/min that is 0.1 / 0.1 / 0.1 / 0.7 of a minute-second each.
    const expected = [0.1, 0.1, 0.1, 0.7];
    const utterances = utterancesOf(run);
    utterances.forEach((u, i) => expect(u.cost).toBeCloseTo(expected[i]!, 10));

    expect(run.cost).toBeCloseTo(1, 10);
    const total = utterances.reduce((sum, u) => sum + (u.cost ?? 0), 0);
    expect(total).toBeCloseTo(run.cost!, 10);
  });
});

// ---------------------------------------------------------------------------

describe('runOnce — segmentation mismatch is a RUN-LEVEL failure (ticket 031)', () => {
  it('TOO MANY: 5 observed against a 4-entry manifest fails with a named reason and no attribution', async () => {
    const h = corpusHarness({ count: 5 });
    const { run } = await runCorpus(h);

    expect(run.status).toBe('failed');
    expect(run.errors).toContain('segmentation: expected 4 utterances, observed 5');
    // NO partial attribution: a run whose segmentation disagrees is not evidence.
    expect(run.utterances).toBeUndefined();
    // Still stored — a failure is real information (PRD §12).
    expect(h.posted).toHaveLength(1);
    expect(h.posted[0]!.status).toBe('failed');
    expect(h.posted[0]!.utterances).toBeUndefined();
  });

  it('TOO FEW: a run that loses a stage after 3 of 4 saves, fails, names both reasons, and RESOLVES', async () => {
    const h = corpusHarness({
      count: 3,
      extra: [{ at: 400, type: 'error', message: 'TTS provider 503', opaque: false, stage: 'tts' }],
    });
    const { run } = await runCorpus(h); // resolves — never throws

    expect(run.status).toBe('failed');
    const joined = run.errors.join(' | ');
    expect(joined).toContain('tts: TTS provider 503');
    expect(run.errors).toContain('segmentation: expected 4 utterances, observed 3');
    expect(run.utterances).toBeUndefined();
    expect(h.posted).toHaveLength(1);
    expect(h.posted[0]).toEqual(run);
  });

  it('a matching count is NOT reported as a mismatch (the rule is not vacuous)', async () => {
    const h = corpusHarness();
    const { run } = await runCorpus(h);
    expect(run.status).toBe('complete');
    expect(run.errors.join(' | ')).not.toContain('segmentation');
  });

  it('the settle window is what catches the extra split — it is waited out on the happy path too', async () => {
    const h = corpusHarness();
    const done = start(h);
    // The 4th (last expected) completion lands at 450 ms.
    await vi.advanceTimersByTimeAsync(450 + SEGMENTATION_SETTLE_MS - 1);
    expect(h.posted).toHaveLength(0);
    await vi.advanceTimersByTimeAsync(2);
    await done;
    expect(h.posted).toHaveLength(1);
  });
});

// ---------------------------------------------------------------------------

describe('runOnce — backward compatibility (ticket 031 REGRESSION GUARDS)', () => {
  it('REGRESSION: a Recording with NO manifest behaves exactly as today — ends at the first boundary, no utterances key', async () => {
    // The script segments into two utterances; without a manifest the run is
    // over at the first completion, exactly as it has always been.
    const h = makeHarness({
      recording: { origin: 'mic', durationMs: 1000, speechEndMs: 900 },
      transportFactory: () =>
        new FixtureTransport({
          armId: 'fx',
          kind: 'cascade',
          script: corpusScript({ count: 2 }),
          costPerMinUsd: CORPUS_COST_PER_MIN,
        }),
    });
    const done = start(h);
    await vi.advanceTimersByTimeAsync(2000);
    const { run, t0 } = await done;

    expect(run.utterances).toBeUndefined();
    expect(run.status).toBe('complete');
    expect(run.errors).toEqual([]);
    expect(run.transcripts).toEqual({ source: 'src 0', target: 'tgt 0' });
    expect(run.timings.stt_final).toBe(110);
    expect(run.timings.speech_end).toBe(t0 + 900);
    expect(run.timings.audio_queued).toBe(t0 + 130);
  });

  it('REGRESSION: a 1-entry manifest produces exactly one record and one anchored sample', async () => {
    // TICKET 055b — 100, not 300, for the same reason the four-entry manifest
    // above moved: this utterance's answer sounds at 130, and an anchor of 300
    // made the fixture claim the answer began 170 ms before the speech ended.
    const single: CorpusUtterance[] = [
      { id: 'solo', index: 1, category: 'proper-nouns', trueSpeechEndMs: 100 },
    ];
    const h = corpusHarness({ count: 1, recording: { utterances: single } });
    const { run, t0 } = await runCorpus(h);

    const utterances = utterancesOf(run);
    expect(utterances).toHaveLength(1);
    expect(utterances[0]).toMatchObject({
      utteranceId: 'solo',
      index: 1,
      category: 'proper-nouns',
      status: 'complete',
      errors: [],
    });
    expect(utterances[0]!.timings.speech_end).toBe(t0 + 100);
    expect(utterances[0]!.timings.audio_queued).toBe(t0 + 130);
    // The whole clip is one span, so the split is the Run cost.
    expect(utterances[0]!.cost).toBeCloseTo(run.cost!, 10);
    expect(run.status).toBe('complete');
  });

  it('REGRESSION: Run-level transcripts/cost and the flat marks keep TODAY\'s semantics (last mark wins)', async () => {
    const h = corpusHarness();
    const { run, t0 } = await runCorpus(h);

    // Flat map, last utterance's marks — unchanged, so nothing downstream of
    // the Run-level fields moves before ticket 032.
    expect(run.timings.stt_final).toBe(410);
    expect(run.timings.tts_first_byte).toBe(420);
    expect(run.transcripts).toEqual({ source: 'src 3', target: 'tgt 3' });
    expect(run.cost).toBeCloseTo(CORPUS_COST_PER_MIN * (1000 / 60_000), 10);

    // TICKET 055b — THE ONE PAIR THAT NO LONGER KEEPS TODAY'S SEMANTICS, and
    // deliberately so. It WAS `t0 + CORPUS_RECORDING.speechEndMs` (900, the
    // Recording's anchor) against `t0 + 130` (the FIRST utterance's audio) —
    // two different utterances, which is how run 7acb0cc9 reported −13973 ms.
    // The envelope now COPIES the last record's two marks, so the pair is one
    // utterance's and the run-level interval is that utterance's interval.
    const last = utterancesOf(run)[3]!;
    expect(run.timings.speech_end).toBe(t0 + 400);
    expect(run.timings.audio_queued).toBe(t0 + 430);
    expect({ speech_end: run.timings.speech_end, audio_queued: run.timings.audio_queued }).toEqual({
      speech_end: last.timings.speech_end,
      audio_queued: last.timings.audio_queued,
    });
    expect(run.timings.speech_end).not.toBe(t0 + CORPUS_RECORDING.speechEndMs!);
  });
});

// ---------------------------------------------------------------------------

describe('runOnce — pacing and cancellation survive per-utterance measurement (ticket 031)', () => {
  it('PACING IS UNCHANGED: one continuous 1x clip, one pacer — it does NOT stop at an utterance boundary', async () => {
    const h = makeHarness({
      recording: CORPUS_RECORDING,
      samples: ramp(SAMPLE_RATE / 2), // 0.5 s => 25 frames, spanning 3 boundaries
      transportFactory: () =>
        new FixtureTransport({
          armId: 'fx',
          kind: 'cascade',
          script: corpusScript(),
          costPerMinUsd: CORPUS_COST_PER_MIN,
        }),
    });
    const done = start(h);

    // The first utterance completes at 150 ms — frame 8 of 25.
    await vi.advanceTimersByTimeAsync(200);
    expect(h.sendTimes.length).toBeGreaterThan(8);

    await vi.advanceTimersByTimeAsync(2000);
    const { run } = await done;

    const frames = h.transports[0]!.received;
    expect(frames).toHaveLength(25);
    for (const frame of frames) expect(frame.length).toBe(FRAME_SAMPLES);
    for (let k = 0; k < h.sendTimes.length; k++) {
      expect(Math.abs(h.sendTimes[k]! - k * FRAME_MS)).toBeLessThanOrEqual(1);
    }
    expect(utterancesOf(run)).toHaveLength(4);
  });

  it('cancelling a corpus run still POSTs nothing at all', async () => {
    const h = makeHarness({
      recording: CORPUS_RECORDING,
      samples: ramp(SAMPLE_RATE), // 1 s => 50 frames
      transportFactory: () =>
        new FixtureTransport({
          armId: 'fx',
          kind: 'cascade',
          script: corpusScript(),
          costPerMinUsd: CORPUS_COST_PER_MIN,
        }),
    });
    const controller = new AbortController();
    const done = start(h, CASCADE_CONFIG, controller.signal);

    await vi.advanceTimersByTimeAsync(200); // past the first utterance boundary
    controller.abort();
    await vi.advanceTimersByTimeAsync(3000);
    const result = await done;

    expect(result.cancelled).toBe(true);
    expect(h.posted).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// TICKET 031 (ORCHESTRATOR DECISION) — a SHORT manifest must FAIL, not hang.
//
// The settle window catches "too many". "Too few" is the mirror and is NOT
// self-announcing: a VAD that MERGED two utterances simply delivers N-1
// completions and goes quiet — no error, no disconnect, nothing to react to.
// Once pacing has completed, a manifest-backed run waits at most
// SEGMENTATION_IDLE_MS for what it is still owed and then fails with the SAME
// named reason. One merged clip must not stall an overnight sweep.
//
// A manifest-LESS run is deliberately untouched, hang included: its
// termination is byte-for-byte what it has always been.
// ---------------------------------------------------------------------------

/** Long enough for the idle deadline (armed at pacing end) to have elapsed. */
const PAST_IDLE_MS = SEGMENTATION_IDLE_MS * 2;

describe('runOnce — a short manifest fails on the idle deadline (ticket 031)', () => {
  it('a transport that delivers 3 of 4 and GOES QUIET resolves, fails, and names the segmentation reason', async () => {
    // No error, no disconnect, no lost stage — the transport is simply done.
    const h = corpusHarness({ count: 3 });
    const done = start(h);
    await vi.advanceTimersByTimeAsync(PAST_IDLE_MS);
    const { run } = await done; // RESOLVES — the whole point

    expect(run.status).toBe('failed');
    expect(run.errors).toContain('segmentation: expected 4 utterances, observed 3');
    expect(run.utterances).toBeUndefined();
    // Stored like any other failure (PRD §12).
    expect(h.posted).toHaveLength(1);
    expect(h.posted[0]).toEqual(run);
  });

  it('going quiet reaches the SAME named reason as losing a stage, by a different route', async () => {
    const quiet = corpusHarness({ count: 3 });
    const quietDone = start(quiet);
    await vi.advanceTimersByTimeAsync(PAST_IDLE_MS);
    const quietRun = (await quietDone).run;

    const lost = corpusHarness({
      count: 3,
      extra: [{ at: 400, type: 'error', message: 'TTS provider 503', opaque: false, stage: 'tts' }],
    });
    const lostDone = start(lost);
    await vi.advanceTimersByTimeAsync(PAST_IDLE_MS);
    const lostRun = (await lostDone).run;

    const REASON = 'segmentation: expected 4 utterances, observed 3';
    expect(quietRun.errors).toContain(REASON);
    expect(lostRun.errors).toContain(REASON);
    expect(quietRun.status).toBe('failed');
    expect(lostRun.status).toBe('failed');
    // The routes ARE different: only the lost-stage run names a failing stage.
    expect(quietRun.errors.join(' | ')).not.toContain('TTS provider 503');
    expect(lostRun.errors.join(' | ')).toContain('tts: TTS provider 503');
    expect(quietRun.utterances).toBeUndefined();
    expect(lostRun.utterances).toBeUndefined();
  });

  it('the deadline is NOT charged before pacing has completed — it does not truncate the clip', async () => {
    const h = makeHarness({
      recording: CORPUS_RECORDING,
      samples: ramp(SAMPLE_RATE / 2), // 0.5 s of pacing
      transportFactory: () =>
        new FixtureTransport({
          armId: 'fx',
          kind: 'cascade',
          script: corpusScript({ count: 3 }),
          costPerMinUsd: CORPUS_COST_PER_MIN,
        }),
    });
    const done = start(h);
    await vi.advanceTimersByTimeAsync(PAST_IDLE_MS);
    const { run } = await done;

    // Every frame still went out: the deadline governs the WAIT, not the clip.
    expect(h.transports[0]!.received).toHaveLength(25);
    expect(run.status).toBe('failed');
    expect(run.errors).toContain('segmentation: expected 4 utterances, observed 3');
  });
});

// ---------------------------------------------------------------------------

describe('runOnce — the idle deadline never fires on a healthy run (ticket 031)', () => {
  it('a run whose 4 completions all arrive is complete, with no segmentation reason', async () => {
    const h = corpusHarness();
    const done = start(h);
    await vi.advanceTimersByTimeAsync(PAST_IDLE_MS);
    const { run } = await done;

    expect(run.status).toBe('complete');
    expect(run.errors).toEqual([]);
    expect(utterancesOf(run)).toHaveLength(4);
  });

  it('a SLOW but valid final utterance, long after pacing ends, is not killed by the deadline', async () => {
    // Answers at 150 / 1450 / 2750 / 4050 ms; pacing ends at ~100 ms, so the
    // last completion lands ~3.95 s after the deadline was armed.
    const h = corpusHarness({ stepMs: 1300 });
    const done = start(h);
    await vi.advanceTimersByTimeAsync(PAST_IDLE_MS);
    const { run } = await done;

    expect(run.status).toBe('complete');
    expect(run.errors.join(' | ')).not.toContain('segmentation');
    expect(utterancesOf(run)).toHaveLength(4);
    expect(utterancesOf(run).map((u) => u.utteranceId)).toEqual(['u-1', 'u-2', 'u-3', 'u-4']);
  });
});

// ---------------------------------------------------------------------------

describe('runOnce — no timer leaks past a run (ticket 031)', () => {
  it('HAPPY PATH: the run leaves no pending timer behind (the idle deadline is disarmed)', async () => {
    const h = corpusHarness();
    const done = start(h);
    await vi.advanceTimersByTimeAsync(2000);
    const { run } = await done;

    expect(run.status).toBe('complete');
    // A leaked idle deadline would still be pending here, 3 s before it fires.
    expect(vi.getTimerCount()).toBe(0);
  });

  it('SHORT PATH: a run failed by the deadline leaves no pending timer behind', async () => {
    const h = corpusHarness({ count: 3 });
    const done = start(h);
    await vi.advanceTimersByTimeAsync(PAST_IDLE_MS);
    await done;
    expect(vi.getTimerCount()).toBe(0);
  });

  it('LOST STAGE: failing mid-clip disarms both the settle window and the idle deadline', async () => {
    const h = corpusHarness({
      extra: [{ at: 200, type: 'error', message: 'TTS provider 503', opaque: false, stage: 'tts' }],
    });
    const done = start(h);
    await vi.advanceTimersByTimeAsync(2000);
    const { run } = await done;

    expect(run.status).toBe('failed');
    expect(vi.getTimerCount()).toBe(0);
  });
});

// ---------------------------------------------------------------------------

describe('runOnce — the idle deadline is MANIFEST-ONLY (ticket 031 REGRESSION GUARD)', () => {
  it('REGRESSION: a manifest-less run arms NO 031 deadline — it outlives the idle window (updated by 048)', async () => {
    // TICKET 048 UPDATE. This test used to assert the manifest-less run "still
    // hangs", i.e. never settles at all. That was 031's true statement about
    // 031's deadlines, but 048 gives such a run a deadline of its OWN
    // (RUN_COMPLETION_TIMEOUT_MS) precisely because an unbounded `await finished`
    // freezes a sweep. Asserting the hang would now lock in the defect.
    //
    // What 031's rule actually claims is preserved verbatim and is what is
    // asserted here: NEITHER 031 timer is armed for a manifest-less run, so the
    // run is still alive well past SEGMENTATION_IDLE_MS. The 048 deadline is
    // deliberately longer than 031's, which is what leaves this window to observe.
    const h = makeHarness({
      recording: { origin: 'mic', durationMs: 1000, speechEndMs: 900 },
      transportFactory: () =>
        new FixtureTransport({
          armId: 'fx',
          kind: 'cascade',
          // Every event of utterance 0 EXCEPT its completion.
          script: corpusScript({ count: 1 }).filter((e) => e.type !== 'utteranceComplete'),
          costPerMinUsd: CORPUS_COST_PER_MIN,
        }),
    });

    let settled = false;
    const done = start(h);
    void done.then(
      () => {
        settled = true;
      },
      () => {
        settled = true;
      },
    );

    // PAST_IDLE_MS * 2 is 20 s — four times 031's idle window and still inside
    // 048's completion budget. A manifest-less run that armed 031's deadline
    // would have failed with a segmentation reason by now.
    await vi.advanceTimersByTimeAsync(PAST_IDLE_MS * 2);
    expect(PAST_IDLE_MS * 2).toBeLessThan(RUN_COMPLETION_TIMEOUT_MS);
    expect(settled).toBe(false);
    expect(h.posted).toHaveLength(0);

    // ...and then 048's deadline — NOT 031's — ends it, with its own named
    // reason and no segmentation claim (there is no manifest to disagree with).
    await vi.advanceTimersByTimeAsync(RUN_COMPLETION_TIMEOUT_MS);
    expect(settled).toBe(true);
    const { run } = await done;
    expect(run.status).toBe('failed');
    expect(run.errors.some((e) => e.startsWith(RUN_COMPLETION_TIMED_OUT))).toBe(true);
    expect(run.errors.some((e) => e.startsWith('segmentation:'))).toBe(false);
    expect(run.utterances).toBeUndefined();
    expect(h.posted).toHaveLength(1);
  });

  it('REGRESSION: the same transport WITH a 1-entry manifest fails on the deadline instead of hanging', async () => {
    // The mirror of the guard above — the rule is manifest-only, not absent.
    const single: CorpusUtterance[] = [
      { id: 'solo', index: 1, category: 'proper-nouns', trueSpeechEndMs: 300 },
    ];
    const h = makeHarness({
      recording: { ...CORPUS_RECORDING, utterances: single },
      transportFactory: () =>
        new FixtureTransport({
          armId: 'fx',
          kind: 'cascade',
          script: corpusScript({ count: 1 }).filter((e) => e.type !== 'utteranceComplete'),
          costPerMinUsd: CORPUS_COST_PER_MIN,
        }),
    });
    const done = start(h);
    await vi.advanceTimersByTimeAsync(PAST_IDLE_MS);
    const { run } = await done;

    expect(run.status).toBe('failed');
    expect(run.errors).toContain('segmentation: expected 1 utterances, observed 0');
    expect(run.utterances).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// TICKET 040 — Arm A's audio rides the WebRTC MEDIA TRACK, so a realtime run
// delivers NO onAudio PCM at all and `audio_queued` arrives as a transport
// TIMING MARK (the transport stamps it from `output_audio_buffer.started`).
// The runner used to overwrite that mark with `firstAudioAt` — null for a
// track-carried answer — so every Replay Arm A run counted toward n and cost
// while contributing NO latency sample to Experiment 1.
// ---------------------------------------------------------------------------

/** speech_end for the default RECORDING is t0 + 60; the mark lands 70 ms later. */
const TRACK_AUDIO_QUEUED_T = 130;
const TRACK_LATENCY_MS = TRACK_AUDIO_QUEUED_T - RECORDING.speechEndMs;

/** A realtime answer with transcripts and a timing mark, and NO audio events. */
function trackAudioScript(): FixtureScriptEvent[] {
  return [
    { at: 10, type: 'sourceText', kind: 'final', text: 'hello', utt: 0 },
    { at: 20, type: 'timing', event: 'server_speech_stopped', utt: 0, t: 20 },
    { at: 30, type: 'targetText', kind: 'final', text: 'hola', utt: 0 },
    { at: 70, type: 'timing', event: 'audio_queued', utt: 0, t: TRACK_AUDIO_QUEUED_T },
    { at: 90, type: 'utteranceComplete', record: { utt: 0 } },
  ];
}

describe('runOnce — Arm A audio_queued survives when audio rides the media track (ticket 040)', () => {
  it('a realtime run with NO onAudio still reports a NON-NULL audio_queued from the transport mark', async () => {
    const h = makeHarness({ kind: 'realtime', script: trackAudioScript() });
    const done = start(h, REALTIME_CONFIG);
    await vi.advanceTimersByTimeAsync(1000);
    const { run } = await done;

    expect(run.timings.audio_queued).toBe(TRACK_AUDIO_QUEUED_T);
    expect(run.timings.audio_queued).not.toBeNull();
    expect(run.status).toBe('complete');
  });

  it('and therefore yields a REAL latency sample for Arm A', async () => {
    const h = makeHarness({ kind: 'realtime', script: trackAudioScript() });
    const done = start(h, REALTIME_CONFIG);
    await vi.advanceTimersByTimeAsync(1000);
    const { run } = await done;

    expect(run.armTag).toBe('A');
    const samples = runSamples(run);
    expect(samples).toHaveLength(1);
    expect(samples[0]!.latencyMs).toBe(TRACK_LATENCY_MS);
    expect(samples[0]!.arm).toBe('A');
  });

  // TICKET 046 NOTE: still true, and still about the DATA CHANNEL. A transport
  // with no capture seam (FixtureTransport has none) yields no samples; Arm A's
  // real media-track capture rides `takeOutputAudio` and is pinned in
  // replayArmA.test.ts, deliberately away from the `onAudio` path that stamps
  // `audio_queued`.
  it('the run still buffers no PCM — nothing on the data channel carried audio', async () => {
    const h = makeHarness({ kind: 'realtime', script: trackAudioScript() });
    const done = start(h, REALTIME_CONFIG);
    await vi.advanceTimersByTimeAsync(1000);
    const result = await done;

    expect(result.outputAudio.length).toBe(0);
    expect(result.audioReady).toBe(false);
  });

  it('REGRESSION GUARD: a decoded PCM sample still WINS over a transport-sent mark', async () => {
    // Cascade's audio path is untouched: audio_queued is the instant the first
    // sample was decoded and queued (30 ms), never a mark a provider volunteers.
    const script: FixtureScriptEvent[] = [
      ...utteranceScript(),
      { at: 32, type: 'timing', event: 'audio_queued', utt: 0, t: 999_999 },
    ];
    const h = makeHarness({ script });
    const done = start(h);
    await vi.advanceTimersByTimeAsync(1000);
    const { run, t0 } = await done;

    expect(run.timings.audio_queued).toBe(t0 + 30);
  });

  it('REGRESSION GUARD: a run with neither PCM nor a mark still reports audio_queued null', async () => {
    const script = utteranceScript().filter((e) => e.type !== 'audio');
    const h = makeHarness({ script });
    const done = start(h);
    await vi.advanceTimersByTimeAsync(1000);
    const { run } = await done;

    expect(run.timings.audio_queued).toBeNull();
  });
});

describe('runOnce — per-utterance audio_queued from the media-track mark (ticket 040)', () => {
  /** Manifest anchors are 200/400/600/800; each mark lands 50 ms after its own. */
  const MARKS = [250, 450, 650, 850];

  function trackCorpusHarness(opts: { silentUtts?: number[]; markUtts?: number[] } = {}) {
    const markUtts = opts.markUtts ?? [0, 1, 2, 3];
    const extra: FixtureScriptEvent[] = markUtts.map((utt) => ({
      at: 100 + utt * 100 + 35,
      type: 'timing' as const,
      event: 'audio_queued',
      utt,
      t: MARKS[utt]!,
    }));
    return makeHarness({
      recording: CORPUS_RECORDING,
      transportFactory: () =>
        new FixtureTransport({
          armId: 'fx',
          kind: 'realtime',
          // silentUtts: no onAudio at all — exactly the WebRTC media-track case.
          script: corpusScript({ silentUtts: opts.silentUtts ?? [0, 1, 2, 3], extra }),
          costPerMinUsd: CORPUS_COST_PER_MIN,
        }),
    });
  }

  it('each utterance reports its OWN mark, and none is failed for "no output audio"', async () => {
    const h = trackCorpusHarness();
    const { run } = await runCorpus(h);

    const utterances = utterancesOf(run);
    expect(utterances.map((u) => u.timings.audio_queued)).toEqual(MARKS);
    expect(utterances.map((u) => u.status)).toEqual([
      'complete',
      'complete',
      'complete',
      'complete',
    ]);
    expect(utterances.flatMap((u) => u.errors)).toEqual([]);
  });

  it('REGRESSION GUARD: an utterance with NEITHER audio NOR a mark is still failed with a null audio_queued', async () => {
    const h = trackCorpusHarness({ markUtts: [0, 1, 3] });
    const { run } = await runCorpus(h);

    const utterances = utterancesOf(run);
    expect(utterances[2]!.timings.audio_queued).toBeNull();
    expect(utterances[2]!.status).toBe('failed');
    expect(utterances[2]!.errors).toEqual(['no output audio']);
    expect(run.status).toBe('complete');
  });

  it('REGRESSION GUARD: decoded PCM still wins per utterance over a volunteered mark', async () => {
    const h = trackCorpusHarness({ silentUtts: [], markUtts: [0, 1, 2, 3] });
    const { run, t0 } = await runCorpus(h);

    // Script audio for utt u lands at 100 + 100u + 30 ms.
    expect(utterancesOf(run).map((u) => u.timings.audio_queued)).toEqual([
      t0 + 130,
      t0 + 230,
      t0 + 330,
      t0 + 430,
    ]);
  });
});

// ---------------------------------------------------------------------------
// TICKET 062 — the run must RECORD the pair it used, and must not run without one.
// ---------------------------------------------------------------------------

describe('TICKET 062 — the Run records the language pair and direction it actually used', () => {
  async function runHappy(h: Harness, config: RunOnceConfig = CASCADE_CONFIG) {
    const done = start(h, config);
    await vi.advanceTimersByTimeAsync(1000);
    return done;
  }

  const cases: { label: string; config: RunOnceConfig }[] = [
    {
      label: 'cascade en→es',
      config: CASCADE_CONFIG,
    },
    {
      label: 'realtime en→es',
      config: REALTIME_CONFIG,
    },
    {
      label: 'realtime es→en (the reverse direction)',
      config: {
        ...REALTIME_CONFIG,
        languagePair: 'EN↔ES',
        direction: 'es→en',
        targetLanguage: 'English',
      },
    },
    {
      label: 'realtime en→yue',
      config: {
        ...REALTIME_CONFIG,
        languagePair: 'EN↔YUE',
        direction: 'en→yue',
        targetLanguage: 'Cantonese',
      },
    },
  ];

  it.each(cases)(
    '$label: the stored Run carries the SAME pair and direction the transport was started with',
    async ({ config }) => {
      const h = makeHarness({ kind: config.architecture === 'realtime' ? 'realtime' : 'cascade' });
      const { run } = await runHappy(h, config);

      // Ticket 061 owns the field; 062 owns the claim that it is not a lie.
      // Without this, 061 can be "satisfied" by writing a constant.
      const stored = run as Run & { languagePair?: string; direction?: string };
      expect(stored.languagePair).toBe(config.languagePair);
      expect(stored.direction).toBe(config.direction);
      // And it agrees with what the transport was actually told — the run
      // dbeb6d94 recorded no pair at all while translating into German.
      expect(h.startConfigs[0]!.languagePair).toBe(stored.languagePair);
      expect(h.startConfigs[0]!.direction).toBe(stored.direction);
      expect(h.posted[0]).toEqual(run);
    },
  );

  it('a run with NO target language never reports as complete', async () => {
    // Exactly what ReplayView hands `runOnce` today: architecture + providers
    // and nothing else. The fixture transport answers happily, the Run is
    // POSTed `complete`, and every figure derived from it is aggregated — which
    // is how a German translation became an Arm A latency number.
    const h = makeHarness();
    const { run } = await runHappy(h, {
      architecture: 'cascade',
      providers: DEFAULT_CASCADE_TRIPLE,
    });

    expect(run.status).not.toBe('complete');
    expect(run.errors.join(' ')).toMatch(/language/i);
  });

  it('a realtime run with no target language never reports as complete either', async () => {
    const h = makeHarness({ kind: 'realtime' });
    const { run } = await runHappy(h, {
      architecture: 'realtime',
      realtimeModel: REALTIME_MODEL,
    });
    expect(run.status).not.toBe('complete');
    expect(run.errors.join(' ')).toMatch(/language/i);
  });

  // -------------------------------------------------------------------------
  // ADVERSARIAL REVIEW FINDING 3 — ABSENCE MUST STAY ABSENCE.
  //
  // The two guarded writes in runner.ts ("if (transportConfig.languagePair !==
  // '')") could be made UNCONDITIONAL and the whole suite stayed green: nothing
  // asserted what a language-LESS run stores. `''` in an append-only ledger is a
  // VALUE — a row claiming a pair it never had — and it is precisely what run
  // dbeb6d94 stored. ledger.ts's own contract (§ Run.languagePair) says absent.
  // -------------------------------------------------------------------------
  it('a run that named NO language stores absence, never an empty string', async () => {
    const h = makeHarness();
    const { run } = await runHappy(h, {
      architecture: 'cascade',
      providers: DEFAULT_CASCADE_TRIPLE,
    });

    const stored = run as Run & { languagePair?: string; direction?: string };
    expect(stored.languagePair).toBeUndefined();
    expect(stored.direction).toBeUndefined();
    // `undefined` is not enough: an explicitly-written '' would also read as
    // falsy to a careless assertion. The KEY must not be there at all.
    expect(Object.keys(stored)).not.toContain('languagePair');
    expect(Object.keys(stored)).not.toContain('direction');
    // The failure is still stored (PRD §12) — and the POSTed row carries the
    // same absence, because that row is what the ledger keeps forever.
    expect(h.posted).toHaveLength(1);
    expect(Object.keys(h.posted[0]!)).not.toContain('languagePair');
    expect(Object.keys(h.posted[0]!)).not.toContain('direction');
  });

  // -------------------------------------------------------------------------
  // ADVERSARIAL REVIEW FINDING 4 — A BLANK NAME IS NOT A NAME.
  //
  // Dropping `.trim()` from the runner's `namesTarget` check kept every test
  // green: the realtime transport has its own trim-refusal, so only the CASCADE
  // path is exposed. A '   ' target would ride `session.start`, reach the MT
  // system prompt as "into   .", and the run would report `complete` — the exact
  // dbeb6d94 shape with whitespace instead of nothing.
  // -------------------------------------------------------------------------
  it('CASCADE: a whitespace-only target language is refused like a missing one', async () => {
    const h = makeHarness();
    const { run } = await runHappy(h, {
      architecture: 'cascade',
      providers: DEFAULT_CASCADE_TRIPLE,
      languagePair: 'EN↔ES',
      direction: 'en→es',
      targetLanguage: '   ',
    });

    expect(run.status).not.toBe('complete');
    expect(run.errors.join(' ')).toMatch(/language/i);
    // And nothing was ever put on the wire under a nameless instruction —
    // cascade has no refusal of its own to fall back on.
    expect(h.startConfigs).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// TICKET 061 — THE SECOND CONSTRUCTION SITE.
//
// `abandonedRunStub` builds a Run for a rep the sweep's budget gave up on
// before `runOnce` could produce one. It is a Run like any other in the
// append-only ledger — it lands in the arm's provenance DENOMINATOR (ticket
// 048 R2-3) — and it is built from the SAME `RunOnceConfig` the real Run is.
// Ticket 062 taught the real site to record its languages and left this one
// silent, so a sweep that lost a rep writes a row nobody can attribute to a
// direction, in the one table whose whole job is to say what was attempted.
//
// Same config, same rule: absence stays absence. `''` is a VALUE in a ledger
// that has no PATCH, and it is precisely what run dbeb6d94 stored.
// ---------------------------------------------------------------------------

describe('TICKET 061 — the abandoned-run stub records the languages of the run it stands in for', () => {
  const stubArgs = {
    id: 'stub-1',
    recordingId: 'rec-1',
    createdAt: 4_242,
    reason: 'run abandoned',
  };

  const CASES: { label: string; config: RunOnceConfig }[] = [
    { label: 'cascade en→es', config: CASCADE_CONFIG },
    { label: 'realtime en→es', config: REALTIME_CONFIG },
    {
      label: 'realtime en→yue',
      config: {
        ...REALTIME_CONFIG,
        languagePair: 'EN↔YUE',
        direction: 'en→yue',
        targetLanguage: 'Cantonese',
      },
    },
    {
      label: 'cascade es→en (the reverse direction)',
      config: {
        ...CASCADE_CONFIG,
        languagePair: 'EN↔ES',
        direction: 'es→en',
        targetLanguage: 'English',
      },
    },
  ];

  it.each(CASES)(
    '$label: the stub carries the pair and direction from its own config',
    ({ config }) => {
      const stub = abandonedRunStub({ ...stubArgs, config });
      expect(stub.languagePair).toBe(config.languagePair);
      expect(stub.direction).toBe(config.direction);
      // The failure row is still a failure row — the languages are additive
      // and must not turn an abandoned attempt into a measurement.
      expect(stub.status).toBe('failed');
      expect(stub.errors).toEqual([stubArgs.reason]);
      // ...and the derived arm is untouched: languages are NOT part of the
      // configuration arm membership is derived from.
      expect(stub.armTag).toBe(deriveArmTag(config));
    },
  );

  it('agrees with the real Run built from the SAME config — one rule, not two', async () => {
    const h = makeHarness();
    const done = start(h, CASCADE_CONFIG);
    await vi.advanceTimersByTimeAsync(1000);
    const { run } = await done;

    const stub = abandonedRunStub({ ...stubArgs, config: CASCADE_CONFIG });
    expect(stub.languagePair).toBe(run.languagePair);
    expect(stub.direction).toBe(run.direction);
    expect(run.languagePair).toBe(CASCADE_CONFIG.languagePair);
  });

  it('a config that named NO language leaves the stub with no key at all', () => {
    const stub = abandonedRunStub({
      ...stubArgs,
      config: { architecture: 'cascade', providers: DEFAULT_CASCADE_TRIPLE },
    });
    expect(Object.keys(stub)).not.toContain('languagePair');
    expect(Object.keys(stub)).not.toContain('direction');
  });

  it("an EMPTY-STRING config language is an absence, never a stored ''", () => {
    // `runner.ts` fills the transport config with `?? ''`, so `''` is the shape
    // a language-less run has always had in flight. Storing it would put a row
    // in the ledger claiming a pair it never had.
    const stub = abandonedRunStub({
      ...stubArgs,
      config: {
        architecture: 'cascade',
        providers: DEFAULT_CASCADE_TRIPLE,
        languagePair: '',
        direction: '',
        targetLanguage: '',
      },
    });
    expect(Object.keys(stub)).not.toContain('languagePair');
    expect(Object.keys(stub)).not.toContain('direction');
  });
});

// ---------------------------------------------------------------------------
// TICKET 055b — THE RUN ENVELOPE AND THE PER-UTTERANCE DRIFT ARE TWO DEFECTS.
//
// Run 7acb0cc9 renders `total -13973 ms` in Replay. It has TWO distinct causes
// and fixing either alone leaves the other in place:
//
//  1. THE ENVELOPE. `runner.ts` sets the Run-level `speech_end` from the
//     RECORDING (`t0 + recording.speechEndMs`, i.e. where the LAST utterance's
//     speech ends) and the Run-level `audio_queued` from `firstAudioAt` (the
//     FIRST utterance's audio). The two marks are on the SAME clock — this is
//     last-wins vs first-wins at the envelope, not a two-clock problem, and a
//     same-clock assertion would not catch it. Pairing utterance 4's speech end
//     with utterance 1's audio is what produces `885175 − 899148 = −13973`.
//
//  2. THE DRIFT. Per utterance, `audio_queued − speech_end` is
//     +3424 / +1231 / −1435 / −2364 ms: the later two are physically
//     impossible on their OWN marks, independent of the envelope. Nearest-rank
//     p50 over those four is −1435 ms — exactly the `-1.44 s` Results renders.
//     The UI is faithfully reporting a real measurement defect.
//
// EVERY NUMBER BELOW IS HAND-DERIVED FROM THE RECORD ON DISK, never recomputed
// from the model under test:
//
//   data/recordings/rec_msjjjc0m001_f1314d52.json — durationMs 20940,
//     speechEndMs 19797, manifest trueSpeechEndMs 2400 / 8598 / 14560 / 19797
//   data/ledger.jsonl run 7acb0cc9 — per-utterance speech_end
//     …881751 / …887949 / …893911 / …899148 and audio_queued
//     …885175 / …889180 / …892476 / …896784
//
//   t0            = 1786148881751 − 2400 = 1786148879351 (and the same t0
//                   reproduces all four speech ends, so the anchor is sound)
//   audio offsets = 885175 − 879351 = 5824, then 9829, 13125, 17433
//   deltas        = 5824 − 2400  = +3424
//                   9829 − 8598  = +1231
//                   13125 − 14560 = −1435
//                   17433 − 19797 = −2364
//   envelope      = 5824 − 19797 = −13973   (utterance 1's audio against
//                                            utterance 4's speech end)
//
// NOTE ON THE DELIBERATE SPLIT OF RESPONSIBILITY. The runner's half of the
// write-time guard is stated here as the STRONG form — the Run it POSTs
// carries no negative interval at any level — because a fix that leaves the
// negative marks in place and merely relabels the run `failed` hides the drift
// (the ticket says so explicitly). The BACKSTOP half, "a record that already
// carries an inverted interval is refused, named and excluded", is asserted
// against `RunLedger.appendRun` in `src/client/state/ledger.test.ts`, which is
// the surface golden eval 02 drives.
// ---------------------------------------------------------------------------

/** The manifest of `rec_msjjjc0m001_f1314d52`, verbatim (ids shortened). */
const DRIFT_MANIFEST: CorpusUtterance[] = [
  { id: 'u-1', index: 1, category: 'short-reply', trueSpeechEndMs: 2400 },
  { id: 'u-2', index: 2, category: 'numbers-dates', trueSpeechEndMs: 8598 },
  { id: 'u-3', index: 3, category: 'disfluency', trueSpeechEndMs: 14560 },
  { id: 'u-4', index: 4, category: 'proper-nouns', trueSpeechEndMs: 19797 },
];

const DRIFT_SPEECH_END_MS = [2400, 8598, 14560, 19797] as const;

/** Offsets from t0 at which run 7acb0cc9's four answers really began sounding. */
const DRIFT_AUDIO_AT_MS = [5824, 9829, 13125, 17433] as const;

/** What that pairing produced, per utterance. Two of them are impossible. */
const DRIFT_DELTAS_MS = [3424, 1231, -1435, -2364] as const;

/** The headline figure: utterance 1's audio against utterance 4's speech end. */
const DRIFT_ENVELOPE_MS = -13973;

/**
 * The Recording 7acb0cc9 replayed. `speechEndMs` is the LAST utterance's true
 * speech end (19797) — which is exactly why the envelope's first-wins
 * `audio_queued` reproduces −13973 against it.
 */
const DRIFT_RECORDING: Partial<Recording> = {
  origin: 'corpus',
  durationMs: 20_940,
  speechEndMs: 19_797,
  utterances: DRIFT_MANIFEST,
  corpusVersion: 'corpus-v1',
};

/** One well-formed answer per utterance, its audio landing at `audioAtMs[utt]`. */
function timelineScript(audioAtMs: readonly number[]): FixtureScriptEvent[] {
  return audioAtMs.flatMap((audioAt, utt): FixtureScriptEvent[] => [
    { at: audioAt - 20, type: 'sourceText', kind: 'final', text: `src ${utt}`, utt },
    { at: audioAt, type: 'audio', pcm: ramp(240), utt },
    { at: audioAt + 5, type: 'targetText', kind: 'final', text: `tgt ${utt}`, utt },
    { at: audioAt + 10, type: 'utteranceComplete', record: { utt } },
  ]);
}

/**
 * A harness on the REAL clip length. 20940 ms at 1x is exactly 1047 frames, and
 * the length is load-bearing: SEGMENTATION_IDLE_MS is armed when PACING ends,
 * so a stub clip would finish the run 5 s in and the later answers — the
 * inverted ones — would never be delivered at all.
 */
function timelineHarness(audioAtMs: readonly number[]) {
  return makeHarness({
    recording: DRIFT_RECORDING,
    samples: ramp(FRAME_SAMPLES * 1047),
    transportFactory: () =>
      new FixtureTransport({
        armId: 'fx',
        kind: 'cascade',
        script: timelineScript(audioAtMs),
        costPerMinUsd: CORPUS_COST_PER_MIN,
      }),
  });
}

/** Pacing is 20.94 s of virtual time; every script above settles inside it. */
async function runTimeline(h: Harness) {
  const done = start(h);
  await vi.advanceTimersByTimeAsync(30_000);
  return done;
}

/** `audio_queued − speech_end` out of ONE timings map. Null if either is absent. */
function pairedDelta(timings: Record<string, number | null>): number | null {
  const speechEnd = timings.speech_end;
  const audioQueued = timings.audio_queued;
  if (typeof speechEnd !== 'number' || typeof audioQueued !== 'number') return null;
  return audioQueued - speechEnd;
}

describe('TICKET 055b — the Run envelope pairs marks from ONE utterance', () => {
  it('a run whose every per-utterance delta is POSITIVE cannot report a negative run-level delta', async () => {
    // Each answer lands 50 ms after its own true speech end: +50, +50, +50, +50.
    const audioAt = DRIFT_SPEECH_END_MS.map((ms) => ms + 50);
    const h = timelineHarness(audioAt);
    const { run, t0 } = await runTimeline(h);

    // THE PREMISE, asserted rather than assumed — the test is not vacuous.
    const utterances = utterancesOf(run);
    expect(utterances).toHaveLength(4);
    expect(utterances.map((u) => pairedDelta(u.timings))).toEqual([50, 50, 50, 50]);

    // THE CLAIM. Today the envelope pairs `t0 + 19797` (the Recording's speech
    // end, i.e. the LAST utterance's) with `t0 + 2450` (the FIRST utterance's
    // audio) and reports −17347 for a run in which nothing whatsoever inverted.
    const envelope = pairedDelta(run.timings);
    expect(envelope).not.toBeNull();
    expect(envelope!).toBeGreaterThanOrEqual(0);
    // ...and the same claim about the record that actually reaches the store.
    expect(h.posted).toHaveLength(1);
    expect(pairedDelta(h.posted[0]!.timings)!).toBeGreaterThanOrEqual(0);
    // The marks are still real instants of THIS run, not a repaired constant.
    expect(run.timings.audio_queued).not.toBeNull();
    expect(audioAt.map((ms) => t0 + ms)).toContain(run.timings.audio_queued);
  });

  it('the envelope\'s two marks come from the SAME utterance — never last-wins against first-wins', async () => {
    const audioAt = DRIFT_SPEECH_END_MS.map((ms) => ms + 50);
    const h = timelineHarness(audioAt);
    const { run, t0 } = await runTimeline(h);

    const pairs = utterancesOf(run).map((u) => ({
      speech_end: u.timings.speech_end,
      audio_queued: u.timings.audio_queued,
    }));
    // Hand-derived, not recomputed from the run: t0 + the manifest anchors and
    // t0 + the scripted audio instants.
    expect(pairs).toEqual([
      { speech_end: t0 + 2400, audio_queued: t0 + 2450 },
      { speech_end: t0 + 8598, audio_queued: t0 + 8648 },
      { speech_end: t0 + 14560, audio_queued: t0 + 14610 },
      { speech_end: t0 + 19797, audio_queued: t0 + 19847 },
    ]);

    // THE CLAIM: whichever utterance the envelope speaks for, it speaks for ONE.
    expect(pairs).toContainEqual({
      speech_end: run.timings.speech_end,
      audio_queued: run.timings.audio_queued,
    });
    // Named explicitly, because this exact mixture is the defect: utterance 4's
    // speech end (t0 + 19797) against utterance 1's audio (t0 + 2450).
    expect({
      speech_end: run.timings.speech_end,
      audio_queued: run.timings.audio_queued,
    }).not.toEqual({ speech_end: t0 + 19797, audio_queued: t0 + 2450 });
  });

  it('run 7acb0cc9\'s own timeline no longer produces the headline −13973 ms', async () => {
    const h = timelineHarness(DRIFT_AUDIO_AT_MS);
    const { run, t0 } = await runTimeline(h);

    // The reproduction is exact: the stored run reads
    // speech_end 1786148899148, audio_queued 1786148885175, and
    // 885175 − 899148 = −13973.
    expect(pairedDelta(run.timings)).not.toBe(DRIFT_ENVELOPE_MS);
    expect({
      speech_end: run.timings.speech_end,
      audio_queued: run.timings.audio_queued,
    }).not.toEqual({ speech_end: t0 + 19797, audio_queued: t0 + 5824 });
    // Deliberately NOT asserted here: that this envelope is non-negative. On
    // THIS timeline the last utterance really did answer before its own speech
    // end, so an honest same-utterance envelope may still be negative. That is
    // the per-utterance defect below, and conflating the two is what lets a fix
    // to one of them look complete.
    expect(pairedDelta(h.posted[0]!.timings)).not.toBe(DRIFT_ENVELOPE_MS);
  });
});

describe('TICKET 055b — no utterance may report audio BEFORE its own speech end', () => {
  it('reproduces the recorded drift: +3424 / +1231 / −1435 / −2364 on the marks as assigned today', async () => {
    // The falsification target, pinned as literals so the fix has something to
    // move. This is the ONE assertion in the ticket that is expected to keep
    // passing after the fix only in its `.not` form below.
    const h = timelineHarness(DRIFT_AUDIO_AT_MS);
    const { run, t0 } = await runTimeline(h);

    const utterances = utterancesOf(run);
    expect(utterances).toHaveLength(4);
    // Ground truth, both sides, hand-derived from the two files on disk.
    expect(utterances.map((u) => u.timings.speech_end)).toEqual(
      DRIFT_SPEECH_END_MS.map((ms) => t0 + ms),
    );
    expect(DRIFT_AUDIO_AT_MS.map((a, i) => a - DRIFT_SPEECH_END_MS[i]!)).toEqual([
      ...DRIFT_DELTAS_MS,
    ]);
  });

  it('every stored utterance reports a NON-NEGATIVE delta, or no delta at all', async () => {
    const h = timelineHarness(DRIFT_AUDIO_AT_MS);
    const { run, t0 } = await runTimeline(h);

    const utterances = utterancesOf(run);
    // The attribution SURVIVES: dropping the records would hide the drift, and
    // golden eval 02 requires the report to name which utterances inverted.
    expect(utterances).toHaveLength(4);

    // Every anchor is still manifest ground truth — the fix may not re-anchor
    // an utterance onto the Recording, onto VAD, or onto a repaired constant.
    const anchors = DRIFT_SPEECH_END_MS.map((ms) => t0 + ms);
    for (const u of utterances) expect(anchors).toContain(u.timings.speech_end);

    // Every audio mark is an instant at which output audio REALLY arrived, or
    // null for "not measured" — never clamped to the anchor, never a zero.
    const instants: Array<number | null> = [...DRIFT_AUDIO_AT_MS.map((ms) => t0 + ms), null];
    for (const u of utterances) expect(instants).toContain(u.timings.audio_queued);

    // THE CLAIM. Today utterances 3 and 4 report −1435 and −2364 ms.
    const deltas = utterances.map((u) => pairedDelta(u.timings));
    expect(deltas).not.toEqual([...DRIFT_DELTAS_MS]);
    expect(deltas.filter((ms) => ms !== null && ms < 0)).toEqual([]);
    // ...and not by nulling the whole run out: the two utterances that DID
    // answer after their own speech end keep their measurement.
    expect(deltas.filter((d) => d !== null).length).toBeGreaterThanOrEqual(2);
  });

  it('the Run the runner POSTs carries no negative interval at ANY level', async () => {
    const h = timelineHarness(DRIFT_AUDIO_AT_MS);
    await runTimeline(h);

    expect(h.posted).toHaveLength(1);
    const stored = h.posted[0]!;
    // Unconditional on purpose: "no negative anywhere", collected rather than
    // asserted behind an `if`, so an implementation that stops emitting records
    // cannot make this pass by having nothing left to check (the length
    // assertion below is the other half of that).
    const intervals = [stored.timings, ...(stored.utterances ?? []).map((u) => u.timings)].map(
      pairedDelta,
    );
    expect(intervals.filter((ms) => ms !== null && ms < 0)).toEqual([]);
    // The evidence is still there to be read — a run that stored nothing is
    // half of what made this invisible (PRD §12).
    expect(stored.utterances).toHaveLength(4);
    expect(stored.transcripts.target).toBe('tgt 3');
  });
});

// ---------------------------------------------------------------------------
// TICKET 055b, ADVERSARIAL ROUND — WHAT THE REFUSAL LEAVES ON THE RECORD.
//
// The locked block above pins that no negative interval survives. It does NOT
// pin WHAT REPLACES IT, and both halves of that are load-bearing:
//
//  - THE REASON. `runner.ts` refuses the pairing and pushes a `clock-inversion`
//    error NAMING the instant it observed and by how much it preceded the
//    anchor. Swap that reason for `no output audio` — or drop it entirely, so
//    the record is refused with `errors: []` — and every assertion above still
//    passes. A SILENT refusal is precisely this ticket's failure mode: the
//    ticket's own rule is that a guard which relabels while deleting the
//    evidence HIDES a systematic drift. The instant is the only place that
//    evidence still exists, since the mark itself is now `null`.
//
//  - THE STATUS. `status` is keyed on the RESOLVED `audio_queued`, not on the
//    instant that was observed. Key it on the observation instead and a refused
//    utterance is stored `complete` with `audio_queued: null` — a record that
//    passes `isAggregatableUtterance`, enters `n` and `measuredCostSamples` as
//    a cost-only sample, and sails through `derive.ts`'s `status === 'complete'`
//    filter. It would report money spent on an utterance it also reports as
//    unmeasurable, in a row whose `n` counts it.
// ---------------------------------------------------------------------------

describe('TICKET 055b — a refused utterance NAMES the instant it refused', () => {
  it('carries a clock-inversion error giving the observed instant, the anchor and the gap', async () => {
    const h = timelineHarness(DRIFT_AUDIO_AT_MS);
    const { run, t0 } = await runTimeline(h);

    const utterances = utterancesOf(run);
    expect(utterances).toHaveLength(4);

    // THE CLAIM, verbatim. Hand-derived from the two files on disk: utterance 3
    // saw its output audio at t0 + 13125 while its manifest anchor is
    // t0 + 14560, i.e. 1435 ms EARLIER; utterance 4 at t0 + 17433 against
    // t0 + 19797, i.e. 2364 ms earlier.
    expect(utterances[2]!.errors).toEqual([
      `clock-inversion: output audio at ${t0 + 13125} precedes its own speech_end ` +
        `${t0 + 14560} by 1435 ms`,
    ]);
    expect(utterances[3]!.errors).toEqual([
      `clock-inversion: output audio at ${t0 + 17433} precedes its own speech_end ` +
        `${t0 + 19797} by 2364 ms`,
    ]);

    // The instant named is a REAL instant of this run — the one the mark itself
    // no longer holds — and not the anchor, a clamp or a zero.
    expect(DRIFT_AUDIO_AT_MS.map((ms) => t0 + ms)).toContain(t0 + 13125);
    expect(utterances[2]!.timings.audio_queued).toBeNull();

    // Not vacuous: the two utterances that answered honestly are accused of
    // nothing, so "every record carries this error" cannot pass the test.
    expect(utterances[0]!.errors).toEqual([]);
    expect(utterances[1]!.errors).toEqual([]);

    // And the same record is what reaches the store, errors and all.
    expect(h.posted).toHaveLength(1);
    expect(h.posted[0]!.utterances![3]!.errors).toEqual(utterances[3]!.errors);
  });

  it('an utterance that produced NO audio at all reports the other reason, never this one', async () => {
    // The two ways to arrive at "no number" are different facts. A refusal that
    // reported them under one reason would lose the drift signal entirely.
    const h = corpusHarness({ silentUtts: [2] });
    const { run } = await runCorpus(h);

    const utterances = utterancesOf(run);
    expect(utterances[2]!.errors).toEqual(['no output audio']);
    expect(utterances[2]!.timings.audio_queued).toBeNull();
    expect(utterances[2]!.status).toBe('failed');
  });
});

describe('TICKET 055b — a refused utterance is stored FAILED, never complete-with-a-null', () => {
  it('status is keyed on the RESOLVED audio mark, not on the instant that was observed', async () => {
    const h = timelineHarness(DRIFT_AUDIO_AT_MS);
    const { run } = await runTimeline(h);

    const utterances = utterancesOf(run);
    // Hand-derived: utterances 1 and 2 answered after their own speech end,
    // 3 and 4 before it, so 3 and 4 hold no measurement to be `complete` about.
    expect(utterances.map((u) => u.status)).toEqual([
      'complete',
      'complete',
      'failed',
      'failed',
    ]);
    // Stated as the rule rather than the instance: an utterance with no
    // `audio_queued` is never `complete`, whatever produced the absence.
    for (const u of utterances) {
      expect(u.status).toBe(u.timings.audio_queued === null ? 'failed' : 'complete');
    }
  });

  it('and so contributes NO cost-only sample: the money it carries is not aggregatable', async () => {
    const h = timelineHarness(DRIFT_AUDIO_AT_MS);
    await runTimeline(h);

    // The runner posts `origin: 'manual'`; re-homed as a sweep so the parent
    // Run passes the gate and the RECORD's own verdict is what is under test.
    const asSweep: Run = { ...h.posted[0]!, origin: 'sweep' };
    expect(isAggregatableRun(asSweep)).toBe(true);

    const samples = runSamples(asSweep);
    expect(samples).toHaveLength(4);
    const refused = samples.filter((s) => s.latencyMs === null);
    expect(refused).toHaveLength(2);

    for (const sample of refused) {
      // It still carries its split of the clip's cost — the record is real and
      // is not deleted (PRD §12)...
      expect(sample.cost).not.toBeNull();
      // ...and it still contributes none of it, because it is not a sample.
      expect(isAggregatableUtterance(asSweep, sample.utterance)).toBe(false);
    }
    // Not vacuous: the two honest records DO pass the same gate.
    const measured = samples.filter((s) => s.latencyMs !== null);
    expect(measured).toHaveLength(2);
    for (const sample of measured) {
      expect(isAggregatableUtterance(asSweep, sample.utterance)).toBe(true);
    }
  });
});

describe('TICKET 055b — the envelope quotes the LAST RECORD, not the Recording', () => {
  /**
   * F6 — the block above cannot catch a last-wins `speech_end` at the envelope,
   * because its fixture has `recording.speechEndMs === manifest[3]
   * .trueSpeechEndMs` (19797) and the two candidate anchors coincide. Here they
   * deliberately do not: the clip's annotated speech end is 20500 while the
   * last utterance's is 19797, which is the shape `replayArmA.test.ts` already
   * has on disk. Reading the anchor off the Recording is then visible without
   * depending on any edited fixture.
   */
  const LATE_CLIP_SPEECH_END_MS = 20_500;

  function skewedHarness(audioAtMs: readonly number[]) {
    return makeHarness({
      recording: { ...DRIFT_RECORDING, speechEndMs: LATE_CLIP_SPEECH_END_MS },
      samples: ramp(FRAME_SAMPLES * 1047),
      transportFactory: () =>
        new FixtureTransport({
          armId: 'fx',
          kind: 'cascade',
          script: timelineScript(audioAtMs),
          costPerMinUsd: CORPUS_COST_PER_MIN,
        }),
    });
  }

  it('takes both marks from the last record even when the clip claims a LATER speech end', async () => {
    const audioAt = DRIFT_SPEECH_END_MS.map((ms) => ms + 50);
    const h = skewedHarness(audioAt);
    const { run, t0 } = await runTimeline(h);

    // THE PREMISE, asserted: the two candidate anchors really do differ here.
    expect(h.recording.speechEndMs).toBe(LATE_CLIP_SPEECH_END_MS);
    expect(DRIFT_SPEECH_END_MS[3]).not.toBe(LATE_CLIP_SPEECH_END_MS);

    // THE CLAIM: the envelope is a copy of the LAST record's two marks.
    const last = utterancesOf(run)[3]!;
    expect(last.timings.speech_end).toBe(t0 + 19_797);
    expect({
      speech_end: run.timings.speech_end,
      audio_queued: run.timings.audio_queued,
    }).toEqual({ speech_end: t0 + 19_797, audio_queued: t0 + 19_847 });
    // Named explicitly, because this is the mark last-wins would have used.
    expect(run.timings.speech_end).not.toBe(t0 + LATE_CLIP_SPEECH_END_MS);
    expect(pairedDelta(run.timings)).toBe(50);
  });
});

// ---------------------------------------------------------------------------
// TICKET 059 — THE RUN RECORDS THE PRICE SOURCE IT WAS WRITTEN UNDER.
//
// `LiveSession` has carried `pricingVersion` since 052 R2, and `liveCostOf`
// uses it as the discriminator: a session with no stamp priced NOTHING, whatever
// zeros its utterances carry. That stamp is the only reason the Live footer
// reads `session not measured` instead of `$0.00`.
//
// `Run` carries no such stamp, so the three Runs in `data/runs/` — every one of
// them `"cost": 0` on the Run AND on all four of its utterance records, written
// by a build with no cost model at all — read forward as MEASUREMENTS, and
// Results › By Recording renders `$0.000` while Replay's cards render
// `$0.000/min`. Two takes asserting the configuration was free.
//
// THE FIX IS THE STAMP, NOT THE FORMATTER (`formatCostUsd` is correct and
// pinned), and a stamp nothing writes changes no screen: this is where the
// PRODUCTION construction site is pinned. Adding the field to the type and to
// the fixture builders satisfies every derivation test while `runner.ts` still
// writes nothing and the operator still sees `$0.000`.
//
// AND IT IS STAMPED WHATEVER THE FIGURE IS. The stamp reports which price
// source was in force, never what it came to; gating it on `cost !== null`
// would make it a restatement of the cost and leave a Run that measured a real
// zero indistinguishable from a Run nobody could price — the exact collapse
// this ticket exists to prevent, reintroduced at the write path.
// ---------------------------------------------------------------------------

import { PRICING_VERSION } from '../../core/pricing';

/** TICKET 059 — the `Run` shape with the stamp, as a widening of today's. */
type StampedRun = Run & { pricingVersion?: string };

describe('TICKET 059 — runOnce stamps the price source onto the Run it writes', () => {
  it('stamps PRICING_VERSION on the produced Run and on the record it POSTs', async () => {
    const h = makeHarness();
    const done = start(h);
    await vi.advanceTimersByTimeAsync(1000);
    const { run } = await done;

    expect((run as StampedRun).pricingVersion).toBe(PRICING_VERSION);
    // Not a display-time decoration: the stamp has to be ON THE RECORD, because
    // the ledger is append-only and a Run written without one can never be
    // retro-fixed — the same reason `corpusVersion` is copied onto the row.
    expect(h.posted).toHaveLength(1);
    expect((h.posted[0] as StampedRun).pricingVersion).toBe(PRICING_VERSION);
  });

  it('stamps it even when the transport declares no rate and the cost is null', async () => {
    // The fixture transport meters nothing, so this run's cost is UNMEASURED.
    // The stamp still says which price source was in force — it reports the
    // SOURCE, never the figure, and a stamp conditioned on the figure would be
    // no discriminator at all.
    const h = makeHarness();
    const done = start(h);
    await vi.advanceTimersByTimeAsync(1000);
    const { run } = await done;

    expect(run.cost).toBeNull();
    expect((run as StampedRun).pricingVersion).toBe(PRICING_VERSION);
  });

  it('stamps a manifest-backed run, whose utterance records carry the money', async () => {
    // The shape of 7acb0cc9 and dbeb6d94: the Run is a container and the split
    // costs live on the records. One stamp on the container covers all four —
    // a per-record stamp would be a second vocabulary for one fact.
    const h = corpusHarness();
    const { run } = await runCorpus(h);

    expect(utterancesOf(run)).toHaveLength(4);
    expect(run.cost).toBeCloseTo(1, 10);
    expect((run as StampedRun).pricingVersion).toBe(PRICING_VERSION);
    expect((h.posted[0] as StampedRun).pricingVersion).toBe(PRICING_VERSION);
  });

  it('stamps a FAILED run too — the price source is not a status report', async () => {
    // 2ba6332b is `status: 'failed'` with `cost: 0`. A stamp withheld from
    // failed runs would leave that record indistinguishable from a pre-059 one
    // for a reason that has nothing to do with pricing.
    const h = makeHarness({
      script: [{ at: 30, type: 'error', message: 'STT provider 503', opaque: false, stage: 'stt' }],
    });
    const done = start(h);
    await vi.advanceTimersByTimeAsync(1000);
    const { run } = await done;

    expect(run.status).toBe('failed');
    expect((run as StampedRun).pricingVersion).toBe(PRICING_VERSION);
  });
});

// ---------------------------------------------------------------------------
// 059 FOLLOW-UP — THE SECOND CONSTRUCTION SITE, UNDER THE SAME RULE.
//
// `abandonedRunStub` is the OTHER place a `Run` is built, and it was the only
// one with no test: removing its `pricingVersion` left the whole suite green.
//
// It is behaviourally inert TODAY — the stub's `cost` is always `null`, so a
// stamped and an unstamped stub both read `not measured` — and that is exactly
// why it needs pinning rather than why it does not. The stub rides the arm's
// provenance denominator forever in an append-only ledger, so an unstamped one
// is a record written by today's code that is INDISTINGUISHABLE FROM A PRE-059
// RECORD, for a reason that has nothing to do with pricing. The moment a stub
// carries any cost at all — or anything reads the stamp as "was this row
// written under a price model" rather than as a cost qualifier — the absence
// becomes a lie the ledger cannot take back out.
//
// A stamp reports the SOURCE, never the figure. Conditioning it on `cost !==
// null` here would be the same collapse the locked block above forbids at the
// real site.
// ---------------------------------------------------------------------------

describe('059 follow-up — the abandoned-run stub declares the price source too', () => {
  const stubArgs = {
    id: 'stub-priced',
    recordingId: 'rec-1',
    createdAt: 4_242,
    reason: 'run abandoned',
  };

  it('stamps PRICING_VERSION on the stub, whose cost is null by construction', () => {
    const stub = abandonedRunStub({ ...stubArgs, config: CASCADE_CONFIG });

    // The premise: an abandoned run measured NOTHING. The stamp is therefore
    // not a restatement of the figure — it is the only thing on the record that
    // says which price model was in force when nothing was measured.
    expect(stub.cost).toBeNull();
    expect(stub.status).toBe('failed');
    expect((stub as StampedRun).pricingVersion).toBe(PRICING_VERSION);
    // ABSENCE IS THE OTHER STATE, and it is expressed by a MISSING KEY — the
    // shape the three pre-059 Runs on disk have. So the key must be present.
    expect(Object.keys(stub)).toContain('pricingVersion');
  });

  it('stamps it for every configuration, exactly as the real Run site does', () => {
    // One rule, not one per architecture: nothing about the arm, the transport
    // or the language bears on which price table was in force.
    for (const config of [CASCADE_CONFIG, REALTIME_CONFIG]) {
      const stub = abandonedRunStub({ ...stubArgs, config });
      expect((stub as StampedRun).pricingVersion).toBe(PRICING_VERSION);
    }
  });

  it('agrees with the real Run built from the SAME config — one rule, not two', async () => {
    // The pairing the 061 block makes for the languages, made for the stamp:
    // the two construction sites must not drift apart.
    const h = makeHarness();
    const done = start(h, CASCADE_CONFIG);
    await vi.advanceTimersByTimeAsync(1000);
    const { run } = await done;

    const stub = abandonedRunStub({ ...stubArgs, config: CASCADE_CONFIG });
    expect((stub as StampedRun).pricingVersion).toBe((run as StampedRun).pricingVersion);
    // Not vacuous: both are the real constant, not two matching undefineds.
    expect((run as StampedRun).pricingVersion).toBe(PRICING_VERSION);
  });
});

// ---------------------------------------------------------------------------
// TICKET 068 — A HALLUCINATED LEADING SEGMENT SHIFTS EVERY REAL UTTERANCE, AND
// THE RUNNER TRUNCATES INSTEAD OF NOTICING.
//
// `attributeUtterances` maps manifest entry i onto transport bucket
// `entry.index - 1` and reads EXACTLY `manifest.length` buckets. `observed` is
// the count of `onUtteranceComplete` events that arrived BEFORE the run stopped
// listening — never how many segments the transport actually produced. So when
// the STT hallucinates a leading utterance on the clip's opening silence
// (7 of the operator's 17 runs: "Turn right.", "그러나.", "Hallo.", "żeśmy.",
// "Yardımımın", "Telephone", "Ok."):
//
//   bucket 0 <- the spurious segment        (in NO manifest entry)
//   bucket 1 <- manifest utterance 1's answer
//   bucket 2 <- manifest utterance 2's answer
//   bucket 3 <- manifest utterance 3's answer
//   bucket 4 <- manifest utterance 4's answer — READ BY NOBODY
//
// The 4th completion arms the settle window, it expires 250 ms later, and the
// 5th segment lands ~2.5 s after that — by which time the run has stopped
// listening. `observed` is 4, `expected` is 4, no segmentation reason is
// recorded, and the Run is stored `complete` with every transcript one manifest
// entry late. Run 8aba8e2e, verbatim:
//
//   slot 1 "No, none at all."          <- "Turn right."   (spurious)
//   slot 2 "Take two hundred fifty…"   <- manifest 1
//   slot 3 "It started— sorry…"        <- manifest 2
//   slot 4 "Doctor Nguyen referred…"   <- manifest 3
//   manifest 4 absent from the record entirely
//
// Anchors 2400 / 8598 / 14560 / 19797, audio at 5197 / 11134 / 17161: against
// each utterance's OWN anchor that is −3401 / −3426 / −2636, and against the
// PREVIOUS anchor +2797 / +2536 / +2601 — a tightly clustered cascade latency.
// 055b's clock guard caught that run BY ACCIDENT. A shift whose deltas happen
// to come out positive is caught by nothing at all, and those are exactly the
// samples that survived into the graded screen.
//
// WHAT IS ALREADY TRUE, and is asserted below as a control rather than claimed:
// ticket 031 ALREADY compares `observed !== expected` in both directions, and a
// transport that emits 5 COMPLETIONS in time already fails with
// `segmentation: expected 4 utterances, observed 5`. The hole is narrower and
// meaner than "there is no too-many check": it is that a segment the transport
// demonstrably produced — a distinct `utt` carrying a final transcript — is
// never counted as a segment at all, and its bucket is silently dropped.
//
// THE CLOCK-INVERSION GUARD IS NOT TOUCHED BY ANY TEST BELOW. It is correct,
// it is what surfaced this, and the primary fixture here is deliberately built
// so that it never fires: every delta the shift produces is POSITIVE.
// ---------------------------------------------------------------------------

/**
 * The manifest of `rec_msjjjc0m001_f1314d52` again — the SAME four anchors as
 * DRIFT_MANIFEST, now carrying reference text, because the defect this block
 * exists for is WHICH TRANSCRIPT LANDED ON WHICH ENTRY. A sign check on the
 * deltas cannot see a shift; a pairing check can.
 */
const ALIGN_MANIFEST: CorpusUtterance[] = [
  {
    id: 'a-1',
    index: 1,
    category: 'short-reply',
    trueSpeechEndMs: DRIFT_SPEECH_END_MS[0],
    referenceText: 'No, none at all.',
  },
  {
    id: 'a-2',
    index: 2,
    category: 'numbers-dates',
    trueSpeechEndMs: DRIFT_SPEECH_END_MS[1],
    referenceText: 'Take two hundred fifty milligrams twice a day.',
  },
  {
    id: 'a-3',
    index: 3,
    category: 'disfluency',
    trueSpeechEndMs: DRIFT_SPEECH_END_MS[2],
    referenceText: 'It started, sorry, three days ago.',
  },
  {
    id: 'a-4',
    index: 4,
    category: 'proper-nouns',
    trueSpeechEndMs: DRIFT_SPEECH_END_MS[3],
    referenceText: 'Doctor Nguyen referred you.',
  },
];

/** What the STT put on the clip's opening silence in run 8aba8e2e. */
const SPURIOUS_LEAD_TEXT = 'Turn right.';

/** The reference text of each manifest entry, in index order. */
const ALIGN_REFERENCES = ALIGN_MANIFEST.map((entry) => entry.referenceText!);

/**
 * One segment as the TRANSPORT numbered it — never as the manifest numbers it.
 * The whole ticket is that the two are not the same sequence.
 */
interface SegmentSpec {
  /** The transport's 0-based `utt`. */
  utt: number;
  /** The source transcript this segment carried, and when it was delivered. */
  source: string;
  sourceAt: number;
  /** When this segment's answer began sounding. `null` => it never sounded. */
  audioAt: number | null;
  /**
   * When the transport announced this segment complete. A value past the end of
   * the run models the real thing: the segment WAS produced, the run had already
   * stopped listening.
   */
  completeAt: number;
}

function segmentScript(segments: readonly SegmentSpec[]): FixtureScriptEvent[] {
  return segments.flatMap((s): FixtureScriptEvent[] => [
    { at: s.sourceAt, type: 'sourceText', kind: 'final', text: s.source, utt: s.utt },
    ...(s.audioAt === null
      ? []
      : [
          { at: s.audioAt, type: 'audio', pcm: ramp(240), utt: s.utt } as FixtureScriptEvent,
          {
            at: s.audioAt + 5,
            type: 'targetText',
            kind: 'final',
            text: `tgt ${s.utt}`,
            utt: s.utt,
          } as FixtureScriptEvent,
        ]),
    { at: s.completeAt, type: 'utteranceComplete', record: { utt: s.utt } },
  ]);
}

/**
 * The real clip's length — 20940 ms is exactly 1047 frames at 1x, and it is
 * load-bearing twice over: SEGMENTATION_IDLE_MS is armed when PACING ends, and
 * the run tears the transport down the instant pacing finishes if the settle
 * window has already expired. That teardown is precisely what hid the 5th
 * segment in the sweep.
 */
const ALIGN_FRAMES = 1047;

function alignHarness(script: FixtureScriptEvent[]) {
  return makeHarness({
    recording: { ...DRIFT_RECORDING, utterances: ALIGN_MANIFEST },
    samples: ramp(FRAME_SAMPLES * ALIGN_FRAMES),
    transportFactory: () =>
      new FixtureTransport({
        armId: 'fx',
        kind: 'cascade',
        script,
        costPerMinUsd: CORPUS_COST_PER_MIN,
      }),
  });
}

/** Well past pacing (20.94 s) AND past the idle deadline armed at its end. */
async function runAlign(h: Harness) {
  const done = start(h);
  await vi.advanceTimersByTimeAsync(40_000);
  return done;
}

/**
 * THE CONTROL TIMELINE — four segments, one per manifest entry, and FOUR
 * DISTINCT latencies. Equal latencies cannot detect a shift: shifted by one
 * they read back identically. These are the sweep's own measured intervals
 * (+2797 / +2536 / +2601 against the previous anchor), with the fourth chosen
 * distinct from all three.
 */
const ALIGNED_LATENCY_MS = [2797, 2536, 2601, 2455] as const;
const ALIGNED_AUDIO_AT_MS = DRIFT_SPEECH_END_MS.map((ms, i) => ms + ALIGNED_LATENCY_MS[i]!);

function alignedSegments(): SegmentSpec[] {
  return ALIGNED_AUDIO_AT_MS.map((audioAt, utt) => ({
    utt,
    source: ALIGN_REFERENCES[utt]!,
    sourceAt: audioAt - 20,
    audioAt,
    completeAt: audioAt + 10,
  }));
}

/**
 * THE SHIFTED TIMELINE — a spurious leading segment plus the four real ones,
 * every delta POSITIVE so that 055b's clock guard never fires and this defect
 * has to be caught on its own terms.
 *
 * `lastCompleteAt` is the whole point. In the sweep the 5th segment's
 * completion arrived ~2.5 s after the 4th, i.e. after the settle window had
 * expired and after the run had torn the transport down, so `observed` stopped
 * at 4. Its transcript, though, had already been delivered: the segment is on
 * the record, in a bucket nobody reads.
 */
const SHIFTED_LATENCY_MS = [300, 400, 500, 600] as const;
const SHIFTED_AUDIO_AT_MS = DRIFT_SPEECH_END_MS.map((ms, i) => ms + SHIFTED_LATENCY_MS[i]!);
/** Delivered while the run is still listening — pacing does not end until 20940. */
const FIFTH_SEGMENT_SOURCE_AT = 18_500;
/** After the run has stopped listening (settle expires ~20700, pacing ends ~20940). */
const FIFTH_SEGMENT_LATE_COMPLETE_AT = 22_050;
/** Inside the settle window — the case ticket 031 already catches. */
const FIFTH_SEGMENT_INTIME_COMPLETE_AT = 20_500;

function shiftedSegments(fifthCompleteAt: number): SegmentSpec[] {
  return [
    // utt 0 — the hallucination on the opening silence. It answers, so nothing
    // about it looks broken from inside the run.
    {
      utt: 0,
      source: SPURIOUS_LEAD_TEXT,
      sourceAt: SHIFTED_AUDIO_AT_MS[0]! - 20,
      audioAt: SHIFTED_AUDIO_AT_MS[0]!,
      completeAt: SHIFTED_AUDIO_AT_MS[0]! + 60,
    },
    // utt 1..3 — manifest utterances 1..3, one slot late.
    ...[1, 2, 3].map((utt) => ({
      utt,
      source: ALIGN_REFERENCES[utt - 1]!,
      sourceAt: SHIFTED_AUDIO_AT_MS[utt]! - 20,
      audioAt: SHIFTED_AUDIO_AT_MS[utt]!,
      completeAt: SHIFTED_AUDIO_AT_MS[utt]! + 60,
    })),
    // utt 4 — manifest utterance 4. Its transcript IS delivered; its completion
    // is not, and its bucket is past the end of everything the runner reads.
    {
      utt: 4,
      source: ALIGN_REFERENCES[3]!,
      sourceAt: FIFTH_SEGMENT_SOURCE_AT,
      audioAt: null,
      completeAt: fifthCompleteAt,
    },
  ];
}

/** The manifest entry a stored record claims to be. */
function entryOf(utterance: RunUtterance): CorpusUtterance {
  const entry = ALIGN_MANIFEST.find((e) => e.id === utterance.utteranceId);
  expect(entry).toBeDefined();
  return entry!;
}

describe('TICKET 068 — the runner counts the segments the transport PRODUCED, both directions', () => {
  it('TOO MANY, and the 5th arrived late: 5 segments against a 4-entry manifest is a mismatch', async () => {
    const h = alignHarness(segmentScript(shiftedSegments(FIFTH_SEGMENT_LATE_COMPLETE_AT)));
    const { run } = await runAlign(h);

    // THE PREMISE, asserted rather than assumed: the whole clip really was
    // paced, so the transport had every chance to deliver what it produced.
    expect(h.transports[0]!.received).toHaveLength(ALIGN_FRAMES);

    // THE CLAIM. Today `observed` is the count of completions that arrived
    // before the run stopped listening — 4 — so this run is stored `complete`
    // with four confident, wrong records.
    expect(run.status).toBe('failed');
    const reason = run.errors.find((e) => e.startsWith('segmentation:'));
    expect(reason).toBeDefined();
    // BOTH counts are named, in 031's own words.
    expect(reason).toMatch(/expected 4 utterances/);
    expect(reason).toMatch(/observed 5/);
  });

  it('CONTROL: the SAME 5 segments with the 5th completing in time are already caught', async () => {
    // The gap is only WHEN the 5th arrived, not whether it existed — this is
    // ticket 031's existing rule, working, and it must keep working verbatim.
    const h = alignHarness(segmentScript(shiftedSegments(FIFTH_SEGMENT_INTIME_COMPLETE_AT)));
    const { run } = await runAlign(h);

    expect(run.status).toBe('failed');
    expect(run.errors).toContain('segmentation: expected 4 utterances, observed 5');
    expect(run.utterances).toBeUndefined();
  });

  it("CONTROL: TOO FEW keeps ticket 031's message and behaviour byte-for-byte", async () => {
    // 3 segments, 3 completions, nothing else wrong. The new direction must not
    // change one character of the old one.
    const h = alignHarness(segmentScript(alignedSegments().slice(0, 3)));
    const { run } = await runAlign(h);

    expect(run.status).toBe('failed');
    expect(run.errors).toContain('segmentation: expected 4 utterances, observed 3');
    expect(run.utterances).toBeUndefined();
  });
});

describe('TICKET 068 — a misaligned run is stored failed and truncates NOTHING', () => {
  it('does not silently truncate to manifest.length — no partial attribution survives', async () => {
    const h = alignHarness(segmentScript(shiftedSegments(FIFTH_SEGMENT_LATE_COMPLETE_AT)));
    const { run } = await runAlign(h);

    // Stored, like every other failure (PRD §12) — a run that stored nothing is
    // half of what made this invisible.
    expect(h.posted).toHaveLength(1);
    const stored = h.posted[0]!;
    expect(stored).toEqual(run);
    expect(stored.status).toBe('failed');
    // 031's rule, one level up: a run whose segmentation disagrees is not
    // evidence, so it carries no records rather than four truncated ones.
    expect(stored.utterances).toBeUndefined();
  });

  it('no stored record is paired with ANOTHER manifest entry\'s transcript', async () => {
    const h = alignHarness(segmentScript(shiftedSegments(FIFTH_SEGMENT_LATE_COMPLETE_AT)));
    const { run } = await runAlign(h);

    // THE INDEX MAPPING, pinned directly. Today record `a-1` carries
    // "Turn right." (in no manifest entry at all), `a-2` carries manifest 1's
    // text, `a-3` manifest 2's and `a-4` manifest 3's.
    for (const utterance of run.utterances ?? []) {
      expect(utterance.transcripts.source).toBe(entryOf(utterance).referenceText);
    }
    // The loop above is vacuous once the fix refuses to attribute at all, so
    // the verdict carries the weight: this run may not read as a measurement.
    expect(run.status).not.toBe('complete');
    // Named explicitly, because this exact pairing IS the defect.
    const shifted = (run.utterances ?? []).find((u) => u.utteranceId === 'a-2');
    expect(shifted?.transcripts.source).not.toBe(ALIGN_REFERENCES[0]);
    const spurious = (run.utterances ?? []).find((u) => u.utteranceId === 'a-1');
    expect(spurious?.transcripts.source).not.toBe(SPURIOUS_LEAD_TEXT);
  });

  it("run 8aba8e2e's own timeline reaches the same verdict, with the clock guard untouched", async () => {
    // The sweep's real shape: the spurious segment produced NO audio, and the
    // three real answers land 5197 / 11134 / 17161 — −3401 / −3426 / −2636
    // against the anchors they were misfiled under. 055b's guard fires here BY
    // ACCIDENT; it is not what this run should be caught by, and the two
    // verdicts are asserted separately so a fix to one cannot pass for the other.
    const realAudioAt = [null, 5197, 11134, 17161] as const;
    const segments: SegmentSpec[] = [
      ...realAudioAt.map((audioAt, utt) => ({
        utt,
        source: utt === 0 ? SPURIOUS_LEAD_TEXT : ALIGN_REFERENCES[utt - 1]!,
        sourceAt: (audioAt ?? 1200) - 20,
        audioAt,
        completeAt: (audioAt ?? 1200) + 60,
      })),
      {
        utt: 4,
        source: ALIGN_REFERENCES[3]!,
        sourceAt: FIFTH_SEGMENT_SOURCE_AT,
        audioAt: null,
        completeAt: FIFTH_SEGMENT_LATE_COMPLETE_AT,
      },
    ];
    const h = alignHarness(segmentScript(segments));
    const { run } = await runAlign(h);

    expect(run.status).toBe('failed');
    const reason = run.errors.find((e) => e.startsWith('segmentation:'));
    expect(reason).toMatch(/expected 4 utterances/);
    expect(reason).toMatch(/observed 5/);
    // NOT relaxed, not given a tolerance: this run must not come back as a
    // clock-inversion-free `complete` either.
    expect(run.status).not.toBe('complete');
  });
});

describe('TICKET 068 — a misaligned run never reaches an aggregate (through isAggregatableRun)', () => {
  it('its shifted figures are not aggregated — the ONE gate, no second one beside it', async () => {
    const h = alignHarness(segmentScript(shiftedSegments(FIFTH_SEGMENT_LATE_COMPLETE_AT)));
    await runAlign(h);

    // The runner posts `origin: 'manual'`; re-homed as a sweep so the parent
    // Run's own verdict is what is under test rather than its origin.
    const asSweep: Run = { ...h.posted[0]!, origin: 'sweep' };
    expect(isAggregatableRun(asSweep)).toBe(false);
    // ...and it is excluded by the clause that already exists, `status`.
    expect(asSweep.status).toBe('failed');

    // What actually reaches a figure, expressed the way every aggregate does:
    // expand into samples, admit them only through the gate.
    const aggregated = isAggregatableRun(asSweep)
      ? runSamples(asSweep)
          .filter((s) => isAggregatableUtterance(asSweep, s.utterance))
          .map((s) => s.latencyMs)
      : [];
    expect(aggregated).toEqual([]);
    // Today those four samples are +300 / +400 / +500 / +600 — plausible,
    // positive, and every one of them measured against the wrong anchor.
    for (const ms of SHIFTED_LATENCY_MS) expect(aggregated).not.toContain(ms);
  });
});

describe('TICKET 068 — a WELL-FORMED run is UNTOUCHED (the control that matters as much)', () => {
  it('four segments, four records, each transcript on its OWN manifest entry', async () => {
    const h = alignHarness(segmentScript(alignedSegments()));
    const { run, t0 } = await runAlign(h);

    // THE FIXTURE'S OWN PREMISE: four DISTINCT latencies. Equal ones read back
    // identically under a shift and could not detect one.
    expect(new Set(ALIGNED_LATENCY_MS).size).toBe(4);

    expect(run.status).toBe('complete');
    expect(run.errors).toEqual([]);
    const utterances = utterancesOf(run);
    expect(utterances).toHaveLength(4);
    expect(utterances.map((u) => u.utteranceId)).toEqual(['a-1', 'a-2', 'a-3', 'a-4']);
    expect(utterances.map((u) => u.index)).toEqual([1, 2, 3, 4]);

    // THE MAPPING: entry i's own reference text, on entry i's own record.
    expect(utterances.map((u) => u.transcripts.source)).toEqual([...ALIGN_REFERENCES]);
    // Anchors and answers are both hand-derived, so a shift in EITHER direction
    // moves this list — it is not a sign check.
    expect(utterances.map((u) => u.timings.speech_end)).toEqual(
      DRIFT_SPEECH_END_MS.map((ms) => t0 + ms),
    );
    expect(utterances.map((u) => u.timings.audio_queued)).toEqual(
      ALIGNED_AUDIO_AT_MS.map((ms) => t0 + ms),
    );
    expect(utterances.map((u) => pairedDelta(u.timings))).toEqual([...ALIGNED_LATENCY_MS]);
    expect(utterances.map((u) => u.status)).toEqual([
      'complete',
      'complete',
      'complete',
      'complete',
    ]);
    for (const u of utterances) expect(u.errors).toEqual([]);

    // The figures, unchanged: the envelope quotes the LAST record (055b), and
    // the cost split still sums back to the Run's whole-clip cost (031).
    expect({
      speech_end: run.timings.speech_end,
      audio_queued: run.timings.audio_queued,
    }).toEqual({
      speech_end: utterances[3]!.timings.speech_end,
      audio_queued: utterances[3]!.timings.audio_queued,
    });
    expect(run.cost).toBeCloseTo(CORPUS_COST_PER_MIN * (20_940 / 60_000), 10);
    const total = utterances.reduce((sum, u) => sum + (u.cost ?? 0), 0);
    expect(total).toBeCloseTo(run.cost!, 10);

    // It is the same record that was stored.
    expect(h.posted).toHaveLength(1);
    expect(h.posted[0]).toEqual(run);
  });

  it('...and it still aggregates: the gate rejects the misaligned run and only that one', async () => {
    const h = alignHarness(segmentScript(alignedSegments()));
    await runAlign(h);

    const asSweep: Run = { ...h.posted[0]!, origin: 'sweep' };
    expect(isAggregatableRun(asSweep)).toBe(true);

    const aggregated = runSamples(asSweep)
      .filter((s) => isAggregatableUtterance(asSweep, s.utterance))
      .map((s) => s.latencyMs);
    expect(aggregated).toEqual([...ALIGNED_LATENCY_MS]);
  });
});

// ---------------------------------------------------------------------------
// TICKET 069 — THE TRANSMISSION TRIM.
//
// The Whisper-family STT hallucinates on non-speech: across 17 real sweep runs
// the FIRST stored source text was a foreign-language invention ("그러나.",
// "żeśmy.", "Yardımımın") in 7 of them, fired by the clip's opening silence.
// Each occurrence consumed segment 0 and shifted every real utterance one slot
// later — the corruption ticket 068 now detects.
//
// ⚠️ THE DANGEROUS FIX IS THE OBVIOUS ONE. Trimming the CLIP would shift the
// audio against the manifest anchors and silently invalidate every latency
// number in the project — and it would look like a small, consistent
// IMPROVEMENT rather than an error, which is exactly why nobody would catch it.
// `t0` is frame 0 of the paced audio and every anchor is `t0 +
// trueSpeechEndMs`; neither may move.
//
// So the contract is TRIM TRANSMISSION, NOT TIME: the pacer keeps pacing the
// whole clip at 1x off an untouched `t0`, and leading frames below the silence
// threshold are simply never handed to the transport. Frame k still LEAVES at
// `t0 + k * FRAME_MS` — it just does not leave at all until speech onset.
//
// THE FIXTURE'S PREMISE: 200 ms of DIGITAL silence (exact zeros) followed by
// 800 ms in which EVERY sample is at |amplitude| >= 20000. No threshold rule —
// peak, mean or RMS, per frame or per sample — can disagree about where onset
// is, so these tests pin the BEHAVIOUR and not one particular threshold.
// ---------------------------------------------------------------------------

/** Leading digital silence, in 20 ms frames (200 ms). */
const TRIM_SILENCE_FRAMES = 10;
/** Speech frames after the silence (800 ms). */
const TRIM_SPEECH_FRAMES = 40;
/** The whole clip: 50 frames == 1000 ms == CORPUS_RECORDING.durationMs. */
const TRIM_TOTAL_FRAMES = TRIM_SILENCE_FRAMES + TRIM_SPEECH_FRAMES;
/** First sample of speech in the leading-silence clip. */
const TRIM_ONSET_SAMPLE = TRIM_SILENCE_FRAMES * FRAME_SAMPLES;

/**
 * Unambiguous speech: every sample sits at |amplitude| in [20000, 27999], and
 * the value depends on the sample's ABSOLUTE position in the clip, so a frame
 * delivered from the wrong offset reads back as different content.
 */
const loud = (n: number, offset = 0): Int16Array =>
  Int16Array.from({ length: n }, (_, i) => {
    const k = i + offset;
    return (k % 2 === 0 ? 1 : -1) * (20000 + ((k * 7919) % 8000));
  });

/** THE FAILURE SHAPE: 200 ms of exact zeros, then 800 ms of speech. */
function clipWithLeadingSilence(): Int16Array {
  const clip = new Int16Array(TRIM_TOTAL_FRAMES * FRAME_SAMPLES);
  clip.set(loud(TRIM_SPEECH_FRAMES * FRAME_SAMPLES, TRIM_ONSET_SAMPLE), TRIM_ONSET_SAMPLE);
  return clip;
}

/**
 * The 031 corpus harness over an ARBITRARY clip, with the trim optionally
 * disabled through the runner's seam.
 *
 * `trimLeadingSilence` is the disable switch AC6 is stated in terms of: a run
 * with it `false` transmits the clip exactly as the runner does today, and is
 * the control every trimmed run is compared against. It is cast on rather than
 * declared here — the field belongs on `RunnerDeps`, which is production's job.
 */
function trimHarness(opts: { samples: Int16Array; trimLeadingSilence?: boolean }): Harness {
  const h = makeHarness({
    samples: opts.samples,
    recording: CORPUS_RECORDING,
    transportFactory: () =>
      new FixtureTransport({
        armId: 'fx',
        kind: 'cascade',
        script: corpusScript(),
        costPerMinUsd: CORPUS_COST_PER_MIN,
      }),
  });
  if (opts.trimLeadingSilence !== undefined) {
    (h.deps as RunnerDeps & { trimLeadingSilence?: boolean }).trimLeadingSilence =
      opts.trimLeadingSilence;
  }
  return h;
}

/** Every frame the transport actually received, flattened in arrival order. */
function transmitted(h: Harness): number[] {
  return h.transports[0]!.received.flatMap((f) => Array.from(f));
}

/**
 * THE SHARPEST ASSERTION IN THIS TICKET (AC6).
 *
 * A clip-trim and a transmission-trim are indistinguishable by transcript, by
 * status, and by anything the operator would look at. They are distinguishable
 * HERE: the anchors are manifest ground truth and must be bit-identical to the
 * same clip run with the trim off, while the audio that reached the provider
 * must NOT be. Asserting only the first half is satisfied by shipping nothing;
 * asserting only the second is satisfied by the fix that destroys the study.
 */
describe('TICKET 069 — the trim removes TRANSMISSION, never time (AC6)', () => {
  it('per-utterance speech_end is identical with the trim ON and OFF, while the transmitted audio is not', async () => {
    const clip = clipWithLeadingSilence();

    const trimmed = trimHarness({ samples: clip });
    const withTrim = await runCorpus(trimmed);

    const control = trimHarness({ samples: clip, trimLeadingSilence: false });
    const noTrim = await runCorpus(control);

    // Manifest ground truth, absolutely, in BOTH runs. Hand-derived from
    // MANIFEST — not recomputed from either run.
    const anchorsWith = utterancesOf(withTrim.run).map((u) => u.timings.speech_end!);
    const anchorsWithout = utterancesOf(noTrim.run).map((u) => u.timings.speech_end!);
    expect(anchorsWith).toEqual([100, 200, 300, 400].map((ms) => withTrim.t0 + ms));
    expect(anchorsWithout).toEqual([100, 200, 300, 400].map((ms) => noTrim.t0 + ms));
    // ...and identical to each other once each run's own t0 is removed.
    expect(anchorsWith.map((t) => t - withTrim.t0)).toEqual(
      anchorsWithout.map((t) => t - noTrim.t0),
    );
    // The run envelope's anchor did not move either (055b: the LAST record's).
    expect(withTrim.run.timings.speech_end! - withTrim.t0).toBe(
      noTrim.run.timings.speech_end! - noTrim.t0,
    );

    // AND THE TRIM ACTUALLY HAPPENED. Without this line the equalities above
    // are satisfied by an implementation that does nothing at all.
    expect(control.transports[0]!.received).toHaveLength(TRIM_TOTAL_FRAMES);
    expect(trimmed.transports[0]!.received).toHaveLength(TRIM_SPEECH_FRAMES);
    expect(transmitted(control)).toEqual(Array.from(clip));
    expect(transmitted(trimmed)).toEqual(Array.from(clip.subarray(TRIM_ONSET_SAMPLE)));

    // Neither run's verdict changed: the trim is not allowed to buy its
    // silence by losing an utterance.
    expect(withTrim.run.status).toBe('complete');
    expect(noTrim.run.status).toBe('complete');
    expect(utterancesOf(withTrim.run).map((u) => u.transcripts.source)).toEqual(
      utterancesOf(noTrim.run).map((u) => u.transcripts.source),
    );
  });
});

/**
 * AC5 + AC7 — and the assertion that CATCHES A CLIP-TRIM.
 *
 * A clip-trim would put the first transmitted frame at `t0 + 0` and the last at
 * `t0 + 39 * 20 ms`: the run would finish 200 ms early and every measurement
 * would improve by exactly the silence it removed. A transmission-trim leaves
 * frame k where the clock put it — the first transmitted frame leaves 200 ms
 * into the run and the last still leaves at `t0 + 980 ms`, one clip-length in.
 */
describe('TICKET 069 — transmission starts at onset; the pacing clock does not (AC5, AC7)', () => {
  it('frame k still leaves at t0 + k * FRAME_MS of the ORIGINAL clip — the silent frames are skipped, not shifted', async () => {
    const h = trimHarness({ samples: clipWithLeadingSilence() });
    const { t0 } = await runCorpus(h);

    expect(h.sendTimes).toHaveLength(TRIM_SPEECH_FRAMES);
    for (let j = 0; j < h.sendTimes.length; j += 1) {
      expect(
        Math.abs(h.sendTimes[j]! - t0 - (TRIM_SILENCE_FRAMES + j) * FRAME_MS),
      ).toBeLessThanOrEqual(1);
    }
    // Stated as the two endpoints, because those are the two a clip-trim moves.
    expect(Math.abs(h.sendTimes[0]! - t0 - TRIM_SILENCE_FRAMES * FRAME_MS)).toBeLessThanOrEqual(1);
    expect(
      Math.abs(h.sendTimes.at(-1)! - t0 - (TRIM_TOTAL_FRAMES - 1) * FRAME_MS),
    ).toBeLessThanOrEqual(1);
    // 1x, over the WHOLE clip: the run still spans a clip-length of wall clock
    // even though 200 ms of it went nowhere.
    expect(h.sendTimes.at(-1)! - t0).toBeGreaterThanOrEqual(
      (TRIM_TOTAL_FRAMES - 1) * FRAME_MS - 1,
    );
  });
});

/**
 * AC10 — THE PROOF, stated as an INPUT.
 *
 * The hallucination fired in 7 of 17 real runs, so a test that runs the
 * pipeline once and reads a clean transcript proves nothing at all. What is
 * pinned here is what the provider was HANDED: not one sample of the opening
 * silence, so there is nothing left for it to invent a Korean sentence from.
 */
describe('TICKET 069 — the STT is handed nothing from before onset (AC10)', () => {
  it('the transmitted audio is the clip FROM ONSET, byte-for-byte, and contains no silent frame', async () => {
    const clip = clipWithLeadingSilence();
    const h = trimHarness({ samples: clip });
    await runCorpus(h);

    const received = h.transports[0]!.received;
    expect(received).toHaveLength(TRIM_SPEECH_FRAMES);
    for (const frame of received) expect(frame.length).toBe(FRAME_SAMPLES);
    // Byte-for-byte: no silence transmitted, and no speech sample lost either.
    expect(transmitted(h)).toEqual(Array.from(clip.subarray(TRIM_ONSET_SAMPLE)));
    // The same fact from the other side, so a partial trim cannot pass: every
    // transmitted frame carries signal.
    for (const frame of received) {
      expect(Array.from(frame).every((s) => s === 0)).toBe(false);
    }
  });
});

/**
 * AC8 + AC9 — the two controls. A clip that starts speaking immediately is
 * transmitted from frame 0 exactly as the runner transmits it today, and an
 * INTERIOR silence is never touched: only LEADING frames may be withheld, and a
 * trim that scanned the whole clip would swallow a pause mid-sentence.
 */
describe('TICKET 069 — a clip with no leading silence is untouched (AC8, AC9)', () => {
  it('speech at sample 0 transmits from frame 0, byte-for-byte and on today’s schedule', async () => {
    const clip = loud(TRIM_TOTAL_FRAMES * FRAME_SAMPLES);
    const h = trimHarness({ samples: clip });
    const { t0 } = await runCorpus(h);

    expect(h.transports[0]!.received).toHaveLength(TRIM_TOTAL_FRAMES);
    expect(transmitted(h)).toEqual(Array.from(clip));
    for (let k = 0; k < h.sendTimes.length; k += 1) {
      expect(Math.abs(h.sendTimes[k]! - t0 - k * FRAME_MS)).toBeLessThanOrEqual(1);
    }

    // ...and identical, frame for frame, to the same clip with the trim off.
    const control = trimHarness({ samples: clip, trimLeadingSilence: false });
    await runCorpus(control);
    expect(h.transports[0]!.received.map((f) => Array.from(f))).toEqual(
      control.transports[0]!.received.map((f) => Array.from(f)),
    );
  });

  it('an INTERIOR silence is transmitted in full — the trim is LEADING-only', async () => {
    // Loud from sample 0, silent for frames 10..19, loud again to the end.
    const clip = new Int16Array(TRIM_TOTAL_FRAMES * FRAME_SAMPLES);
    clip.set(loud(10 * FRAME_SAMPLES, 0), 0);
    clip.set(loud(30 * FRAME_SAMPLES, 20 * FRAME_SAMPLES), 20 * FRAME_SAMPLES);

    const h = trimHarness({ samples: clip });
    const { t0, run } = await runCorpus(h);

    expect(h.transports[0]!.received).toHaveLength(TRIM_TOTAL_FRAMES);
    expect(transmitted(h)).toEqual(Array.from(clip));
    expect(Math.abs(h.sendTimes[0]! - t0)).toBeLessThanOrEqual(1);
    // The anchors are still the manifest's, gap or no gap.
    expect(utterancesOf(run).map((u) => u.timings.speech_end!)).toEqual(
      [100, 200, 300, 400].map((ms) => t0 + ms),
    );
  });
});

// ---------------------------------------------------------------------------
// TICKET 070 — THE TRANSPORT REPORTS THE USAGE AND THE RUNNER DROPS IT.
//
// Every arm on the operator's Results screen reads `cost measured on 0 of N
// samples`. Ticket 059 is working: an unmeasured cost reads `not measured` and
// never a fabricated `$0.000`. NOTHING MEASURES.
//
// `runner.ts` contains zero references to `usage`. It prices with
// `transport.costPerMinUsd` — a single blended $/min that `browserDeps.ts`
// wires at `0` on EVERY transport, Replay and Live alike (four call sites, all
// `costPerMinUsd: 0`) — so `costPerMinUsd > 0` is false and both the Run's
// `cost` and every `RunUtterance.cost` are `null` on every real run.
//
// Meanwhile `realtime.ts` ALREADY sends it:
//
//     case 'response.done': {
//       const response = msg.response as { usage?: unknown } | undefined;
//       h.onUtteranceComplete?.({ utt: this.utt, usage: response?.usage });
//
// `UtteranceCompletion` already DECLARES `usage?: unknown`, and
// `priceRealtimeUsage` already prices exactly that envelope — from
// `useSessionController.ts`, the LIVE path, and nowhere else. The runner's
// handler is `onUtteranceComplete: () => {`: it takes no parameter at all, so
// the number arrives and is discarded on the doorstep.
//
// THE FIXTURES BELOW PACE PRODUCTION. Every transport here declares
// `costPerMinUsd: 0`, exactly as `browserDeps` does, so the ONLY thing that can
// produce a figure is the usage envelope. Nothing in this block touches the
// blended path, which ticket 053 owns and this ticket deliberately leaves
// unconfigured.
//
// FOUR TRAPS THESE TESTS EXIST TO CATCH, in ascending order of subtlety:
//
//  1. A fix that prices nothing (today).
//  2. A fix that reimplements the arithmetic instead of calling
//     `priceRealtimeUsage`. Pinned two ways: the dollar figures below are hand
//     derived from `RATE_CARD`'s own published numbers (asserted as a premise,
//     so a rate change restates them visibly), AND four envelopes are included
//     whose verdict is a REFUSAL nobody re-derives by accident — a cached count
//     with no breakdown, a breakdown that contradicts its own total, an
//     envelope whose only numbers are negative, and an empty one.
//  3. A fix that BLENDS across turns. A run of four turns where three report
//     usage must read three priced records, one `null`, and `3 of 4` — never a
//     four-way average of the three priced turns (which would satisfy "the
//     total is right" and "every record has a figure" simultaneously and be
//     wrong), and never the three-turn total relabelled `4 of 4`.
//  4. A fix that collapses "measured, and it came to zero" into "unmeasured".
//     A turn reporting `audio_tokens: 0` MEASURED a zero, and `$0.000` is the
//     honest rendering of it — the other half of ticket 059.
//
// AND TWO CONTROLS THAT MATTER AS MUCH. A realtime run with no usage anywhere
// keeps today's `null` / `0 of N` (so the fix cannot invent a figure), and a
// CASCADE run keeps `cost: null` even when its completions carry a realtime
// envelope — Arms B and C stay unpriced until 053 is implemented, and this
// ticket may not half-price a cascade run on the way past.
// ---------------------------------------------------------------------------

import {
  RATE_CARD,
  costFromPriceSource,
  formatCostUsd,
  priceRealtimeUsage,
  type RealtimeUsage,
  type TokenRate,
} from '../../core/pricing';
import { RunLedger, type RunArmAggregate } from '../state/ledger';

/** The dev model — never an arm, and priced at a DIFFERENT meter (10 / 20). */
const MINI_MODEL = 'gpt-realtime-mini';

/* ---------------------------------------------------------------- envelopes --
 *
 * THE RATE-CARD ARITHMETIC, WRITTEN OUT. `gpt-realtime`: audio in $32/M, audio
 * out $64/M (the 2× that makes summing the two directions first wrong), text in
 * $4/M, text out $16/M, cached input $0.40/M. Every figure below is
 * `sum(tokens × rate) / 1e6` over those five meters, by hand.
 */

/** Audio and text, both directions, no caching. */
const USAGE_PLAIN: RealtimeUsage = {
  input_token_details: { audio_tokens: 1000, text_tokens: 500 },
  output_token_details: { audio_tokens: 2000, text_tokens: 250 },
};
/** (1000×32 + 500×4 + 2000×64 + 250×16) / 1e6 = 166000 / 1e6. */
const USD_PLAIN = 0.166;

/**
 * The cached SUBSET, subtracted and re-priced (PRICING_ASSUMPTIONS'
 * `realtime-cached-tokens-are-a-subset`). The additive reading — the bug 052
 * replaced — comes to 0.13408 here, so this envelope alone separates the two.
 */
const USAGE_CACHED: RealtimeUsage = {
  input_token_details: {
    audio_tokens: 2000,
    text_tokens: 1000,
    cached_tokens: 1200,
    cached_tokens_details: { audio_tokens: 800, text_tokens: 400 },
  },
  output_token_details: { audio_tokens: 1000, text_tokens: 100 },
};
/** (1200×32 + 800×0.4 + 600×4 + 400×0.4 + 1000×64 + 100×16) / 1e6 = 106880 / 1e6. */
const USD_CACHED = 0.10688;
/** What ADDING the cached tokens on top would come to. Named so it can be refused. */
const USD_CACHED_ADDITIVE = 0.13408;

/** Audio only, both directions. */
const USAGE_AUDIO_ONLY: RealtimeUsage = {
  input_token_details: { audio_tokens: 500 },
  output_token_details: { audio_tokens: 500 },
};
/** (500×32 + 500×64) / 1e6 = 48000 / 1e6. */
const USD_AUDIO_ONLY = 0.048;

/**
 * Text only, both directions — the SUB-METERS. Priced at the audio meters this
 * would come to 0.096, so this envelope catches a fix that knows there are two
 * directions but not that there are two modalities.
 */
const USAGE_TEXT_ONLY: RealtimeUsage = {
  input_token_details: { text_tokens: 1000 },
  output_token_details: { text_tokens: 1000 },
};
/** (1000×4 + 1000×16) / 1e6 = 20000 / 1e6. */
const USD_TEXT_ONLY = 0.02;
/** The same envelope read off the AUDIO meters. Named so it can be refused. */
const USD_TEXT_ON_AUDIO_METERS = 0.096;

/** A turn that really did consume nothing. MEASURED — `0` is not `null`. */
const USAGE_ZERO: RealtimeUsage = {
  input_token_details: { audio_tokens: 0 },
  output_token_details: { audio_tokens: 0 },
};

/* The four REFUSALS. `priceRealtimeUsage` answers `null` to each; the figure a
 * plain multiply-and-sum would produce is named beside it, so "this fix did its
 * own arithmetic" is a failing assertion and not a code review. */

/** A cached count with no breakdown: the split is unknown, so the turn is not priceable. */
const USAGE_CACHED_NO_DETAIL: RealtimeUsage = {
  input_token_details: { audio_tokens: 2000, cached_tokens: 1200 },
  output_token_details: { audio_tokens: 1000 },
};
/** (2000×32 + 1000×64) / 1e6 — what ignoring `cached_tokens` would report. */
const USD_CACHED_NO_DETAIL_NAIVE = 0.128;

/** A breakdown that contradicts its own total (800 + 100 ≠ 1200). */
const USAGE_CACHED_CONTRADICTS: RealtimeUsage = {
  input_token_details: {
    audio_tokens: 2000,
    cached_tokens: 1200,
    cached_tokens_details: { audio_tokens: 800, text_tokens: 100 },
  },
  output_token_details: { audio_tokens: 1000 },
};
/** (1200×32 + 800×0.4 + 1000×64) / 1e6 — subtract-then-reprice with no agreement check. */
const USD_CACHED_CONTRADICTS_NAIVE = 0.10272;

/** Every number negative: a metering fault, NOT a turn that was free. */
const USAGE_NEGATIVE_ONLY: RealtimeUsage = {
  input_token_details: { audio_tokens: -5 },
  output_token_details: { audio_tokens: -1 },
};

/** An envelope that reported nothing at all. */
const USAGE_EMPTY: RealtimeUsage = {};

/* ------------------------------------------------------------------ harness --
 *
 * The 4-entry `MANIFEST` / `CORPUS_RECORDING` pair the 031 suites already use,
 * driven by a REALTIME transport whose completions carry `usage`.
 */

interface UsageTurn {
  /** The `response.done` envelope. `undefined` => the `usage` KEY IS ABSENT. */
  usage?: unknown;
  /** When `onUtteranceComplete` fires. Default: that turn's own window. */
  completeAt?: number;
}

/** Turn u answers on [100 + 100u, 150 + 100u] ms — corpusScript's own windows. */
function usageScript(turns: readonly UsageTurn[]): FixtureScriptEvent[] {
  const events: FixtureScriptEvent[] = [];
  turns.forEach((turn, utt) => {
    const base = 100 + utt * 100;
    events.push(
      { at: base, type: 'sourceText', kind: 'final', text: `src ${utt}`, utt },
      { at: base + 25, type: 'targetText', kind: 'final', text: `tgt ${utt}`, utt },
      { at: base + 30, type: 'audio', pcm: ramp(240), utt },
      {
        at: turn.completeAt ?? base + 50,
        type: 'utteranceComplete',
        // ABSENT, not `usage: undefined`: the runner must handle a transport
        // that reports no usage key at all, which is every cascade completion
        // and any realtime `response.done` that omits it.
        record: turn.usage === undefined ? { utt } : { utt, usage: turn.usage },
      },
    );
  });
  return events;
}

function usageHarness(opts: {
  turns: readonly UsageTurn[];
  kind?: TransportKind;
  /** PRODUCTION'S OWN VALUE (browserDeps wires 0 on all four transports). */
  costPerMinUsd?: number;
  recording?: Partial<Recording>;
}): Harness {
  const script = usageScript(opts.turns);
  return makeHarness({
    recording: { ...CORPUS_RECORDING, ...opts.recording },
    transportFactory: () =>
      new FixtureTransport({
        armId: 'fx',
        kind: opts.kind ?? 'realtime',
        script,
        costPerMinUsd: opts.costPerMinUsd ?? 0,
      }),
  });
}

async function runUsage(h: Harness, config: RunOnceConfig = REALTIME_CONFIG) {
  const done = start(h, config);
  await vi.advanceTimersByTimeAsync(2000);
  return done;
}

/** The four turns of the primary fixture, and their hand-derived figures. */
const PRIMARY_TURNS: readonly UsageTurn[] = [
  { usage: USAGE_PLAIN },
  { usage: USAGE_CACHED },
  { usage: USAGE_AUDIO_ONLY },
  { usage: USAGE_TEXT_ONLY },
];
const PRIMARY_USD = [USD_PLAIN, USD_CACHED, USD_AUDIO_ONLY, USD_TEXT_ONLY] as const;
/** 0.166 + 0.10688 + 0.048 + 0.02. */
const PRIMARY_TOTAL_USD = 0.34088;

/**
 * What an aggregate makes of the Run — the ONE gate and nothing beside it.
 *
 * The runner posts `origin: 'manual'`; re-homed as a sweep exactly as the 068
 * block does, so the parent Run's own verdict is what is under test rather than
 * its origin. `runAggregates` is the real path: it expands each Run into its
 * measured atoms, admits them through `isAggregatableUtterance`, and counts
 * `measuredCostSamples` beside `n`.
 */
function aggregateOf(run: Run): RunArmAggregate {
  const asSweep: Run = { ...run, origin: 'sweep' };
  // THE PREMISE: the gate lets this run through on its own terms. If it ever
  // stops doing so, every count below is vacuous and this says so first.
  expect(isAggregatableRun(asSweep)).toBe(true);
  const ledger = new RunLedger();
  ledger.appendRun(asSweep);
  const agg = ledger.runAggregates().perArm[runArmTag(asSweep)];
  expect(agg).toBeDefined();
  return agg!;
}

// ---------------------------------------------------------------------------

describe('TICKET 070 — the rate card these figures are derived from (the premise)', () => {
  it("`gpt-realtime`'s five published meters are what the hand arithmetic used", () => {
    // Asserted rather than assumed: every dollar figure in this block is
    // `sum(tokens × rate) / 1e6` over exactly these numbers, so a rate that
    // moves RESTATES these tests visibly instead of silently re-deriving them.
    const rate = RATE_CARD[REALTIME_MODEL] as TokenRate;
    expect({
      shape: rate.shape,
      inputPerMillionUsd: rate.inputPerMillionUsd,
      outputPerMillionUsd: rate.outputPerMillionUsd,
      textInputPerMillionUsd: rate.textInputPerMillionUsd,
      textOutputPerMillionUsd: rate.textOutputPerMillionUsd,
      cachedInputPerMillionUsd: rate.cachedInputPerMillionUsd,
      cachedTextInputPerMillionUsd: rate.cachedTextInputPerMillionUsd,
    }).toEqual({
      shape: 'token',
      inputPerMillionUsd: 32,
      outputPerMillionUsd: 64,
      textInputPerMillionUsd: 4,
      textOutputPerMillionUsd: 16,
      cachedInputPerMillionUsd: 0.4,
      cachedTextInputPerMillionUsd: 0.4,
    });

    // ...and the price source agrees with the hand arithmetic BEFORE the runner
    // is involved at all. If these four disagree, every runner assertion below
    // is measuring the wrong thing and this test names it.
    expect(priceRealtimeUsage(USAGE_PLAIN, REALTIME_MODEL).usd).toBeCloseTo(USD_PLAIN, 12);
    expect(priceRealtimeUsage(USAGE_CACHED, REALTIME_MODEL).usd).toBeCloseTo(USD_CACHED, 12);
    expect(priceRealtimeUsage(USAGE_AUDIO_ONLY, REALTIME_MODEL).usd).toBeCloseTo(
      USD_AUDIO_ONLY,
      12,
    );
    expect(priceRealtimeUsage(USAGE_TEXT_ONLY, REALTIME_MODEL).usd).toBeCloseTo(USD_TEXT_ONLY, 12);

    // The four REFUSALS, at the source. Each is `null` — never a figure.
    for (const usage of [
      USAGE_CACHED_NO_DETAIL,
      USAGE_CACHED_CONTRADICTS,
      USAGE_NEGATIVE_ONLY,
      USAGE_EMPTY,
    ]) {
      expect(priceRealtimeUsage(usage, REALTIME_MODEL).usd).toBeNull();
    }
    // And the measured zero, which is NOT one of them.
    expect(priceRealtimeUsage(USAGE_ZERO, REALTIME_MODEL)).toMatchObject({
      measured: true,
      usd: 0,
    });
  });
});

// ---------------------------------------------------------------------------
// AC1 + AC2 — the runner captures `usage` per utterance, keyed by `utt`, and
// prices it through `priceRealtimeUsage`.
// ---------------------------------------------------------------------------

describe('TICKET 070 — a realtime run prices every utterance from the reported usage', () => {
  it('each record carries its OWN turn’s hand-derived figure, to the cent and beyond', async () => {
    const h = usageHarness({ turns: PRIMARY_TURNS });
    const { run } = await runUsage(h);

    expect(run.status).toBe('complete');
    const utterances = utterancesOf(run);
    expect(utterances).toHaveLength(4);

    // THE FIXTURE'S PREMISE: four DISTINCT figures. Equal ones could not detect
    // a mis-keyed bucket, a blend, or a swapped meter.
    expect(new Set(PRIMARY_USD).size).toBe(4);

    // THE CLAIM, against the rate card's own arithmetic. Today every one of
    // these is `null`: `costPerMinUsd` is 0 and nothing reads `usage` at all.
    utterances.forEach((u, i) => expect(u.cost).toBeCloseTo(PRIMARY_USD[i]!, 12));

    // ...and EXACTLY what the price source Live calls returns, bit for bit. A
    // reimplementation that rounds, re-orders the terms, or blends will not sit
    // on the same double.
    utterances.forEach((u, i) =>
      expect(u.cost).toBe(priceRealtimeUsage(PRIMARY_TURNS[i]!.usage, REALTIME_MODEL).usd),
    );
  });

  it('the cached subset is SUBTRACTED and re-priced, never added on top', async () => {
    const h = usageHarness({ turns: PRIMARY_TURNS });
    const { run } = await runUsage(h);

    const cached = utterancesOf(run)[1]!;
    expect(cached.cost).toBeCloseTo(USD_CACHED, 12);
    // The additive reading bills cached input at MORE than uncached input and
    // inverts prompt caching entirely — 052's named defect, refused by name.
    expect(cached.cost).not.toBeCloseTo(USD_CACHED_ADDITIVE, 6);
  });

  it('text tokens are priced at the TEXT meters, not at the audio ones', async () => {
    const h = usageHarness({ turns: PRIMARY_TURNS });
    const { run } = await runUsage(h);

    const textOnly = utterancesOf(run)[3]!;
    expect(textOnly.cost).toBeCloseTo(USD_TEXT_ONLY, 12);
    // 4.8× out on a turn that reported no audio at all.
    expect(textOnly.cost).not.toBeCloseTo(USD_TEXT_ON_AUDIO_METERS, 6);
  });

  it('the usage bucket is keyed by `utt`, like every other bucket — not by arrival order', async () => {
    // The completions arrive 2, 3, 0, 1. Every other bucket in the runner is
    // keyed by `utt` precisely so an interleaving transport cannot re-file a
    // measurement; the usage bucket is under the same rule. A fix that pushed
    // envelopes onto a list would report 0.048 / 0.02 / 0.166 / 0.10688 here.
    const h = usageHarness({
      turns: [
        { usage: USAGE_PLAIN, completeAt: 600 },
        { usage: USAGE_CACHED, completeAt: 700 },
        { usage: USAGE_AUDIO_ONLY, completeAt: 450 },
        { usage: USAGE_TEXT_ONLY, completeAt: 500 },
      ],
    });
    const { run } = await runUsage(h);

    const utterances = utterancesOf(run);
    expect(run.status).toBe('complete');
    // The transcripts confirm the buckets really were interleaved and the
    // records really are in manifest order — the cost list below is read off
    // the same four buckets.
    expect(utterances.map((u) => u.transcripts.source)).toEqual([
      'src 0',
      'src 1',
      'src 2',
      'src 3',
    ]);
    utterances.forEach((u, i) => expect(u.cost).toBeCloseTo(PRIMARY_USD[i]!, 12));
    // Named explicitly, because THIS is the list arrival order would produce.
    expect(utterances.map((u) => u.cost)).not.toEqual([
      USD_AUDIO_ONLY,
      USD_TEXT_ONLY,
      USD_PLAIN,
      USD_CACHED,
    ]);
  });

  it("the model is the RUN'S model snapshot, not a hardcoded constant", async () => {
    // `gpt-realtime-mini` is billed 10 / 20 with no text or cached sub-rates,
    // so the SAME envelope comes to 0.06 instead of 0.166: a fix that always
    // passes REALTIME_MODEL reports Arm A's price for a dev run.
    const h = usageHarness({ turns: [0, 1, 2, 3].map(() => ({ usage: USAGE_PLAIN })) });
    const { run } = await runUsage(h, {
      ...REALTIME_CONFIG,
      realtimeModel: MINI_MODEL,
    });

    // (1000×10 + 500×10 + 2000×20 + 250×20) / 1e6 = 60000 / 1e6 — text falls
    // back to the headline meters, which the card says OVERSTATES a dev run.
    const perTurn = 0.06;
    expect(priceRealtimeUsage(USAGE_PLAIN, MINI_MODEL).usd).toBeCloseTo(perTurn, 12);
    expect(run.modelSnapshots.realtime).toBe(MINI_MODEL);
    for (const u of utterancesOf(run)) expect(u.cost).toBeCloseTo(perTurn, 12);
    expect(run.cost).toBeCloseTo(perTurn * 4, 12);
    // Arm A's meter, refused by name: the same four turns at `gpt-realtime`.
    expect(run.cost).not.toBeCloseTo(USD_PLAIN * 4, 6);
  });
});

// ---------------------------------------------------------------------------
// AC3 — the Run's total is the SUM of its priced turns, and the aggregate
// counts them. `cost measured on 15 of 15 samples` becomes possible for Arm A.
// ---------------------------------------------------------------------------

describe('TICKET 070 — the Run total is the sum of its priced utterances', () => {
  it('sums to the hand-derived total, and the splits sum back to it exactly', async () => {
    const h = usageHarness({ turns: PRIMARY_TURNS });
    const { run } = await runUsage(h);

    expect(run.cost).toBeCloseTo(PRIMARY_TOTAL_USD, 12);
    const total = utterancesOf(run).reduce((sum, u) => sum + (u.cost ?? 0), 0);
    expect(total).toBeCloseTo(run.cost!, 12);
    // It is a MEASUREMENT, and it renders as one.
    expect(formatCostUsd(run.cost)).toBe('$0.341');
    // The same record was stored, money and all.
    expect(h.posted).toHaveLength(1);
    expect(h.posted[0]).toEqual(run);
  });

  it('`measuredCostSamples` reaches 4 of 4 — the shape of `15 of 15` for Arm A', async () => {
    const h = usageHarness({ turns: PRIMARY_TURNS });
    const { run } = await runUsage(h);

    const agg = aggregateOf(run);
    expect(agg.n).toBe(4);
    expect(agg.measuredCostSamples).toBe(4);
    expect(agg.measuredCostSamples).toBe(agg.n);
    expect(agg.costUsd).toBeCloseTo(PRIMARY_TOTAL_USD, 12);
  });

  it('a run with NO records still totals from the usage its one turn reported', async () => {
    // A mic-shaped realtime run: no manifest, so the run ends at the first
    // utterance boundary and carries no `utterances` key. The usage still
    // arrived, so the Run still has a total — a fix wired only into
    // `attributeUtterances` reports `null` here.
    const h = usageHarness({
      turns: [{ usage: USAGE_PLAIN }],
      recording: { ...RECORDING, utterances: undefined },
    });
    const { run } = await runUsage(h);

    expect(run.utterances).toBeUndefined();
    expect(run.cost).toBeCloseTo(USD_PLAIN, 12);
    expect(run.cost).toBe(priceRealtimeUsage(USAGE_PLAIN, REALTIME_MODEL).usd);
  });
});

// ---------------------------------------------------------------------------
// AC4 — THE SHARPEST ONE. A turn whose `response.done` omits usage prices
// `null` FOR THAT TURN ONLY, and the denominator says so.
// ---------------------------------------------------------------------------

describe('TICKET 070 — an unreported turn prices null for THAT turn, never a blend', () => {
  const MIXED_TURNS: readonly UsageTurn[] = [
    { usage: USAGE_PLAIN },
    { usage: USAGE_CACHED },
    // No `usage` key at all — the turn the vendor said nothing about.
    {},
    { usage: USAGE_TEXT_ONLY },
  ];
  /** 0.166 + 0.10688 + 0.02 — the THREE turns that reported. */
  const MIXED_TOTAL_USD = 0.29288;
  /** That total spread over four turns. The blend this test exists to refuse. */
  const MIXED_BLENDED_EACH = MIXED_TOTAL_USD / 4;

  it('three priced records, one null, and the null is the turn that went unreported', async () => {
    const h = usageHarness({ turns: MIXED_TURNS });
    const { run } = await runUsage(h);

    const utterances = utterancesOf(run);
    expect(utterances).toHaveLength(4);
    expect(utterances[2]!.cost).toBeNull();
    expect(utterances[0]!.cost).toBeCloseTo(USD_PLAIN, 12);
    expect(utterances[1]!.cost).toBeCloseTo(USD_CACHED, 12);
    expect(utterances[3]!.cost).toBeCloseTo(USD_TEXT_ONLY, 12);
    // NULL, never a zero: a turn nobody metered did not cost nothing.
    expect(utterances[2]!.cost).not.toBe(0);
    expect(formatCostUsd(utterances[2]!.cost)).toBe('not measured');

    // The unpriced turn is still a RECORD, and still a complete one: it
    // produced its audio and its transcripts. Money is the only thing missing.
    expect(utterances[2]!.status).toBe('complete');
    expect(utterances[2]!.errors).toEqual([]);
    expect(utterances[2]!.transcripts.source).toBe('src 2');
  });

  it('the total is the THREE that reported — not a four-way average of them', async () => {
    const h = usageHarness({ turns: MIXED_TURNS });
    const { run } = await runUsage(h);

    expect(run.cost).toBeCloseTo(MIXED_TOTAL_USD, 12);
    // THE BLEND, refused by name. Spreading 0.29288 over four turns gives every
    // record 0.07322 and still sums to the right total — it satisfies "the
    // total is right" and "every record has a figure" at once, and it is a
    // figure nobody measured on three of the four records.
    for (const u of utterancesOf(run)) expect(u.cost).not.toBeCloseTo(MIXED_BLENDED_EACH, 6);
  });

  it('the denominator says 3 of 4 — not 4 of 4, and `n` is still 4', async () => {
    const h = usageHarness({ turns: MIXED_TURNS });
    const { run } = await runUsage(h);

    const agg = aggregateOf(run);
    // PROVENANCE REPORTS ACTUAL N. The three-turn total relabelled `4 of 4` is
    // the other half of the blend, and it is refused here rather than in the
    // dollars — the dollars cannot tell those two apart.
    expect(agg.measuredCostSamples).toBe(3);
    expect(agg.n).toBe(4);
    expect(agg.measuredCostSamples).not.toBe(agg.n);
    expect(agg.costUsd).toBeCloseTo(MIXED_TOTAL_USD, 12);
  });

  it.each([
    { name: 'a cached count with no breakdown', usage: USAGE_CACHED_NO_DETAIL, naive: USD_CACHED_NO_DETAIL_NAIVE },
    { name: 'a breakdown contradicting its own total', usage: USAGE_CACHED_CONTRADICTS, naive: USD_CACHED_CONTRADICTS_NAIVE },
    { name: 'an envelope whose only numbers are negative', usage: USAGE_NEGATIVE_ONLY, naive: 0 },
    { name: 'an empty envelope', usage: USAGE_EMPTY, naive: 0 },
  ])(
    'NO SECOND PRICING PATH: $name prices null for that turn, and its neighbours are untouched',
    async ({ usage, naive }) => {
      // These four verdicts are `priceRealtimeUsage`'s OWN judgement and nobody
      // re-derives them by accident: a fix that multiplies tokens by rates
      // itself produces `naive` here instead of a refusal.
      const h = usageHarness({
        turns: [{ usage: USAGE_PLAIN }, { usage }, { usage: USAGE_AUDIO_ONLY }, { usage: USAGE_TEXT_ONLY }],
      });
      const { run } = await runUsage(h);

      const utterances = utterancesOf(run);
      expect(utterances[1]!.cost).toBeNull();
      expect(utterances[1]!.cost).not.toBe(naive);
      // ONE turn, not the run: the other three still price.
      expect(utterances[0]!.cost).toBeCloseTo(USD_PLAIN, 12);
      expect(utterances[2]!.cost).toBeCloseTo(USD_AUDIO_ONLY, 12);
      expect(utterances[3]!.cost).toBeCloseTo(USD_TEXT_ONLY, 12);
      expect(run.cost).toBeCloseTo(USD_PLAIN + USD_AUDIO_ONLY + USD_TEXT_ONLY, 12);
      expect(aggregateOf(run).measuredCostSamples).toBe(3);
    },
  );

  it('A MEASURED ZERO IS STILL A MEASUREMENT — `0` and `null` stay different facts', async () => {
    // Ticket 059's other half. A turn reporting `audio_tokens: 0` metered a
    // zero, and `$0.000` is the honest rendering of it. A fix that treated a
    // falsy figure as unmeasured would report this run `0 of 4`.
    const h = usageHarness({ turns: [0, 1, 2, 3].map(() => ({ usage: USAGE_ZERO })) });
    const { run } = await runUsage(h);

    const utterances = utterancesOf(run);
    expect(utterances.map((u) => u.cost)).toEqual([0, 0, 0, 0]);
    for (const u of utterances) expect(u.cost).not.toBeNull();
    expect(run.cost).toBe(0);
    expect(formatCostUsd(run.cost)).toBe('$0.000');

    const agg = aggregateOf(run);
    expect(agg.measuredCostSamples).toBe(4);
    expect(agg.costUsd).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// AC5 — THE CONTROL. A run with no usage anywhere keeps today's behaviour, so
// the fix cannot invent a figure where none was reported.
// ---------------------------------------------------------------------------

describe('TICKET 070 — CONTROL: a run with no usage anywhere still measures nothing', () => {
  const SILENT_TURNS: readonly UsageTurn[] = [{}, {}, {}, {}];

  it('every record is null, the Run is null, and it renders `not measured`', async () => {
    const h = usageHarness({ turns: SILENT_TURNS });
    const { run } = await runUsage(h);

    expect(run.status).toBe('complete');
    expect(utterancesOf(run).map((u) => u.cost)).toEqual([null, null, null, null]);
    expect(run.cost).toBeNull();
    // NEVER `$0.00`, and never a 0 that reads as "this configuration is free".
    expect(run.cost).not.toBe(0);
    expect(formatCostUsd(run.cost)).toBe('not measured');
  });

  it('`0 of 4` — the denominator the operator sees today, pinned', async () => {
    const h = usageHarness({ turns: SILENT_TURNS });
    const { run } = await runUsage(h);

    const agg = aggregateOf(run);
    expect(agg.measuredCostSamples).toBe(0);
    expect(agg.costUsd).toBeNull();
    expect(agg.n).toBe(4);
  });
});

// ---------------------------------------------------------------------------
// AC7 — CASCADE IS UNTOUCHED. Arms B and C keep `cost: null` until 053 lands.
// ---------------------------------------------------------------------------

describe('TICKET 070 — CONTROL: a cascade run is not priced through the realtime path', () => {
  it('a cascade transport reporting a realtime envelope still measures nothing', async () => {
    // `costPerMinUsd: 0` is what `browserDeps` wires for the real cascade
    // transport, and 053's per-stage metering (MT tokens, ElevenLabs
    // characters) is not this ticket. A cascade run that came back priced would
    // mean this ticket had quietly half-priced Arm B or Arm C through a meter
    // that does not describe them — and `openai-tts` structurally cannot report
    // usage at all, so Arm B's total staying null is the FINDING, not a gap.
    const h = usageHarness({ turns: PRIMARY_TURNS, kind: 'cascade' });
    const { run } = await runUsage(h, CASCADE_CONFIG);

    expect(run.status).toBe('complete');
    expect(run.architecture).toBe('cascade');
    expect(utterancesOf(run).map((u) => u.cost)).toEqual([null, null, null, null]);
    expect(run.cost).toBeNull();
    // Named explicitly: this is the figure the realtime path would have produced.
    expect(run.cost).not.toBeCloseTo(PRIMARY_TOTAL_USD, 6);
    expect(aggregateOf(run).measuredCostSamples).toBe(0);
  });

  it("the blended path is untouched for a transport that DOES declare a rate", async () => {
    // 053's `costPerMinUsd` is left in place and left unconfigured (this
    // ticket's own out-of-scope note). A fixture that declares 60 USD/min must
    // still split by manifest span exactly as ticket 031 pinned it.
    const h = usageHarness({
      turns: [{}, {}, {}, {}],
      kind: 'cascade',
      costPerMinUsd: CORPUS_COST_PER_MIN,
    });
    const { run } = await runUsage(h, CASCADE_CONFIG);

    const splits = utterancesOf(run).map((u) => u.cost);
    [0.1, 0.1, 0.1, 0.7].forEach((usd, i) => expect(splits[i]).toBeCloseTo(usd, 10));
    expect(run.cost).toBeCloseTo(1, 10);
  });
});

// ---------------------------------------------------------------------------
// AC6 — the 059 stamp survives, on a priced run and on an unpriced one.
// AC8 — `isAggregatableRun` stays the ONE gate; `n` does not move with a price.
// ---------------------------------------------------------------------------

describe('TICKET 070 — the price-source stamp is unchanged by any of this (ticket 059)', () => {
  it('a run that PRICED is stamped, and its figures read back through the stamp', async () => {
    const h = usageHarness({ turns: PRIMARY_TURNS });
    const { run } = await runUsage(h);

    expect((run as StampedRun).pricingVersion).toBe(PRICING_VERSION);
    expect((h.posted[0] as StampedRun).pricingVersion).toBe(PRICING_VERSION);
    // The stamp is what lets a stored figure re-enter the model as a
    // MEASUREMENT — the mechanism `runSamples` uses on every record.
    for (const u of utterancesOf(run)) {
      expect(costFromPriceSource(run.pricingVersion, u.cost).measured).toBe(true);
    }
  });

  it('a run that priced NOTHING is stamped just the same — the source, not the figure', async () => {
    const h = usageHarness({ turns: [{}, {}, {}, {}] });
    const { run } = await runUsage(h);

    expect(run.cost).toBeNull();
    expect((run as StampedRun).pricingVersion).toBe(PRICING_VERSION);
  });

  it('a FAILED realtime run carrying usage is stamped too', async () => {
    const h = makeHarness({
      recording: CORPUS_RECORDING,
      transportFactory: () =>
        new FixtureTransport({
          armId: 'fx',
          kind: 'realtime',
          costPerMinUsd: 0,
          script: [
            ...usageScript([{ usage: USAGE_PLAIN }]),
            { at: 300, type: 'error', message: 'realtime 503', opaque: true },
          ],
        }),
    });
    const { run } = await runUsage(h);

    expect(run.status).toBe('failed');
    expect((run as StampedRun).pricingVersion).toBe(PRICING_VERSION);
  });
});

describe('TICKET 070 — `isAggregatableRun` stays the ONE gate; a price never moves `n`', () => {
  it('priced, half-priced and unpriced runs all aggregate to the SAME `n`', async () => {
    const priced = usageHarness({ turns: PRIMARY_TURNS });
    const half = usageHarness({
      turns: [{ usage: USAGE_PLAIN }, {}, {}, { usage: USAGE_TEXT_ONLY }],
    });
    const none = usageHarness({ turns: [{}, {}, {}, {}] });

    const runs = [
      (await runUsage(priced)).run,
      (await runUsage(half)).run,
      (await runUsage(none)).run,
    ];

    // ONE GATE. Every one of these three is aggregatable on the clauses that
    // already exist — arm, origin, status, languages, realness — and NOT on
    // whether anybody could price it. An unpriced run is not an unrun run.
    const aggregates = runs.map((run) => aggregateOf(run));
    expect(aggregates.map((a) => a.n)).toEqual([4, 4, 4]);
    // Only the MONEY moves.
    expect(aggregates.map((a) => a.measuredCostSamples)).toEqual([4, 2, 0]);
    expect(aggregates[2]!.costUsd).toBeNull();
    expect(aggregates[1]!.costUsd).toBeCloseTo(USD_PLAIN + USD_TEXT_ONLY, 12);
  });
});


// ---------------------------------------------------------------------------
// THE TRAILING PAD — the clip must not end before the last turn can endpoint.
//
// WHAT BROKE, IN PRODUCTION, ON 2026-08-10: five of six corpus takes carried
// 21–640 ms of silence after the last word, because the operator hit stop when
// they stopped talking. A provider's VAD closes a turn only after it OBSERVES
// ENDPOINTING_MS of silence, so the final turn never endpointed and all 26 runs
// failed `segmentation: expected 4 utterances, observed 3` — on Arm A, B and C
// alike. The manifest said 4 because the LOCAL segmenter ends the last
// utterance at end-of-clip and needs no trailing silence at all.
//
// WHAT THESE TESTS CAN AND CANNOT PIN. FixtureTransport is scripted: it emits
// the completions it was given and models no VAD, so no unit test here can
// reproduce "observed 3". What is pinned instead is what the provider is
// HANDED — the same reasoning ticket 069's AC10 states for the leading trim —
// plus the property that makes the pad safe: it moves NOTHING.
// ---------------------------------------------------------------------------

/** 50 frames (1000 ms) of unambiguous speech: no leading silence to trim. */
const PAD_CLIP_FRAMES = TRIM_TOTAL_FRAMES;
/** What production appends, in frames. Derived here, never a second literal. */
const PAD_FRAMES = Math.ceil(TRAILING_PAD_MS / FRAME_MS);

/**
 * The corpus harness on production's OWN default: the seam is DELETED rather
 * than set, so these cases exercise the path a real run takes. (makeHarness
 * switches the pad off for every other case in this file, which is why it has
 * to be removed here rather than merely left alone.)
 */
function padHarness(opts: { trailingPadMs?: number } = {}): Harness {
  const h = trimHarness({ samples: loud(PAD_CLIP_FRAMES * FRAME_SAMPLES) });
  const deps = h.deps as RunnerDeps & { trailingPadMs?: number };
  if (opts.trailingPadMs === undefined) delete deps.trailingPadMs;
  else deps.trailingPadMs = opts.trailingPadMs;
  return h;
}

/** Long enough for the clip AND the pad: 2 s of advance would truncate pacing. */
async function runPadded(h: Harness) {
  const done = start(h);
  await vi.advanceTimersByTimeAsync(10_000);
  return done;
}

describe('the trailing pad gives the VAD its window', () => {
  it('is longer than the endpointing window it exists to satisfy', () => {
    // The whole point: a pad <= ENDPOINTING_MS cannot close the last turn, and
    // one exactly equal has no room for jitter or the final frame's duration.
    expect(TRAILING_PAD_MS).toBeGreaterThan(ENDPOINTING_MS);
    expect(TRAILING_PAD_MS).toBe(ENDPOINTING_MS + 500);
  });

  it('appends PAD_FRAMES of digital silence AFTER the clip, on the default path', async () => {
    const h = padHarness();
    await runPadded(h);

    const received = h.transports[0]!.received;
    expect(received).toHaveLength(PAD_CLIP_FRAMES + PAD_FRAMES);

    // The clip's own frames are untouched and still first...
    const clipFrames = received.slice(0, PAD_CLIP_FRAMES);
    for (const frame of clipFrames) {
      expect(Array.from(frame).every((sample) => sample === 0)).toBe(false);
    }
    // ...and every appended frame is a full frame of pure zeros. Both halves
    // matter: a pad of noise would be something for the STT to transcribe, and
    // a short pad would not close the turn.
    const padded = received.slice(PAD_CLIP_FRAMES);
    expect(padded).toHaveLength(PAD_FRAMES);
    for (const frame of padded) {
      expect(frame.length).toBe(FRAME_SAMPLES);
      expect(Array.from(frame).every((sample) => sample === 0)).toBe(true);
    }
    // And it really is long enough to satisfy the window, stated in ms.
    expect(padded.length * FRAME_MS).toBeGreaterThan(ENDPOINTING_MS);
  });

  it('is paced at 1x like every other frame — silence sent in a burst is not silence', async () => {
    // A pad flushed at socket speed occupies no TIME, and time is the only
    // thing a VAD is counting. This is the assertion that catches that fix.
    const h = padHarness();
    const { t0 } = await runPadded(h);

    expect(h.sendTimes).toHaveLength(PAD_CLIP_FRAMES + PAD_FRAMES);
    for (let k = 0; k < h.sendTimes.length; k += 1) {
      expect(Math.abs(h.sendTimes[k]! - t0 - k * FRAME_MS)).toBeLessThanOrEqual(1);
    }
    expect(h.sendTimes.at(-1)! - t0).toBeGreaterThanOrEqual(
      (PAD_CLIP_FRAMES + PAD_FRAMES - 1) * FRAME_MS - 1,
    );
  });

  it('MOVES NOTHING: every anchor and transcript matches the same run with no pad', async () => {
    // Pure addition after the last real frame — contrast the leading trim,
    // which had to withhold transmission precisely because touching the clip's
    // START would have dragged every manifest anchor with it.
    const padded = padHarness();
    const withPad = await runPadded(padded);

    const control = padHarness({ trailingPadMs: 0 });
    const noPad = await runPadded(control);

    const anchorsWith = utterancesOf(withPad.run).map((u) => u.timings.speech_end!);
    const anchorsWithout = utterancesOf(noPad.run).map((u) => u.timings.speech_end!);
    expect(anchorsWith).toEqual([100, 200, 300, 400].map((ms) => withPad.t0 + ms));
    expect(anchorsWith.map((t) => t - withPad.t0)).toEqual(
      anchorsWithout.map((t) => t - noPad.t0),
    );
    expect(withPad.run.timings.speech_end! - withPad.t0).toBe(
      noPad.run.timings.speech_end! - noPad.t0,
    );
    expect(withPad.run.status).toBe('complete');
    expect(noPad.run.status).toBe('complete');
    expect(utterancesOf(withPad.run).map((u) => u.transcripts.source)).toEqual(
      utterancesOf(noPad.run).map((u) => u.transcripts.source),
    );

    // AND THE PAD ACTUALLY HAPPENED — without this the equalities above are
    // satisfied by an implementation that appends nothing.
    expect(padded.transports[0]!.received).toHaveLength(PAD_CLIP_FRAMES + PAD_FRAMES);
    expect(control.transports[0]!.received).toHaveLength(PAD_CLIP_FRAMES);
    // The audio the provider heard is byte-identical up to the clip's end.
    expect(transmitted(control)).toEqual(transmitted(padded).slice(0, PAD_CLIP_FRAMES * FRAME_SAMPLES));
  });
});
