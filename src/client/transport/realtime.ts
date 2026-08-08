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
 * INBOUND MEDIA TRACK (ticket 040): on every (re)connect the transport
 * installs `pc.ontrack`. An event whose `track.kind === 'audio'` has its
 * `streams[0]` handed to `deps.remoteAudioSink.attach(stream)`. Non-audio
 * tracks, streamless events, a missing sink and post-stop() events all route
 * nothing. Fakes that implement neither `ontrack` nor media APIs are
 * unaffected.
 *
 * OUTBOUND MEDIA TRACK (ticket 043): before createOffer the transport attaches
 * exactly one outbound audio source.
 *  - A mic MediaStream (Live): its tracks are added via addTrack, and
 *    `deps.createOutboundAudioSink` is NEVER invoked — a synthesized track
 *    would compete with the mic and sendAudio would double it onto the wire.
 *  - No mic + `deps.createOutboundAudioSink` (Replay): the factory is called
 *    per connect, the previous sink is CLOSED (or every reconnect leaks an
 *    AudioContext), and `sink.track` is added via addTrack — or, on a peer
 *    connection that can only negotiate directions, `addTransceiver('audio',
 *    { direction: 'sendrecv' })`.
 *  - No mic and no factory: the ticket-040 `recvonly` transceiver fallback,
 *    unchanged — nothing can be sent, and this is still how the model's
 *    inbound track is asked for.
 * Fakes implementing neither optional method behave exactly as before.
 *
 * sendAudio(pcm): with a mic, a NO-OP — realtime mic audio rides the WebRTC
 * media track (wired from getUserMedia outside this class) and the router fans
 * chunks here only so both transport kinds share one call site. With an
 * outbound sink (Replay) the frame is written to the sink AS IT ARRIVES: one
 * write per paced frame, never buffered or flushed ahead, so delivery stays 1×.
 * Frames before start() and after stop() reach no sink; stop() releases the
 * sink exactly once.
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
 * - output_audio_buffer.started ->
 *     onTiming { event: 'audio_queued', t: now(), utt } — ONCE per utterance,
 *     re-armed at response.done. TICKET 040: over WebRTC the model's audio
 *     arrives on the MEDIA TRACK, so `audio_queued` cannot come from a PCM
 *     enqueue; this event is the instant the model's audio begins on the
 *     track, which is the same quantity cascade calls "first audio queued".
 * - output_audio_buffer.stopped -> inert.
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

/** Minimal MediaStream surface the transport touches (production only). */
export interface RtcMediaStreamLike {
  getAudioTracks(): unknown[];
}

/**
 * TICKET 040 — the minimal `RTCTrackEvent` surface the transport reads when
 * the model's audio track arrives. Over WebRTC, OpenAI sends the response
 * audio on the MEDIA TRACK only (there is no `response.output_audio.delta`),
 * so this event is the whole audio path.
 */
export interface RtcTrackEventLike {
  track: { kind: string };
  streams: readonly RtcMediaStreamLike[];
}

/**
 * TICKET 040 — where the inbound remote audio goes. Production wires this to
 * an `<audio>` element (`srcObject`); tests inject a recorder. `play()` /
 * `pause()` exist so Live's play/pause control drives the REAL audio path
 * rather than an ArmPlayback queue that never receives a PCM sample.
 */
export interface RemoteAudioSink {
  /** Route the model's inbound media stream to the output device. */
  attach(stream: RtcMediaStreamLike): void;
  play(): void;
  pause(): void;
}

/**
 * TICKET 043 — where OUTBOUND paced PCM goes when there is no microphone.
 *
 * The exact mirror of `RemoteAudioSink`: an INJECTABLE seam, because jsdom has
 * neither `AudioContext` nor `MediaStreamAudioDestinationNode`. Production
 * builds one with `createOutboundAudioSink` (audio/outboundAudio.ts) from a
 * 24 kHz context feeding a `MediaStreamAudioDestinationNode`; tests inject a
 * recorder.
 *
 * `track` is what the transport adds to the peer connection BEFORE createOffer,
 * so the offer negotiates a SENDABLE m-line instead of the `recvonly`
 * transceiver Replay used to fall back to. `write` receives one paced frame at
 * the instant the pacer hands it over — the sink never buffers ahead of 1×.
 */
