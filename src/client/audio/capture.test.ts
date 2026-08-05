/**
 * Ticket 010 — capture.ts acceptance tests. All audio machinery is behind
 * injectable seams (getUserMedia, audioContextFactory, pipeline) so no real
 * AudioContext ever exists in jsdom.
 */
import { describe, expect, it, vi } from 'vitest';
import {
  startCapture,
  type CaptureAudioContextLike,
  type MediaStreamLike,
  type StartCaptureOptions,
} from './capture';

function fakeStream(trackCount = 2): {
  stream: MediaStreamLike;
  stops: ReturnType<typeof vi.fn>[];
} {
  const stops = Array.from({ length: trackCount }, () => vi.fn());
  const stream: MediaStreamLike = {
    getTracks: () => stops.map((stop) => ({ stop })),
  };
  return { stream, stops };
}

interface Harness {
  opts: StartCaptureOptions;
  onChunk: ReturnType<typeof vi.fn>;
  onLevel: ReturnType<typeof vi.fn>;
  pipeline: ReturnType<typeof vi.fn>;
  teardown: ReturnType<typeof vi.fn>;
  contextFactory: ReturnType<typeof vi.fn>;
  getEmit: () => (samples: Float32Array) => void;
  stops: ReturnType<typeof vi.fn>[];
}

function makeHarness(
  getUserMedia: StartCaptureOptions['getUserMedia'] | 'granted',
  sampleRate = 48000,
): Harness {
  const { stream, stops } = fakeStream();
  const gum =
    getUserMedia === 'granted'
      ? vi.fn(async () => stream)
      : getUserMedia;
  const onChunk = vi.fn();
  const onLevel = vi.fn();
  const teardown = vi.fn();
  let emit: ((samples: Float32Array) => void) | null = null;
  const pipeline = vi.fn(
    (args: { context: CaptureAudioContextLike; emit: (s: Float32Array) => void }) => {
      emit = args.emit;
      return teardown;
    },
  );
  const contextFactory = vi.fn(() => ({ sampleRate }));
  return {
    opts: {
      getUserMedia: gum as StartCaptureOptions['getUserMedia'],
      audioContextFactory: contextFactory as unknown as () => CaptureAudioContextLike,
      pipeline: pipeline as unknown as StartCaptureOptions['pipeline'],
      onChunk,
      onLevel,
    },
    onChunk,
    onLevel,
    pipeline,
    teardown,
    contextFactory,
    getEmit: () => {
      if (!emit) throw new Error('pipeline was never invoked');
      return emit;
    },
    stops,
  };
}

describe('startCapture permission mapping (four-value model)', () => {
  it('resolved getUserMedia -> granted with a stop handle', async () => {
    const h = makeHarness('granted');
    const result = await startCapture(h.opts);
    expect(result.status).toBe('granted');
    if (result.status !== 'granted') return;
    expect(typeof result.handle.stop).toBe('function');
    expect(h.pipeline).toHaveBeenCalledTimes(1);
  });

  it('NotAllowedError rejection -> denied with reason "blocked"', async () => {
    const err = new Error('Permission denied');
    err.name = 'NotAllowedError';
    const h = makeHarness(vi.fn(async () => Promise.reject(err)));
    const result = await startCapture(h.opts);
    expect(result).toEqual({ status: 'denied', reason: 'blocked' });
  });

  it('non-NotAllowed rejection -> denied with DISTINCT reason "unavailable"', async () => {
    const err = new Error('Requested device not found');
    err.name = 'NotFoundError';
    const h = makeHarness(vi.fn(async () => Promise.reject(err)));
    const result = await startCapture(h.opts);
    expect(result).toEqual({ status: 'denied', reason: 'unavailable' });
  });

  it('on denial, neither the context nor the pipeline are created', async () => {
    const err = new Error('nope');
    err.name = 'NotAllowedError';
    const h = makeHarness(vi.fn(async () => Promise.reject(err)));
    await startCapture(h.opts);
    expect(h.contextFactory).not.toHaveBeenCalled();
    expect(h.pipeline).not.toHaveBeenCalled();
  });
});

describe('startCapture audio path', () => {
  it('resamples 48k pipeline frames to 24k and chunks into 480-sample Int16 frames', async () => {
    const h = makeHarness('granted', 48000);
    await startCapture(h.opts);
    // 960 samples @48k -> 480 @24k -> exactly one chunk.
    h.getEmit()(new Float32Array(960).fill(0.5));
    expect(h.onChunk).toHaveBeenCalledTimes(1);
    const chunk = h.onChunk.mock.calls[0]![0] as Int16Array;
    expect(chunk).toBeInstanceOf(Int16Array);
    expect(chunk.length).toBe(480);
    // 0.5 float -> ~16384 int16
    expect(Math.abs(chunk[100]! - 16384)).toBeLessThanOrEqual(1);
  });

  it('carries chunker remainder across emits', async () => {
    const h = makeHarness('granted', 48000);
    await startCapture(h.opts);
    const emit = h.getEmit();
    emit(new Float32Array(480).fill(0.25)); // -> 240 @24k, below one frame
    expect(h.onChunk).not.toHaveBeenCalled();
    emit(new Float32Array(480).fill(0.25)); // total 480 -> one frame
    expect(h.onChunk).toHaveBeenCalledTimes(1);
    expect((h.onChunk.mock.calls[0]![0] as Int16Array).length).toBe(480);
  });

  it('reports level bars per emitted frame: 0 for silence, 5 for full-scale sine', async () => {
    const h = makeHarness('granted', 48000);
    await startCapture(h.opts);
    const emit = h.getEmit();
    emit(new Float32Array(960)); // silence
    expect(h.onLevel).toHaveBeenLastCalledWith(0);
    const sine = new Float32Array(960);
    for (let i = 0; i < sine.length; i++) sine[i] = Math.sin((2 * Math.PI * 440 * i) / 48000);
    emit(sine);
    expect(h.onLevel).toHaveBeenLastCalledWith(5);
    expect(h.onLevel).toHaveBeenCalledTimes(2);
  });
});

describe('startCapture stop()', () => {
  it('releases every track and runs the pipeline teardown', async () => {
    const h = makeHarness('granted');
    const result = await startCapture(h.opts);
    if (result.status !== 'granted') throw new Error('expected granted');
    result.handle.stop();
    for (const stop of h.stops) expect(stop).toHaveBeenCalledTimes(1);
    expect(h.teardown).toHaveBeenCalledTimes(1);
  });

  it('emits no further onChunk/onLevel after stop, even if emit keeps firing', async () => {
    const h = makeHarness('granted', 48000);
    const result = await startCapture(h.opts);
    if (result.status !== 'granted') throw new Error('expected granted');
    h.getEmit()(new Float32Array(960).fill(0.5));
    expect(h.onChunk).toHaveBeenCalledTimes(1);
    result.handle.stop();
    h.getEmit()(new Float32Array(960).fill(0.5));
    expect(h.onChunk).toHaveBeenCalledTimes(1);
    expect(h.onLevel).toHaveBeenCalledTimes(1);
  });

  it('stop is idempotent', async () => {
    const h = makeHarness('granted');
    const result = await startCapture(h.opts);
    if (result.status !== 'granted') throw new Error('expected granted');
    result.handle.stop();
    expect(() => result.handle.stop()).not.toThrow();
    for (const stop of h.stops) expect(stop).toHaveBeenCalledTimes(1);
  });
});
