/**
 * Ticket 007 — pacer.ts acceptance tests.
 *
 * Everything runs on VIRTUAL time: vi.useFakeTimers() + vi.setSystemTime(0),
 * with the pacer's clock and scheduler injected through `deps` so it never
 * reaches for Date.now/setTimeout itself. No test sleeps for real — the whole
 * file must finish in milliseconds even though it asserts a full second of
 * 1x playback.
 *
 * The load-bearing assertions live in `1x pacing`: an implementation that
 * dumps the buffer as fast as the consumer accepts it must fail loudly there.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { SAMPLE_RATE } from '../../core/protocol';
import { createPacer, FRAME_MS, FRAME_SAMPLES, type Pacer } from './pacer';

/** The framing the whole project pins: 20 ms at 24 kHz. */
const MS = 20;
const N = 480;

/** Distinct, non-repeating-ish sample values so concatenation is falsifiable. */
const ramp = (n: number): Int16Array =>
  Int16Array.from({ length: n }, (_, i) => ((i * 7919) % 65536) - 32768);

function concat(frames: Int16Array[]): Int16Array {
  const total = frames.reduce((acc, f) => acc + f.length, 0);
  const out = new Int16Array(total);
  let offset = 0;
  for (const f of frames) {
    out.set(f, offset);
    offset += f.length;
  }
  return out;
}

interface Harness {
  pacer: Pacer;
  /** Frames handed to onFrame, in order. */
  frames: Int16Array[];
  /** Virtual time (ms since t0) at which each frame was emitted. */
  times: number[];
  setTimeoutSpy: ReturnType<typeof vi.fn>;
}

function makeHarness(
  samples: Int16Array,
  opts: {
    signal?: AbortSignal;
    /** Runs inside onFrame, before the frame is recorded's slot ends. */
    onEachFrame?: (index: number) => void;
  } = {},
): Harness {
  const frames: Int16Array[] = [];
  const times: number[] = [];
  const setTimeoutSpy = vi.fn((fn: () => void, ms: number): unknown =>
    globalThis.setTimeout(fn, ms),
  );
  const clearTimeoutSpy = vi.fn((handle: unknown): void => {
    globalThis.clearTimeout(handle as ReturnType<typeof globalThis.setTimeout>);
  });

  const pacer = createPacer({
    samples,
    onFrame: (frame: Int16Array) => {
      const index = frames.length;
      frames.push(frame);
      times.push(Date.now());
      opts.onEachFrame?.(index);
    },
    signal: opts.signal,
    deps: {
      now: () => Date.now(),
      setTimeout: setTimeoutSpy as PacerSetTimeout,
      clearTimeout: clearTimeoutSpy,
    },
  });

  return { pacer, frames, times, setTimeoutSpy };
}

type PacerSetTimeout = (fn: () => void, ms: number) => unknown;

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(0);
});

afterEach(() => {
  vi.useRealTimers();
});

// ---------------------------------------------------------------------------

describe('framing constants', () => {
  it('exposes FRAME_MS and FRAME_SAMPLES derived from SAMPLE_RATE', () => {
    expect(FRAME_MS).toBe(MS);
    expect(FRAME_SAMPLES).toBe(N);
    // Derived, not two independent literals: a SAMPLE_RATE change must move
    // FRAME_SAMPLES with it.
    expect(FRAME_SAMPLES).toBe((SAMPLE_RATE * FRAME_MS) / 1000);
  });
});

