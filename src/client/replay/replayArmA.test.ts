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
import { runOnce, type RunOnceConfig, type RunnerDeps } from './runner';

/** Four utterances, one per second of a 4 s clip — a PRD §9 corpus take. */
const MANIFEST: CorpusUtterance[] = [
  { id: 'u1', index: 1, category: 'short-reply', trueSpeechEndMs: 1_000 },
  { id: 'u2', index: 2, category: 'numbers-dates', trueSpeechEndMs: 2_000 },
  { id: 'u3', index: 3, category: 'proper-nouns', trueSpeechEndMs: 3_000 },
  { id: 'u4', index: 4, category: 'long-compound', trueSpeechEndMs: 4_000 },
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
}

function makeArmAHarness(opts: ArmAHarnessOptions = {}) {
  const posted: Run[] = [];
  const pcs: E2ePc[] = [];
  /** Every paced frame the outbound sink received, with its virtual clock. */
  const written: { length: number; at: number }[] = [];
  const sinks: { closed: number }[] = [];
  /** TICKET 046 — the inbound taps built, and what the track carried. */
  const taps: { attached: unknown[]; closed: number }[] = [];
  const trackAudio: number[] = [];
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
    channel.emit({ type: 'input_audio_buffer.speech_stopped' });
    queuedAt.push(Date.now());
    channel.emit({ type: 'output_audio_buffer.started' });
    // TICKET 046 — and THE AUDIO ITSELF, on the media track and nowhere else.
    // There is no `response.output_audio.delta` on this transport (040).
    if (opts.mute !== true) {
      for (let i = 0; i < TRACK_SAMPLES_PER_UTTERANCE; i++) {
        trackAudio.push(i % 2 === 0 ? answered * 100 + i : -(answered * 100 + i));
      }
    }
    channel.emit({
      type: 'response.output_audio_transcript.done',
      transcript: `translation ${answered}`,
    });
    channel.emit({ type: 'output_audio_buffer.stopped' });
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
                  take: () => Int16Array.from(trackAudio),
                  close: () => {
                    entry.closed += 1;
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

  return { deps, posted, pcs, written, sinks, taps, trackAudio, queuedAt, uploads, runs };
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

/** Every sample the fake model put on the track, as the run should have stored. */
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
