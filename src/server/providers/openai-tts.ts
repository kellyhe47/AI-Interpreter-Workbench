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
 *   response_format: 'pcm', and `instructions` ONLY when config.instructions
 *   is a non-empty string (ticket 074)} -> chunked body of raw PCM16 LE @ 24kHz.
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

import { ProviderError, RateLimitError } from '../../core/types';
import type { ProviderCallOpts, TtsProvider } from '../../core/types';
import { ABORTED, Pcm16Assembler, defaultFetch, watchAbort } from './internal';
import { envVar, type FetchLike } from './transport';

const SPEECH_URL = 'https://api.openai.com/v1/audio/speech';

export interface OpenAiTtsConfig {
  apiKey?: string;
  /** Speech model. Default 'gpt-4o-mini-tts'. */
  model?: string;
  /** Voice id. Default 'alloy'. */
  voice?: string;
  /**
   * TICKET 074 — natural-language delivery steering, sent as the API's
   * `instructions` field. This is the ONE lever that reaches Cantonese:
   * Mandarin and Cantonese share written characters, so the model decides
   * pronunciation, and `gpt-4o-mini-tts` documents this field as steering
   * accent, intonation and tone. Unset (or empty) means NO field on the wire —
   * a guessed default delivery is a claim no run has earned.
   */
  instructions?: string;
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

  private readonly deps: OpenAiTtsDeps;

  constructor(config: OpenAiTtsConfig = {}, deps: OpenAiTtsDeps = {}) {
    this.config = config;
    this.apiKey = config.apiKey ?? envVar('OPENAI_API_KEY');
    this.deps = deps;
  }

  async *synthesize(
    text: AsyncIterable<string>,
    opts?: ProviderCallOpts,
  ): AsyncGenerator<Int16Array, void, void> {
    const signal = opts?.signal;
    if (signal?.aborted) return;
    const fetchImpl = this.deps.fetchImpl ?? defaultFetch;

    // Non-streaming input: concatenate everything up front (PRD: less capable
    // providers concatenate internally).
    let input = '';
    for await (const chunk of text) {
      if (signal?.aborted) return;
      input += chunk;
    }
    if (input === '') return; // no fetch, no audio
    if (signal?.aborted) return;

    const instructions = this.config.instructions ?? '';
    const res = await fetchImpl(SPEECH_URL, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${this.apiKey ?? ''}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        model: this.config.model ?? 'gpt-4o-mini-tts',
        voice: this.config.voice ?? 'alloy',
        input,
        response_format: 'pcm',
        // Absence stays absence: no instruction, no key (ticket 074).
        ...(instructions === '' ? {} : { instructions }),
      }),
      signal,
    });
    if (res.status === 429) throw new RateLimitError('openai tts rate limited (429)');
    if (!res.ok) throw new ProviderError(`openai tts HTTP ${res.status}`);
    const body = res.body;
    if (!body) return;

    const reader = body.getReader();
    const abortWatch = watchAbort(signal);
    const assembler = new Pcm16Assembler();
    try {
      while (true) {
        if (signal?.aborted) return;
        const step = await Promise.race([reader.read(), abortWatch.promise]);
        if (step === ABORTED) return;
        const { done, value } = step;
        if (value !== undefined && value.length > 0) {
          const samples = assembler.push(value);
          if (samples !== null && samples.length > 0) yield samples;
        }
        if (done) break;
      }
    } finally {
      abortWatch.dispose();
      reader.cancel().catch(() => {});
    }
  }
}
