/**
 * OpenAI Realtime transcription adapter (STT). STUB — tests first (TDD).
 *
 * Design decisions pinned by openai-stt.test.ts:
 * - Transport: WebSocket to
 *   wss://api.openai.com/v1/realtime?intent=transcription
 *   with header `Authorization: Bearer <key>`. The socket is created through
 *   the injected `deps.wsFactory` (tests pass fakes; the real default lazily
 *   imports 'ws').
 * - API key resolved AT CONSTRUCTION: `config.apiKey ?? process.env.OPENAI_API_KEY`.
 * - First frame sent after open is `session.update` with
 *   session.type 'transcription',
 *   audio.input.format {type:'audio/pcm', rate: 24000},   // ALWAYS 24000 —
 *     the API rejects 16000; regression-locked by a dedicated test
 *   audio.input.transcription.model 'gpt-4o-transcribe' (config.model overrides),
 *   audio.input.turn_detection {type:'server_vad', silence_duration_ms: 500}.
 * - Each audio Int16Array chunk is sent as
 *   {type:'input_audio_buffer.append', audio:<base64 of little-endian PCM16 bytes>}
 *   as it is pulled from the input iterable (one append per chunk).
 * - Server event mapping:
 *   conversation.item.input_audio_transcription.delta      -> 'partial' event,
 *     text = ACCUMULATED transcript so far for the current turn (deltas are
 *     concatenated; accumulation resets after each turn-final)
 *   conversation.item.input_audio_transcription.completed  -> 'final' (TURN-final;
 *     exactly one per turn, text = event.transcript), generator completes after
 *     the final for the last turn once the audio input is exhausted
 *   input_audio_buffer.speech_stopped                      -> 'speech_stopped'
 *     (ticket 051): the endpointer's decision, text '', emitted BEFORE the
 *     turn-final. The cascade orchestrator stamps `vad_fired` from it.
 *   speech_started/committed/session.updated and any unknown event types are
 *     ignored
 *   {type:'error', error} -> throws ProviderError
 * - Abort semantics (project-wide contract): already-aborted signal yields
 *   nothing and opens NO connection; abort mid-stream closes the socket and
 *   the generator RETURNS cleanly (no throw).
 * - tStart/tEnd: milliseconds since transcription start (wall-clock based);
 *   the contract only requires numbers.
 */

import { ProviderError } from '../../core/types';
import type { ProviderCallOpts, SttEvent, SttProvider } from '../../core/types';
import {
  AsyncQueue,
  bytesToBase64,
  int16ToLeBytes,
  loadDefaultWsFactory,
  waitForOpen,
} from './internal';
import { envVar, type WsFactory } from './transport';

const REALTIME_URL = 'wss://api.openai.com/v1/realtime?intent=transcription';

export interface OpenAiSttConfig {
  apiKey?: string;
  /** Transcription model. Default 'gpt-4o-transcribe'. */
  model?: string;
}

export interface OpenAiSttDeps {
  wsFactory?: WsFactory;
}

export class OpenAiStt implements SttProvider {
  readonly name = 'openai';
  readonly config: OpenAiSttConfig;
  /** Resolved at construction (config first, then OPENAI_API_KEY). */
  readonly apiKey: string | undefined;

  private readonly deps: OpenAiSttDeps;

  constructor(config: OpenAiSttConfig = {}, deps: OpenAiSttDeps = {}) {
    this.config = config;
    this.apiKey = config.apiKey ?? envVar('OPENAI_API_KEY');
    this.deps = deps;
  }

