/**
 * Cascade WebSocket wire protocol.
 * Isomorphic TypeScript — no node/DOM imports.
 *
 * FRAMING (PRD §4 — "Binary frames, PCM16 mono", 24 kHz both directions):
 *
 * - TEXT frames carry JSON control/event messages (the unions below).
 * - BINARY frames carry PCM16 mono audio at SAMPLE_RATE, little-endian
 *   samples, in BOTH directions:
 *
 *   client -> server binary frame:
 *     raw PCM16 audio bytes, no header. Each frame is one audio chunk;
 *     byte length MUST be even (whole Int16 samples).
 *
 *   server -> client binary frame (TTS audio):
 *     [4-byte little-endian uint32 utterance sequence number][PCM16 bytes]
 *     The header makes every downstream audio frame attributable to an
 *     utterance. Utterance sequence numbers (`utt`) start at 0 for the first
 *     utterance of a session and increment by 1 per utterance; the same `utt`
 *     appears on the JSON events for that utterance. Use encodeTtsFrame /
 *     decodeTtsFrame below — they are the normative implementation of this
 *     framing (chosen over base64 JSON tts.chunk: binary both ways per PRD,
 *     and the helpers make it just as easy to test).
 *
 * RUN IDENTITY IS OPTIONAL AND CARRIED ON session.start (PRD §7).
 *
 * A session either is a benchmark run or it is not, and that is decided by the
 * caller opening the socket — not by a later message. Live capture sends none
 * of `recordingId` / `runId` / `origin`; a replay or a sweep leg stamps them on
 * the same `session.start` it was already sending. Each field is independently
 * optional so a partially-identified session (a recording replayed ad hoc, with
 * no run row yet) is expressible without a second message shape.
 *
 * `origin` is the CLOSED run vocabulary 'sweep' | 'manual' — the same values
 * the stored Run record uses. A free string would let the wire invent origins
 * the ledger cannot aggregate.
 *
 * CASCADE IS CONTEXT-FREE (PRD §7): there is deliberately NO context-policy
 * field on session.start. Each utterance is translated on its own, and a knob
 * on the wire would advertise a control that exists nowhere in the pipeline or
 * the UI.
 */

import type { Mode, UtteranceRecord } from './timing';

/** PCM sample rate used across the wire (16-bit mono), both directions. */
export const SAMPLE_RATE = 24000;

/** Byte length of the downstream (server->client) binary frame header. */
export const TTS_FRAME_HEADER_BYTES = 4;

/** Pipeline stage names used in stage-attributed events. */
export type CascadeStage = 'stt' | 'mt' | 'tts';

/**
 * Where a session/run came from. Closed vocabulary, shared verbatim with the
 * stored Run record's `origin` (PRD §7).
 */
export type RunOrigin = 'sweep' | 'manual';

/**
 * Client -> server JSON (text frame) messages. Audio itself travels as raw
 * binary frames (see FRAMING above), NOT as JSON.
 */
export type ClientToServerMessage =
  | {
      type: 'session.start';
      mode: Mode;
      languagePair: string;
      direction: string;
      providers: { stt: string; mt: string; tts: string };
      /** Recording being replayed, when this session is not live capture. */
      recordingId?: string;
      /** Run row this session's output belongs to, when one exists. */
      runId?: string;
      /** How the run was initiated. Omitted by Live. */
      origin?: RunOrigin;
    }
  | { type: 'session.end' };

/**
 * Server -> client JSON (text frame) messages. TTS audio travels as binary
 * frames with the 4-byte utt header (see FRAMING above), NOT as JSON.
 * `utt` is the utterance sequence number (0-based, per session).
 */
export type ServerToClientMessage =
  | { type: 'stt.partial'; utt: number; text: string }
  | { type: 'stt.final'; utt: number; text: string }
  | { type: 'mt.delta'; utt: number; text: string }
  | { type: 'mt.final'; utt: number; text: string }
  | { type: 'stage.timing'; utt: number; stage: CascadeStage; event: string; t: number }
  | { type: 'utterance.complete'; utt: number; record: UtteranceRecord }
  | { type: 'error'; stage?: CascadeStage; message: string };

/**
 * Encode a downstream TTS binary frame: 4-byte LE uint32 `utt` header
 * followed by the PCM16 sample bytes (little-endian, as in the Int16Array).
 */
export function encodeTtsFrame(utt: number, pcm: Int16Array): Uint8Array {
  const out = new Uint8Array(TTS_FRAME_HEADER_BYTES + pcm.byteLength);
  new DataView(out.buffer).setUint32(0, utt, true);
  out.set(
    new Uint8Array(pcm.buffer, pcm.byteOffset, pcm.byteLength),
    TTS_FRAME_HEADER_BYTES,
  );
  return out;
}

/**
 * Decode a downstream TTS binary frame produced by encodeTtsFrame.
 * Accepts any Uint8Array view (byteOffset-safe); the returned pcm is a copy
 * (alignment-safe regardless of the input view's offset).
 */
export function decodeTtsFrame(frame: Uint8Array): { utt: number; pcm: Int16Array } {
  if (frame.byteLength < TTS_FRAME_HEADER_BYTES) {
    throw new Error(
      `tts frame too short: ${frame.byteLength} bytes (need >= ${TTS_FRAME_HEADER_BYTES})`,
    );
  }
  const body = frame.byteLength - TTS_FRAME_HEADER_BYTES;
  if (body % 2 !== 0) {
    throw new Error(`tts frame body must be whole Int16 samples, got ${body} bytes`);
  }
  const view = new DataView(frame.buffer, frame.byteOffset, frame.byteLength);
  const utt = view.getUint32(0, true);
  const pcm = new Int16Array(body / 2);
  new Uint8Array(pcm.buffer).set(
    frame.subarray(TTS_FRAME_HEADER_BYTES, frame.byteLength),
  );
  return { utt, pcm };
}
