/**
 * Ticket 043 — THE ACCEPTANCE TEST: a Replay Arm A run must produce a real
 * latency sample.
 *
 * Everything above this is a unit. This is the shape the operator actually ran
 * and that actually failed:
 *
 *   errors:  ['segmentation: expected 4 utterances, observed 0']
 *   timings: { audio_queued: null }
 *
 * A REAL RealtimeTransport is driven by `runOnce` over a 4-utterance corpus
 * manifest. The peer connection, the token/SDP fetches and the outbound sink are
 * fakes, but the sink is a RESPONSIVE one: it counts the paced frames it
 * receives and, as each manifest boundary goes by, pushes the data-channel
 * events a listening model would send. That is what makes this test falsifiable
 * — with the shipped no-op `sendAudio` the sink receives nothing, the fake model
 * stays silent, ticket 031's idle deadline fires, and the run fails with exactly
 * the operator's error.
 *
 * No real network, no real RTCPeerConnection, no real AudioContext.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { REALTIME_MODEL } from '../../core/arms';
import type { CorpusUtterance } from '../../core/corpus';
import { SAMPLE_RATE } from '../../core/protocol';
import { readWav, writeWav } from '../../harness/wav';
import { INBOUND_TAIL_GRACE_SAMPLES } from '../audio/inboundAudio';
import type { Recording, Run } from '../state/ledger';
import {
  RealtimeTransport,
  type InboundAudioTap,
  type OutboundAudioSink,
  type RtcDataChannelLike,
  type RtcPeerConnectionLike,
  type RtcSessionDescriptionLike,
} from '../transport/realtime';
import type { InterpreterTransport } from '../transport/types';
import { FRAME_MS, FRAME_SAMPLES } from './pacer';
import type { RecordingsClient, RunsClient } from './recordingsClient';
import {
  CAPTURE_GATE_NEVER_OPENED,
  TRANSPORT_CLOSE_TIMEOUT_MS,
  runOnce,
  type RunOnceConfig,
  type RunnerDeps,
} from './runner';

/**
 * Four utterances, roughly one per second of a 4 s clip — a PRD §9 corpus take.
 *
 * TICKET 055b — THE ANCHORS ARE 900/1900/2900/3900, NOT THE ROUND SECONDS.
 * The fake model answers utterance u on the frame that CARRIES that second's
 * last 20 ms, i.e. at 980 / 1980 / 2980 / 3980, so anchors on the round seconds
 * made every utterance of this fixture answer 20 ms BEFORE its own speech had
 * ended. The runner now refuses such a mark as "not measured" (it is physically
 * impossible, and it is how run 7acb0cc9 stored a negative p50), which would
 * have nulled every `audio_queued` this file asserts on. The anchors moved, not
 * the assertions: each answer now lands 80 ms after the speech it answers.
 */
const MANIFEST: CorpusUtterance[] = [
  { id: 'u1', index: 1, category: 'short-reply', trueSpeechEndMs: 900 },
  { id: 'u2', index: 2, category: 'numbers-dates', trueSpeechEndMs: 1_900 },
  { id: 'u3', index: 3, category: 'proper-nouns', trueSpeechEndMs: 2_900 },
  { id: 'u4', index: 4, category: 'long-compound', trueSpeechEndMs: 3_900 },
];

const DURATION_MS = 4_000;
const TOTAL_FRAMES = DURATION_MS / FRAME_MS; // 200 frames at 20 ms

const RECORDING: Recording = {
  id: 'rec-corpus-1',
  label: 'corpus clip',
  sourceLanguage: 'en',
  durationMs: DURATION_MS,
  speechEndMs: DURATION_MS,
  origin: 'mic',
  createdAt: 1_000,
  utterances: MANIFEST,
  corpusVersion: 'corpus-v1',
};

const REALTIME_CONFIG: RunOnceConfig = {
  architecture: 'realtime',
  realtimeModel: REALTIME_MODEL,
  languagePair: 'EN↔ES',
  direction: 'en→es',
  targetLanguage: 'Spanish',
};

const clip = Int16Array.from({ length: (SAMPLE_RATE * DURATION_MS) / 1000 }, (_, i) =>
  Math.round(8000 * Math.sin(i / 12)),
);

/** The model's inbound stream — the only place Arm A's output audio exists. */
const REMOTE_STREAM = { tag: 'remote', getAudioTracks: () => [{ kind: 'audio' }] };

/** A peer connection fake with the production media surface. */
class E2ePc implements RtcPeerConnectionLike {
  channel: FakeChannel | null = null;
  added: unknown[] = [];
  transceivers: { kind: string; direction: string | undefined }[] = [];
  closed = false;
  ontrack: ((ev: { track: { kind: string }; streams: readonly unknown[] }) => void) | null = null;
  createDataChannel(label: string): RtcDataChannelLike {
    this.channel = new FakeChannel(label);
    return this.channel;
  }
  async createOffer(): Promise<RtcSessionDescriptionLike> {
    return { type: 'offer', sdp: 'v=0 offer' };
  }
  async setLocalDescription(): Promise<void> {}
  /**
   * TICKET 046 — applying the answer is what creates the receiver, so the
   * model's audio track arrives HERE, exactly as a real RTCPeerConnection
   * raises it (see FakeTrackPc in transport/realtime.test.ts).
   */
  async setRemoteDescription(): Promise<void> {
    this.ontrack?.({ track: { kind: 'audio' }, streams: [REMOTE_STREAM] });
  }
  addTrack(track: unknown): unknown {
    this.added.push(track);
    return {};
  }
  addTransceiver(kind: string, init?: { direction: string }): unknown {
    this.transceivers.push({ kind, direction: init?.direction });
    return {};
  }
  close(): void {
    this.closed = true;
  }
}

