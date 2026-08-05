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
import { WebSocket } from 'ws';
import { SAMPLE_RATE, decodeTtsFrame } from '../core/protocol';
import type { ServerToClientMessage } from '../core/protocol';
import type { CascadeTimestamps, UtteranceRecord } from '../core/timing';

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

function serverPort(server: Server): number {
  const addr = server.address();
  if (addr === null || typeof addr === 'string') {
    throw new Error('server must be listening on a TCP port');
  }
  return addr.port;
}

/** Convert ws RawData into a single Uint8Array view. */
function toBytes(data: Buffer | ArrayBuffer | Buffer[]): Uint8Array {
  if (Array.isArray(data)) return Buffer.concat(data);
  if (data instanceof ArrayBuffer) return new Uint8Array(data);
  return data;
}

async function runClip(
  port: number,
  clip: BenchClip,
  opts: RunFixtureBenchOptions,
): Promise<BenchRecord> {
  const chunkMs = opts.chunkMs ?? 20;
  const samplesPerChunk = Math.max(1, Math.round((SAMPLE_RATE * chunkMs) / 1000));
  const ws = new WebSocket(`ws://127.0.0.1:${port}/ws/cascade`);

  try {
    const record = await new Promise<BenchRecord>((resolve, reject) => {
      let clipStartMs = 0;
      let done = false;
      const ttsFramesByUtt = new Map<number, number>();

      const finish = (fn: () => void): void => {
        if (done) return;
        done = true;
        fn();
      };

      ws.on('error', (err) => finish(() => reject(err)));
      ws.on('close', () =>
        finish(() => reject(new Error(`socket closed before utterance.complete (clip ${clip.id})`))),
      );

      ws.on('open', () => {
        ws.send(
          JSON.stringify({
            type: 'session.start',
            mode: 'cascade',
            languagePair: opts.languagePair ?? 'en-es',
            direction: opts.direction ?? 'a->b',
            providers: opts.providers,
          }),
        );

        // Harness-clock clip start; ground-truth speech end is relative to it.
        clipStartMs = Date.now();
        for (let i = 0; i < clip.samples.length; i += samplesPerChunk) {
          const chunk = clip.samples.subarray(i, i + samplesPerChunk);
          ws.send(Buffer.from(chunk.buffer, chunk.byteOffset, chunk.byteLength));
        }
      });

      ws.on('message', (data: Buffer | ArrayBuffer | Buffer[], isBinary: boolean) => {
        if (done) return;
        if (isBinary) {
          const { utt } = decodeTtsFrame(toBytes(data));
          ttsFramesByUtt.set(utt, (ttsFramesByUtt.get(utt) ?? 0) + 1);
          return;
        }

        let msg: ServerToClientMessage;
        try {
          const bytes = toBytes(data);
          msg = JSON.parse(
            Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength).toString('utf8'),
          ) as ServerToClientMessage;
        } catch (err) {
          finish(() => reject(err as Error));
          return;
        }

        if (msg.type === 'error') {
          finish(() => reject(new Error(`server error (clip ${clip.id}): ${msg.message}`)));
          return;
        }

        if (msg.type === 'utterance.complete') {
          // Keep only the FIRST utterance's record for this clip.
          const timings: CascadeTimestamps = {
            ...(msg.record.timings as CascadeTimestamps),
            speech_end: clipStartMs + clip.speechEndMs,
          };
          const augmented: BenchRecord = {
            ...msg.record,
            speechEndSource: 'corpus',
            corpusId: opts.corpusId,
            timings,
            audioChunkCount: ttsFramesByUtt.get(msg.utt) ?? 0,
          };
          ws.send(JSON.stringify({ type: 'session.end' }));
          finish(() => resolve(augmented));
        }
      });
    });
    return record;
  } finally {
    // Close the socket per clip and wait for it so no handles leak.
    if (ws.readyState !== WebSocket.CLOSED) {
      await new Promise<void>((resolve) => {
        ws.once('close', () => resolve());
        ws.close();
      });
    }
    ws.removeAllListeners();
  }
}

export async function runFixtureBench(
  opts: RunFixtureBenchOptions,
): Promise<BenchRecord[]> {
  const port = serverPort(opts.server);
  const records: BenchRecord[] = [];
  for (const clip of opts.clips) {
    records.push(await runClip(port, clip, opts));
  }
  return records;
}
