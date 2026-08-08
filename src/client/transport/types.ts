/**
 * Ticket 011 / 012 — Transport contracts. Both transports (realtime WebRTC,
 * cascade WS), the fixture transport, and the TransportRouter speak exactly
 * this surface; the UI consumes it. Shapes here are NORMATIVE — implementer
 * and UI follow them.
 *
 * Event shapes:
 * - onSourceText: { kind: 'partial' | 'final', text, utt } — source-language
 *   transcript. 'partial' carries the ACCUMULATED text so far (not the raw
 *   delta); 'final' the closing transcript.
 * - onTargetText: { kind: 'delta' | 'final', text, utt } — target-language
 *   translation. 'delta' carries the incremental token chunk; 'final' the
 *   full translation.
 * - onAudio(pcm, utt): 24 kHz mono PCM16 TTS audio for utterance `utt`.
 * - onTiming({ event, t, utt, stage? }): timing marks named after
 *   src/core/timing.ts timestamp keys (e.g. 'server_speech_stopped',
 *   'first_audio_delta', 'vad_fired', 'stt_final', ...). `t` is epoch ms
 *   from the transport's injected clock (server-supplied for cascade).
 *   `stage` is set for cascade stage.timing events ('stt' | 'mt' | 'tts').
 * - onUtteranceComplete(record-ish): for cascade, the server's full
 *   UtteranceRecord; for realtime, { utt, usage } (the client assembles the
 *   record). Hence the loose UtteranceCompletion type.
 * - onError({ message, opaque, stage? }): opaque === true means no stage
 *   attribution is possible (realtime); opaque === false carries the
 *   cascade stage-attributed message verbatim, with `stage` when the server
 *   sent one.
 * - onConnectionState(state, attempt?): 'connected' on (re)establishment;
 *   'reconnecting' with attempt = 1..5 per retry; 'disconnected' after
 *   retries are exhausted (MAX_TRANSPORT_RECONNECT_ATTEMPTS = 5, matching
 *   MAX_RECONNECT_ATTEMPTS in sessionMachine).
 *
 * `utt` is the 0-based per-session utterance sequence number (cascade: from
 * the wire protocol; realtime: assigned client-side, incremented at each
 * response.done).
 *
 * All handlers are optional; setHandlers replaces the whole set and may be
 * called before or after start().
 */

import type { UtteranceRecord } from '../../core/timing';

export const MAX_TRANSPORT_RECONNECT_ATTEMPTS = 5;

export type TransportKind = 'realtime' | 'cascade';

export interface SourceTextEvent {
  kind: 'partial' | 'final';
  text: string;
  utt: number;
}

export interface TargetTextEvent {
  kind: 'delta' | 'final';
  text: string;
  utt: number;
}

export interface TimingMark {
  /** Timestamp key name, e.g. 'server_speech_stopped', 'stt_final'. */
  event: string;
  /** Epoch milliseconds. */
  t: number;
  utt: number;
  /** Cascade pipeline stage for stage.timing events. */
  stage?: string;
}

export interface TransportError {
  message: string;
  /** true: no stage attribution possible (realtime). false: cascade, verbatim. */
  opaque: boolean;
  stage?: string;
}

export type ConnectionState = 'connected' | 'reconnecting' | 'disconnected';

/** Cascade delivers the server's full record; realtime delivers {utt, usage}. */
export type UtteranceCompletion = Partial<UtteranceRecord> & {
  utt?: number;
  usage?: unknown;
};

export interface TransportHandlers {
  onSourceText?: (e: SourceTextEvent) => void;
  onTargetText?: (e: TargetTextEvent) => void;
  onAudio?: (pcm: Int16Array, utt: number) => void;
  onTiming?: (mark: TimingMark) => void;
  onUtteranceComplete?: (record: UtteranceCompletion) => void;
  onError?: (e: TransportError) => void;
  onConnectionState?: (state: ConnectionState, attempt?: number) => void;
}

/** Config passed to start(). */
export interface TransportConfig {
  /** e.g. 'EN↔ES' — forwarded to cascade session.start. */
  languagePair: string;
  /** e.g. 'en→es' — forwarded to cascade session.start. */
  direction: string;
  /** Human-readable target language, used in realtime interpreter instructions. */
  targetLanguage: string;
  /** Cascade provider selection; required for cascade, ignored by realtime. */
  providers?: { stt: string; mt: string; tts: string };
}

/**
 * TICKET 012: no `armId`. Live runs ONE transport at a time (the router is a
 * switch, not a fan-out), so there is nothing for an id to disambiguate.
 * Concrete transports may still carry their own construction-time id.
 */
export interface InterpreterTransport {
  readonly kind: TransportKind;
  readonly label: string;
  readonly costPerMinUsd: number;
  start(config: TransportConfig): Promise<void>;
  /**
   * Tear the session down.
   *
   * TICKET 046 ROUND 2 (R2-7) — MAY return a promise that settles once the
   * transport's audio contexts are really closed. A realtime Replay run builds
   * TWO AudioContexts and Chrome caps concurrent ones (~6), so a 60-run sweep
   * that never waits for a close can make a later construction throw and kill a
   * run. `runOnce` AWAITS this; Live's router does not need to (one session at a
   * time), and every transport that closes nothing keeps returning void.
   */
  stop(): void | Promise<void>;
  /** 24 kHz mono PCM16 mic chunk. No-op for realtime (mic rides WebRTC media). */
  sendAudio(pcm: Int16Array): void;
  setHandlers(handlers: TransportHandlers): void;
  /**
   * TICKET 046 (OPTIONAL) — the transport's OWN captured output audio, as
   * 24 kHz mono PCM16, for transports whose output audio never reaches
   * `onAudio`. Over WebRTC the model's audio rides the media track only, so
   * Arm A has nothing to hand the `onAudio` path; a transport that taps that
   * track reports the samples here instead.
   *
   * DELIBERATELY NOT `onAudio`: `onAudio` is what stamps `audio_queued` in the
   * runner, and Arm A's `audio_queued` must keep coming from
   * `output_audio_buffer.started`. Capturing must not move the measurement.
   *
   * Readable AFTER `stop()`. Transports without a capture path omit it, and
   * every existing fake keeps working untouched.
   */
  takeOutputAudio?(): Int16Array;
  /**
   * TICKET 046 ROUND 3 (R3-7, OPTIONAL) — what the capture path SAW, in samples.
   *
   * AC1 (an Arm A run returns audible speech from `GET /api/runs/:id/audio`) is
   * the one criterion no vitest run can prove; the ticket concedes it to an
   * operator smoke test in a real Chrome session. Capture hangs off a
   * data-channel event, so "the gate never opened" stores an artifact BYTE-
   * IDENTICAL to "the model never spoke" — and a smoke test that cannot tell
   * those apart does not confirm AC1, it merely fails to contradict it.
   *
   * `undefined` for a transport with no capture path at all (cascade, Live,
   * every fake that omits the tap): absent is not the same as "saw nothing", and
   * only the second one is a symptom.
   */
  outputAudioStats?(): OutputAudioStats | undefined;
}

/**
 * TICKET 046 ROUND 3 (R3-7) — the capture gate's own account of the track.
 * `admitted + dropped` is everything the capture node was handed, so
 * `{ admitted: 0, dropped: 0 }` (a dead track) and `{ admitted: 0, dropped: n }`
 * (a gate that never opened) are finally distinguishable.
 */
export interface OutputAudioStats {
  /** Samples that reached the recording — always `takeOutputAudio().length`. */
  admitted: number;
  /** Samples the gate refused: outside every window and past every grace. */
  dropped: number;
}
