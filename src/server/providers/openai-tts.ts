/**
 * OpenAI speech synthesis adapter (TTS). STUB — tests first (TDD).
 *
 * Design decisions pinned by openai-tts.test.ts:
 * - streamingInput = FALSE: OpenAI's speech endpoint takes the full text up
 *   front, so the adapter CONCATENATES its AsyncIterable<string> input into
 *   one string first (PRD: less capable providers concatenate internally) and
 *   makes exactly ONE HTTP request.
 * - Empty concatenated input -> complete with no audio and NO fetch at all.
 * - Transport: POST https://api.openai.com/v1/audio/speech via injected
 *   `deps.fetchImpl` (defaults to global fetch), headers
 *   `Authorization: Bearer <key>` + `Content-Type: application/json`.
 * - API key resolved AT CONSTRUCTION: `config.apiKey ?? process.env.OPENAI_API_KEY`.
 * - Request body: {model:'gpt-4o-mini-tts' (config.model overrides),
 *   voice: config.voice ?? 'alloy', input: <concatenated text>,
 *   response_format: 'pcm'} -> chunked body of raw PCM16 LE @ 24kHz.
 * - Streams the response body, yielding Int16Array chunks as bytes arrive.
 *   Body chunk boundaries are NOT sample-aligned: when a chunk has an odd
 *   byte length the trailing byte is CARRIED into the next chunk so Int16
 *   alignment is never lost (regression-locked by an odd-offset-split test).
 * - HTTP 429 -> RateLimitError (withRetry-compatible); other non-ok ->
 *   ProviderError.
 * - Abort: signal propagated to fetch (transport observes it); already-aborted
 *   yields nothing (and performs no fetch); abort mid-stream -> generator
 *   RETURNS cleanly.
 */

import type { ProviderCallOpts, TtsProvider } from '../../core/types';
import { envVar, type FetchLike } from './transport';

export interface OpenAiTtsConfig {
  apiKey?: string;
  /** Speech model. Default 'gpt-4o-mini-tts'. */
  model?: string;
  /** Voice id. Default 'alloy'. */
  voice?: string;
}

export interface OpenAiTtsDeps {
  fetchImpl?: FetchLike;
}

export class OpenAiTts implements TtsProvider {
  readonly name = 'openai';
  readonly streamingInput = false;
  readonly config: OpenAiTtsConfig;
  /** Resolved at construction (config first, then OPENAI_API_KEY). */
  readonly apiKey: string | undefined;

  constructor(config: OpenAiTtsConfig = {}, deps: OpenAiTtsDeps = {}) {
    this.config = config;
    this.apiKey = config.apiKey ?? envVar('OPENAI_API_KEY');
    void deps;
  }

  synthesize(
    _text: AsyncIterable<string>,
    _opts?: ProviderCallOpts,
  ): AsyncGenerator<Int16Array, void, void> {
    throw new Error('not implemented');
  }
}
