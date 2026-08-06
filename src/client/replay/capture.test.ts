/**
 * Ticket 035 — startTake acceptance tests.
 *
 * PRD §7 Replay step 1: "Record a clip — maximum 1 minute. It is saved and
 * appears in the UI." This file pins the CORE: 24 kHz PCM16 + WAV out, the
 * 1-minute cap enforced by the module itself, denial that starts nothing, and
 * a stop() that is idempotent and releases the mic.
 *
 * Every audio seam is injected exactly as src/client/audio/capture.test.ts
 * does — no real AudioContext or getUserMedia ever exists in jsdom. The cap is
 * driven by an injected timer seam, so no wall-clock time passes either.
 */

import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { readWav } from '../../harness/wav';
import type { CaptureAudioContextLike, MediaStreamLike } from '../audio/capture';
import {
  CORPUS_TAKE_MS,
  MAX_TAKE_MS,
  startTake,
  type StartTakeOptions,
  type TakeRecorder,
  type TakeTimers,
} from './capture';

const RATE = 24_000;

interface FakeTimers {
  timers: TakeTimers;
  scheduled: Array<{ id: number; fn: () => void; ms: number }>;
  cleared: number[];
  fireAll: () => void;
}

function fakeTimers(): FakeTimers {
  const scheduled: FakeTimers['scheduled'] = [];
  const cleared: number[] = [];
  let nextId = 1;
  return {
    timers: {
      setTimeout: (fn, ms) => {
        const id = nextId++;
        scheduled.push({ id, fn, ms });
        return id;
      },
      clearTimeout: (id) => {
        cleared.push(id);
      },
    },
    scheduled,
    cleared,
    fireAll: () => {
      for (const t of [...scheduled]) t.fn();
    },
  };
}

interface Harness {
  opts: StartTakeOptions;
  pipeline: ReturnType<typeof vi.fn>;
  teardown: ReturnType<typeof vi.fn>;
  contextFactory: ReturnType<typeof vi.fn>;
  onMaxDuration: ReturnType<typeof vi.fn>;
  onLevel: ReturnType<typeof vi.fn>;
  stops: ReturnType<typeof vi.fn>[];
  clock: FakeTimers;
  getEmit: () => (samples: Float32Array) => void;
}

function makeHarness(
  overrides: {
    getUserMedia?: StartTakeOptions['getUserMedia'];
    sampleRate?: number;
    maxDurationMs?: number;
  } = {},
): Harness {
  const sampleRate = overrides.sampleRate ?? RATE;
  const stops = [vi.fn(), vi.fn()];
  const stream: MediaStreamLike = { getTracks: () => stops.map((stop) => ({ stop })) };
  const teardown = vi.fn();
  let emit: ((samples: Float32Array) => void) | null = null;
  const pipeline = vi.fn((args: { emit: (s: Float32Array) => void }) => {
    emit = args.emit;
    return teardown;
  });
  const contextFactory = vi.fn(() => ({ sampleRate }));
  const onMaxDuration = vi.fn();
  const onLevel = vi.fn();
  const clock = fakeTimers();
  return {
    opts: {
      getUserMedia: overrides.getUserMedia ?? (vi.fn(async () => stream) as StartTakeOptions['getUserMedia']),
      audioContextFactory: contextFactory as unknown as () => CaptureAudioContextLike,
      pipeline: pipeline as unknown as StartTakeOptions['pipeline'],
      onLevel,
      timers: clock.timers,
      onMaxDuration,
      ...(overrides.maxDurationMs === undefined ? {} : { maxDurationMs: overrides.maxDurationMs }),
    },
    pipeline,
    teardown,
    contextFactory,
    onMaxDuration,
    onLevel,
    stops,
    clock,
    getEmit: () => {
      if (!emit) throw new Error('pipeline was never invoked');
      return emit;
    },
  };
}

async function startGranted(h: Harness): Promise<TakeRecorder> {
  const result = await startTake(h.opts);
  if ('status' in result) throw new Error(`expected a recorder, got denied:${result.reason}`);
  return result;
}