class FakeChannel implements RtcDataChannelLike {
  onopen: (() => void) | null = null;
  onmessage: ((ev: { data: string }) => void) | null = null;
  onclose: (() => void) | null = null;
  constructor(readonly label: string) {}
  send(): void {}
  close(): void {}
  emit(obj: unknown): void {
    this.onmessage?.({ data: JSON.stringify(obj) });
  }
}

function fakeFetch(): typeof fetch {
  return (async (url: RequestInfo | URL) => {
    const u = String(url);
    if (u.includes('/api/realtime-token')) {
      return {
        ok: true,
        status: 200,
        json: async () => ({ value: 'ephemeral' }),
        text: async () => '',
      } as unknown as Response;
    }
    return {
      ok: true,
      status: 200,
      json: async () => ({}),
      text: async () => 'v=0 answer',
    } as unknown as Response;
  }) as typeof fetch;
}

/** Samples the fake model puts on the media track per answered utterance. */
const TRACK_SAMPLES_PER_UTTERANCE = 6;

/* ---------------------------------------------------------------------------
 * ROUND 2 (R2-4) — the media track carries more than the model's voice.
 *
 * A real inbound track runs from the moment the answer is applied: leading
 * comfort noise, then speech, then the gap to the next utterance. Capturing all
 * of it makes an Arm A file the whole ~45 s run while cascade's is a few seconds
 * of gapless TTS, and blind compare — which plays the WHOLE stored WAV — is
 * unblinded in the first second. These three markers are what the fake model
 * puts in each of those regions, so "the gate dropped the right thing" is a
 * claim about identifiable samples rather than about a length.
 * ------------------------------------------------------------------------ */

/** Comfort noise on the track before the model has EVER spoken. Must be dropped. */
const NOISE_MARK = -31_000;
/** The last syllable, still in flight when `.stopped` lands. Must be KEPT. */
const TAIL_MARK = 31_000;
/** The inter-utterance gap, past the tail grace. Must be dropped. */
const GAP_MARK = -30_000;

interface ArmAHarnessOptions {
  /** Frames the model needs before it responds at all. Default: every frame. */
  deaf?: boolean;
  /**
   * TICKET 046 — omit `createInboundAudioTap` entirely, i.e. the shipped Arm A:
   * the model's audio rides the track and nothing captures it.
   */
  noTap?: boolean;
  /**
   * TICKET 046 falsifiability control — the model answers on the DATA CHANNEL
   * exactly as always, but puts NOTHING on the media track. Captured audio must
   * then be empty. If a run still uploads bytes here, the capture is coming from
   * a timer or from the connect, not from the model's audio.
   */
  mute?: boolean;
  /**
   * ROUND 3 (R3-7) — THE GATE NEVER OPENS, while the track keeps delivering.
   *
   * This is the failure mode capture acquired by hanging off a data-channel
   * event: if `output_audio_buffer.started` stops arriving (or the gate wiring
   * regresses), Arm A stores nothing and the stored artifact is byte-identical
   * to `mute` above. The two MUST be distinguishable, or the operator smoke test
   * AC1 is deferred to cannot confirm AC1 — only fail to contradict it.
   */
  gateStuck?: boolean;
  /**
   * ROUND 4 (R4-1) — THE REAL-CHROME SILENT-MODEL SIGNATURE.
   *
   * The model answers on the data channel but NEVER sends
   * `output_audio_buffer.started`, while the track keeps rendering frames. In a
   * real browser this is what an honestly-silent connected run looks like: once
   * the ScriptProcessor is connected the graph is pulled continuously and the
   * receiver renders silence frames whether or not any RTP arrives, so `{0, 0}`
   * is essentially unreachable and BOTH "the gate is stuck" and "the model never
   * spoke" present as `{n, 0}`.
   *
   * The distinguishing fact is `audio_queued`: it is stamped from
   * `output_audio_buffer.started`, so a model that demonstrably started an
   * output buffer and admitted nothing is a STUCK GATE, while no mark at all is
   * a model that never spoke — a fact about the MODEL, not about capture.
   */
  noStartedEvent?: boolean;
  /**
   * ROUND 2 (R2-7) — hold the tap's context close open, so a run that does not
   * WAIT for it is visible. Two AudioContexts per realtime run against Chrome's
   * ~6-context cap is a 60-run sweep that dies part-way through.
   */
  holdClose?: boolean;
}

