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
 *   speech_started/speech_stopped/committed/session.updated and any unknown
 *     event types are ignored
 *   {type:'error', error} -> throws ProviderError
 * - Abort semantics (project-wide contract): already-aborted signal yields
 *   nothing and opens NO connection; abort mid-stream closes the socket and
 *   the generator RETURNS cleanly (no throw).
 * - tStart/tEnd: milliseconds since transcription start (wall-clock based);
 *   the contract only requires numbers.
 */

import type { ProviderCallOpts, SttEvent, SttProvider } from '../../core/types';
import { envVar, type WsFactory } from './transport';

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

  constructor(config: OpenAiSttConfig = {}, deps: OpenAiSttDeps = {}) {
    this.config = config;
    this.apiKey = config.apiKey ?? envVar('OPENAI_API_KEY');
    void deps;
  }

  transcribe(
    _audio: AsyncIterable<Int16Array>,
    _opts?: ProviderCallOpts,
  ): AsyncGenerator<SttEvent, void, void> {
    throw new Error('not implemented');
  }
}