export interface OutboundAudioSink {
  /** The outbound MediaStreamTrack, added to the peer connection. */
  readonly track: unknown;
  /** Write ONE frame of 24 kHz mono PCM16, as it is handed over. */
  write(pcm: Int16Array): void;
  /** Release the sink (close the context). Idempotent. */
  close(): void;
}

export interface RtcPeerConnectionLike {
  createDataChannel(label: string): RtcDataChannelLike;
  createOffer(): Promise<RtcSessionDescriptionLike>;
  setLocalDescription(desc: RtcSessionDescriptionLike): Promise<void>;
  setRemoteDescription(desc: RtcSessionDescriptionLike): Promise<void>;
  close(): void;
  /**
   * OPTIONAL production-path additions (real RTCPeerConnection has them;
   * test fakes may omit them and behave exactly as before). Exercised by
   * browser QA, not unit tests.
   */
  addTrack?(track: unknown, stream?: unknown): unknown;
  addTransceiver?(kind: string, init?: { direction: string }): unknown;
  /**
   * TICKET 040 — inbound remote track callback. OPTIONAL: fakes that do not
   * declare it keep working (assigning the handler is harmless and nothing
   * ever calls it).
   */
  ontrack?: ((ev: RtcTrackEventLike) => void) | null;
}

export interface RealtimeDeps {
  fetchImpl: typeof fetch;
  rtcFactory: () => RtcPeerConnectionLike;
  /** Epoch-ms clock for timing marks. */
  now: () => number;
  /**
   * OPTIONAL (production): the live getUserMedia MediaStream, so the mic
   * track rides the WebRTC media path. Called on every (re)connect BEFORE
   * createOffer; null/undefined → no track is attached (test fakes and
   * pre-grant connects behave exactly as before). Exercised by browser QA,
   * not unit tests.
   */
  getMediaStream?: () => RtcMediaStreamLike | null;
  /**
   * TICKET 040 (OPTIONAL) — where an inbound audio track is routed. Omitted
   * by fakes that do not care; when omitted the transport still behaves
   * exactly as before.
   */
  remoteAudioSink?: RemoteAudioSink;
  /**
   * TICKET 043 (OPTIONAL) — builds the OUTBOUND sink for a microphone-less
   * session. A FACTORY rather than an instance, for two reasons: the sink owns
   * an AudioContext, so nothing may be constructed until a connect actually
   * happens (a bag built in jsdom must stay harmless), and each (re)connect
   * needs a track for ITS peer connection.
   *
   * Invoked on every connect that has NO mic MediaStream. When a mic stream IS
   * in use it is never invoked at all — Live's mic track is the outbound audio
   * and a second synthesized track would compete with it.
   */
  createOutboundAudioSink?: () => OutboundAudioSink;
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
  /**
   * TICKET 043 — the outbound sink for the current connection, or null when
   * there is a mic (Live), no factory, or no connection yet. Rebuilt per
   * connect; the previous one is closed as the new one is installed.
   */
  private outboundSink: OutboundAudioSink | null = null;

  /** Client-assigned utterance counter (0-based). */
  private utt = 0;
  /** Accumulated input transcription deltas for the current utterance. */
  private sourceAccum = '';
  /** Whether first_audio_delta has fired for the current utterance. */
  private firstAudioMarked = false;
  /**
   * TICKET 040 — whether audio_queued has been stamped for the current
   * utterance. Re-armed at response.done, exactly like firstAudioMarked.
   */
  private audioQueuedMarked = false;

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

      // TICKET 040 — the inbound audio path. Installed BEFORE
      // setRemoteDescription (in fact before the offer is even built) because
      // the remote track can fire the instant the answer is applied, and a
      // handler installed after it would miss the only audio there is. The
      // guard tolerates `this.pc === null`: on the first connect the field is
      // not assigned until the answer has landed, so `this.pc !== pc` alone
      // would drop exactly the early track this ordering exists to catch.
      pc.ontrack = (ev) => {
        if (this.stopped) return;
        if (this.pc !== null && this.pc !== pc) return;
        if (ev.track.kind !== 'audio') return;
        const stream = ev.streams[0];
        if (stream === undefined) return;
        this.deps.remoteAudioSink?.attach(stream);
      };

