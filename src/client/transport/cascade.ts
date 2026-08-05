/**
 * Ticket 011 — Cascade (server WS pipeline) transport.
 *
 * ============================ API DESIGN (normative) =======================
 * Locked by cascade.test.ts:
 *
 * new CascadeTransport(opts, deps)
 *   opts: { armId, label?, costPerMinUsd?, baseUrl? }
 *   deps: { wsFactory: (url) => WsLike, now: () => number }
 *
 * URL: CASCADE_WS_PATH = '/ws/cascade'. The socket URL is
 * `${base}${CASCADE_WS_PATH}` where base is opts.baseUrl when provided
 * (tests inject it), otherwise derived from location:
 * `${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.host}`.
 *
 * start(config):
 *  - ws = wsFactory(url); sets ws.binaryType = 'arraybuffer'.
 *  - On open: sends the protocol session.start TEXT frame
 *      { type: 'session.start', mode: 'cascade',
 *        languagePair: config.languagePair, direction: config.direction,
 *        providers: config.providers }
 *    then emits onConnectionState('connected') and start() resolves.
 *
 * sendAudio(pcm): sends ONE binary frame of exactly the raw little-endian
 * PCM16 bytes (byte-exact: same length and content as the Int16Array's
 * buffer view — no header, per src/core/protocol.ts client->server framing).
 *
 * INBOUND MESSAGES (ws.onmessage):
 *  - string data -> JSON.parse -> ServerToClientMessage mapping:
 *      stt.partial        -> onSourceText { kind: 'partial', text, utt }
 *      stt.final          -> onSourceText { kind: 'final', text, utt }
 *      mt.delta           -> onTargetText { kind: 'delta', text, utt }
 *      mt.final           -> onTargetText { kind: 'final', text, utt }
 *      stage.timing       -> onTiming { event, t, utt, stage } (pass-through)
 *      utterance.complete -> onUtteranceComplete(record)
 *      error              -> onError { opaque: false, message (VERBATIM
 *                            pass-through — cascade errors are stage-
 *                            attributed by the server), stage }
 *  - binary data (ArrayBuffer) -> decodeTtsFrame (4-byte LE utt header) ->
 *      onAudio(pcm, utt)
 *
 * RECONNECT: an unexpected close (not caused by stop()) starts a reconnect
 * loop: onConnectionState('reconnecting', attempt) for attempt = 1..5, each
 * attempt re-opening via wsFactory and re-sending session.start on open,
 * then onConnectionState('connected'). After 5 failed attempts (each new
 * socket closing before opening) -> onConnectionState('disconnected').
 *
 * stop(): sends { type: 'session.end' } if the socket is open, closes it,
 * and guarantees NO further events (no reconnect on the resulting close, no
 * mapped messages).
 * ==========================================================================
 */

import { decodeTtsFrame } from '../../core/protocol';
import {
  MAX_TRANSPORT_RECONNECT_ATTEMPTS,
  type InterpreterTransport,
  type TransportConfig,
  type TransportHandlers,
  type TransportKind,
  type UtteranceCompletion,
} from './types';

export const CASCADE_WS_PATH = '/ws/cascade';

export interface WsLike {
  binaryType: string;
  send(data: string | ArrayBufferLike | Uint8Array): void;
  close(): void;
  onopen: (() => void) | null;
  onmessage: ((ev: { data: string | ArrayBuffer }) => void) | null;
  onclose: (() => void) | null;
  onerror: ((ev: unknown) => void) | null;
}

export interface CascadeDeps {
  wsFactory: (url: string) => WsLike;
  /** Epoch-ms clock. */
  now: () => number;
}

export interface CascadeTransportOptions {
  armId: string;
  label?: string;
  costPerMinUsd?: number;
  /** e.g. 'ws://localhost:3000'; defaults to location-derived ws(s) origin. */
  baseUrl?: string;
}

export class CascadeTransport implements InterpreterTransport {
  readonly kind: TransportKind = 'cascade';
  readonly armId: string;
  readonly label: string;
  readonly costPerMinUsd: number;

  private readonly baseUrl?: string;
  private readonly deps: CascadeDeps;
  private handlers: TransportHandlers = {};
  private config: TransportConfig | null = null;
  private ws: WsLike | null = null;
  private open = false;
  private stopped = false;
  private reconnectAttempt = 0;
  private resolveStart: (() => void) | null = null;

