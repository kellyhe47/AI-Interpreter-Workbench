/**
 * Ticket 046 — the REAL inbound audio tap: Arm A's output audio, captured off
 * the WebRTC media track.
 *
 * ============================ API DESIGN (normative) =======================
 * Locked by inboundAudio.test.ts.
 *
 * WHY THIS EXISTS
 *   Over WebRTC OpenAI sends the response audio on the MEDIA TRACK ONLY —
 *   `response.output_audio.delta` does not exist (established empirically in
 *   ticket 040). So `onAudio` never fires for Arm A, an Arm A run buffers zero
 *   samples, ticket 045's upload path has nothing to upload, and blind compare
 *   — playback-only by design (PRD §10) — has nothing to play for any pair
 *   involving Arm A.
 *
 *   This module is the mirror of `outboundAudio.ts`: an AudioContext at
 *   INBOUND_SAMPLE_RATE with a MediaStreamAudioSourceNode over the remote
 *   stream, feeding a capture node whose frames are converted to PCM16 and
 *   accumulated. What comes out is byte-comparable with what cascade produces,
 *   so blind compare cannot tell the two arms apart by format.
 *
 * INBOUND_SAMPLE_RATE is SAMPLE_RATE (24 000), DERIVED and never a second
 * literal: the context runs at the wire rate, so what is captured needs no
 * resampling to become the same 24 kHz mono PCM16 the cascade path uploads.
 *
 * createInboundAudioTap({ audioContextFactory }) -> InboundAudioTap
 *   - audioContextFactory is called EXACTLY ONCE, EAGERLY, with
 *     `{ sampleRate: INBOUND_SAMPLE_RATE }`.
 *   - `attach(stream)` builds a media-stream source over that stream and routes
 *     it into a mono capture node. A SECOND attach (a reconnect) disconnects
 *     the previous source and APPENDS to the same buffer: one run is one
 *     recording, whatever the connection did underneath.
 *   - CAPTURE IS SILENT. Nothing in Replay autoplays (PRD §7), so the tap may
 *     never sound the stream: any path this module opens to `ctx.destination`
 *     is through a gain node whose gain is 0.
 *   - `take()` is NON-DESTRUCTIVE: it returns everything captured so far and
 *     leaves it in place, so the runner can read it AFTER `stop()` has already
 *     closed the tap.
 *   - `close()` closes the context and is idempotent; frames that land after
 *     close are dropped rather than throwing, and the audio captured before it
 *     is still readable.
 * ==========================================================================
 */

import { SAMPLE_RATE } from '../../core/protocol';
import type { InboundAudioTap } from '../transport/realtime';
import { floatTo16 } from './pcm';

/** The tap's context rate. Derived from the wire rate, never re-literalled. */
export const INBOUND_SAMPLE_RATE = SAMPLE_RATE;

/**
 * ROUND 2 (R2-4) — how long capture continues past `output_audio_buffer.stopped`.
 *
 * The event marks the end of the model's OUTPUT BUFFER, not the end of the sound
 * arriving over RTP: the last syllable is still in flight when it lands. 250 ms
 * is a syllable's worth of tail — enough that nothing audible is clipped, short
 * enough that the inter-utterance silence which would unblind blind compare is
 * still dropped.
 */
export const INBOUND_TAIL_GRACE_MS = 250;

/** The grace expressed in SAMPLES — the only unit the capture node counts in. */
export const INBOUND_TAIL_GRACE_SAMPLES = Math.round(
  (INBOUND_TAIL_GRACE_MS * INBOUND_SAMPLE_RATE) / 1000,
);

export interface InboundAudioProcessEventLike {
  inputBuffer: { getChannelData(channel: number): Float32Array };
}

export interface InboundProcessorLike {
  onaudioprocess: ((ev: InboundAudioProcessEventLike) => void) | null;
  connect(node: unknown): void;
  disconnect(): void;
}

export interface InboundSourceNodeLike {
  connect(node: unknown): void;
  disconnect(): void;
}

export interface InboundGainLike {
  gain: { value: number };
  connect(node: unknown): void;
  disconnect(): void;
}

/** The minimal AudioContext surface this module touches (tests fake exactly it). */
export interface InboundAudioContextLike {
  readonly sampleRate: number;
  readonly destination: unknown;
  createMediaStreamSource(stream: unknown): InboundSourceNodeLike;
  createScriptProcessor(
    bufferSize: number,
    inputChannels: number,
    outputChannels: number,
  ): InboundProcessorLike;
  createGain(): InboundGainLike;
  close(): Promise<void> | void;
}

export interface InboundAudioTapOptions {
  /** Builds the context; production passes `(o) => new AudioContext(o)`. */
  audioContextFactory: (options: { sampleRate: number }) => InboundAudioContextLike;
}

/**
 * The capture block size. A power of two, as Web Audio requires; 2048 is the
 * same quantum `browserDeps`' microphone pipeline uses, so both capture paths
 * in this client render on the same grain.
 */
const CAPTURE_BUFFER_SIZE = 2048;

