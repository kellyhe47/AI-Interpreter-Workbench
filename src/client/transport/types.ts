/**
 * Ticket 011 — Transport contracts. Both transports (realtime WebRTC,
 * cascade WS), the fixture transport, and the ArmRouter speak exactly this
 * surface; the UI (ticket 012) consumes it. Shapes here are NORMATIVE —
 * implementer and UI follow them.
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

export interface InterpreterTransport {
  readonly armId: string;
  readonly kind: TransportKind;
  readonly label: string;
  readonly costPerMinUsd: number;
  start(config: TransportConfig): Promise<void>;
  stop(): void;
  /** 24 kHz mono PCM16 mic chunk. No-op for realtime (mic rides WebRTC media). */
  sendAudio(pcm: Int16Array): void;
  setHandlers(handlers: TransportHandlers): void;
}