  constructor(opts: CascadeTransportOptions, deps: CascadeDeps) {
    this.armId = opts.armId;
    this.label = opts.label ?? 'Cascade';
    this.costPerMinUsd = opts.costPerMinUsd ?? 0;
    this.baseUrl = opts.baseUrl;
    this.deps = deps;
  }

  private url(): string {
    const base =
      this.baseUrl ??
      `${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.host}`;
    return `${base}${CASCADE_WS_PATH}`;
  }

  private sessionStart(): unknown {
    return {
      type: 'session.start',
      mode: 'cascade',
      languagePair: this.config?.languagePair,
      direction: this.config?.direction,
      providers: this.config?.providers,
    };
  }

  async start(config: TransportConfig): Promise<void> {
    this.config = config;
    await new Promise<void>((resolve) => {
      this.resolveStart = resolve;
      this.openSocket();
    });
  }

  private openSocket(): void {
    const ws = this.deps.wsFactory(this.url());
    this.ws = ws;
    this.open = false;
    ws.binaryType = 'arraybuffer';
    ws.onopen = () => {
      if (this.stopped || this.ws !== ws) return;
      this.open = true;
      this.reconnectAttempt = 0;
      ws.send(JSON.stringify(this.sessionStart()));
      this.handlers.onConnectionState?.('connected');
      const resolve = this.resolveStart;
      this.resolveStart = null;
      resolve?.();
    };
    ws.onmessage = (ev) => {
      if (this.stopped || this.ws !== ws) return;
      this.handleMessage(ev.data);
    };
    ws.onclose = () => {
      if (this.stopped || this.ws !== ws) return;
      this.open = false;
      this.handleClose();
    };
    ws.onerror = () => {
      // errors are followed by close; the close path drives reconnect
    };
  }

  private handleClose(): void {
    if (this.reconnectAttempt >= MAX_TRANSPORT_RECONNECT_ATTEMPTS) {
      this.ws = null;
      this.handlers.onConnectionState?.('disconnected');
      return;
    }
    this.reconnectAttempt++;
    this.handlers.onConnectionState?.('reconnecting', this.reconnectAttempt);
    this.openSocket();
  }

  private handleMessage(data: string | ArrayBuffer): void {
    const h = this.handlers;
    if (typeof data !== 'string') {
      const { utt, pcm } = decodeTtsFrame(new Uint8Array(data));
      h.onAudio?.(pcm, utt);
      return;
    }
    let msg: Record<string, unknown>;
    try {
      msg = JSON.parse(data) as Record<string, unknown>;
    } catch {
      return;
    }
    const utt = Number(msg.utt ?? 0);
    switch (msg.type) {
      case 'stt.partial':
        h.onSourceText?.({ kind: 'partial', text: String(msg.text ?? ''), utt });
        break;
      case 'stt.final':
        h.onSourceText?.({ kind: 'final', text: String(msg.text ?? ''), utt });
        break;
      case 'mt.delta':
        h.onTargetText?.({ kind: 'delta', text: String(msg.text ?? ''), utt });
        break;
      case 'mt.final':
        h.onTargetText?.({ kind: 'final', text: String(msg.text ?? ''), utt });
        break;
      case 'stage.timing':
        h.onTiming?.({
          event: String(msg.event ?? ''),
          t: Number(msg.t ?? this.deps.now()),
          utt,
          stage: msg.stage as string | undefined,
        });
        break;
      case 'utterance.complete':
        h.onUtteranceComplete?.(msg.record as UtteranceCompletion);
        break;
      case 'error':
        h.onError?.({
          message: String(msg.message ?? ''),
          opaque: false,
          stage: msg.stage as string | undefined,
        });
        break;
      default:
        break;
    }
  }

  stop(): void {
    if (this.stopped) return;
    this.stopped = true;
    if (this.ws) {
      if (this.open) this.ws.send(JSON.stringify({ type: 'session.end' }));
      this.ws.close();
      this.ws = null;
    }
  }

  sendAudio(pcm: Int16Array): void {
    if (this.stopped || !this.ws || !this.open) return;
    const bytes = new Uint8Array(pcm.byteLength);
    bytes.set(new Uint8Array(pcm.buffer, pcm.byteOffset, pcm.byteLength));
    this.ws.send(bytes);
  }

  setHandlers(handlers: TransportHandlers): void {
    this.handlers = handlers;
  }
}
