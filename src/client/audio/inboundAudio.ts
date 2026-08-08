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

/** PCM16 full scale. `v * 32768` maps -1 -> -32768 and +1 -> 32768 (clamped). */
const PCM16_SCALE = 32_768;
const PCM16_MIN = -32_768;
const PCM16_MAX = 32_767;

/**
 * One float sample to PCM16, CLAMPED AT FULL SCALE.
 *
 * Web Audio permits samples outside [-1, 1] (a mixed or gained graph routinely
 * produces them), and 1.0 itself would wrap to -32768 under a bare 16-bit
 * truncation. Clamping keeps an over-range sample loud rather than turning it
 * into aliased garbage that blind compare would hear as a defect of the ARM.
 */
function toPcm16(sample: number): number {
  const scaled = Math.round(sample * PCM16_SCALE);
  if (scaled > PCM16_MAX) return PCM16_MAX;
  if (scaled < PCM16_MIN) return PCM16_MIN;
  return scaled;
}

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
        const pcm = new Int16Array(frame.length);
        for (let i = 0; i < frame.length; i++) pcm[i] = toPcm16(frame[i] ?? 0);
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
    // STUB (test-writer, round 2) — the capture gate. Implement R2-4 here.
    startWindow(): void {},
    endWindow(): void {},
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
    close(): void {
      if (closed) return;
      closed = true;
      release();
      // The recording itself is deliberately NOT cleared: `take()` runs after
      // this, and the bytes are the whole point of the tap.
      void ctx.close();
    },
  };
}