export function createInboundAudioTap(options: InboundAudioTapOptions): InboundAudioTap {
  // EAGER, exactly once — the mirror of the outbound sink. The FACTORY is what
  // keeps jsdom safe: a transport that never sees an audio track never calls
  // `createInboundAudioTap` at all, so no AudioContext is ever constructed.
  const ctx = options.audioContextFactory({ sampleRate: INBOUND_SAMPLE_RATE });

  /** Everything captured so far, in arrival order. ONE run is ONE recording. */
  const chunks: Int16Array[] = [];
  let captured = 0;

  /** The current connection's graph, or null before the first attach. */
  let source: InboundSourceNodeLike | null = null;
  let processor: InboundProcessorLike | null = null;
  let gain: InboundGainLike | null = null;
  let closed = false;
  /** The single in-flight (or settled) context close. Null until close(). */
  let closing: Promise<void> | null = null;

  /**
   * ROUND 2 (R2-4) — THE CAPTURE GATE, and it is SHUT BY DEFAULT.
   *
   * The media track runs from the moment the answer is applied; only some of it
   * is the model speaking. `capturing` is the model's own window
   * (`output_audio_buffer.started` .. `.stopped`); `graceRemaining` is the
   * SAMPLE BUDGET that survives the window's end, because `.stopped` marks the
   * end of the output BUFFER and the last syllable is still on the wire. A
   * budget rather than a frame count: whichever frame overruns it is truncated
   * at exactly the sample where the grace runs out.
   */
  let capturing = false;
  let graceRemaining = 0;

  /** How many leading samples of this frame the gate lets through. */
  const admit = (length: number): number => {
    if (capturing) return length;
    if (graceRemaining <= 0) return 0;
    const kept = Math.min(length, graceRemaining);
    graceRemaining -= kept;
    return kept;
  };

  /**
   * Tears down the graph of the PREVIOUS connection without touching `chunks`.
   * Silencing the old processor is the load-bearing half: a reconnect that left
   * it live would double every subsequent frame into the recording.
   */
  const release = (): void => {
    if (processor !== null) {
      processor.onaudioprocess = null;
      processor.disconnect();
    }
    source?.disconnect();
    gain?.disconnect();
    source = null;
    processor = null;
    gain = null;
  };

  return {
    attach(stream): void {
      // A track event can land after stop(); it must be inert, never fatal.
      if (closed) return;
      release();

      const nextSource = ctx.createMediaStreamSource(stream);
      // MONO in, mono out: cascade's uploaded audio is one channel, and blind
      // compare must not be able to tell the arms apart by format.
      const nextProcessor = ctx.createScriptProcessor(CAPTURE_BUFFER_SIZE, 1, 1);
      // A ScriptProcessor is only pulled when it reaches a destination, so the
      // graph has to end at one — but NOTHING IN REPLAY AUTOPLAYS (PRD §7), so
      // the only path there is through a gain pinned at 0.
      const nextGain = ctx.createGain();
      nextGain.gain.value = 0;

      nextProcessor.onaudioprocess = (ev): void => {
        if (closed) return;
        const frame = ev.inputBuffer.getChannelData(0);
        const keep = admit(frame.length);
        // DROPPED, never buffered: the gap between utterances must not be able
        // to reach the file by any later decision.
        if (keep === 0) return;
        // ONE encoder for the whole client (R2-5). `floatTo16` is what the
        // microphone path, the WAV writer and every stored recording already
        // use — a second convention here would drift by an LSB and then freely.
        const pcm = floatTo16(keep === frame.length ? frame : frame.subarray(0, keep));
        chunks.push(pcm);
        captured += pcm.length;
      };

      nextSource.connect(nextProcessor);
      nextProcessor.connect(nextGain);
      nextGain.connect(ctx.destination);

      source = nextSource;
      processor = nextProcessor;
      gain = nextGain;
    },
    startWindow(): void {
      if (closed) return;
      // Re-arming during the grace RESUMES full capture: the model is speaking
      // again, and what follows is speech rather than tail.
      capturing = true;
      graceRemaining = 0;
    },
    endWindow(): void {
      if (closed) return;
      // Inert without an open window: a stray `.stopped` must not hand the gap
      // a grace it never earned.
      if (!capturing) return;
      capturing = false;
      graceRemaining = INBOUND_TAIL_GRACE_SAMPLES;
    },
    take(): Int16Array {
      // NON-DESTRUCTIVE: the runner reads this AFTER stop() has closed the tap,
      // and a second read (upload, then playback) must see the same recording.
      const out = new Int16Array(captured);
      let offset = 0;
      for (const chunk of chunks) {
        out.set(chunk, offset);
        offset += chunk.length;
      }
      return out;
    },
    close(): Promise<void> {
      // Idempotent AND still awaitable: a second caller gets the SAME close,
      // never a second `ctx.close()` and never a promise that resolves early.
      if (closing !== null) return closing;
      closed = true;
      capturing = false;
      graceRemaining = 0;
      release();
      // The recording itself is deliberately NOT cleared: `take()` runs after
      // this, and the bytes are the whole point of the tap.
      //
      // R2-7 — AWAITED, not fired and forgotten: a realtime Replay run holds two
      // AudioContexts and Chrome caps concurrent ones (~6), so a lagging close
      // is what makes construction throw part-way through a 60-run sweep. It
      // never REJECTS — a wedged context is not something a run can act on, and
      // failing the run over it would lose the measurement.
      closing = Promise.resolve(ctx.close()).then(
        () => undefined,
        () => undefined,
      );
      return closing;
    },
  };
}
