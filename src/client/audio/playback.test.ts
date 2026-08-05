/**
 * Ticket 010 — playback.ts acceptance tests, driven entirely by a fake
 * AudioContext implementing the minimal surface documented in playback.ts:
 * createBuffer / createBufferSource / destination / currentTime / resume /
 * suspend.
 */
import { describe, expect, it } from 'vitest';
import {
  ArmPlayback,
  type PlaybackAudioContextLike,
  type PlaybackBufferLike,
  type PlaybackSourceLike,
} from './playback';

class FakeBuffer implements PlaybackBufferLike {
  data: Float32Array;
  constructor(
    public numChannels: number,
    public length: number,
    public sampleRate: number,
  ) {
    this.data = new Float32Array(length);
  }
  getChannelData(_channel: number): Float32Array {
    return this.data;
  }
}

class FakeSource implements PlaybackSourceLike {
  buffer: PlaybackBufferLike | null = null;
  onended: (() => void) | null = null;
  startCalls: number[] = [];
  connectedTo: unknown[] = [];
  stopped = false;
  connect(node: unknown): void {
    this.connectedTo.push(node);
  }
  start(when = 0): void {
    this.startCalls.push(when);
  }
  stop(): void {
    this.stopped = true;
  }
}

class FakeAudioContext implements PlaybackAudioContextLike {
  buffers: FakeBuffer[] = [];
  sources: FakeSource[] = [];
  destination = { fake: 'destination' };
  currentTime = 0;
  resumeCalls = 0;
  suspendCalls = 0;
  createBuffer(numChannels: number, length: number, sampleRate: number): FakeBuffer {
    const b = new FakeBuffer(numChannels, length, sampleRate);
    this.buffers.push(b);
    return b;
  }
  createBufferSource(): FakeSource {
    const s = new FakeSource();
    this.sources.push(s);
    return s;
  }
  resume(): void {
    this.resumeCalls++;
  }
  suspend(): void {
    this.suspendCalls++;
  }
  /** Sources that have had start() called, in creation order. */
  get started(): FakeSource[] {
    return this.sources.filter((s) => s.startCalls.length > 0);
  }
}

function makeHarness(autoplay: boolean) {
  const ctx = new FakeAudioContext();
  const clock = { t: 1000 };
  const playback = new ArmPlayback({
    audioContextFactory: () => ctx,
    autoplay,
    now: () => clock.t,
  });
  return { ctx, clock, playback };
}

const chunk = (len: number, value = 1000): Int16Array => new Int16Array(len).fill(value);

describe('audioQueuedAt', () => {
  it('is null before any enqueue', () => {
    const { playback } = makeHarness(true);
    expect(playback.audioQueuedAt).toBeNull();
  });

  it('is captured exactly once at the FIRST enqueue (autoplay=true)', () => {
    const { playback, clock } = makeHarness(true);
    playback.enqueue(chunk(480));
    expect(playback.audioQueuedAt).toBe(1000);
    clock.t = 2000;
    playback.enqueue(chunk(480));
    expect(playback.audioQueuedAt).toBe(1000); // never overwritten
  });

  it('is captured at first enqueue even when autoplay=false (no playback yet)', () => {
    const { playback, clock, ctx } = makeHarness(false);
    playback.enqueue(chunk(480));
    expect(playback.audioQueuedAt).toBe(1000);
    expect(ctx.started).toHaveLength(0); // buffered, not playing
    clock.t = 3000;
    playback.enqueue(chunk(480));
    expect(playback.audioQueuedAt).toBe(1000);
  });

  it('reset() clears it so the next utterance captures a fresh time', () => {
    const { playback, clock } = makeHarness(true);
    playback.enqueue(chunk(480));
    playback.reset();
    expect(playback.audioQueuedAt).toBeNull();
    clock.t = 5000;
    playback.enqueue(chunk(480));
    expect(playback.audioQueuedAt).toBe(5000);
  });
});