function makeArmAHarness(opts: ArmAHarnessOptions = {}) {
  const posted: Run[] = [];
  const pcs: E2ePc[] = [];
  /** Every paced frame the outbound sink received, with its virtual clock. */
  const written: { length: number; at: number }[] = [];
  const sinks: { closed: number }[] = [];
  /** TICKET 046 — the inbound taps built, and what the track carried. */
  const taps: { attached: unknown[]; closed: number }[] = [];
  /** EVERYTHING the model put on the media track, in order. */
  const delivered: number[] = [];
  /** What the GATED tap kept — the bytes the run must store, and no others. */
  const trackAudio: number[] = [];
  /** Every capture-gate transition the transport drove, in order. */
  const windows: string[] = [];
  /**
   * ROUND 2 (R2-4) — the fake tap's gate, implementing exactly the contract
   * inboundAudio.test.ts pins: frames outside a window are DROPPED, never
   * buffered, and capture continues for INBOUND_TAIL_GRACE_SAMPLES past
   * `endWindow()` so the last syllable is not clipped.
   */
  const gate = { capturing: false, grace: 0 };
  const deliver = (...samples: number[]): void => {
    for (const sample of samples) {
      delivered.push(sample);
      if (gate.capturing) {
        trackAudio.push(sample);
      } else if (gate.grace > 0) {
        gate.grace -= 1;
        trackAudio.push(sample);
      }
    }
  };
  /** R2-7 — the tap's context close, held open when `holdClose` is set. */
  let releaseClose!: () => void;
  const closeGate = new Promise<void>((res) => {
    releaseClose = res;
  });
  /** R3-1 — the virtual clock at which the run ASKED the tap to close. */
  const closedAt: number[] = [];
  /** Clock at each `output_audio_buffer.started` the model sent. */
  const queuedAt: number[] = [];
  /** What `uploadAudio` was given, by run id. */
  const uploads: { id: string; wav: Uint8Array }[] = [];
  const stored = new Map<string, Uint8Array>();

  const recordings: RecordingsClient = {
    list: async () => [RECORDING],
    get: async () => RECORDING,
    getAudio: async () => writeWav(clip, SAMPLE_RATE),
    create: async () => RECORDING,
    patchLabel: async () => RECORDING,
    remove: async () => RECORDING,
  };
  const runs: RunsClient = {
    create: async (run: Run) => {
      posted.push(run);
      return run;
    },
    list: async () => posted,
    // TICKET 046 — a REAL read-back: GET /api/runs/:id/audio must return the
    // very bytes the run uploaded, or "Arm A produces capturable output" is
    // only a claim about a function call.
    getAudio: async (id: string) => stored.get(id) ?? new Uint8Array(0),
    uploadAudio: async (id: string, wavBytes: Uint8Array) => {
      uploads.push({ id, wav: wavBytes });
      stored.set(id, wavBytes);
      return { id, outputAudioPath: `runs/${id}.out.wav`, bytes: wavBytes.length };
    },
  };

  /**
   * The fake model. It only ever hears what the OUTBOUND SINK is given, so a
   * transport that discards `sendAudio` leaves it silent — which is the whole
   * point of driving it from here rather than from a timer.
   */
  let heard = 0;
  let answered = 0;
  const respondTo = (channel: FakeChannel | null): void => {
    if (channel === null || opts.deaf === true) return;
    heard += 1;
    const boundaryFrames = ((answered + 1) * 1_000) / FRAME_MS;
    if (heard < boundaryFrames) return;
    answered += 1;
    const speaks = opts.mute !== true;
    channel.emit({ type: 'input_audio_buffer.speech_stopped' });
    // ROUND 2 — the track has been running since the answer was applied. Before
    // the model's FIRST word that is comfort noise, and it is not evidence.
    if (speaks && answered === 1) deliver(NOISE_MARK, NOISE_MARK);

    // ROUND 4 (R4-1) — a model that never starts an output buffer. Everything
    // else about the answer is unchanged; there is simply no `audio_queued` to
    // stamp, which is what makes this a fact about the MODEL and not capture.
    if (opts.noStartedEvent !== true) {
      queuedAt.push(Date.now());
      channel.emit({ type: 'output_audio_buffer.started' });
    }
    // TICKET 046 — and THE AUDIO ITSELF, on the media track and nowhere else.
    // There is no `response.output_audio.delta` on this transport (040).
    if (speaks) {
      for (let i = 0; i < TRACK_SAMPLES_PER_UTTERANCE; i++) {
        deliver(i % 2 === 0 ? answered * 100 + i : -(answered * 100 + i));
      }
    }
    channel.emit({
      type: 'response.output_audio_transcript.done',
      transcript: `translation ${answered}`,
    });
    channel.emit({ type: 'output_audio_buffer.stopped' });
    // ROUND 2 — `.stopped` ends the model's output BUFFER, not the sound on the
    // wire: this syllable is still in flight and the tail grace must keep it.
    if (speaks) deliver(TAIL_MARK);
    // ...and then the gap. Exhausting the grace once is enough to prove it is a
    // BUDGET and not "everything after the last window".
    if (speaks && answered === MANIFEST.length) {
      deliver(...new Array<number>(INBOUND_TAIL_GRACE_SAMPLES - 1).fill(0));
      deliver(GAP_MARK, GAP_MARK);
    }
    channel.emit({ type: 'response.done', response: { usage: { total_tokens: 10 } } });
  };

  const createTransport = (config: RunOnceConfig): InterpreterTransport => {
    if (config.architecture !== 'realtime') throw new Error('this harness is Arm A only');
    let pc: E2ePc | null = null;
    return new RealtimeTransport(
      { armId: 'replay', label: 'Realtime', costPerMinUsd: 0, model: config.realtimeModel },
      {
        fetchImpl: fakeFetch(),
        rtcFactory: (): RtcPeerConnectionLike => {
          pc = new E2ePc();
          pcs.push(pc);
          return pc;
        },
        now: () => Date.now(),
        createOutboundAudioSink: (): OutboundAudioSink => {
          const entry = { closed: 0 };
          sinks.push(entry);
          return {
            track: { kind: 'audio', tag: `outbound-${sinks.length}` },
            write: (pcm: Int16Array) => {
              written.push({ length: pcm.length, at: Date.now() });
              respondTo(pc?.channel ?? null);
            },
            close: () => {
              entry.closed += 1;
            },
          };
        },
        // TICKET 046 — the INBOUND capture seam. jsdom has no AudioContext and
        // no MediaStream, so this is the injected recorder; the production one
        // is audio/inboundAudio.ts and is tested there.
        ...(opts.noTap === true
          ? {}
          : {
              createInboundAudioTap: (): InboundAudioTap => {
                const entry = { attached: [] as unknown[], closed: 0 };
                taps.push(entry);
                return {
                  attach: (stream: unknown) => entry.attached.push(stream),
                  startWindow: () => {
                    windows.push('start');
                    // R3-7 — a gate that is asked to open and does not. The
                    // track still runs; nothing is admitted.
                    if (opts.gateStuck === true) return;
                    gate.capturing = true;
                    gate.grace = 0;
                  },
                  endWindow: () => {
                    windows.push('end');
                    // Inert without an open window — a stray `.stopped` must not
                    // hand the gap a grace it never earned (pinned in
                    // inboundAudio.test.ts, and what makes `gateStuck` admit
                    // NOTHING rather than one grace per utterance).
                    if (!gate.capturing) return;
                    gate.capturing = false;
                    gate.grace = INBOUND_TAIL_GRACE_SAMPLES;
                  },
                  stats: () => ({
                    admitted: trackAudio.length,
                    dropped: delivered.length - trackAudio.length,
                  }),
                  take: () => Int16Array.from(trackAudio),
                  close: (): void | Promise<void> => {
                    entry.closed += 1;
                    closedAt.push(Date.now());
                    return opts.holdClose === true ? closeGate : undefined;
                  },
                };
              },
            }),
      },
    );
  };

  const deps: RunnerDeps = {
    recordings,
    runs,
    createTransport,
    now: () => Date.now(),
    newId: () => 'run-arm-a',
  };

  return {
    deps,
    posted,
    pcs,
    written,
    sinks,
    taps,
    delivered,
    trackAudio,
    windows,
    closedAt,
    releaseClose: (): void => releaseClose(),
    queuedAt,
    uploads,
    runs,
  };
}

