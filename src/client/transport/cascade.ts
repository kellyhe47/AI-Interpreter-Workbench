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

import type {
  InterpreterTransport,
  TransportConfig,
  TransportHandlers,
  TransportKind,
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

  constructor(opts: CascadeTransportOptions, _deps: CascadeDeps) {
    this.armId = opts.armId;
    this.label = opts.label ?? 'Cascade';
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
