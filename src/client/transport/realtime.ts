/**
 * Ticket 011 — Realtime (OpenAI speech-to-speech over WebRTC) transport.
 *
 * ============================ API DESIGN (normative) =======================
 * Locked by realtime.test.ts:
 *
 * new RealtimeTransport(opts, deps)
 *   opts: { armId, label?, costPerMinUsd?, model? (default 'gpt-realtime-mini') }
 *   deps: { fetchImpl, rtcFactory, now } — ALL injectable; tests use fakes.
 *
 * start(config):
 *  1. POST TOKEN_ENDPOINT ('/api/realtime-token') with
 *     { 'Content-Type': 'application/json' } and body { model } ->
 *     { value: ephemeral }.
 *  2. pc = rtcFactory(); channel = pc.createDataChannel('oai-events');
 *     offer = await pc.createOffer(); await pc.setLocalDescription(offer);
 *     POST the offer SDP to OPENAI_REALTIME_CALLS_URL (query params allowed
 *     after the base URL) with headers
 *       Authorization: `Bearer ${ephemeral}`, 'Content-Type': 'application/sdp'
 *     and body === offer.sdp; the response text is the answer SDP ->
 *     await pc.setRemoteDescription({ type: 'answer', sdp: answer }).
 *  3. start() resolves once the answer is applied, and emits
 *     onConnectionState('connected') at that point.
 *  4. When the data channel opens, send ONE session.update JSON whose
 *     serialized form contains: turn_detection type 'server_vad' with
 *     silence_duration_ms 500, input audio transcription enabled, and
 *     interpreter `instructions` that mention config.targetLanguage.
 *  START FAILURE (e.g. token fetch rejects or non-ok): start() RESOLVES
 *  (never rejects — no unhandled rejections by construction); the failure
 *  surfaces as onError({opaque: true, ...}) + onConnectionState('disconnected').
 *
 * sendAudio(): NO-OP. Realtime mic audio rides the WebRTC media track (wired
 * from getUserMedia outside this class); the router still fans chunks here
 * harmlessly so both transport kinds share one call site.
 *
 * DATA-CHANNEL EVENT MAPPING (GA event names), driven per parsed message:
 * - conversation.item.input_audio_transcription.delta { delta } ->
 *     onSourceText { kind: 'partial', text: <accumulated deltas>, utt }
 * - conversation.item.input_audio_transcription.completed { transcript } ->
 *     onSourceText { kind: 'final', text: transcript, utt } (resets accumulator)
 * - response.output_audio_transcript.delta { delta } ->
 *     onTargetText { kind: 'delta', text: delta, utt }
 * - response.output_audio_transcript.done { transcript } ->
 *     onTargetText { kind: 'final', text: transcript, utt }
 * - input_audio_buffer.speech_stopped ->
 *     onTiming { event: 'server_speech_stopped', t: now(), utt }
 * - response.output_audio.delta { delta: base64 PCM16 } ->
 *     onAudio(Int16Array, utt); the FIRST audio delta of an utterance also
 *     emits onTiming { event: 'first_audio_delta', t: now(), utt }
 * - response.done { response: { usage } } ->
 *     onUtteranceComplete({ utt, usage }) and THEN increments the
 *     client-side utt counter (starts at 0).
 * - error -> onError with opaque: true and the EXACT message
 *     REALTIME_OPAQUE_ERROR_MESSAGE (the model gives us no stage attribution
 *     and the session keeps running).
 *
 * RECONNECT: an unexpected pc/channel close (any close not caused by stop())
 * triggers onConnectionState('reconnecting', attempt) for attempt = 1..5;
 * each attempt re-runs the full token + offer flow through the injected
 * fakes. A successful attempt emits onConnectionState('connected'). After 5
 * failed attempts -> onConnectionState('disconnected').
 *
 * stop(): closes channel + pc; NO events of any kind fire afterwards (no
 * reconnect, no mapped messages).
 * ==========================================================================
 */

import type {
  InterpreterTransport,
  TransportConfig,
  TransportHandlers,
  TransportKind,
} from './types';

export const TOKEN_ENDPOINT = '/api/realtime-token';
export const OPENAI_REALTIME_CALLS_URL = 'https://api.openai.com/v1/realtime/calls';

/** EXACT user-facing copy for opaque realtime failures (locked by tests). */
export const REALTIME_OPAQUE_ERROR_MESSAGE =
  'opaque failure — no stage attribution · session still running';

export interface RtcDataChannelLike {
  readonly label: string;
  send(data: string): void;
  close(): void;
  onopen: (() => void) | null;
  onmessage: ((ev: { data: string }) => void) | null;
  onclose: (() => void) | null;
}

export interface RtcSessionDescriptionLike {
  type: string;
  sdp: string;
}

export interface RtcPeerConnectionLike {
  createDataChannel(label: string): RtcDataChannelLike;
  createOffer(): Promise<RtcSessionDescriptionLike>;
  setLocalDescription(desc: RtcSessionDescriptionLike): Promise<void>;
  setRemoteDescription(desc: RtcSessionDescriptionLike): Promise<void>;
  close(): void;
}

export interface RealtimeDeps {
  fetchImpl: typeof fetch;
  rtcFactory: () => RtcPeerConnectionLike;
  /** Epoch-ms clock for timing marks. */
  now: () => number;
}

export interface RealtimeTransportOptions {
  armId: string;
  label?: string;
  costPerMinUsd?: number;
  model?: string;
}

export class RealtimeTransport implements InterpreterTransport {
  readonly kind: TransportKind = 'realtime';
  readonly armId: string;
  readonly label: string;
  readonly costPerMinUsd: number;

  constructor(opts: RealtimeTransportOptions, _deps: RealtimeDeps) {
    this.armId = opts.armId;
    this.label = opts.label ?? 'Realtime';
    this.costPerMinUsd = opts.costPerMinUsd ?? 0;
  }

  async start(_config: TransportConfig): Promise<void> {
    throw new Error('not implemented');
  }

  stop(): void {
    throw new Error('not implemented');
  }

  sendAudio(_pcm: Int16Array): void {
    throw new Error('not implemented');
  }

  setHandlers(_handlers: TransportHandlers): void {
    throw new Error('not implemented');
  }
}
