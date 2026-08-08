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
import { writeWav } from '../../harness/wav';
import type { Recording, Run } from '../state/ledger';
import {
  RealtimeTransport,
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
  async setRemoteDescription(): Promise<void> {}
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

interface ArmAHarnessOptions {
  /** Frames the model needs before it responds at all. Default: every frame. */
  deaf?: boolean;
}

function makeArmAHarness(opts: ArmAHarnessOptions = {}) {
  const posted: Run[] = [];
  const pcs: E2ePc[] = [];
  /** Every paced frame the outbound sink received, with its virtual clock. */
  const written: { length: number; at: number }[] = [];
  const sinks: { closed: number }[] = [];

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
    getAudio: async () => new Uint8Array(0),
    // TICKET 045 — the output-audio upload seam; these suites produce no assertions on it.
    uploadAudio: async (id: string) => ({ id, outputAudioPath: `runs/${id}.out.wav`, bytes: 0 }),
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
    channel.emit({ type: 'output_audio_buffer.started' });
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

  return { deps, posted, pcs, written, sinks };
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(0);
});

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
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