/** A constant-amplitude float frame; `count` samples at the pipeline's rate. */
function frame(count: number, value = 0.5): Float32Array {
  return new Float32Array(count).fill(value);
}

describe('startTake — permission denial (existing four-value model, unchanged)', () => {
  const cases: Array<[string, string, 'blocked' | 'unavailable']> = [
    ['NotAllowedError', 'NotAllowedError', 'blocked'],
    ['NotFoundError', 'NotFoundError', 'unavailable'],
  ];

  for (const [label, name, reason] of cases) {
    it(`${label} -> { status: 'denied', reason: '${reason}' } and starts no context or pipeline`, async () => {
      const err = new Error('nope');
      err.name = name;
      const h = makeHarness({ getUserMedia: vi.fn(async () => Promise.reject(err)) as StartTakeOptions['getUserMedia'] });
      const result = await startTake(h.opts);
      expect(result).toEqual({ status: 'denied', reason });
      expect(h.contextFactory).not.toHaveBeenCalled();
      expect(h.pipeline).not.toHaveBeenCalled();
      expect(h.clock.scheduled).toHaveLength(0);
    });
  }
});

describe('startTake — the recorded take is 24 kHz mono PCM16 + WAV', () => {
  it('accumulates emitted frames and round-trips through readWav at rate 24000', async () => {
    const h = makeHarness();
    const recorder = await startGranted(h);
    // 24 kHz in, so the resample is a copy: 4 x 480 samples = 1920 = 80 ms.
    for (let i = 0; i < 4; i++) h.getEmit()(frame(480));

    const take = await recorder.stop();
    expect(take.samples).toBeInstanceOf(Int16Array);
    expect(take.samples.length).toBe(1920);
    // 0.5 float -> 16384 int16 (pcm.floatTo16's asymmetric mapping).
    expect(Math.abs(take.samples[100]! - 16384)).toBeLessThanOrEqual(1);
    expect(take.durationMs).toBe(80);

    const decoded = readWav(take.wav);
    expect(decoded.rate).toBe(RATE);
    expect(decoded.samples.length).toBe(take.samples.length);
    expect(Array.from(decoded.samples.slice(0, 8))).toEqual(Array.from(take.samples.slice(0, 8)));
  });

  it('downsamples a 48 kHz pipeline to 24 kHz — half as many samples out', async () => {
    const h = makeHarness({ sampleRate: 48_000 });
    const recorder = await startGranted(h);
    h.getEmit()(frame(1920)); // 40 ms @48k -> 960 samples @24k
    const take = await recorder.stop();
    expect(take.samples.length).toBe(960);
    expect(take.durationMs).toBe(40);
    expect(readWav(take.wav).rate).toBe(RATE);
  });

  it('forwards mic level bars while recording', async () => {
    const h = makeHarness();
    const recorder = await startGranted(h);
    h.getEmit()(new Float32Array(480)); // silence
    expect(h.onLevel).toHaveBeenLastCalledWith(0);
    h.getEmit()(frame(480, 0.5));
    expect(h.onLevel).toHaveBeenLastCalledWith(5);
    await recorder.stop();
  });
});

