/**
 * Ticket 043 — createOutboundAudioSink acceptance tests.
 *
 * This is the PRODUCTION half of the outbound seam: the thing browserDeps hands
 * a microphone-less RealtimeTransport. jsdom has neither AudioContext nor
 * MediaStreamAudioDestinationNode, so the context is injected and every Web
 * Audio call the module makes is asserted here.
 *
 * The two claims that matter: the context runs at 24 kHz (so paced PCM16 needs
 * NO resampling in the measured path — AGENTS.md records that OpenAI rejects
 * 16 kHz), and one write schedules exactly one contiguous buffer, so the sink
 * can never drain the clip faster than the pacer feeds it.
 */
import { describe, expect, it } from 'vitest';
import { SAMPLE_RATE } from '../../core/protocol';
import {
  OUTBOUND_SAMPLE_RATE,
  createOutboundAudioSink,
  type OutboundAudioContextLike,
  type OutboundBufferLike,
  type OutboundDestinationLike,
  type OutboundSourceLike,
} from './outboundAudio';

interface StartedSource {
  length: number;
  connectedTo: unknown[];
  startedAt: number | undefined;
  data: Float32Array;
}

/** A promise whose settlement a test controls — R3-6's close sequencing. */
function makeGate() {
  let resolve!: () => void;
  const promise = new Promise<void>((res) => {
    resolve = res;
  });
  return { promise, resolve };
}

interface FakeContextOptions {
  /** Make `ctx.close()` reject, as a wedged hardware context can. */
  closeRejects?: boolean;
}

function makeFakeContext(options: FakeContextOptions = {}) {
  const buffers: { channels: number; length: number; sampleRate: number; data: Float32Array }[] = [];
  const sources: StartedSource[] = [];
  const factoryArgs: { sampleRate: number }[] = [];
  const destinations: OutboundDestinationLike[] = [];
  const track = { kind: 'audio', tag: 'outbound-track' };
  const state = { closes: 0 };
  /**
   * TICKET 046 ROUND 3 (R3-6) — a real `AudioContext.close()` is asynchronous,
   * and this gate is what lets a test hold it open. Round 2 made the INBOUND
   * tap's close awaitable because a realtime Replay run holds TWO contexts
   * against Chrome's ~6-context cap; this sink is the other one, and it was
   * left fire-and-forget while `runner.ts`'s comment claimed both were covered.
   */
  const closeGate = makeGate();

  const ctx: OutboundAudioContextLike = {
    currentTime: 0,
    createBuffer: (channels, length, sampleRate): OutboundBufferLike => {
      const entry = { channels, length, sampleRate, data: new Float32Array(length) };
      buffers.push(entry);
      return { getChannelData: () => entry.data };
    },
    createBufferSource: (): OutboundSourceLike => {
      const entry: StartedSource = {
        length: 0,
        connectedTo: [],
        startedAt: undefined,
        data: new Float32Array(0),
      };
      sources.push(entry);
      const src: OutboundSourceLike = {
        buffer: null,
        connect: (node) => entry.connectedTo.push(node),
        start: (when) => {
          // Read at start(), so a source started before its buffer is assigned
          // is visible as an empty one rather than passing silently.
          const b = src.buffer;
          if (b !== null) {
            entry.data = b.getChannelData(0);
            entry.length = entry.data.length;
          }
          entry.startedAt = when;
        },
      };
      return src;
    },
    createMediaStreamDestination: (): OutboundDestinationLike => {
      const dest = { stream: { getAudioTracks: () => [track] } };
      destinations.push(dest);
      return dest;
    },
    close: () => {
      state.closes += 1;
      if (options.closeRejects === true) return Promise.reject(new Error('context wedged'));
      return closeGate.promise;
    },
  };

  const audioContextFactory = (options: { sampleRate: number }): OutboundAudioContextLike => {
    factoryArgs.push(options);
    return ctx;
  };

  return {
    ctx,
    buffers,
    sources,
    factoryArgs,
    destinations,
    track,
    state,
    closeGate,
    audioContextFactory,
  };
}

describe('createOutboundAudioSink — 24 kHz, never 16 kHz (ticket 043)', () => {
  it('OUTBOUND_SAMPLE_RATE is the wire rate, derived and not a second literal', () => {
    expect(OUTBOUND_SAMPLE_RATE).toBe(SAMPLE_RATE);
    expect(OUTBOUND_SAMPLE_RATE).toBe(24_000);
    expect(OUTBOUND_SAMPLE_RATE).not.toBe(16_000);
  });

  it('builds the context ONCE, at 24 000 Hz, and takes its track from the destination stream', () => {
    const fake = makeFakeContext();
    const sink = createOutboundAudioSink({ audioContextFactory: fake.audioContextFactory });

    expect(fake.factoryArgs).toEqual([{ sampleRate: 24_000 }]);
    expect(fake.destinations).toHaveLength(1);
    // The track has to exist before the offer is created, so it is eager.
    expect(sink.track).toBe(fake.track);
  });

  it('writes buffers at 24 kHz too — a context rate and a buffer rate that disagree resample silently', () => {
    const fake = makeFakeContext();
    const sink = createOutboundAudioSink({ audioContextFactory: fake.audioContextFactory });

    sink.write(new Int16Array(480));
    expect(fake.buffers).toEqual([
      expect.objectContaining({ channels: 1, length: 480, sampleRate: 24_000 }),
    ]);
  });
});

