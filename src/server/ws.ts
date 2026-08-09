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
 *  - {type:'session.start'} builds providers from msg.providers — MODEL ids —
 *    by resolving them to (vendor, options) with core/models.resolveTriple and
 *    passing both into the vendor-keyed registry (createStt/createMt/
 *    createTts). An UNKNOWN model or provider sends
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
import type { WebSocket } from 'ws';
import { WebSocketServer } from 'ws';
import { encodeTtsFrame } from '../core/protocol';
import type { ClientToServerMessage, RunOrigin } from '../core/protocol';
import type { UtteranceRecord } from '../core/timing';
import { createMt, createStt, createTts } from '../core/registry';
import { resolveTriple } from '../core/models';
import { pushChannel, runCascade } from './cascade/orchestrator';
import type {
  CascadeEvent,
  CascadeProviders,
  PushChannel,
  RunCascadeOptions,
} from './cascade/orchestrator';

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
  let buf: Buffer;
  if (Array.isArray(data)) buf = Buffer.concat(data);
  else if (data instanceof ArrayBuffer) buf = Buffer.from(data);
  else buf = data;

  if (buf.byteLength % 2 !== 0) {
    throw new Error(`PCM16 payload must be whole Int16 samples, got ${buf.byteLength} bytes`);
  }
  const pcm = new Int16Array(buf.byteLength / 2);
  // Byte-exact copy honoring the Buffer's byteOffset into its pool.
  new Uint8Array(pcm.buffer).set(new Uint8Array(buf.buffer, buf.byteOffset, buf.byteLength));
  return pcm;
}

interface SocketSession {
  audio: PushChannel<Int16Array>;
  ac: AbortController;
}

/**
 * The record as it goes out on the wire, widened with the run `origin`.
 *
 * `origin` describes the RUN, not the utterance, so it is stamped here from
 * session.start rather than added to UtteranceRecord in core/timing — the
 * cascade pipeline has no notion of why a session was opened, and threading one
 * through it would put a benchmark concern inside the translation path.
 */
type EmittedRecord = UtteranceRecord & { origin?: RunOrigin };

function sendJson(ws: WebSocket, msg: unknown): void {
  if (ws.readyState === ws.OPEN) ws.send(JSON.stringify(msg));
}

/**
 * Mount the cascade WebSocket endpoint on `server` at CASCADE_WS_PATH.
 * Returns the WebSocketServer (caller closes it with the http server).
 */
export function attachCascadeWs(
  server: HttpServer,
  opts?: AttachCascadeWsOptions,
): WebSocketServer {
  const createOrchestrator = opts?.createOrchestrator ?? runCascade;
  const wss = new WebSocketServer({ server, path: CASCADE_WS_PATH });

  wss.on('connection', (ws: WebSocket) => {
    let session: SocketSession | null = null;

    const endSession = (): void => {
      if (!session) return;
      session.audio.close();
      session.ac.abort();
      session = null;
    };

    ws.on('message', (data: Buffer | ArrayBuffer | Buffer[], isBinary: boolean) => {
      if (isBinary) {
        // Binary frames before session.start are ignored.
        if (!session) return;
        try {
          session.audio.push(bufferToPcm(data));
        } catch (err) {
          sendJson(ws, { type: 'error', message: (err as Error).message });
        }
        return;
      }

      let msg: ClientToServerMessage;
      try {
        msg = JSON.parse(
          Array.isArray(data)
            ? Buffer.concat(data).toString('utf8')
            : Buffer.from(data as ArrayBuffer).toString('utf8'),
        ) as ClientToServerMessage;
      } catch {
        sendJson(ws, { type: 'error', message: 'invalid JSON message' });
        return;
      }

      if (msg.type === 'session.start') {
        let providers: CascadeProviders;
        try {
          // msg.providers carries MODEL ids (arms.ts MENUS); the registry is
          // keyed by VENDOR. resolveTriple maps each stage to its vendor AND
          // the options that carry the model onto that adapter — dropping the
          // model here would make Arms B and C run one configuration under two
          // labels (ticket 039).
          const resolved = resolveTriple(msg.providers);
          providers = {
            stt: createStt(resolved.stt.vendor, resolved.stt.options),
            mt: createMt(resolved.mt.vendor, resolved.mt.options),
            tts: createTts(resolved.tts.vendor, resolved.tts.options),
          };
        } catch (err) {
          // Unknown model or provider: report and keep the socket open for a retry.
          sendJson(ws, { type: 'error', message: (err as Error).message });
          return;
        }

        endSession(); // replace any previous session on this socket
        const audio = pushChannel<Int16Array>();
        const ac = new AbortController();
        const current: SocketSession = { audio, ac };
        session = current;

        // Run identity (ticket 003) is OPTIONAL and rides on session.start:
        // Live sends none of it, a replay/sweep leg stamps all three. A
        // Recording IS the corpus clip (PRD §7), so `recordingId` is the
        // record's `corpusId` — one identity field, not two.
        const { recordingId, runId, origin } = msg;

        void (async () => {
          try {
            const events = createOrchestrator(audio.iterable, providers, {
              signal: ac.signal,
              // TICKET 052 — the MODEL ids, forwarded so the cost model can
              // pick the right rate card per stage. `provider.name` is a
              // VENDOR name and cannot price anything.
              models: msg.providers,
              session: {
                languagePair: msg.languagePair,
                direction: msg.direction,
                // TICKET 062 — THE MISSING LINK. The pair and direction were
                // copied onto the emitted record and used nowhere else, so the
                // MT stage was never told what to translate into and every
                // cascade run produced the adapter's construction default.
                targetLanguage: msg.targetLanguage,
                corpusId: recordingId,
                runId,
              },
            });
            for await (const ev of events) {
              if (ws.readyState !== ws.OPEN) break;
              if (ev.type === 'tts.audio') {
                ws.send(encodeTtsFrame(ev.utt, ev.pcm));
              } else if (ev.type === 'error') {
                sendJson(ws, { type: 'error', stage: ev.stage, message: ev.message });
              } else if (ev.type === 'utterance.complete' && origin !== undefined) {
                const record: EmittedRecord = { ...ev.record, origin };
                sendJson(ws, { ...ev, record });
              } else {
                sendJson(ws, ev);
              }
            }
          } catch (err) {
            sendJson(ws, { type: 'error', message: (err as Error).message });
          } finally {
            if (session === current) session = null;
          }
        })();
        return;
      }

      if (msg.type === 'session.end') {
        // End the audio source; orchestrator drains and finishes.
        session?.audio.close();
      }
    });

    ws.on('error', () => {
      /* surfaced via close */
    });
    ws.on('close', () => {
      endSession(); // abort the session promptly on socket close
    });
  });

  return wss;
}
