/**
 * OpenAI chat-completions translation adapter (MT). STUB — tests first (TDD).
 *
 * Design decisions pinned by openai-mt.test.ts:
 * - streaming = true (yields the translation as multiple token chunks).
 * - Transport: POST https://api.openai.com/v1/chat/completions via the
 *   injected `deps.fetchImpl` (defaults to global fetch), headers
 *   `Authorization: Bearer <key>` + `Content-Type: application/json`.
 * - API key resolved AT CONSTRUCTION: `config.apiKey ?? process.env.OPENAI_API_KEY`.
 * - Request body: {model: 'gpt-4o-mini' (config.model overrides), stream: true,
 *   messages: [{role:'system', content: translation instruction mentioning
 *   config.targetLang}, {role:'user', content: <source text>}]}.
 * - Response parsing (SSE): lines of the form `data: {...}`; yield
 *   choices[0].delta.content for each content-bearing delta; SKIP silently:
 *   role-only deltas, frames with empty `choices` (usage frames), and the
 *   terminal `data: [DONE]`. SSE events may be split across HTTP body chunks —
 *   the adapter buffers partial lines.
 * - HTTP 429 -> throws RateLimitError (so withRetry can retry the call).
 *   Other non-ok statuses -> ProviderError.
 * - Abort: the caller's signal is propagated to fetch (the transport observes
 *   the abort); already-aborted yields nothing; abort mid-stream makes the
 *   generator RETURN cleanly.
 */

import type { MtProvider, ProviderCallOpts } from '../../core/types';
import { envVar, type FetchLike } from './transport';

export interface OpenAiMtConfig {
  apiKey?: string;
  /** Chat model. Default 'gpt-4o-mini'. */
  model?: string;
  /** Target language for the system translation instruction. Default 'Spanish'. */
  targetLang?: string;
  /** Optional source language hint for the instruction. */
  sourceLang?: string;
}

export interface OpenAiMtDeps {
  fetchImpl?: FetchLike;
}

export class OpenAiMt implements MtProvider {
  readonly name = 'openai';
  readonly streaming = true;
  readonly config: OpenAiMtConfig;
  /** Resolved at construction (config first, then OPENAI_API_KEY). */
  readonly apiKey: string | undefined;

  constructor(config: OpenAiMtConfig = {}, deps: OpenAiMtDeps = {}) {
    this.config = config;
    this.apiKey = config.apiKey ?? envVar('OPENAI_API_KEY');
    void deps;
  }

  translate(
    _text: string,
    _opts?: ProviderCallOpts,
  ): AsyncGenerator<string, void, void> {
    throw new Error('not implemented');
  }
}
