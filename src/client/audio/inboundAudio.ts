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

/** STUB — ticket 046 implementation pending. */
export function createInboundAudioTap(_options: InboundAudioTapOptions): InboundAudioTap {
  throw new Error('createInboundAudioTap is not implemented');
}