/** TICKET 046 — nothing in Replay autoplays, so nothing may build a context. */
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

describe('Replay Arm A end to end (ticket 043)', () => {
  it('a 4-utterance corpus clip yields 4 utterance.complete events and a NON-NULL audio_queued', async () => {
    const h = makeArmAHarness();
    const done = runOnce({ recordingId: RECORDING.id, config: REALTIME_CONFIG, deps: h.deps });
    await vi.advanceTimersByTimeAsync(DURATION_MS + 10_000);
    const result = await done;

    // THE criterion: Arm A produced a real latency sample, not a null.
    expect(result.run.timings.audio_queued).not.toBeNull();
    expect(typeof result.run.timings.audio_queued).toBe('number');
    // ...and the segmentation the operator's run never reached.
    expect(result.run.errors).toEqual([]);
    expect(result.run.status).toBe('complete');
    expect(result.run.utterances).toHaveLength(4);
    for (const u of result.run.utterances ?? []) {
      expect(u.timings.audio_queued).not.toBeNull();
      expect(u.status).toBe('complete');
      expect(u.errors).toEqual([]);
    }
    expect(h.posted).toHaveLength(1);
  });

  it('the paced clip really reached the outbound track — every frame, at 24 kHz, at 1x', async () => {
    const h = makeArmAHarness();
    const done = runOnce({ recordingId: RECORDING.id, config: REALTIME_CONFIG, deps: h.deps });
    await vi.advanceTimersByTimeAsync(DURATION_MS + 10_000);
    await done;

    expect(h.written).toHaveLength(TOTAL_FRAMES);
    for (const w of h.written) expect(w.length).toBe(FRAME_SAMPLES); // 480 @ 24 kHz
    // Frame k arrived at ~k * 20 ms. A sink fed by a dump would show every
    // frame at ~0 ms, and every latency figure above would be fiction.
    for (let k = 0; k < h.written.length; k++) {
      expect(Math.abs(h.written[k]!.at - k * FRAME_MS)).toBeLessThanOrEqual(1);
    }
    expect(h.written.at(-1)!.at - h.written[0]!.at).toBeGreaterThanOrEqual(
      (TOTAL_FRAMES - 1) * FRAME_MS - 1,
    );
  });

  it('the offer carried a SENDABLE track, never the recvonly transceiver, and stop() released the sink', async () => {
    const h = makeArmAHarness();
    const done = runOnce({ recordingId: RECORDING.id, config: REALTIME_CONFIG, deps: h.deps });
    await vi.advanceTimersByTimeAsync(DURATION_MS + 10_000);
    await done;

    expect(h.pcs).toHaveLength(1);
    expect(h.pcs[0]!.added).toHaveLength(1);
    expect(h.pcs[0]!.transceivers.map((t) => t.direction)).not.toContain('recvonly');
    expect(h.sinks).toHaveLength(1);
    expect(h.sinks[0]!.closed).toBe(1);
  });

  it('THE BUG, pinned: a model that receives no audio fails exactly as the operator saw', async () => {
    // `deaf: true` reproduces the shipped no-op sendAudio — the samples go
    // nowhere, VAD never fires, and 031's idle deadline names the failure. If
    // this test ever goes green with the other three, the fake model is
    // answering something other than the audio and they prove nothing.
    const h = makeArmAHarness({ deaf: true });
    const done = runOnce({ recordingId: RECORDING.id, config: REALTIME_CONFIG, deps: h.deps });
    await vi.advanceTimersByTimeAsync(DURATION_MS + 10_000);
    const result = await done;

    expect(result.run.errors).toEqual(['segmentation: expected 4 utterances, observed 0']);
    expect(result.run.timings.audio_queued).toBeNull();
    expect(result.run.status).toBe('failed');
    expect(result.run.utterances).toBeUndefined();
  });
});

/* ===========================================================================
 * TICKET 046 — Arm A must produce CAPTURABLE output audio.
 *
 * 045 gave runs an upload path, which fixed cascade playback and could not fix
 * Arm A: over WebRTC the model's audio is on the media track only, so `onAudio`
 * never fires, `outputAudio.length === 0`, there is nothing to upload and blind
 * compare — playback-only by design (PRD §10) — has nothing to play for any
 * pair involving Arm A.
 *
 * The fake model above now puts its audio EXACTLY where the real one does: on
 * the track, never on the data channel.
 * ======================================================================== */

