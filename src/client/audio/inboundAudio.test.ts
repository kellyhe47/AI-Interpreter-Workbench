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
 *
 * ============================ ROUND 2 ======================================
 * An independent reviewer deleted things this module must do and the whole
 * suite stayed green. Three of those holes are closed here:
 *
 *  R2-2  THE GRAPH IS CONNECTED. The old fake called `onaudioprocess` directly,
 *        so nothing depended on any node being wired: all three `connect()`
 *        calls could be deleted with the suite green. In a real browser an
 *        unconnected ScriptProcessorNode is never pulled, so Arm A would
 *        silently capture nothing. The fake now records EDGES, and the graph
 *        source -> processor -> gain -> ctx.destination is asserted — which is
 *        also what makes the AC7 "gain is 0" claim non-vacuous.
 *
 *  R2-4  CAPTURE IS GATED to the model's speaking windows. Capturing from
 *        track-attach to stop() makes an Arm A file the whole ~45 s run —
 *        leading silence, inter-utterance gaps, comfort noise — while cascade's
 *        is a few seconds of gapless TTS. BlindCompare plays the whole stored
 *        WAV, so an evaluator would tell the arms apart in the first second:
 *        AC2's wording met, its PURPOSE defeated. Frames outside a window are
 *        DROPPED, not buffered, and a named tail grace keeps the last syllable.
 *
 *        ROUND 3 — the gate is ASYMMETRIC, and deliberately so. The ONSET side
 *        is safe for free: `output_audio_buffer.started` LEADS the audio it
 *        announces (the event is on the data channel; the sound is still in the
 *        receiver's jitter buffer), so opening a window early can only admit
 *        extra leading silence — it can never clip an onset. The TAIL side has
 *        the mirror-image problem and no free protection, which is what
 *        INBOUND_TAIL_GRACE_MS buys and why R3-2 raised it to 750 ms.
 *
 *  R2-5  ONE PCM16 CONVENTION. This module reimplemented pcm.ts's `floatTo16`
 *        with a DIFFERENT scale (`v * 32768` clamped, vs pcm.ts's asymmetric
 *        `v < 0 ? v * 32768 : v * 32767`), so the client's two capture paths
 *        could drift apart by 1 LSB and then independently. pcm.ts's convention
 *        is the one that survives, because it is the one the microphone path,
 *        the WAV writer and every stored recording already use.
 * ==========================================================================
 */
import { describe, expect, it } from 'vitest';
import { SAMPLE_RATE } from '../../core/protocol';
import type { RtcMediaStreamLike } from '../transport/realtime';
import {
  INBOUND_SAMPLE_RATE,
  INBOUND_TAIL_GRACE_MS,
  INBOUND_TAIL_GRACE_SAMPLES,
  createInboundAudioTap,
  type InboundAudioContextLike,
  type InboundGainLike,
  type InboundProcessorLike,
  type InboundSourceNodeLike,
} from './inboundAudio';
import { floatTo16 } from './pcm';

interface FakeNode {
  kind: 'source' | 'processor' | 'gain';
  /**
   * The object handed BACK to the module. R2-2: edges are recorded as the very
   * objects `connect()` was called with, so "source -> processor" is a claim
   * about the graph the module built and not about the order it built it in.
   */
  node: unknown;
  connectedTo: unknown[];
  disconnects: number;
  /** Only for gains. */
  gain?: { value: number };
  /** Only for the stream source. */
  stream?: unknown;
}

/** A promise whose settlement a test controls — R2-7's close sequencing. */
function makeGate() {
  let resolve!: () => void;
  let reject!: (e: unknown) => void;
  const promise = new Promise<void>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

interface FakeContextOptions {
  /** Make `ctx.close()` reject, as a wedged hardware context can. */
  closeRejects?: boolean;
}

function makeFakeContext(options: FakeContextOptions = {}) {
  const nodes: FakeNode[] = [];
  const processors: InboundProcessorLike[] = [];
  const processorArgs: { bufferSize: number; inputChannels: number; outputChannels: number }[] = [];
  const factoryArgs: { sampleRate: number }[] = [];
  const state = { closes: 0 };
  const destination = { tag: 'ctx-destination' };
  const closeGate = makeGate();

  const ctx: InboundAudioContextLike = {
    sampleRate: 24_000,
    destination,
    createMediaStreamSource: (stream): InboundSourceNodeLike => {
      const entry: FakeNode = {
        kind: 'source',
        node: null,
        connectedTo: [],
        disconnects: 0,
        stream,
      };
      const node: InboundSourceNodeLike = {
        connect: (target) => entry.connectedTo.push(target),
        disconnect: () => {
          entry.disconnects += 1;
        },
      };
      entry.node = node;
      nodes.push(entry);
      return node;
    },
    createScriptProcessor: (bufferSize, inputChannels, outputChannels): InboundProcessorLike => {
      processorArgs.push({ bufferSize, inputChannels, outputChannels });
      const entry: FakeNode = { kind: 'processor', node: null, connectedTo: [], disconnects: 0 };
      const proc: InboundProcessorLike = {
        onaudioprocess: null,
        connect: (target) => entry.connectedTo.push(target),
        disconnect: () => {
          entry.disconnects += 1;
        },
      };
      entry.node = proc;
      nodes.push(entry);
      processors.push(proc);
      return proc;
    },
    createGain: (): InboundGainLike => {
      const entry: FakeNode = {
        kind: 'gain',
        node: null,
        connectedTo: [],
        disconnects: 0,
        gain: { value: 1 },
      };
      const node: InboundGainLike = {
        gain: entry.gain!,
        connect: (target) => entry.connectedTo.push(target),
        disconnect: () => {
          entry.disconnects += 1;
        },
      };
      entry.node = node;
      nodes.push(entry);
      return node;
    },
    close: () => {
      state.closes += 1;
      if (options.closeRejects === true) return Promise.reject(new Error('context wedged'));
      return closeGate.promise;
    },
  };

  const audioContextFactory = (opts: { sampleRate: number }): InboundAudioContextLike => {
    factoryArgs.push(opts);
    return ctx;
  };

  /** What an edge target IS, by identity — a node kind, or the destination. */
  const labelOf = (target: unknown): string => {
    if (target === destination) return 'destination';
    return nodes.find((n) => n.node === target)?.kind ?? 'UNKNOWN';
  };

  /** Every edge in the graph the module built, as `from -> to`. */
  const edges = (): string[] =>
    nodes.flatMap((n) => n.connectedTo.map((t) => `${n.kind} -> ${labelOf(t)}`));

  /** Push one Web Audio render quantum through EVERY live processor. */
  const emit = (frame: Float32Array): void => {
    for (const proc of processors) {
      proc.onaudioprocess?.({ inputBuffer: { getChannelData: () => frame } });
    }
  };

  return {
    ctx,
    nodes,
    processors,
    processorArgs,
    factoryArgs,
    state,
    destination,
    closeGate,
    labelOf,
    edges,
    emit,
    audioContextFactory,
  };
}

/** A minimal remote MediaStream, tagged so assertions can name which one. */
const fakeStream = (tag: string): RtcMediaStreamLike & { tag: string } => ({
  tag,
  getAudioTracks: () => [{ kind: 'audio' }],
});

/**
 * An ATTACHED, OPEN tap — the state every capture assertion below is about.
 * The gate (R2-4) is shut until the model starts speaking, so a test that only
 * attached would be asserting against a deliberately silent tap.
 */
function openTap(fake: ReturnType<typeof makeFakeContext>, tag = 'remote') {
  const tap = createInboundAudioTap({ audioContextFactory: fake.audioContextFactory });
  tap.attach(fakeStream(tag));
  tap.startWindow();
  return tap;
}

const f32 = (...values: number[]): Float32Array => Float32Array.from(values);

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
    const tap = openTap(fake);

    expect(fake.processorArgs).toHaveLength(1);
    const args = fake.processorArgs[0]!;
    expect(args.inputChannels).toBe(1);
    expect(args.outputChannels).toBe(1);
    // A power-of-two render block, as Web Audio requires.
    expect([256, 512, 1024, 2048, 4096, 8192, 16384]).toContain(args.bufferSize);

    fake.emit(f32(0.25, -0.25));
    expect(Array.from(tap.take())).toEqual([8192, -8192]);
  });

  it('routes the ATTACHED stream, and accumulates frames in ARRIVAL ORDER', () => {
    const fake = makeFakeContext();
    const tap = createInboundAudioTap({ audioContextFactory: fake.audioContextFactory });
    const stream = fakeStream('remote');
    tap.attach(stream);
    tap.startWindow();

    const source = fake.nodes.find((n) => n.kind === 'source');
    expect(source?.stream).toBe(stream);

    fake.emit(f32(0.25));
    fake.emit(f32(-0.25));
    fake.emit(f32(0.5));
    expect(Array.from(tap.take())).toEqual([8192, -8192, 16384]);
  });

  it('take() is NON-DESTRUCTIVE, so the runner can read it after stop() closed the tap', () => {
    const fake = makeFakeContext();
    const tap = openTap(fake);
    fake.emit(f32(0.5, -0.5));

    expect(Array.from(tap.take())).toEqual([16384, -16384]);
    expect(Array.from(tap.take())).toEqual([16384, -16384]);
    void tap.close();
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

/* ===========================================================================
 * R2-5 — ONE PCM16 convention across the client's two capture paths.
 * ======================================================================== */

describe('createInboundAudioTap — PCM16 conversion is pcm.ts’s, not a second one', () => {
  it('uses the ASYMMETRIC scale: +1 -> 32767 via *32767, -1 -> -32768 via *32768', () => {
    const fake = makeFakeContext();
    const tap = openTap(fake);

    // 0.75 is where the two conventions disagree: 0.75 * 32768 = 24576, but
    // pcm.ts's positive scale gives round(0.75 * 32767) = 24575. One LSB today,
    // two independently drifting encoders tomorrow.
    fake.emit(f32(0, 0.5, -0.5, 0.75, -0.75, 1, -1));
    expect(Array.from(tap.take())).toEqual([0, 16384, -16384, 24575, -24576, 32767, -32768]);
  });

  it('CLAMPS out-of-range float rather than aliasing it — Web Audio permits |v| > 1', () => {
    const fake = makeFakeContext();
    const tap = openTap(fake);
    fake.emit(f32(2, -2, 1.0001, -1.0001));
    expect(Array.from(tap.take())).toEqual([32767, -32768, 32767, -32768]);
  });

  it('AGREES SAMPLE-FOR-SAMPLE with pcm.ts floatTo16, the microphone path’s encoder', () => {
    // The two client capture paths must be one encoder. If this ever fails, an
    // Arm A file and a cascade file are no longer byte-comparable and blind
    // compare has a format tell.
    const frame = f32(
      0, 0.75, -0.75, 0.1, -0.1, 0.3333, -0.3333, 0.5, -0.5, 0.999_9, -0.999_9, 1, -1, 2, -2,
    );
    const fake = makeFakeContext();
    const tap = openTap(fake);
    fake.emit(frame);

    expect(Array.from(tap.take())).toEqual(Array.from(floatTo16(frame)));
  });
});

/* ===========================================================================
 * R2-2 — the Web Audio graph is really CONNECTED.
 *
 * The fake drives `onaudioprocess` directly, so no other test in this file can
 * tell a connected graph from a disconnected one: all three `connect()` calls
 * were deletable with the suite green. In Chrome a ScriptProcessorNode that
 * reaches no destination is never pulled — zero frames, and Arm A silently
 * uploads nothing.
 * ======================================================================== */

describe('createInboundAudioTap — the capture graph is CONNECTED (round 2, R2-2)', () => {
  it('wires mediaStreamSource -> processor -> gain -> ctx.destination, and nothing else', () => {
    const fake = makeFakeContext();
    openTap(fake);

    expect(fake.edges()).toEqual([
      'source -> processor',
      'processor -> gain',
      'gain -> destination',
    ]);

    // ...and the edges are between the ACTUAL nodes: the processor the module
    // installed its callback on is the one the source feeds.
    const source = fake.nodes.find((n) => n.kind === 'source')!;
    const processor = fake.nodes.find((n) => n.kind === 'processor')!;
    const gain = fake.nodes.find((n) => n.kind === 'gain')!;
    expect(source.connectedTo).toEqual([processor.node]);
    expect(processor.connectedTo).toEqual([gain.node]);
    expect(gain.connectedTo).toEqual([fake.destination]);
    expect(fake.processors[0]).toBe(processor.node);
  });

  it('the processor reaches the destination — a node nothing pulls captures nothing', () => {
    const fake = makeFakeContext();
    openTap(fake);

    // Walk the graph forward from the processor. This is the property Chrome
    // enforces and the one a deleted connect() breaks.
    const reachesDestination = (from: FakeNode, seen = new Set<unknown>()): boolean =>
      from.connectedTo.some((target) => {
        if (target === fake.destination) return true;
        if (seen.has(target)) return false;
        seen.add(target);
        const next = fake.nodes.find((n) => n.node === target);
        return next !== undefined && reachesDestination(next, seen);
      });

    expect(reachesDestination(fake.nodes.find((n) => n.kind === 'processor')!)).toBe(true);
    expect(reachesDestination(fake.nodes.find((n) => n.kind === 'source')!)).toBe(true);
  });

  it('a RECONNECT rebuilds the whole graph, not a dangling processor', () => {
    const fake = makeFakeContext();
    const tap = createInboundAudioTap({ audioContextFactory: fake.audioContextFactory });
    tap.attach(fakeStream('first'));
    tap.attach(fakeStream('second'));

    expect(fake.edges()).toEqual([
      'source -> processor',
      'processor -> gain',
      'gain -> destination',
      'source -> processor',
      'processor -> gain',
      'gain -> destination',
    ]);
  });
});

describe('createInboundAudioTap — capture is SILENT (ticket 046, PRD §7)', () => {
  it('the ONLY path to ctx.destination is a gain pinned at 0', () => {
    // A ScriptProcessor needs a sink to be pulled, so a route to the
    // destination is required — but Replay autoplays NOTHING, so the one thing
    // reaching the speakers must be silenced at a gain node.
    const fake = makeFakeContext();
    openTap(fake);
    fake.emit(f32(0.5));

    const intoDestination = fake.nodes.filter((n) => n.connectedTo.includes(fake.destination));
    // EXACTLY ONE path, and it is silent. "every path is a zero gain" is
    // vacuously true when there are no paths at all — which is precisely the
    // state R2-2 above proves is fatal.
    expect(intoDestination).toHaveLength(1);
    expect(intoDestination[0]!.kind).toBe('gain');
    expect(intoDestination[0]!.gain?.value).toBe(0);
  });
});

/* ===========================================================================
 * R2-4 — capture is GATED to the model's speaking windows.
 * ======================================================================== */

describe('createInboundAudioTap — the capture gate (round 2, R2-4)', () => {
  it('the tail grace covers the RECEIVER’S JITTER BUFFER, not a syllable (round 3, R3-2)', () => {
    // `output_audio_buffer.stopped` rides the DATA CHANNEL, which has no jitter
    // buffer. The audio the event refers to is still in NetEq: Chrome's target
    // delay is commonly 60-150 ms and expands to several hundred on a jittery
    // link. A grace shorter than that clips the last word of EVERY Arm A
    // utterance, silently — and a blind evaluator hears the clipping as a defect
    // of the ARM, which is the exact attribution error this project exists to
    // prevent. R2-4's unblinding concern is about MULTI-SECOND gaps, so being
    // generous here is nearly free.
    expect(INBOUND_TAIL_GRACE_MS).toBe(750);
    // Still DERIVED from the wire rate, never a second literal.
    expect(INBOUND_TAIL_GRACE_SAMPLES).toBe((INBOUND_TAIL_GRACE_MS * INBOUND_SAMPLE_RATE) / 1000);
    expect(INBOUND_TAIL_GRACE_SAMPLES).toBe(18_000);
    // Comfortably past Chrome's expanded NetEq target, and nowhere near the
    // inter-utterance silence the gate exists to drop.
    expect(INBOUND_TAIL_GRACE_MS).toBeGreaterThanOrEqual(500);
    expect(INBOUND_TAIL_GRACE_MS).toBeLessThan(2_000);
  });

  it('DROPS everything before the first window — the run’s leading silence is not the model', () => {
    const fake = makeFakeContext();
    const tap = createInboundAudioTap({ audioContextFactory: fake.audioContextFactory });
    tap.attach(fakeStream('remote'));

    // Comfort noise, from track-attach until the model actually speaks.
    fake.emit(f32(0.25, -0.25));
    fake.emit(f32(0.25));
    expect(tap.take()).toHaveLength(0);

    tap.startWindow();
    fake.emit(f32(0.5));
    expect(Array.from(tap.take())).toEqual([16384]);
  });

  it('DROPS frames outside a window, and CONCATENATES the windows it kept', () => {
    const fake = makeFakeContext();
    const tap = createInboundAudioTap({ audioContextFactory: fake.audioContextFactory });
    tap.attach(fakeStream('remote'));

    fake.emit(f32(-1)); // before: dropped
    tap.startWindow();
    fake.emit(f32(0.5)); // utterance 1: kept
    tap.endWindow();
    // Past the grace: the inter-utterance gap that would unblind blind compare.
    fake.emit(new Float32Array(INBOUND_TAIL_GRACE_SAMPLES));
    fake.emit(f32(-1)); // dropped
    tap.startWindow();
    fake.emit(f32(0.25)); // utterance 2: kept
    tap.endWindow();
    fake.emit(new Float32Array(INBOUND_TAIL_GRACE_SAMPLES));
    fake.emit(f32(-1)); // dropped

    // Two utterances, gapless apart from the two tail graces they earned.
    const captured = Array.from(tap.take());
    expect(captured).toHaveLength(2 + 2 * INBOUND_TAIL_GRACE_SAMPLES);
    expect(captured.filter((v) => v !== 0)).toEqual([16384, 8192]);
    expect(captured[0]).toBe(16384);
    expect(captured[1 + INBOUND_TAIL_GRACE_SAMPLES]).toBe(8192);
  });

  it('HONOURS THE TAIL GRACE: capture continues past endWindow, then stops mid-frame', () => {
    // `output_audio_buffer.stopped` marks the end of the model's output BUFFER,
    // not the end of the sound arriving over RTP — the last syllable is still in
    // flight. Cutting at the event clips it.
    const fake = makeFakeContext();
    const tap = createInboundAudioTap({ audioContextFactory: fake.audioContextFactory });
    tap.attach(fakeStream('remote'));
    tap.startWindow();
    fake.emit(f32(0.5));
    tap.endWindow();

    // A short tail frame is kept whole...
    fake.emit(f32(0.25, 0.25));
    expect(Array.from(tap.take())).toEqual([16384, 8192, 8192]);

    // ...and the grace is a BUDGET, not a frame count: the frame that overruns
    // it is truncated to exactly what is left, and the next one is dropped.
    const remaining = INBOUND_TAIL_GRACE_SAMPLES - 2;
    fake.emit(Float32Array.from({ length: remaining + 5 }, () => 0.5));
    fake.emit(f32(-1));
    const captured = Array.from(tap.take());
    expect(captured).toHaveLength(1 + INBOUND_TAIL_GRACE_SAMPLES);
    expect(captured.at(-1)).toBe(16384);
    expect(captured).not.toContain(-32768);
  });

  it('a window REOPENED during the grace resumes full capture and re-arms the grace', () => {
    const fake = makeFakeContext();
    const tap = createInboundAudioTap({ audioContextFactory: fake.audioContextFactory });
    tap.attach(fakeStream('remote'));
    tap.startWindow();
    tap.endWindow();
    fake.emit(f32(0.5)); // in grace: kept

    tap.startWindow();
    // Far more than one grace's worth — all of it inside a real window.
    fake.emit(new Float32Array(INBOUND_TAIL_GRACE_SAMPLES * 2));
    fake.emit(f32(0.25));
    tap.endWindow();
    fake.emit(f32(0.25));

    const captured = Array.from(tap.take());
    expect(captured).toHaveLength(1 + INBOUND_TAIL_GRACE_SAMPLES * 2 + 2);
    expect(captured[0]).toBe(16384);
    expect(captured.at(-1)).toBe(8192);
  });

  it('the gate SURVIVES a reconnect: a window open when the track drops keeps capturing', () => {
    // One run is one recording, and the model does not stop speaking because
    // the peer connection blinked.
    const fake = makeFakeContext();
    const tap = createInboundAudioTap({ audioContextFactory: fake.audioContextFactory });
    tap.attach(fakeStream('first'));
    tap.startWindow();
    fake.emit(f32(0.5));

    tap.attach(fakeStream('second'));
    fake.emit(f32(0.25));
    expect(Array.from(tap.take())).toEqual([16384, 8192]);
  });

  it('endWindow() before any window, and after close(), are inert', () => {
    const fake = makeFakeContext();
    const tap = createInboundAudioTap({ audioContextFactory: fake.audioContextFactory });
    tap.attach(fakeStream('remote'));
    expect(() => tap.endWindow()).not.toThrow();
    fake.emit(f32(0.5));
    expect(tap.take()).toHaveLength(0);

    tap.startWindow();
    fake.emit(f32(0.5));
    void tap.close();
    expect(() => tap.startWindow()).not.toThrow();
    fake.emit(f32(0.25));
    expect(Array.from(tap.take())).toEqual([16384]);
  });
});

/* ===========================================================================
 * R3-3 — the gate KEEPS ACCOUNTS.
 *
 * Capture now depends on a data-channel event. If `output_audio_buffer.started`
 * ever stops arriving, Arm A stores nothing — and the artifact is byte-identical
 * to a model that never spoke. AC1 is explicitly deferred to an operator smoke
 * test, and without an account of what the gate SAW that smoke test cannot tell
 * "the gate never opened" from "the track was dead".
 * ======================================================================== */

describe('createInboundAudioTap — the gate reports what it dropped (round 3, R3-3)', () => {
  it('a full track with NO window opened: zero admitted, non-zero dropped', () => {
    // THE diagnostic case. Today this is indistinguishable from a mute model.
    const fake = makeFakeContext();
    const tap = createInboundAudioTap({ audioContextFactory: fake.audioContextFactory });
    tap.attach(fakeStream('remote'));

    fake.emit(new Float32Array(2_048));
    fake.emit(new Float32Array(2_048));

    expect(tap.take()).toHaveLength(0);
    expect(tap.stats()).toEqual({ admitted: 0, dropped: 4_096 });
  });

  it('a DEAD track is distinguishable from a shut gate: both counts are zero', () => {
    // The other half of the diagnosis. "0 seen" is a track problem; "seen but
    // 0 admitted" is a gate problem, and a smoke run must be able to say which.
    const fake = makeFakeContext();
    const tap = createInboundAudioTap({ audioContextFactory: fake.audioContextFactory });
    tap.attach(fakeStream('remote'));
    tap.startWindow();

    expect(tap.stats()).toEqual({ admitted: 0, dropped: 0 });
  });

  it('admitted always equals take().length, and the two counts add up to the whole track', () => {
    const fake = makeFakeContext();
    const tap = createInboundAudioTap({ audioContextFactory: fake.audioContextFactory });
    tap.attach(fakeStream('remote'));

    fake.emit(new Float32Array(100)); // before the window: dropped
    tap.startWindow();
    fake.emit(new Float32Array(40)); // speech: admitted
    tap.endWindow();
    fake.emit(new Float32Array(INBOUND_TAIL_GRACE_SAMPLES + 25)); // grace, then dropped

    const stats = tap.stats();
    expect(stats.admitted).toBe(tap.take().length);
    expect(stats.admitted).toBe(40 + INBOUND_TAIL_GRACE_SAMPLES);
    expect(stats.dropped).toBe(125);
    expect(stats.admitted + stats.dropped).toBe(100 + 40 + INBOUND_TAIL_GRACE_SAMPLES + 25);
  });

  it('counts nothing before attach and nothing after close — the tap only accounts for its own track', () => {
    const fake = makeFakeContext();
    const tap = createInboundAudioTap({ audioContextFactory: fake.audioContextFactory });
    expect(tap.stats()).toEqual({ admitted: 0, dropped: 0 });

    tap.attach(fakeStream('remote'));
    fake.emit(new Float32Array(10));
    void tap.close();
    fake.emit(new Float32Array(999));
    // The 999 landed after the tap was released: it was never seen, so counting
    // it would misreport a healthy run as a lossy one.
    expect(tap.stats()).toEqual({ admitted: 0, dropped: 10 });
  });
});

describe('createInboundAudioTap — reconnect and close (ticket 046)', () => {
  it('a SECOND attach appends to the same recording and releases the old source', () => {
    const fake = makeFakeContext();
    const tap = createInboundAudioTap({ audioContextFactory: fake.audioContextFactory });

    tap.attach(fakeStream('first'));
    tap.startWindow();
    fake.emit(f32(0.25));
    const firstSource = fake.nodes.find((n) => n.kind === 'source')!;

    tap.attach(fakeStream('second'));
    expect(firstSource.disconnects).toBeGreaterThanOrEqual(1);
    // ONE context for the tap's whole life — a reconnect must not leak one.
    expect(fake.factoryArgs).toHaveLength(1);

    fake.emit(f32(-0.25));
    // One run is ONE recording, whatever the connection did underneath.
    expect(Array.from(tap.take())).toEqual([8192, -8192]);
  });

  it('close() closes the context idempotently, and later frames are inert', () => {
    const fake = makeFakeContext();
    const tap = openTap(fake);
    fake.emit(f32(0.5));

    void tap.close();
    void tap.close();
    expect(fake.state.closes).toBe(1);

    // A frame that lands after stop() must not throw, and must not extend the
    // recording the run already uploaded.
    expect(() => fake.emit(f32(0.25))).not.toThrow();
    expect(Array.from(tap.take())).toEqual([16384]);
  });
});

/* ===========================================================================
 * R2-7 — the context close is SEQUENCED, not fired and forgotten.
 * ======================================================================== */

describe('createInboundAudioTap — close() awaits the context (round 2, R2-7)', () => {
  it('returns a promise that settles only once ctx.close() has settled', async () => {
    // `void ctx.close()` is fire-and-forget. A realtime Replay run builds TWO
    // AudioContexts and Chrome caps concurrent hardware contexts (~6), so across
    // a 60-run sweep a lagging close makes a later construction throw and kills
    // a run. The caller has to be able to WAIT.
    const fake = makeFakeContext();
    const tap = openTap(fake);

    const order: string[] = [];
    const closed = Promise.resolve(tap.close()).then(() => order.push('tap.close resolved'));

    expect(tap.close()).toBeInstanceOf(Promise); // idempotent AND still awaitable
    // Several microtask turns: a fire-and-forget close resolves in the first.
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();
    expect(order).toEqual([]);
    expect(fake.state.closes).toBe(1);

    order.push('ctx.close settled');
    fake.closeGate.resolve();
    await closed;
    expect(order).toEqual(['ctx.close settled', 'tap.close resolved']);
  });

  it('a context that FAILS to close does not reject the caller — nothing can act on it', async () => {
    const fake = makeFakeContext({ closeRejects: true });
    const tap = openTap(fake);
    await expect(Promise.resolve(tap.close())).resolves.toBeUndefined();
  });

  it('the captured audio is still readable after the close has settled', async () => {
    const fake = makeFakeContext();
    const tap = openTap(fake);
    fake.emit(f32(0.5, -0.5));

    const closed = Promise.resolve(tap.close());
    fake.closeGate.resolve();
    await closed;
    expect(Array.from(tap.take())).toEqual([16384, -16384]);
  });
});
