/**
 * Ticket 046 — createInboundAudioTap acceptance tests.
 *
 * This is the PRODUCTION half of the inbound seam: the thing buildReplayDeps
 * hands a Replay RealtimeTransport so Arm A's media-track audio becomes bytes.
 * jsdom has neither AudioContext nor MediaStream, so the context is injected
 * and every Web Audio call the module makes is asserted here.
 *
 * The claims that matter: the capture runs at 24 kHz MONO PCM16 (so Arm A's
 * uploaded audio is byte-format-identical to cascade's and blind compare cannot
 * tell the arms apart by format), and capturing is SILENT (nothing in Replay
 * autoplays, PRD §7).
 */
import { describe, expect, it } from 'vitest';
import { SAMPLE_RATE } from '../../core/protocol';
import type { RtcMediaStreamLike } from '../transport/realtime';
import {
  INBOUND_SAMPLE_RATE,
  createInboundAudioTap,
  type InboundAudioContextLike,
  type InboundGainLike,
  type InboundProcessorLike,
  type InboundSourceNodeLike,
} from './inboundAudio';

interface FakeNode {
  kind: 'source' | 'processor' | 'gain';
  connectedTo: unknown[];
  disconnects: number;
  /** Only for gains. */
  gain?: { value: number };
  /** Only for the stream source. */
  stream?: unknown;
}

function makeFakeContext() {
  const nodes: FakeNode[] = [];
  const processors: InboundProcessorLike[] = [];
  const processorArgs: { bufferSize: number; inputChannels: number; outputChannels: number }[] = [];
  const factoryArgs: { sampleRate: number }[] = [];
  const state = { closes: 0 };
  const destination = { tag: 'ctx-destination' };

  const ctx: InboundAudioContextLike = {
    sampleRate: 24_000,
    destination,
    createMediaStreamSource: (stream): InboundSourceNodeLike => {
      const entry: FakeNode = { kind: 'source', connectedTo: [], disconnects: 0, stream };
      nodes.push(entry);
      return {
        connect: (node) => entry.connectedTo.push(node),
        disconnect: () => {
          entry.disconnects += 1;
        },
      };
    },
    createScriptProcessor: (bufferSize, inputChannels, outputChannels): InboundProcessorLike => {
      processorArgs.push({ bufferSize, inputChannels, outputChannels });
      const entry: FakeNode = { kind: 'processor', connectedTo: [], disconnects: 0 };
      nodes.push(entry);
      const proc: InboundProcessorLike = {
        onaudioprocess: null,
        connect: (node) => entry.connectedTo.push(node),
        disconnect: () => {
          entry.disconnects += 1;
        },
      };
      processors.push(proc);
      return proc;
    },
    createGain: (): InboundGainLike => {
      const entry: FakeNode = { kind: 'gain', connectedTo: [], disconnects: 0, gain: { value: 1 } };
      nodes.push(entry);
      return {
        gain: entry.gain!,
        connect: (node) => entry.connectedTo.push(node),
        disconnect: () => {
          entry.disconnects += 1;
        },
      };
    },
    close: () => {
      state.closes += 1;
    },
  };

  const audioContextFactory = (options: { sampleRate: number }): InboundAudioContextLike => {
    factoryArgs.push(options);
    return ctx;
  };

  /** Push one Web Audio render quantum through EVERY live processor. */
  const emit = (frame: Float32Array): void => {
    for (const proc of processors) {
      proc.onaudioprocess?.({ inputBuffer: { getChannelData: () => frame } });
    }
  };

  return { ctx, nodes, processors, processorArgs, factoryArgs, state, destination, emit, audioContextFactory };
}

/** A minimal remote MediaStream, tagged so assertions can name which one. */
const fakeStream = (tag: string): RtcMediaStreamLike & { tag: string } => ({
  tag,
  getAudioTracks: () => [{ kind: 'audio' }],
});