/** What the GATED tap kept — exactly the bytes the run must store. */
const capturedFor = (h: ReturnType<typeof makeArmAHarness>): number[] => [...h.trackAudio];

describe('Replay Arm A output audio is captured and stored (ticket 046)', () => {
  it('produces NON-EMPTY output audio, uploads it, and GET /api/runs/:id/audio returns it', async () => {
    const h = makeArmAHarness();
    const done = runOnce({ recordingId: RECORDING.id, config: REALTIME_CONFIG, deps: h.deps });
    await vi.advanceTimersByTimeAsync(DURATION_MS + 10_000);
    const result = await done;

    // The tap saw the one inbound stream the connection produced.
    expect(h.taps).toHaveLength(1);
    expect(h.taps[0]!.attached).toEqual([REMOTE_STREAM]);

    // THE criterion: Arm A produced audio.
    expect(result.outputAudio.length).toBeGreaterThan(0);
    expect(Array.from(result.outputAudio)).toEqual(capturedFor(h));
    expect(result.audioReady).toBe(true);

    // ...uploaded by 045's path, before the Run was POSTed...
    expect(h.uploads).toHaveLength(1);
    expect(h.uploads[0]!.id).toBe(result.run.id);
    expect(result.run.outputAudioPath).toBe(`runs/${result.run.id}.out.wav`);
    expect(h.posted[0]!.outputAudioPath).toBe(result.run.outputAudioPath);

    // ...and readable back out.
    const fetched = await h.runs.getAudio(result.run.id);
    expect(fetched.length).toBeGreaterThan(0);
    expect(Array.from(readWav(fetched).samples)).toEqual(capturedFor(h));
  });

  it('the stored audio is 24 kHz PCM16 MONO — cascade format, indistinguishable in blind compare', async () => {
    const h = makeArmAHarness();
    const done = runOnce({ recordingId: RECORDING.id, config: REALTIME_CONFIG, deps: h.deps });
    await vi.advanceTimersByTimeAsync(DURATION_MS + 10_000);
    const result = await done;

    const decoded = readWav(await h.runs.getAudio(result.run.id));
    expect(decoded.rate).toBe(SAMPLE_RATE);
    expect(SAMPLE_RATE).toBe(24_000);
    // Int16Array IS the PCM16 mono claim: one channel, 16 bits, in order.
    expect(decoded.samples).toBeInstanceOf(Int16Array);
    expect(Array.from(decoded.samples)).toEqual(capturedFor(h));
  });

  it('CAPTURE DOES NOT MOVE THE MEASUREMENT: audio_queued is byte-identical to the same run with no tap', async () => {
    // `audio_queued` comes from `output_audio_buffer.started` (040), not from
    // bytes. A tap that routed its samples through `onAudio` would silently
    // re-anchor Arm A's headline latency to the moment audio was DECODED.
    const tapped = makeArmAHarness();
    const tappedDone = runOnce({
      recordingId: RECORDING.id,
      config: REALTIME_CONFIG,
      deps: tapped.deps,
    });
    await vi.advanceTimersByTimeAsync(DURATION_MS + 10_000);
    const withTap = await tappedDone;

    vi.setSystemTime(0);
    const plain = makeArmAHarness({ noTap: true });
    const plainDone = runOnce({
      recordingId: RECORDING.id,
      config: REALTIME_CONFIG,
      deps: plain.deps,
    });
    await vi.advanceTimersByTimeAsync(DURATION_MS + 10_000);
    const noTap = await plainDone;

    // The tapped run really did capture (else this proves nothing)...
    expect(withTap.outputAudio.length).toBeGreaterThan(0);
    // ...THROUGH THE GATE — the path R2-4 added is the one under test here, not
    // some ungated leftover. Four utterances, four windows, opened and closed.
    expect(tapped.windows).toEqual(
      MANIFEST.flatMap(() => ['start', 'end']),
    );
    // ...and the measurement is untouched by it.
    expect(withTap.run.timings.audio_queued).toBe(noTap.run.timings.audio_queued);
    expect(withTap.run.timings.speech_end).toBe(noTap.run.timings.speech_end);
    // Straight from the model's own event, not from any byte.
    expect(withTap.run.timings.audio_queued).toBe(tapped.queuedAt.at(-1));
    expect(
      (withTap.run.utterances ?? []).map((u) => u.timings.audio_queued),
    ).toEqual(tapped.queuedAt);
    expect((withTap.run.utterances ?? []).map((u) => u.timings.audio_queued)).toEqual(
      (noTap.run.utterances ?? []).map((u) => u.timings.audio_queued),
    );
    // ...and only the no-tap run is the one that stores nothing.
    expect(noTap.outputAudio).toHaveLength(0);
    expect(noTap.run.outputAudioPath).toBeUndefined();
  });

  it('FALSIFIABILITY CONTROL: a model that sends its events but NO track audio stores nothing', async () => {
    // Same connect, same tap, same four utterances, same measurements — the
    // ONLY difference is that nothing came down the media track. If this run
    // ever uploads bytes, the capture above is coming from the connect or a
    // timer rather than from the model's audio.
    const h = makeArmAHarness({ mute: true });
    const done = runOnce({ recordingId: RECORDING.id, config: REALTIME_CONFIG, deps: h.deps });
    await vi.advanceTimersByTimeAsync(DURATION_MS + 10_000);
    const result = await done;

    expect(h.taps).toHaveLength(1);
    expect(result.run.status).toBe('complete');
    expect(result.run.timings.audio_queued).not.toBeNull();
    expect(result.outputAudio).toHaveLength(0);
    expect(result.audioReady).toBe(false);
    expect(h.uploads).toEqual([]);
    expect(result.run.outputAudioPath).toBeUndefined();
    expect(h.posted[0]!.outputAudioPath).toBeUndefined();
  });

  it('STORES THE SPEECH, NOT THE RUN: the gate drops the noise and the gaps (round 2, R2-4)', async () => {
    // Matching FORMAT is not enough. An ungated capture stores the whole ~45 s
    // run — leading silence, inter-utterance gaps, comfort noise — while
    // cascade's file is gapless TTS. BlindCompare plays the WHOLE stored WAV,
    // so an evaluator would tell the arms apart in the first second: AC2's
    // wording met, its PURPOSE defeated.
    const h = makeArmAHarness();
    const done = runOnce({ recordingId: RECORDING.id, config: REALTIME_CONFIG, deps: h.deps });
    await vi.advanceTimersByTimeAsync(DURATION_MS + 10_000);
    const result = await done;

    const stored = Array.from(readWav(await h.runs.getAudio(result.run.id)).samples);

    // The model spoke four times, so the transport opened four windows.
    expect(h.windows).toEqual(MANIFEST.flatMap(() => ['start', 'end']));

    // What the track carried but the model was not speaking is GONE...
    expect(h.delivered).toContain(NOISE_MARK);
    expect(h.delivered).toContain(GAP_MARK);
    expect(stored).not.toContain(NOISE_MARK);
    expect(stored).not.toContain(GAP_MARK);
    // ...the last syllable, still in flight at `.stopped`, is KEPT...
    expect(stored.filter((v) => v === TAIL_MARK)).toHaveLength(MANIFEST.length);
    // ...and the four utterances CONCATENATE, in order, into one recording.
    const speech = stored.filter((v) => v !== 0 && v !== TAIL_MARK);
    expect(speech).toEqual(
      MANIFEST.flatMap((_, u) =>
        Array.from({ length: TRACK_SAMPLES_PER_UTTERANCE }, (__, i) =>
          i % 2 === 0 ? (u + 1) * 100 + i : -((u + 1) * 100 + i),
        ),
      ),
    );
    // The gate really dropped something: an ungated tap stores every sample.
    expect(stored.length).toBeLessThan(h.delivered.length);
    expect(stored).toEqual(capturedFor(h));
  });

  it('the tail grace is a BUDGET: capture stops once it is spent (round 2, R2-4)', async () => {
    const h = makeArmAHarness();
    const done = runOnce({ recordingId: RECORDING.id, config: REALTIME_CONFIG, deps: h.deps });
    await vi.advanceTimersByTimeAsync(DURATION_MS + 10_000);
    const result = await done;

    const stored = Array.from(readWav(await h.runs.getAudio(result.run.id)).samples);
    // Per utterance: the speech, plus one tail sample inside the grace. The last
    // utterance also spends its whole remaining grace on the gap that follows —
    // and everything past that is dropped, however long the run continues.
    expect(stored).toHaveLength(
      MANIFEST.length * (TRACK_SAMPLES_PER_UTTERANCE + 1) + (INBOUND_TAIL_GRACE_SAMPLES - 1),
    );
  });

  it('AWAITS THE AUDIO CONTEXT CLOSE before the run resolves (round 2, R2-7)', async () => {
    // `void ctx.close()` is fire-and-forget, and a realtime Replay run builds
    // TWO AudioContexts (outbound sink + inbound tap) against Chrome's ~6
    // concurrent-context cap. Across a 60-run sweep a lagging close makes a
    // later construction throw and kills a run.
    const h = makeArmAHarness({ holdClose: true });
    let settled = false;
    const done = runOnce({ recordingId: RECORDING.id, config: REALTIME_CONFIG, deps: h.deps }).then(
      (r) => {
        settled = true;
        return r;
      },
    );
    // Just past the close request (~4.2 s) and WELL INSIDE R3-1's budget, so
    // this test is about the wait and the next one is about its bound.
    await vi.advanceTimersByTimeAsync(DURATION_MS + 500);

    // The transport asked the tap to close, and the run is WAITING on it.
    expect(h.closedAt).toHaveLength(1);
    expect(h.taps[0]!.closed).toBe(1);
    expect(Date.now() - h.closedAt[0]!).toBeLessThan(TRANSPORT_CLOSE_TIMEOUT_MS);
    expect(settled).toBe(false);
    // Nothing was uploaded ahead of the close either — the run really stopped.
    expect(h.uploads).toEqual([]);

    h.releaseClose();
    await vi.advanceTimersByTimeAsync(0);
    const result = await done;

    expect(settled).toBe(true);
    // A HEALTHY close costs the run nothing: it resumed the moment the context
    // was gone, not at the end of the budget.
    expect(Date.now() - h.closedAt[0]!).toBeLessThan(TRANSPORT_CLOSE_TIMEOUT_MS);
    expect(result.outputAudio.length).toBeGreaterThan(0);
    expect(h.uploads).toHaveLength(1);
    // ...and R3-1's deadline is CLEARED when it is not needed. A race that
    // leaves its timer armed keeps a 2 s handle alive per run, and in a 60-run
    // sweep that is 60 of them plus a `vi.useFakeTimers` teardown that lies.
    expect(vi.getTimerCount()).toBe(0);
  });

  it('BOUNDS the close wait: a WEDGED context costs a leak, never the run (round 3, R3-1)', async () => {
    // Round 2 made the wait unbounded and nothing races it: `startBatch`'s
    // `runTimeoutMs` only calls `controller.abort()`, and `runOnce` reads the
    // signal nowhere after pacing. So an AudioContext whose `close()` never
    // settles — a device change or removal is the classic cause — freezes the
    // run "running" forever: the sweep stops advancing, no Run is stored and no
    // error is reported. That is a WORSE trade than the leak it replaced.
    const h = makeArmAHarness({ holdClose: true });
    let resolvedAt: number | null = null;
    const done = runOnce({ recordingId: RECORDING.id, config: REALTIME_CONFIG, deps: h.deps }).then(
      (r) => {
        resolvedAt = Date.now();
        return r;
      },
    );

    // The close is NEVER released. Advance far past the budget.
    await vi.advanceTimersByTimeAsync(DURATION_MS + 30_000);
    expect(h.taps[0]!.closed).toBe(1);

    // THE criterion: the run finished anyway.
    expect(resolvedAt).not.toBeNull();
    const waited = resolvedAt! - h.closedAt[0]!;
    // It really waited the budget (a run that skipped the await entirely would
    // show ~0 here and R2-7 above would be meaningless)...
    expect(waited).toBeGreaterThanOrEqual(TRANSPORT_CLOSE_TIMEOUT_MS);
    // ...and no longer than it.
    expect(waited).toBeLessThanOrEqual(TRANSPORT_CLOSE_TIMEOUT_MS + FRAME_MS);

    // ...AND the measurement survived: giving up on the context must not give
    // up on the run, which is the whole point of bounding rather than removing.
    const result = await done;
    expect(result.run.status).toBe('complete');
    expect(result.run.timings.audio_queued).not.toBeNull();
    expect(result.outputAudio.length).toBeGreaterThan(0);
    expect(h.uploads).toHaveLength(1);
    expect(result.run.outputAudioPath).toBe(`runs/${result.run.id}.out.wav`);
  });

  it('A GATE THAT NEVER OPENED IS DIAGNOSED, not silently stored as silence (round 3, R3-7)', async () => {
    // The whole point. AC1 — an Arm A run returns audible speech from
    // GET /api/runs/:id/audio — is the one criterion no vitest run can prove,
    // and the ticket concedes it to an operator smoke test in a real Chrome.
    // Since capture hangs off `output_audio_buffer.started`, a gate that never
    // opened stores an artifact BYTE-IDENTICAL to a model that never spoke. A
    // smoke test that cannot tell those apart does not confirm AC1.
    const h = makeArmAHarness({ gateStuck: true });
    const done = runOnce({ recordingId: RECORDING.id, config: REALTIME_CONFIG, deps: h.deps });
    await vi.advanceTimersByTimeAsync(DURATION_MS + 10_000);
    const result = await done;

    // The track really ran and the gate really refused all of it...
    expect(h.delivered.length).toBeGreaterThan(0);
    expect(h.trackAudio).toEqual([]);
    expect(result.outputAudio).toHaveLength(0);
    // ...and — R4-1, the conjunct that makes this a CAPTURE fault rather than a
    // silent model — the model demonstrably started an output buffer.
    expect(result.run.timings.audio_queued).not.toBeNull();
    expect(typeof result.run.timings.audio_queued).toBe('number');

    // THE criterion: the run SAYS SO, in the place the operator already reads.
    const line = result.run.errors.find((e) => e.startsWith(CAPTURE_GATE_NEVER_OPENED));
    expect(line).toBeDefined();
    // ...naming BOTH numbers, because "seen 288000, admitted 0" is the whole
    // diagnosis and "capture failed" is not.
    expect(line).toContain(String(h.delivered.length));
    expect(line).toContain('0');
    // The line survives into the append-only ledger, not just the return value.
    expect(h.posted[0]!.errors).toEqual(result.run.errors);
  });

  it('the diagnostic does NOT fail the run — it stays complete and aggregatable (round 3, R3-7)', async () => {
    // Exactly the 045 upload-failure contract: `errors` carries the symptom and
    // `status` carries the verdict. Aggregation (exportResults, results/derive)
    // gates on `status === 'complete'` and never on `errors`, so a diagnostic
    // that flipped the status would silently disqualify runs from every figure —
    // far worse than the blind spot it replaces.
    const h = makeArmAHarness({ gateStuck: true });
    const done = runOnce({ recordingId: RECORDING.id, config: REALTIME_CONFIG, deps: h.deps });
    await vi.advanceTimersByTimeAsync(DURATION_MS + 10_000);
    const result = await done;

    expect(result.run.status).toBe('complete');
    expect(result.cancelled).toBeFalsy();
    // Every measurement is untouched: this run is still evidence.
    expect(result.run.timings.audio_queued).toBe(h.queuedAt.at(-1));
    expect(result.run.timings.audio_queued).not.toBeNull();
    expect(result.run.utterances).toHaveLength(MANIFEST.length);
    for (const u of result.run.utterances ?? []) {
      expect(u.status).toBe('complete');
      expect(u.timings.audio_queued).not.toBeNull();
    }
    // Segmentation still agreed — the diagnostic is the ONLY line.
    expect(result.run.errors).toHaveLength(1);
    // ...and it honestly claims no audio, so the play control stays absent
    // rather than offering a button that 404s.
    expect(result.audioReady).toBe(false);
    expect(h.uploads).toEqual([]);
    expect(result.run.outputAudioPath).toBeUndefined();
  });

  it('A SILENT MODEL IS NOT A STUCK GATE: {n, 0} with no audio_queued gets NO line (round 4, R4-1)', async () => {
    // R3-7's condition assumed an honestly-silent run yields `{ 0, 0 }`. That is
    // true of the `mute` harness, which hands the fake tap nothing — and FALSE in
    // Chrome: once the ScriptProcessor is connected the graph is pulled
    // continuously and the receiver renders silence frames whether or not any RTP
    // arrives. So in production `{ 0, 0 }` is essentially unreachable for a
    // connected run, and BOTH failure modes present as `{ n, 0 }` — the two cases
    // the diagnostic exists to separate. Labelling this one "capture" points the
    // operator at the tap when the cause is the MODEL.
    const h = makeArmAHarness({ noStartedEvent: true });
    const done = runOnce({ recordingId: RECORDING.id, config: REALTIME_CONFIG, deps: h.deps });
    await vi.advanceTimersByTimeAsync(DURATION_MS + 10_000);
    const result = await done;

    // The real-Chrome silent-model signature, exactly: a track that rendered
    // frames, nothing admitted, and NO output buffer ever started.
    expect(h.delivered.length).toBeGreaterThan(0);
    expect(h.trackAudio).toEqual([]);
    expect(h.queuedAt).toEqual([]);
    expect(result.run.timings.audio_queued).toBeNull();
    expect(result.outputAudio).toHaveLength(0);

    // THE criterion: no capture diagnostic. The gate was never ASKED to open.
    expect(result.run.errors.some((e) => e.startsWith(CAPTURE_GATE_NEVER_OPENED))).toBe(false);
    expect(result.run.errors).toEqual([]);
    // ...and the run is still the honest record of a model that said nothing.
    expect(result.run.status).toBe('complete');
    expect(result.run.outputAudioPath).toBeUndefined();
  });

  it('A CANCELLED run gets NO line, even with a stuck gate and a real audio_queued (round 4, R4-1)', async () => {
    // The sharp version of "cancelled runs are exempt": the operator stopped this
    // one mid-answer, so `{ n, 0 }` says nothing about the gate — capture was
    // still open for business when the run was taken away from it. Every other
    // conjunct holds here, so `!cancelled` is the only thing suppressing the line.
    const h = makeArmAHarness({ gateStuck: true });
    const controller = new AbortController();
    const done = runOnce({
      recordingId: RECORDING.id,
      config: REALTIME_CONFIG,
      deps: h.deps,
      signal: controller.signal,
    });
    // Past the first utterance boundary, so `output_audio_buffer.started` really
    // did arrive and the track really did carry samples...
    await vi.advanceTimersByTimeAsync(1_500);
    controller.abort();
    await vi.advanceTimersByTimeAsync(DURATION_MS + 10_000);
    const result = await done;

    expect(result.cancelled).toBe(true);
    expect(h.queuedAt.length).toBeGreaterThan(0);
    expect(h.delivered.length).toBeGreaterThan(0);
    expect(h.trackAudio).toEqual([]);

    // THE criterion: the cancellation is the only thing this run reports.
    expect(result.run.errors.some((e) => e.startsWith(CAPTURE_GATE_NEVER_OPENED))).toBe(false);
    expect(result.run.errors).toEqual(['run cancelled']);
  });

  it('A HEALTHY run carries NO diagnostic, and neither does a genuinely mute model (round 3, R3-7)', async () => {
    // Both halves of the negative. Without them the assertion above is vacuous:
    // a runner that stamped the line unconditionally would pass it.
    const healthy = makeArmAHarness();
    const healthyDone = runOnce({
      recordingId: RECORDING.id,
      config: REALTIME_CONFIG,
      deps: healthy.deps,
    });
    await vi.advanceTimersByTimeAsync(DURATION_MS + 10_000);
    const withAudio = await healthyDone;

    expect(withAudio.outputAudio.length).toBeGreaterThan(0);
    expect(withAudio.run.errors).toEqual([]);

    // A model that answered on the data channel and put NOTHING on the track:
    // the gate opened and closed as it should, and there was simply no audio.
    // `{ admitted: 0, dropped: 0 }` is a DEAD TRACK, not a broken gate — and
    // this is precisely the run the diagnostic must NOT claim.
    vi.setSystemTime(0);
    const silent = makeArmAHarness({ mute: true });
    const silentDone = runOnce({
      recordingId: RECORDING.id,
      config: REALTIME_CONFIG,
      deps: silent.deps,
    });
    await vi.advanceTimersByTimeAsync(DURATION_MS + 10_000);
    const noAudio = await silentDone;

    expect(silent.delivered).toEqual([]);
    expect(noAudio.outputAudio).toHaveLength(0);
    expect(noAudio.run.errors.some((e) => e.startsWith(CAPTURE_GATE_NEVER_OPENED))).toBe(false);
    expect(noAudio.run.status).toBe('complete');
  });

  it('NOTHING AUTOPLAYS, and the run ends up judgeable in blind compare', async () => {
    const h = makeArmAHarness();
    const done = runOnce({ recordingId: RECORDING.id, config: REALTIME_CONFIG, deps: h.deps });
    await vi.advanceTimersByTimeAsync(DURATION_MS + 10_000);
    const result = await done;

    // Capturing is not playing: no AudioContext was constructed by the run.
    expect(audioContextSpy).not.toHaveBeenCalled();
    // The tap is released with the transport, exactly like the outbound sink.
    expect(h.taps[0]!.closed).toBe(1);

    // The two gates a sample must pass to be judgeable: RunsList renders
    // [data-run-play] iff `outputAudioPath !== undefined` (045), and blind
    // compare pairs only COMPLETED runs. An Arm A sample now passes both, so an
    // A-vs-B pair can be played and scored.
    const run = h.posted[0]!;
    expect(run.status).toBe('complete');
    expect(run.armTag).toBe('A');
    expect(run.outputAudioPath).not.toBeUndefined();
    expect(result.run.outputAudioPath).toBe(run.outputAudioPath);
  });
});
