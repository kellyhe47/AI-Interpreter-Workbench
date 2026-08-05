/**
 * WebSocket transport for the cascade pipeline (Ticket 005).
 *
 * ============================ API DESIGN (normative) =======================
 * attachCascadeWs(server, opts?) mounts a `ws` WebSocketServer on an existing
 * node http.Server at path /ws/cascade and returns it. Wire protocol is
 * src/core/protocol.ts:
 *
 *  - TEXT frames: JSON ClientToServerMessage / ServerToClientMessage.
 *  - Client binary frames: raw PCM16 audio -> decoded with bufferToPcm
 *    (byte-exact, Buffer byteOffset handled) and pushed into the session's
 *    audio source queue for the orchestrator.
 *  - Server binary frames: TTS audio, framed with protocol.encodeTtsFrame
 *    (4-byte LE utt header + PCM16).
 *
 * SESSION LIFECYCLE per socket:
 *  - {type:'session.start'} builds providers from msg.providers via the
 *    registry (createStt/createMt/createTts). An UNKNOWN provider name sends
 *    {type:'error', message} (message contains the unknown name) and the
 *    socket STAYS OPEN — a later valid session.start on the same socket
 *    starts a session normally.
 *  - Binary frames received before session.start are ignored.
 *  - On a valid session.start, the handler calls opts.createOrchestrator
 *    (default: runCascade from ./cascade/orchestrator) with the socket's
 *    audio-chunk source, the built providers, and {signal} — then forwards
 *    each CascadeEvent to the client:
 *      stt.partial/stt.final/mt.delta/mt.final -> same-name JSON with utt
 *      tts.audio -> BINARY encodeTtsFrame(utt, pcm)
 *      utterance.complete -> JSON with record
 *      error -> JSON {type:'error', stage, message}
 *  - {type:'session.end'} ends the audio source (orchestrator drains and
 *    finishes; socket stays open).
 *  - Socket close ABORTS the session's AbortSignal immediately (<=100ms).
 * ==========================================================================
 */

import type { Server as HttpServer } from 'node:http';
import { WebSocketServer } from 'ws';
import type { CascadeEvent, CascadeProviders, RunCascadeOptions } from './cascade/orchestrator';

/** Path the cascade WebSocket endpoint is mounted on. */
export const CASCADE_WS_PATH = '/ws/cascade';

/** Injectable orchestrator factory (tests inject fakes to observe aborts). */
export type OrchestratorFactory = (
  source: AsyncIterable<Int16Array>,
  providers: CascadeProviders,
  opts?: RunCascadeOptions,
) => AsyncGenerator<CascadeEvent, void, void>;

export interface AttachCascadeWsOptions {
  /** Defaults to runCascade. */
  createOrchestrator?: OrchestratorFactory;
}

/**
 * Decode an incoming ws binary payload into an Int16Array, byte-exact.
 * MUST honor Buffer byteOffset/byteLength (node Buffers are commonly views
 * into a larger pool allocation — naive `new Int16Array(buf.buffer)` is
 * wrong). Accepts the `ws` RawData shapes: Buffer, ArrayBuffer, or Buffer[]
 * (fragments are concatenated in order). Throws on odd byte length.
 */
export function bufferToPcm(data: Buffer | ArrayBuffer | Buffer[]): Int16Array {
  void data;
  throw new Error('not implemented');
}

/**
 * Mount the cascade WebSocket endpoint on `server` at CASCADE_WS_PATH.
 * Returns the WebSocketServer (caller closes it with the http server).
 */
export function attachCascadeWs(
  server: HttpServer,
  opts?: AttachCascadeWsOptions,
): WebSocketServer {
  void server;
  void opts;
  throw new Error('not implemented');
}