describe('framing', () => {
  const cases: { label: string; samples: number }[] = [
    { label: 'empty clip', samples: 0 },
    { label: 'far under one frame', samples: 1 },
    { label: 'one under a frame', samples: N - 1 },
    { label: 'exactly one frame', samples: N },
    { label: 'one over a frame', samples: N + 1 },
    { label: 'exact multiple of the frame size', samples: N * 3 },
    { label: 'multiple plus a partial remainder', samples: N * 3 + 7 },
  ];

  it.each(cases)(
    '$label ($samples samples): ceil(n/480) frames, full frames + whole remainder, sample-identical',
    async ({ samples }) => {
      const clip = ramp(samples);
      const h = makeHarness(clip);
      const expectedFrames = Math.ceil(samples / N);

      const done = h.pacer.start();
      await vi.advanceTimersByTimeAsync(expectedFrames * MS + 100);
      await done;

      expect(h.frames).toHaveLength(expectedFrames);
      for (const frame of h.frames) expect(frame).toBeInstanceOf(Int16Array);
      // Every frame but the last is exactly 480; the last carries the rest.
      for (let i = 0; i < h.frames.length - 1; i++) {
        expect(h.frames[i]!.length).toBe(N);
      }
      if (expectedFrames > 0) {
        const remainder = samples % N;
        expect(h.frames[expectedFrames - 1]!.length).toBe(remainder === 0 ? N : remainder);
      }
      // Order + content: concatenation is sample-identical to the input.
      expect(Array.from(concat(h.frames))).toEqual(Array.from(clip));
    },
  );

  it('an empty clip emits nothing and completes immediately', async () => {
    const h = makeHarness(new Int16Array(0));
    let resolved = false;
    const done = h.pacer.start().then(() => {
      resolved = true;
    });

    await vi.advanceTimersByTimeAsync(0);
    expect(resolved).toBe(true);
    expect(h.frames).toHaveLength(0);

    await vi.advanceTimersByTimeAsync(1000);
    expect(h.frames).toHaveLength(0);
    await done;
  });
});

// ---------------------------------------------------------------------------

describe('1x pacing', () => {
  it('emits frame k at ~k*20 ms of virtual time (a 1 s clip costs ~1000 ms, not ~0)', async () => {
    const clip = ramp(SAMPLE_RATE); // exactly 1 second => 50 frames
    const h = makeHarness(clip);

    let resolved = false;
    const done = h.pacer.start().then(() => {
      resolved = true;
    });

    // A dump would have emitted everything here, at virtual time ~0.
    await vi.advanceTimersByTimeAsync(0);
    expect(h.frames.length).toBe(1);

    await vi.advanceTimersByTimeAsync(960); // now = 960; frame 49 is due at 980
    expect(resolved).toBe(false);

    await vi.advanceTimersByTimeAsync(40); // now = 1000
    expect(resolved).toBe(true);
    await done;

    expect(h.frames).toHaveLength(50);
    for (let k = 0; k < h.times.length; k++) {
      expect(Math.abs(h.times[k]! - k * MS)).toBeLessThanOrEqual(1);
    }
    // The pacer scheduled through the INJECTED seam, not a captured global.
    expect(h.setTimeoutSpy).toHaveBeenCalled();
  });

  it('does not run ahead: at virtual time T only floor(T/20)+1 frames exist', async () => {
    const h = makeHarness(ramp(SAMPLE_RATE)); // 50 frames
    const done = h.pacer.start();

    const checkpoints: { advanceBy: number; at: number }[] = [
      { advanceBy: 0, at: 0 },
      { advanceBy: 10, at: 10 },
      { advanceBy: 10, at: 20 },
      { advanceBy: 19, at: 39 },
      { advanceBy: 1, at: 40 },
      { advanceBy: 60, at: 100 },
      { advanceBy: 400, at: 500 },
    ];

    for (const { advanceBy, at } of checkpoints) {
      await vi.advanceTimersByTimeAsync(advanceBy);
      expect(Date.now()).toBe(at);
      expect(h.frames.length).toBe(Math.floor(at / MS) + 1);
    }

    await vi.advanceTimersByTimeAsync(1000);
    await done;
  });

  it('re-anchors to t0 after a slow consumer instead of drifting permanently late', async () => {
    // 20 frames; the consumer burns 50 ms (2.5 slots) inside frame 1.
    const h = makeHarness(ramp(N * 20), {
      onEachFrame: (index) => {
        if (index === 1) vi.setSystemTime(Date.now() + 50);
      },
    });

    const done = h.pacer.start();
    await vi.advanceTimersByTimeAsync(2000);
    await done;

    expect(h.frames).toHaveLength(20);
    expect(h.times[0]).toBe(0);
    expect(h.times[1]).toBe(MS);
    // Frames 2 and 3 were overdue when the consumer gave the clock back: they
    // are emitted (never dropped) and caught up at once, not one slot apart.
    expect(h.times[2]!).toBeLessThanOrEqual(71);
    expect(h.times[3]!).toBeLessThanOrEqual(71);
    // THE criterion: from the first frame whose slot is still in the future,
    // the schedule is back on t0 + k*20 — the 50 ms did NOT shift every later
    // frame by 50 ms (which is what a cumulative `sleep(20)` loop would do).
    for (let k = 4; k < h.times.length; k++) {
      expect(Math.abs(h.times[k]! - k * MS)).toBeLessThanOrEqual(1);
    }
    // The clip did not silently stretch beyond 1x.
    expect(h.times[19]!).toBeLessThanOrEqual(19 * MS + 1);
  });
});