  async *transcribe(
    audio: AsyncIterable<Int16Array>,
    opts?: ProviderCallOpts,
  ): AsyncGenerator<SttEvent, void, void> {
    const signal = opts?.signal;
    if (signal?.aborted) return;

    const wsFactory = this.deps.wsFactory ?? (await loadDefaultWsFactory());
    if (signal?.aborted) return;
    const ws = wsFactory(REALTIME_URL, {
      headers: { Authorization: `Bearer ${this.apiKey ?? ''}` },
    });

    const queue = new AsyncQueue<SttEvent>();
    let wsClosed = false;
    const closeWs = (): void => {
      if (wsClosed) return;
      wsClosed = true;
      try {
        ws.close();
      } catch {
        // socket may already be gone
      }
    };
    const onAbort = (): void => {
      queue.abort();
      closeWs();
    };
    signal?.addEventListener('abort', onAbort, { once: true });

    const t0 = Date.now();
    let accumulated = '';
    let turnStart = 0;
    let sawFinal = false;
    let pumpDone = false;
    const maybeEnd = (): void => {
      if (pumpDone && sawFinal) queue.end();
    };

    ws.on('message', (data) => {
      let msg: { type?: string; delta?: string; transcript?: string; error?: unknown };
      try {
        msg = JSON.parse(String(data)) as typeof msg;
      } catch {
        return;
      }
      switch (msg.type) {
        case 'conversation.item.input_audio_transcription.delta': {
          if (accumulated === '') turnStart = Date.now() - t0;
          accumulated += msg.delta ?? '';
          queue.push({
            type: 'partial',
            text: accumulated,
            tStart: turnStart,
            tEnd: Date.now() - t0,
          });
          break;
        }
        case 'conversation.item.input_audio_transcription.completed': {
          queue.push({
            type: 'final',
            text: msg.transcript ?? accumulated,
            tStart: turnStart,
            tEnd: Date.now() - t0,
          });
          accumulated = '';
          sawFinal = true;
          maybeEnd();
          break;
        }
        // TICKET 051 — the endpointer's own announcement, surfaced rather than
        // dropped. It is the ONLY signal that says WHEN the server decided the
        // speaker had stopped; without it the cascade orchestrator has nothing
        // to stamp `vad_fired` from but the closing transcript's own instant,
        // which renders "detected end of speech -> transcript" as a fabricated
        // 0 ms on every utterance. It carries no text by construction — the
        // transcript is a separate event and arrives later.
        case 'input_audio_buffer.speech_stopped': {
          queue.push({
            type: 'speech_stopped',
            text: '',
            tStart: turnStart,
            tEnd: Date.now() - t0,
          });
          break;
        }
        case 'error': {
          queue.fail(
            new ProviderError(`openai stt error: ${JSON.stringify(msg.error ?? msg)}`),
          );
          break;
        }
        default:
          break; // speech_started/speech_stopped/committed/session.updated/unknown
      }
    });
    ws.on('error', (err) => {
      queue.fail(new ProviderError(`openai stt transport error: ${String(err)}`));
    });
    ws.on('close', () => queue.end());

    // Pump: session.update first, then one base64 append per audio chunk.
    void (async () => {
      await waitForOpen(ws);
      if (wsClosed || queue.isDone) return;
      ws.send(
        JSON.stringify({
          type: 'session.update',
          session: {
            type: 'transcription',
            audio: {
              input: {
                // ALWAYS 24000 — the API rejects 16000 (regression-locked).
                format: { type: 'audio/pcm', rate: 24000 },
                transcription: { model: this.config.model ?? 'gpt-4o-transcribe' },
                turn_detection: { type: 'server_vad', silence_duration_ms: 500 },
              },
            },
          },
        }),
      );
      for await (const chunk of audio) {
        if (wsClosed || queue.isDone) return;
        ws.send(
          JSON.stringify({
            type: 'input_audio_buffer.append',
            audio: bytesToBase64(int16ToLeBytes(chunk)),
          }),
        );
      }
      pumpDone = true;
      maybeEnd();
    })().catch((err: unknown) => {
      queue.fail(
        err instanceof ProviderError
          ? err
          : new ProviderError(`openai stt input error: ${String(err)}`),
      );
    });

    try {
      for await (const event of queue) yield event;
    } finally {
      signal?.removeEventListener('abort', onAbort);
      queue.abort();
      closeWs();
    }
  }
}
