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

import { ProviderError, RateLimitError } from '../../core/types';
import type { MtProvider, ProviderCallOpts } from '../../core/types';
import { ABORTED, defaultFetch, watchAbort } from './internal';
import { envVar, type FetchLike } from './transport';

const CHAT_COMPLETIONS_URL = 'https://api.openai.com/v1/chat/completions';

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

  private readonly deps: OpenAiMtDeps;

  constructor(config: OpenAiMtConfig = {}, deps: OpenAiMtDeps = {}) {
    this.config = config;
    this.apiKey = config.apiKey ?? envVar('OPENAI_API_KEY');
    this.deps = deps;
  }

  async *translate(
    text: string,
    opts?: ProviderCallOpts,
  ): AsyncGenerator<string, void, void> {
    const signal = opts?.signal;
    if (signal?.aborted) return;
    const fetchImpl = this.deps.fetchImpl ?? defaultFetch;

    const targetLang = this.config.targetLang ?? 'Spanish';
    const sourceHint = this.config.sourceLang ? ` from ${this.config.sourceLang}` : '';
    const system =
      `You are a professional translator. Translate the user's text${sourceHint} ` +
      `into ${targetLang}. Output ONLY the translation, with no quotes or commentary.`;

    const res = await fetchImpl(CHAT_COMPLETIONS_URL, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${this.apiKey ?? ''}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        model: this.config.model ?? 'gpt-4o-mini',
        stream: true,
        messages: [
          { role: 'system', content: system },
          { role: 'user', content: text },
        ],
      }),
      signal,
    });
    if (res.status === 429) throw new RateLimitError('openai mt rate limited (429)');
    if (!res.ok) throw new ProviderError(`openai mt HTTP ${res.status}`);
    const body = res.body;
    if (!body) return;

    const reader = body.getReader();
    const abortWatch = watchAbort(signal);
    const decoder = new TextDecoder();
    let buffer = '';
    try {
      outer: while (true) {
        if (signal?.aborted) return;
        const step = await Promise.race([reader.read(), abortWatch.promise]);
        if (step === ABORTED) return;
        const { done, value } = step;
        buffer += decoder.decode(value ?? new Uint8Array(), { stream: !done });
        let newlineAt: number;
        while ((newlineAt = buffer.indexOf('\n')) >= 0) {
          const line = buffer.slice(0, newlineAt).trim();
          buffer = buffer.slice(newlineAt + 1);
          if (!line.startsWith('data:')) continue;
          const payload = line.slice('data:'.length).trim();
          if (payload === '[DONE]') break outer;
          let parsed: { choices?: Array<{ delta?: { content?: unknown } }> };
          try {
            parsed = JSON.parse(payload) as typeof parsed;
          } catch {
            continue; // tolerate malformed frames
          }
          const content = parsed.choices?.[0]?.delta?.content;
          if (typeof content === 'string' && content.length > 0) yield content;
        }
        if (done) break;
      }
    } finally {
      abortWatch.dispose();
      reader.cancel().catch(() => {});
    }
  }
}