// ---------------------------------------------------------------------------

describe('cancellation', () => {
  it('cancel() mid-clip stops promptly, emits no further frames, completes cleanly', async () => {
    const h = makeHarness(ramp(SAMPLE_RATE)); // 50 frames / 1000 ms
    let resolved = false;
    let rejection: unknown = null;
    const done = h.pacer
      .start()
      .then(() => {
        resolved = true;
      })
      .catch((err: unknown) => {
        rejection = err;
      });

    await vi.advanceTimersByTimeAsync(100); // frames 0..5
    expect(h.frames).toHaveLength(6);

    h.pacer.cancel();
    await vi.advanceTimersByTimeAsync(25); // within one frame slot: prompt
    expect(resolved).toBe(true);
    expect(rejection).toBeNull();
    expect(h.frames).toHaveLength(6);

    await vi.advanceTimersByTimeAsync(2000);
    await done;
    expect(h.frames).toHaveLength(6); // nothing leaked out later
    expect(vi.getTimerCount()).toBe(0); // no leaked timer
  });

  it('aborting the signal mid-clip stops emission the same way', async () => {
    const controller = new AbortController();
    const h = makeHarness(ramp(SAMPLE_RATE), { signal: controller.signal });
    let resolved = false;
    const done = h.pacer.start().then(() => {
      resolved = true;
    });

    await vi.advanceTimersByTimeAsync(100);
    expect(h.frames).toHaveLength(6);

    controller.abort();
    await vi.advanceTimersByTimeAsync(25);
    expect(resolved).toBe(true);
    expect(h.frames).toHaveLength(6);

    await vi.advanceTimersByTimeAsync(2000);
    await done;
    expect(h.frames).toHaveLength(6);
    expect(vi.getTimerCount()).toBe(0);
  });

  it.each([
    { label: 'cancel() before start()', preAborted: false },
    { label: 'an already-aborted signal', preAborted: true },
  ])('$label emits nothing at all', async ({ preAborted }) => {
    const controller = new AbortController();
    if (preAborted) controller.abort();
    const h = makeHarness(ramp(SAMPLE_RATE), { signal: controller.signal });
    if (!preAborted) h.pacer.cancel();

    let resolved = false;
    const done = h.pacer.start().then(() => {
      resolved = true;
    });

    await vi.advanceTimersByTimeAsync(0);
    expect(resolved).toBe(true);
    expect(h.frames).toHaveLength(0);

    await vi.advanceTimersByTimeAsync(2000);
    await done;
    expect(h.frames).toHaveLength(0);
    expect(vi.getTimerCount()).toBe(0);
  });
});