      // Production path (browser QA, not unit tests): attach the live mic
      // track BEFORE createOffer so the offer carries a sendrecv audio
      // m-line (mic up, model audio down). Test fakes implement neither
      // optional method and behave as before.
      //
      // TICKET 043 — the microphone-less case (Replay). With an outbound sink
      // factory the sink's synthesized track takes the mic's place, so the
      // offer still describes SENDABLE audio; `recvonly` cannot send at all,
      // which is why every paced frame used to have nowhere to go. With NO
      // factory nothing can be sent, and the ticket-040 `recvonly` fallback is
      // unchanged — that is still how the model's inbound track is asked for.
      const media = this.deps.getMediaStream?.() ?? null;
      if (media !== null && typeof pc.addTrack === 'function') {
        for (const track of media.getAudioTracks()) pc.addTrack(track, media);
      } else {
        // The factory is invoked ONLY without a mic: under a mic the mic track
        // IS the outbound audio, and a second synthesized track would compete
        // with it (and `sendAudio`, which Live's controller fans mic frames
        // into, would double the microphone onto the wire).
        const sink = media === null ? (this.deps.createOutboundAudioSink?.() ?? null) : null;
        if (sink !== null) {
          // Build AND release: each connect needs a track for ITS peer
          // connection, so without this close every reconnect would leak the
          // abandoned AudioContext.
          this.outboundSink?.close();
          this.outboundSink = sink;
          if (typeof pc.addTrack === 'function') {
            pc.addTrack(sink.track);
          } else if (typeof pc.addTransceiver === 'function') {
            pc.addTransceiver('audio', { direction: 'sendrecv' });
          }
        } else if (typeof pc.addTransceiver === 'function') {
          pc.addTransceiver('audio', { direction: 'recvonly' });
        }
      }

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
        // A sink built for a connection that is being abandoned owns an
        // AudioContext; releasing it here is what keeps a stop() mid-handshake
        // from leaking one. Nulling first makes the release single-shot.
        const abandoned = this.outboundSink;
        this.outboundSink = null;
        abandoned?.close();
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
      // TICKET 040 — the WebRTC audio_queued stamp. Over WebRTC the model's
      // audio rides the media track, so there is no PCM enqueue to time from;
      // this event is the instant that audio begins on the track, which is the
      // same quantity cascade calls "first audio queued".
      case 'output_audio_buffer.started': {
        if (this.audioQueuedMarked) break;
        this.audioQueuedMarked = true;
        h.onTiming?.({ event: 'audio_queued', t: this.deps.now(), utt: this.utt });
        break;
      }
      case 'output_audio_buffer.stopped': {
        // Inert: the end of the buffer measures nothing this project reports.
        break;
      }
      case 'response.done': {
        const response = msg.response as { usage?: unknown } | undefined;
        h.onUtteranceComplete?.({ utt: this.utt, usage: response?.usage });
        this.utt++;
        this.sourceAccum = '';
        this.firstAudioMarked = false;
        this.audioQueuedMarked = false;
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
    // TICKET 043 — release the outbound context. Nulled first so the guard at
    // the top of stop() is not the only thing making this single-shot.
    const sink = this.outboundSink;
    this.outboundSink = null;
    sink?.close();
  }

  /**
   * TICKET 043 — paced PCM out.
   *
   * With a MICROPHONE this is still a no-op: Live's mic rides the WebRTC media
   * track, and the router fans chunks here only so both transport kinds share
   * one call site. In REPLAY there is no mic — the runner paces the recording
   * and hands over one 480-sample frame every 20 ms — so the frame goes to the
   * outbound sink AS IT ARRIVES. Nothing is buffered here: the pacer owns the
   * schedule, and a batched flush would invalidate VAD and every latency figure
   * while looking like it worked.
   *
   * Gated on `stopped`, not merely on sink presence: the pacer can deliver a
   * frame after stop(), and it must reach a released sink no more than it
   * reaches the wire.
   */
  sendAudio(pcm: Int16Array): void {
    if (this.stopped) return;
    this.outboundSink?.write(pcm);
  }

  setHandlers(handlers: TransportHandlers): void {
    this.handlers = handlers;
  }
}