describe('createInboundAudioTap — 24 kHz mono PCM16, matching cascade (ticket 046)', () => {
  it('INBOUND_SAMPLE_RATE is the wire rate, derived and not a second literal', () => {
    expect(INBOUND_SAMPLE_RATE).toBe(SAMPLE_RATE);
    expect(INBOUND_SAMPLE_RATE).toBe(24_000);
    expect(INBOUND_SAMPLE_RATE).not.toBe(16_000);
  });

  it('builds the context ONCE, at 24 000 Hz', () => {
    const fake = makeFakeContext();
    createInboundAudioTap({ audioContextFactory: fake.audioContextFactory });
    expect(fake.factoryArgs).toEqual([{ sampleRate: 24_000 }]);
  });

  it('captures MONO: the capture node takes one input channel and reads channel 0', () => {
    const fake = makeFakeContext();
    const tap = createInboundAudioTap({ audioContextFactory: fake.audioContextFactory });
    tap.attach(fakeStream('remote'));

    expect(fake.processorArgs).toHaveLength(1);
    const args = fake.processorArgs[0]!;
    expect(args.inputChannels).toBe(1);
    expect(args.outputChannels).toBe(1);
    // A power-of-two render block, as Web Audio requires.
    expect([256, 512, 1024, 2048, 4096, 8192, 16384]).toContain(args.bufferSize);

    fake.emit(Float32Array.from([0.25, -0.25]));
    expect(Array.from(tap.take())).toEqual([8192, -8192]);
  });

  it('converts float to PCM16 with FULL-SCALE CLAMPING — the exact cascade format', () => {
    const fake = makeFakeContext();
    const tap = createInboundAudioTap({ audioContextFactory: fake.audioContextFactory });
    tap.attach(fakeStream('remote'));

    // 1.0 must not wrap to -32768, and out-of-range float (Web Audio permits it)
    // must clamp rather than alias into loud garbage.
    fake.emit(Float32Array.from([0, 0.5, -0.5, 1, -1, 2, -2]));
    expect(Array.from(tap.take())).toEqual([0, 16384, -16384, 32767, -32768, 32767, -32768]);
  });

  it('routes the ATTACHED stream, and accumulates frames in ARRIVAL ORDER', () => {
    const fake = makeFakeContext();
    const tap = createInboundAudioTap({ audioContextFactory: fake.audioContextFactory });
    const stream = fakeStream('remote');
    tap.attach(stream);

    const source = fake.nodes.find((n) => n.kind === 'source');
    expect(source?.stream).toBe(stream);

    fake.emit(Float32Array.from([0.25]));
    fake.emit(Float32Array.from([-0.25]));
    fake.emit(Float32Array.from([0.5]));
    expect(Array.from(tap.take())).toEqual([8192, -8192, 16384]);
  });

  it('take() is NON-DESTRUCTIVE, so the runner can read it after stop() closed the tap', () => {
    const fake = makeFakeContext();
    const tap = createInboundAudioTap({ audioContextFactory: fake.audioContextFactory });
    tap.attach(fakeStream('remote'));
    fake.emit(Float32Array.from([0.5, -0.5]));

    expect(Array.from(tap.take())).toEqual([16384, -16384]);
    expect(Array.from(tap.take())).toEqual([16384, -16384]);
    tap.close();
    expect(Array.from(tap.take())).toEqual([16384, -16384]);
  });

  it('captures NOTHING before attach, and take() on an unattached tap is empty', () => {
    const fake = makeFakeContext();
    const tap = createInboundAudioTap({ audioContextFactory: fake.audioContextFactory });
    expect(tap.take()).toHaveLength(0);
    // No stream, no graph: nothing is built speculatively.
    expect(fake.nodes).toEqual([]);
  });
});

describe('createInboundAudioTap — capture is SILENT (ticket 046, PRD §7)', () => {
  it('never sounds the stream: every path to ctx.destination runs through a ZERO gain', () => {
    // A ScriptProcessor needs a sink to be pulled, so a route to the
    // destination is permitted — but Replay autoplays NOTHING, so anything
    // reaching the speakers must be silenced at a gain node.
    const fake = makeFakeContext();
    const tap = createInboundAudioTap({ audioContextFactory: fake.audioContextFactory });
    tap.attach(fakeStream('remote'));
    fake.emit(Float32Array.from([0.5]));

    const intoDestination = fake.nodes.filter((n) => n.connectedTo.includes(fake.destination));
    for (const node of intoDestination) {
      expect(node.kind).toBe('gain');
      expect(node.gain?.value).toBe(0);
    }
  });
});

describe('createInboundAudioTap — reconnect and close (ticket 046)', () => {
  it('a SECOND attach appends to the same recording and releases the old source', () => {
    const fake = makeFakeContext();
    const tap = createInboundAudioTap({ audioContextFactory: fake.audioContextFactory });

    tap.attach(fakeStream('first'));
    fake.emit(Float32Array.from([0.25]));
    const firstSource = fake.nodes.find((n) => n.kind === 'source')!;

    tap.attach(fakeStream('second'));
    expect(firstSource.disconnects).toBeGreaterThanOrEqual(1);
    // ONE context for the tap's whole life — a reconnect must not leak one.
    expect(fake.factoryArgs).toHaveLength(1);

    fake.emit(Float32Array.from([-0.25]));
    // One run is ONE recording, whatever the connection did underneath.
    expect(Array.from(tap.take())).toEqual([8192, -8192]);
  });

  it('close() closes the context idempotently, and later frames are inert', () => {
    const fake = makeFakeContext();
    const tap = createInboundAudioTap({ audioContextFactory: fake.audioContextFactory });
    tap.attach(fakeStream('remote'));
    fake.emit(Float32Array.from([0.5]));

    tap.close();
    tap.close();
    expect(fake.state.closes).toBe(1);

    // A frame that lands after stop() must not throw, and must not extend the
    // recording the run already uploaded.
    expect(() => fake.emit(Float32Array.from([0.25]))).not.toThrow();
    expect(Array.from(tap.take())).toEqual([16384]);
  });
});