describe('createOutboundAudioSink — paced delivery (ticket 043)', () => {
  it('converts PCM16 to float and routes it to the DESTINATION node', () => {
    const fake = makeFakeContext();
    const sink = createOutboundAudioSink({ audioContextFactory: fake.audioContextFactory });

    sink.write(new Int16Array([0, 16384, -16384, 32767, -32768]));

    expect(fake.sources).toHaveLength(1);
    const src = fake.sources[0]!;
    expect(Array.from(src.data)).toEqual([0, 0.5, -0.5, 32767 / 32768, -1]);
    expect(src.connectedTo).toEqual([fake.destinations[0]]);
  });

  it('ONE source per write, scheduled CONTIGUOUSLY — never a burst that outruns the pacer', () => {
    // The sink must not accumulate frames and release them faster than real
    // time: that invalidates VAD and every latency figure, and it looks like it
    // worked. Frame k begins exactly where frame k-1 ended.
    const fake = makeFakeContext();
    const sink = createOutboundAudioSink({ audioContextFactory: fake.audioContextFactory });

    const frameSeconds = 480 / 24_000; // 20 ms
    for (let k = 0; k < 4; k++) sink.write(new Int16Array(480));

    expect(fake.sources).toHaveLength(4);
    for (let k = 0; k < 4; k++) {
      expect(fake.sources[k]!.length).toBe(480);
      expect(fake.sources[k]!.startedAt).toBeCloseTo(k * frameSeconds, 9);
    }
  });

  it('never schedules in the past: a context whose clock has run on starts from currentTime', () => {
    const fake = makeFakeContext();
    const sink = createOutboundAudioSink({ audioContextFactory: fake.audioContextFactory });

    sink.write(new Int16Array(480));
    fake.ctx.currentTime = 5; // the pacer fell behind / the run started late
    sink.write(new Int16Array(480));

    expect(fake.sources[1]!.startedAt).toBe(5);
  });

  it('an EMPTY frame schedules nothing', () => {
    const fake = makeFakeContext();
    const sink = createOutboundAudioSink({ audioContextFactory: fake.audioContextFactory });

    sink.write(new Int16Array(0));
    expect(fake.sources).toHaveLength(0);
    expect(fake.buffers).toHaveLength(0);
  });
});

describe('createOutboundAudioSink — close() (ticket 043)', () => {
  it('closes the context, idempotently, and later writes are inert', () => {
    const fake = makeFakeContext();
    const sink = createOutboundAudioSink({ audioContextFactory: fake.audioContextFactory });

    sink.write(new Int16Array(480));
    void sink.close();
    void sink.close();
    expect(fake.state.closes).toBe(1);

    // A paced frame that lands after stop() must not throw: it would fail a run
    // that had already produced every measurement it was going to.
    expect(() => sink.write(new Int16Array(480))).not.toThrow();
    expect(fake.sources).toHaveLength(1);
  });
});

/* ===========================================================================
 * TICKET 046 ROUND 3 (R3-6) — the context close is SEQUENCED, not fired and
 * forgotten. The exact mirror of `inboundAudio.ts`'s R2-7 close.
 *
 * A realtime Replay run holds TWO AudioContexts: this sink and the inbound tap.
 * Chrome caps concurrent hardware contexts at roughly six, so across a 60-run
 * sweep a lagging close is what eventually makes a construction throw and kills
 * a run. Round 2 fixed the tap and left this one — while `runner.ts`'s comment
 * explained the await by saying the run holds two. A comment claiming protection
 * the code does not give is worse than either half alone.
 * ======================================================================== */

describe('createOutboundAudioSink — close() awaits the context (round 3, R3-6)', () => {
  it('returns a promise that settles only once ctx.close() has settled', async () => {
    const fake = makeFakeContext();
    const sink = createOutboundAudioSink({ audioContextFactory: fake.audioContextFactory });
    sink.write(new Int16Array(480));

    const order: string[] = [];
    const closed = Promise.resolve(sink.close()).then(() => order.push('sink.close resolved'));

    // Idempotent AND still awaitable: a second caller gets the same close, not a
    // second `ctx.close()` and not a promise that resolves early.
    expect(sink.close()).toBeInstanceOf(Promise);
    expect(fake.state.closes).toBe(1);

    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();
    expect(order).toEqual([]);

    order.push('ctx.close settled');
    fake.closeGate.resolve();
    await closed;
    expect(order).toEqual(['ctx.close settled', 'sink.close resolved']);
  });

  it('a context that FAILS to close does not reject the caller — nothing can act on it', async () => {
    // Same rule as the inbound tap: a wedged context is not something a run can
    // act on, and rejecting here would surface as an unhandled rejection in the
    // middle of a sweep.
    const fake = makeFakeContext({ closeRejects: true });
    const sink = createOutboundAudioSink({ audioContextFactory: fake.audioContextFactory });
    await expect(Promise.resolve(sink.close())).resolves.toBeUndefined();
  });

  it('writes after the close has settled are still inert', async () => {
    const fake = makeFakeContext();
    const sink = createOutboundAudioSink({ audioContextFactory: fake.audioContextFactory });

    const closed = Promise.resolve(sink.close());
    fake.closeGate.resolve();
    await closed;

    expect(() => sink.write(new Int16Array(480))).not.toThrow();
    expect(fake.sources).toHaveLength(0);
  });
});