describe('autoplay=true', () => {
  it('starts a source per enqueued chunk as chunks arrive', () => {
    const { playback, ctx } = makeHarness(true);
    playback.enqueue(chunk(480));
    expect(ctx.started).toHaveLength(1);
    playback.enqueue(chunk(240));
    expect(ctx.started).toHaveLength(2);
  });

  it('creates 24kHz mono buffers with converted samples and connects to destination', () => {
    const { playback, ctx } = makeHarness(true);
    playback.enqueue(new Int16Array(480).fill(16384));
    const buf = ctx.buffers[0]!;
    expect(buf.numChannels).toBe(1);
    expect(buf.length).toBe(480);
    expect(buf.sampleRate).toBe(24000);
    expect(Math.abs(buf.data[0]! - 0.5)).toBeLessThan(1e-3); // 16384/32768
    const src = ctx.started[0]!;
    expect(src.buffer).toBe(buf);
    expect(src.connectedTo).toContain(ctx.destination);
  });
});

describe('autoplay=false buffering', () => {
  it('starts nothing until play(), then plays from chunk 0 in order', () => {
    const { playback, ctx } = makeHarness(false);
    playback.enqueue(chunk(480, 111));
    playback.enqueue(chunk(240, 222));
    expect(ctx.started).toHaveLength(0);
    playback.play();
    expect(ctx.started).toHaveLength(2);
    // chunk 0 first: its buffer holds the 111-valued samples
    const first = ctx.started[0]!.buffer as FakeBuffer;
    expect(first.length).toBe(480);
    expect(Math.abs(first.data[0]! - 111 / 32768)).toBeLessThan(1e-4);
    const second = ctx.started[1]!.buffer as FakeBuffer;
    expect(second.length).toBe(240);
  });

  it('play() resumes the context (autoplay-policy safety)', () => {
    const { playback, ctx } = makeHarness(false);
    playback.enqueue(chunk(480));
    playback.play();
    expect(ctx.resumeCalls).toBeGreaterThanOrEqual(1);
  });

  it('chunks enqueued after play() start immediately', () => {
    const { playback, ctx } = makeHarness(false);
    playback.enqueue(chunk(480));
    playback.play();
    expect(ctx.started).toHaveLength(1);
    playback.enqueue(chunk(480));
    expect(ctx.started).toHaveLength(2);
  });
});

describe('pause', () => {
  it('pause() suspends the context', () => {
    const { playback, ctx } = makeHarness(true);
    playback.enqueue(chunk(480));
    playback.pause();
    expect(ctx.suspendCalls).toBe(1);
  });
});

describe('durationMs', () => {
  it('accumulates from sample counts at 24kHz regardless of autoplay', () => {
    for (const autoplay of [true, false]) {
      const { playback } = makeHarness(autoplay);
      expect(playback.durationMs).toBe(0);
      playback.enqueue(chunk(480)); // 20 ms
      expect(playback.durationMs).toBeCloseTo(20, 5);
      playback.enqueue(chunk(480)); // 40 ms total
      expect(playback.durationMs).toBeCloseTo(40, 5);
      playback.enqueue(chunk(240)); // 50 ms total
      expect(playback.durationMs).toBeCloseTo(50, 5);
    }
  });

  it('reset() zeroes durationMs', () => {
    const { playback } = makeHarness(true);
    playback.enqueue(chunk(480));
    playback.reset();
    expect(playback.durationMs).toBe(0);
  });
});

describe('onEnded', () => {
  it('fires once after ALL started sources complete', () => {
    const { playback, ctx } = makeHarness(true);
    let endedCount = 0;
    playback.onEnded(() => endedCount++);
    playback.enqueue(chunk(480));
    playback.enqueue(chunk(480));
    const [a, b] = ctx.started;
    a!.onended?.();
    expect(endedCount).toBe(0); // one source still playing
    b!.onended?.();
    expect(endedCount).toBe(1);
  });

  it('does not fire while more buffered chunks are pending (autoplay=false, before play)', () => {
    const { playback } = makeHarness(false);
    let endedCount = 0;
    playback.onEnded(() => endedCount++);
    playback.enqueue(chunk(480));
    expect(endedCount).toBe(0);
  });
});
