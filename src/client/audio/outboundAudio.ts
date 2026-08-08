/**
 * Ticket 043 — the REAL outbound audio sink for a microphone-less realtime
 * session (Replay Arm A).
 *
 * ============================ API DESIGN (normative) =======================
 * Locked by outboundAudio.test.ts.
 *
 * WHY THIS EXISTS
 *   Live's realtime audio rides the WebRTC media track, wired straight from
 *   getUserMedia — there is nothing to send by hand, which is why
 *   `RealtimeTransport.sendAudio` was a no-op. REPLAY HAS NO MICROPHONE: the
 *   runner paces the recorded clip and hands the transport one 480-sample
 *   frame every 20 ms, and every one of those frames was discarded. OpenAI
 *   received silence, VAD never fired, and Arm A produced zero utterances.
 *
 *   So the paced PCM needs a track of its own. This module builds one: an
 *   AudioContext at OUTBOUND_SAMPLE_RATE feeding a
 *   MediaStreamAudioDestinationNode, whose stream carries exactly one audio
 *   track — the track the transport adds to its peer connection.
 *
 * OUTBOUND_SAMPLE_RATE is SAMPLE_RATE (24 000). It is DERIVED, never a second
 * literal: the context must run at the wire rate so paced 24 kHz PCM16 needs
 * no resampling on the way out, and AGENTS.md records that 16 kHz is rejected
 * outright by OpenAI transcription.
 *
 * createOutboundAudioSink({ audioContextFactory }) -> OutboundAudioSink
 *   - audioContextFactory is called EXACTLY ONCE, EAGERLY, with
 *     `{ sampleRate: OUTBOUND_SAMPLE_RATE }` — the track has to exist before
 *     the offer is created, so there is nothing to be lazy about.
 *   - `track` is `createMediaStreamDestination().stream.getAudioTracks()[0]`.
 *   - `write(pcm)` schedules ONE buffer source per call, CONTIGUOUSLY:
 *     `when = max(ctx.currentTime, nextStartTime)` and
 *     `nextStartTime = when + pcm.length / OUTBOUND_SAMPLE_RATE`. One source
 *     per write, started at the moment of the write — the pacer owns the
 *     schedule, and this module must never accumulate frames and flush them
 *     faster than real time (that invalidates VAD and every latency figure,
 *     and it LOOKS like it worked).
 *   - An EMPTY frame schedules nothing.
 *   - `close()` closes the context and is idempotent; writes after close are
 *     inert rather than throwing (a late paced frame must not fail a run).
 * ==========================================================================
 */

import { SAMPLE_RATE } from '../../core/protocol';
import type { OutboundAudioSink } from '../transport/realtime';

/** The outbound context rate. Derived from the wire rate, never re-literalled. */
export const OUTBOUND_SAMPLE_RATE = SAMPLE_RATE;

export interface OutboundBufferLike {
  getChannelData(channel: number): Float32Array;
}

export interface OutboundSourceLike {
  buffer: OutboundBufferLike | null;
  connect(node: unknown): void;
  start(when?: number): void;
}

export interface OutboundDestinationLike {
  stream: { getAudioTracks(): unknown[] };
}

/** The minimal AudioContext surface this module touches (tests fake exactly it). */
export interface OutboundAudioContextLike {
  currentTime: number;
  createBuffer(numChannels: number, length: number, sampleRate: number): OutboundBufferLike;
  createBufferSource(): OutboundSourceLike;
  createMediaStreamDestination(): OutboundDestinationLike;
  close(): Promise<void> | void;
}

export interface OutboundAudioSinkOptions {
  /** Builds the context; production passes `(o) => new AudioContext(o)`. */
  audioContextFactory: (options: { sampleRate: number }) => OutboundAudioContextLike;
}

/** PCM16 full scale. `s / 32768` maps -32768 -> -1 and 32767 -> 32767/32768. */
const PCM16_SCALE = 32_768;

export function createOutboundAudioSink(options: OutboundAudioSinkOptions): OutboundAudioSink {
  // EAGER, exactly once: the track has to exist before createOffer, so there is
  // nothing to be lazy about. The FACTORY is what keeps jsdom safe — a bag that
  // never connects never calls this function at all.
  const ctx = options.audioContextFactory({ sampleRate: OUTBOUND_SAMPLE_RATE });
  const destination = ctx.createMediaStreamDestination();
  const track: unknown = destination.stream.getAudioTracks()[0];

  /**
   * The end of the last scheduled frame, on the context clock. Frame k begins
   * exactly where frame k-1 ended, so N writes occupy N frame-durations of
   * context time no matter how fast the writes arrive: the pacer owns the
   * schedule and this module can never flush the clip ahead of real time.
   */
  let nextStartTime = 0;
  let closed = false;
  /** The single in-flight (or settled) context close. Null until close(). */
  let closing: Promise<void> | null = null;

  return {
    track,
    write(pcm: Int16Array): void {
      // A paced frame can land after stop(); it must be inert, never fatal.
      if (closed) return;
      // An empty frame schedules nothing at all (no buffer, no source).
      if (pcm.length === 0) return;

      // Buffer rate === context rate: a disagreement here resamples silently.
      const buffer = ctx.createBuffer(1, pcm.length, OUTBOUND_SAMPLE_RATE);
      const channel = buffer.getChannelData(0);
      for (let i = 0; i < pcm.length; i++) channel[i] = (pcm[i] ?? 0) / PCM16_SCALE;

      // Never schedule in the past: a context whose clock has run on (a late
      // start, a pacer that fell behind) resumes from currentTime.
      const when = Math.max(ctx.currentTime, nextStartTime);
      nextStartTime = when + pcm.length / OUTBOUND_SAMPLE_RATE;

      const source = ctx.createBufferSource();
      source.buffer = buffer;
      source.connect(destination);
      source.start(when);
    },
    /**
     * TICKET 046 ROUND 3 (R3-6) — the exact mirror of the inbound tap's close.
     *
     * A realtime Replay run holds TWO AudioContexts (this sink and the tap) and
     * Chrome caps concurrent hardware contexts at roughly six, so across a
     * 60-run sweep a close nobody waits for is what eventually makes a
     * construction throw and kills a run. Round 2 sequenced only the tap while
     * the runner's comment claimed both — a comment promising protection the
     * code does not give is worse than either half alone.
     *
     * Idempotent AND still awaitable: a second caller gets the SAME close. It
     * never REJECTS — a wedged context is not something a run can act on, and a
     * rejection here would surface as an unhandled rejection mid-sweep.
     */
    close(): Promise<void> {
      if (closing !== null) return closing;
      closed = true;
      closing = Promise.resolve(ctx.close()).then(
        () => undefined,
        () => undefined,
      );
      return closing;
    },
  };
}
