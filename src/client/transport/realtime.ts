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

import { base64ToInt16 } from '../audio/pcm';
import {
  MAX_TRANSPORT_RECONNECT_ATTEMPTS,
  type InterpreterTransport,
  type TransportConfig,
  type TransportHandlers,
  type TransportKind,
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

  private readonly model: string;
  private readonly deps: RealtimeDeps;
  private handlers: TransportHandlers = {};
  private config: TransportConfig | null = null;
  private pc: RtcPeerConnectionLike | null = null;
  private channel: RtcDataChannelLike | null = null;
  private stopped = false;
  private reconnecting = false;

  /** Client-assigned utterance counter (0-based). */
  private utt = 0;
  /** Accumulated input transcription deltas for the current utterance. */
  private sourceAccum = '';
  /** Whether first_audio_delta has fired for the current utterance. */
  private firstAudioMarked = false;

  constructor(opts: RealtimeTransportOptions, deps: RealtimeDeps) {
    this.armId = opts.armId;
    this.label = opts.label ?? 'Realtime';
    this.costPerMinUsd = opts.costPerMinUsd ?? 0;
    this.model = opts.model ?? 'gpt-realtime-mini';
    this.deps = deps;
  }

  async start(config: TransportConfig): Promise<void> {
    this.config = config;
    const ok = await this.connect();
    if (ok) {
      if (!this.stopped) this.handlers.onConnectionState?.('connected');
    } else if (!this.stopped) {
      this.handlers.onError?.({ message: REALTIME_OPAQUE_ERROR_MESSAGE, opaque: true });
      this.handlers.onConnectionState?.('disconnected');
    }
  }

  /** Runs the full token + offer/answer flow. Returns success; never throws. */
  private async connect(): Promise<boolean> {
    try {
      const tokenRes = await this.deps.fetchImpl(TOKEN_ENDPOINT, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ model: this.model }),
      });
      if (!tokenRes.ok) return false;
      const { value: ephemeral } = (await tokenRes.json()) as { value: string };

      const pc = this.deps.rtcFactory();
      const channel = pc.createDataChannel('oai-events');
      const offer = await pc.createOffer();
      await pc.setLocalDescription(offer);

      const sdpRes = await this.deps.fetchImpl(
        `${OPENAI_REALTIME_CALLS_URL}?model=${encodeURIComponent(this.model)}`,
        {
          method: 'POST',
          headers: {
            Authorization: `Bearer ${ephemeral}`,
            'Content-Type': 'application/sdp',
          },
          body: offer.sdp,
        },
      );
      if (!sdpRes.ok) return false;
      const answer = await sdpRes.text();
      await pc.setRemoteDescription({ type: 'answer', sdp: answer });

      if (this.stopped) {
        channel.close();
        pc.close();
        return false;
      }

      this.pc = pc;
      this.channel = channel;
      channel.onopen = () => {
        if (this.stopped || this.channel !== channel) return;
        channel.send(JSON.stringify(this.sessionUpdate()));
      };
      channel.onmessage = (ev) => {
        if (this.stopped || this.channel !== channel) return;
        this.handleMessage(ev.data);
      };
      channel.onclose = () => {
        if (this.stopped || this.channel !== channel) return;
        void this.reconnect();
      };
      return true;
    } catch {
      return false;
    }
  }

  private sessionUpdate(): unknown {
    const targetLanguage = this.config?.targetLanguage ?? '';
    return {
      type: 'session.update',
      session: {
        type: 'realtime',
        instructions:
          `You are a professional simultaneous interpreter. ` +
          `Translate everything the user says into ${targetLanguage}. ` +
          `Speak only the ${targetLanguage} translation — no commentary.`,
        audio: {
          input: {
            transcription: { model: 'gpt-4o-mini-transcribe' },
            turn_detection: { type: 'server_vad', silence_duration_ms: 500 },
          },
        },
      },
    };
  }

  private handleMessage(data: string): void {
    let msg: Record<string, unknown>;
    try {
      msg = JSON.parse(data) as Record<string, unknown>;
    } catch {
      return;
    }
    const h = this.handlers;
    switch (msg.type) {
      case 'conversation.item.input_audio_transcription.delta': {
        this.sourceAccum += String(msg.delta ?? '');
        h.onSourceText?.({ kind: 'partial', text: this.sourceAccum, utt: this.utt });
        break;
      }
      case 'conversation.item.input_audio_transcription.completed': {
        this.sourceAccum = '';
        h.onSourceText?.({ kind: 'final', text: String(msg.transcript ?? ''), utt: this.utt });
        break;
      }
      case 'response.output_audio_transcript.delta': {
        h.onTargetText?.({ kind: 'delta', text: String(msg.delta ?? ''), utt: this.utt });
        break;
      }
      case 'response.output_audio_transcript.done': {
        h.onTargetText?.({ kind: 'final', text: String(msg.transcript ?? ''), utt: this.utt });
        break;
      }
      case 'input_audio_buffer.speech_stopped': {
        h.onTiming?.({ event: 'server_speech_stopped', t: this.deps.now(), utt: this.utt });
        break;
      }
      case 'response.output_audio.delta': {
        if (!this.firstAudioMarked) {
          this.firstAudioMarked = true;
          h.onTiming?.({ event: 'first_audio_delta', t: this.deps.now(), utt: this.utt });
        }
        h.onAudio?.(base64ToInt16(String(msg.delta ?? '')), this.utt);
        break;
      }
      case 'response.done': {
        const response = msg.response as { usage?: unknown } | undefined;
        h.onUtteranceComplete?.({ utt: this.utt, usage: response?.usage });
        this.utt++;
        this.sourceAccum = '';
        this.firstAudioMarked = false;
        break;
      }
      case 'error': {
        h.onError?.({ message: REALTIME_OPAQUE_ERROR_MESSAGE, opaque: true });
        break;
      }
      default:
        break;
    }
  }

  private async reconnect(): Promise<void> {
    if (this.reconnecting) return;
    this.reconnecting = true;
    this.pc = null;
    this.channel = null;
    try {
      for (let attempt = 1; attempt <= MAX_TRANSPORT_RECONNECT_ATTEMPTS; attempt++) {
        if (this.stopped) return;
        this.handlers.onConnectionState?.('reconnecting', attempt);
        const ok = await this.connect();
        if (this.stopped) return;
        if (ok) {
          this.handlers.onConnectionState?.('connected');
          return;
        }
      }
      this.handlers.onConnectionState?.('disconnected');
    } finally {
      this.reconnecting = false;
    }
  }

  stop(): void {
    if (this.stopped) return;
    this.stopped = true;
    this.channel?.close();
    this.pc?.close();
    this.channel = null;
    this.pc = null;
  }

  sendAudio(_pcm: Int16Array): void {
    // NO-OP: realtime mic audio rides the WebRTC media track.
  }

  setHandlers(handlers: TransportHandlers): void {
    this.handlers = handlers;
  }
}