describe('startTake — the 1-minute cap stops the take BY ITSELF', () => {
  it('exposes the PRD constants', () => {
    expect(MAX_TAKE_MS).toBe(60_000);
    expect(CORPUS_TAKE_MS).toBe(45_000);
  });

  it('schedules exactly one cap timer at MAX_TAKE_MS by default', async () => {
    const h = makeHarness();
    await startGranted(h);
    expect(h.clock.scheduled).toHaveLength(1);
    expect(h.clock.scheduled[0]!.ms).toBe(MAX_TAKE_MS);
  });

  it('clamps a longer requested cap down to MAX_TAKE_MS, and honours a shorter one', async () => {
    const long = makeHarness({ maxDurationMs: 90_000 });
    await startGranted(long);
    expect(long.clock.scheduled[0]!.ms).toBe(MAX_TAKE_MS);

    const short = makeHarness({ maxDurationMs: CORPUS_TAKE_MS });
    await startGranted(short);
    expect(short.clock.scheduled[0]!.ms).toBe(CORPUS_TAKE_MS);
  });

  it('firing the cap releases the mic, reports the take, and retains no later frames', async () => {
    const h = makeHarness();
    const recorder = await startGranted(h);
    for (let i = 0; i < 2; i++) h.getEmit()(frame(480));

    h.clock.fireAll();

    expect(h.onMaxDuration).toHaveBeenCalledTimes(1);
    const capped = h.onMaxDuration.mock.calls[0]![0] as { samples: Int16Array; durationMs: number };
    expect(capped.samples.length).toBe(960);
    expect(capped.durationMs).toBe(40);
    for (const stop of h.stops) expect(stop).toHaveBeenCalledTimes(1);
    expect(h.teardown).toHaveBeenCalledTimes(1);

    // Frames after the cap are discarded, and stop() yields the same take.
    h.getEmit()(frame(480));
    const take = await recorder.stop();
    expect(take.samples.length).toBe(960);
    expect(h.onMaxDuration).toHaveBeenCalledTimes(1);
  });
});

describe('startTake — stop() and cancel() release the mic', () => {
  it('stop() releases every track, tears down the pipeline, and clears the cap timer', async () => {
    const h = makeHarness();
    const recorder = await startGranted(h);
    h.getEmit()(frame(480));
    await recorder.stop();
    for (const stop of h.stops) expect(stop).toHaveBeenCalledTimes(1);
    expect(h.teardown).toHaveBeenCalledTimes(1);
    expect(h.clock.cleared).toEqual([h.clock.scheduled[0]!.id]);
    expect(h.onMaxDuration).not.toHaveBeenCalled();
  });

  it('stop() is idempotent — same take, tracks released exactly once', async () => {
    const h = makeHarness();
    const recorder = await startGranted(h);
    h.getEmit()(frame(480));
    const first = await recorder.stop();
    const second = await recorder.stop();
    expect(second.samples.length).toBe(first.samples.length);
    expect(second.durationMs).toBe(first.durationMs);
    expect(Array.from(second.wav.slice(0, 44))).toEqual(Array.from(first.wav.slice(0, 44)));
    for (const stop of h.stops) expect(stop).toHaveBeenCalledTimes(1);
    expect(h.teardown).toHaveBeenCalledTimes(1);
  });

  it('no samples are accumulated after stop, even if the pipeline keeps emitting', async () => {
    const h = makeHarness();
    const recorder = await startGranted(h);
    h.getEmit()(frame(480));
    await recorder.stop();
    h.getEmit()(frame(480));
    h.getEmit()(frame(480));
    const again = await recorder.stop();
    expect(again.samples.length).toBe(480);
    expect(h.onLevel).toHaveBeenCalledTimes(1);
  });

  it('cancel() releases the mic, clears the cap timer, and fires no onMaxDuration', async () => {
    const h = makeHarness();
    const recorder = await startGranted(h);
    h.getEmit()(frame(480));
    recorder.cancel();
    for (const stop of h.stops) expect(stop).toHaveBeenCalledTimes(1);
    expect(h.teardown).toHaveBeenCalledTimes(1);
    expect(h.clock.cleared).toEqual([h.clock.scheduled[0]!.id]);
    h.clock.fireAll();
    expect(h.onMaxDuration).not.toHaveBeenCalled();
  });
});

describe('startTake — there is exactly one getUserMedia path in the client', () => {
  it('replay/capture.ts delegates to audio/capture.ts rather than calling getUserMedia itself', () => {
    const source = readFileSync(
      resolve(process.cwd(), 'src/client/replay/capture.ts'),
      'utf8',
    ).replace(/\/\*[\s\S]*?\*\//g, '');
    expect(source).toMatch(/from '\.\.\/audio\/capture'/);
    expect(source).toMatch(/\bstartCapture\b/);
    // The seams are forwarded; the mic is never opened a second way here.
    expect(source).not.toMatch(/navigator/);
    expect(source).not.toMatch(/mediaDevices/);
  });
});
