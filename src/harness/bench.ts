/**
 * Ticket 015 — Fixture benchmark harness (skeleton).
 *
 * ============================ API DESIGN (normative) =======================
 * runFixtureBench({ server, clips, providers, corpusId, ... }) drives the
 * REAL WebSocket endpoint (src/server/ws.ts, path /ws/cascade) of an
 * already-listening http.Server (from createAppServer) with a real `ws`
 * client, once per clip, sequentially:
 *
 *  1. Connect ws://127.0.0.1:<server.address().port>/ws/cascade.
 *  2. Send {type:'session.start', mode:'cascade', languagePair, direction,
 *     providers} (protocol.ts ClientToServerMessage).
 *  3. Record clipStartMs = Date.now() on the HARNESS clock, then stream the
 *     clip's PCM16 samples as raw binary frames chunked to ~chunkMs (default
 *     20 ms => 480 samples/frame at 24 kHz).
 *  4. Collect server events: JSON text frames (stt/mt/utterance.complete)
 *     and binary TTS frames (decodeTtsFrame; count frames per utt).
 *  5. On the FIRST {type:'utterance.complete'} take its record, then send
 *     {type:'session.end'} and close the socket. (With fixture STT each
 *     audio chunk starts a turn; the harness only keeps utterance 0's
 *     record per clip.)
 *  6. AUGMENT the record (harness-side, server output untouched otherwise):
 *       speechEndSource: 'corpus'
 *       corpusId:        opts.corpusId
 *       timings.speech_end = clipStartMs + clip.speechEndMs  (ground truth
 *         on the harness clock — NOT VAD-derived)
 *       audioChunkCount: number of binary TTS frames decoded for that utt
 *         (harness-only extra field; proves audio was actually collected).
 *
 * Returns one BenchRecord per clip, in clip order. WRITES NOTHING — file
 * output belongs to scripts/bench-fixture.mjs.
 * ==========================================================================
 */

import type { Server } from 'node:http';
import type { UtteranceRecord } from '../core/timing';

export interface BenchClip {
  id: string;
  /** 24 kHz mono PCM16 samples (e.g. from wav.generateClip / wav.readWav). */
  samples: Int16Array;
  /** Ground-truth speech end offset within the clip, ms. */
  speechEndMs: number;
}

/** Server-built UtteranceRecord augmented with harness-side fields. */
export type BenchRecord = UtteranceRecord & {
  /** Binary TTS frames the harness client decoded for this utterance. */
  audioChunkCount: number;
};

export interface RunFixtureBenchOptions {
  /** Already-listening http server built by createAppServer(). */
  server: Server;
  clips: BenchClip[];
  providers: { stt: string; mt: string; tts: string };
  /** Stamped onto every record (e.g. 'placeholder-v0'). */
  corpusId: string;
  /** Defaults: languagePair 'en-es', direction 'a->b', chunkMs 20. */
  languagePair?: string;
  direction?: string;
  chunkMs?: number;
}

export async function runFixtureBench(
  opts: RunFixtureBenchOptions,
): Promise<BenchRecord[]> {
  void opts;
  throw new Error('not implemented');
}
