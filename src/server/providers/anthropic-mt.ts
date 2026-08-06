/**
 * Anthropic messages translation adapter (MT), Claude Haiku 4.5. STUB — tests
 * first (TDD).
 *
 * Design decisions pinned by anthropic-mt.test.ts:
 * - streaming = true (yields the translation as multiple token chunks).
 * - Transport: POST https://api.anthropic.com/v1/messages via the injected
 *   `deps.fetchImpl` (defaults to global fetch), headers `x-api-key: <key>` +
 *   `anthropic-version: 2023-06-01` + `content-type: application/json`. NOT an
 *   OpenAI-style `Authorization: Bearer`.
 * - API key resolved AT CONSTRUCTION: `config.apiKey ?? process.env.ANTHROPIC_API_KEY`.
 * - Request body: {model: 'claude-haiku-4-5' (config.model overrides),
 *   stream: true, temperature: 0 (PRD §8 controlled variable — a non-zero
 *   temperature makes translations irreproducible run to run), max_tokens,
 *   system: translation instruction mentioning config.targetLang and
 *   SEMANTICALLY EQUIVALENT to openai-mt's (so an MT swap measures the model,
 *   not the prompt), messages: [{role:'user', content: <source text>}]}.
 * - Response parsing (SSE): Anthropic sends named events — an `event: <name>`
 *   line followed by a `data: {...}` line whose JSON repeats the name in its
 *   `type` field — and there is NO `[DONE]` sentinel; the stream ends with
 *   `message_stop` and the body closing. Yield `delta.text` for every
 *   `content_block_delta` whose `delta.type === 'text_delta'`. Silently skip
 *   `message_start`, `content_block_start`, `content_block_stop`,
 *   `message_delta`, `message_stop`, `ping`, unknown event types, and
 *   malformed JSON frames. SSE events may be split across HTTP body chunks —
 *   the adapter buffers partial lines.
 * - HTTP 429 -> throws RateLimitError (so withRetry can retry the call).
 *   Other non-ok statuses -> ProviderError.
 * - Abort: the caller's signal is propagated to fetch (the transport observes
 *   the abort); already-aborted yields nothing and performs no fetch; abort
 *   mid-stream makes the generator RETURN cleanly.
 */

import type { MtProvider, ProviderCallOpts } from '../../core/types';
import { envVar, type FetchLike } from './transport';

export interface AnthropicMtConfig {
  apiKey?: string;
  /** Messages model. Default 'claude-haiku-4-5'. */
  model?: string;
  /** Target language for the system translation instruction. Default 'Spanish'. */
  targetLang?: string;
  /** Optional source language hint for the instruction. */
  sourceLang?: string;
  /** Output cap for the messages request. */
  maxTokens?: number;
}

export interface AnthropicMtDeps {
  fetchImpl?: FetchLike;
}

export class AnthropicMt implements MtProvider {
  readonly name = 'anthropic';
  readonly streaming = true;
  readonly config: AnthropicMtConfig;
  /** Resolved at construction (config first, then ANTHROPIC_API_KEY). */
  readonly apiKey: string | undefined;

  private readonly deps: AnthropicMtDeps;

  constructor(config: AnthropicMtConfig = {}, deps: AnthropicMtDeps = {}) {
    this.config = config;
    this.apiKey = config.apiKey ?? envVar('ANTHROPIC_API_KEY');
    this.deps = deps;
  }

  // eslint-disable-next-line @typescript-eslint/require-await
  async *translate(
    _text: string,
    _opts?: ProviderCallOpts,
  ): AsyncGenerator<string, void, void> {
    void this.deps;
    throw new Error('AnthropicMt.translate not implemented');
  }
}
