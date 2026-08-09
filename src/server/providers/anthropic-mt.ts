/**
 * Anthropic messages translation adapter (MT), Claude Haiku 4.5.
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
 *
 * ASSUMED ANTHROPIC WIRE FORMAT (what the fakes replay, to be confirmed against
 * the live API by the operator smoke test):
 *
 *   POST https://api.anthropic.com/v1/messages
 *   x-api-key: <key> / anthropic-version: 2023-06-01 / content-type: application/json
 *   {"model":"claude-haiku-4-5","stream":true,"temperature":0,"max_tokens":1024,
 *    "system":"<translation instruction>","messages":[{"role":"user","content":"..."}]}
 *
 *   event: message_start\ndata: {"type":"message_start",...}\n\n
 *   event: content_block_start\ndata: {"type":"content_block_start",...}\n\n
 *   event: ping\ndata: {"type":"ping"}\n\n
 *   event: content_block_delta
 *   data: {"type":"content_block_delta","index":0,
 *          "delta":{"type":"text_delta","text":"Hola"}}\n\n
 *   event: content_block_stop\ndata: {"type":"content_block_stop","index":0}\n\n
 *   event: message_delta\ndata: {"type":"message_delta",...}\n\n
 *   event: message_stop\ndata: {"type":"message_stop"}\n\n   <- then body closes
 *
 * Because every `data:` payload repeats its event name in `type`, the reader
 * keys off the parsed payload alone and ignores `event:` lines entirely — the
 * same `if (!line.startsWith('data:')) continue;` loop openai-mt.ts uses. Errors
 * arrive as non-ok HTTP statuses, never as SSE frames.
 */

import { ProviderError, RateLimitError } from '../../core/types';
import type { MtProvider, ProviderCallOpts } from '../../core/types';
import { ABORTED, defaultFetch, watchAbort } from './internal';
import { envVar, type FetchLike } from './transport';

const MESSAGES_URL = 'https://api.anthropic.com/v1/messages';
const ANTHROPIC_VERSION = '2023-06-01';
const DEFAULT_MODEL = 'claude-haiku-4-5';
const DEFAULT_MAX_TOKENS = 1024;

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

  async *translate(
    text: string,
    opts?: ProviderCallOpts,
  ): AsyncGenerator<string, void, void> {
    const signal = opts?.signal;
    if (signal?.aborted) return;
    const fetchImpl = this.deps.fetchImpl ?? defaultFetch;

    // TICKET 062 — THE CALL WINS, exactly as in openai-mt.ts: the registry
    // builds this adapter from `{ model }` only, so the construction default was
    // the instruction for every pair and both directions.
    const targetLang = opts?.targetLanguage ?? this.config.targetLang ?? 'Spanish';
    const sourceHint = this.config.sourceLang ? ` from ${this.config.sourceLang}` : '';
    // Kept semantically equivalent to openai-mt.ts's system prompt so that
    // swapping MT providers measures the model, not the prompt.
    const system =
      `You are a professional translator. Translate the user's text${sourceHint} ` +
      `into ${targetLang}. Output ONLY the translation, with no quotes or commentary.`;

    const res = await fetchImpl(MESSAGES_URL, {
      method: 'POST',
      headers: {
        'x-api-key': this.apiKey ?? '',
        'anthropic-version': ANTHROPIC_VERSION,
        'content-type': 'application/json',
      },
      body: JSON.stringify({
        model: this.config.model ?? DEFAULT_MODEL,
        stream: true,
        temperature: 0,
        max_tokens: this.config.maxTokens ?? DEFAULT_MAX_TOKENS,
        system,
        messages: [{ role: 'user', content: text }],
      }),
      signal,
    });
    if (res.status === 429) throw new RateLimitError('anthropic mt rate limited (429)');
    if (!res.ok) throw new ProviderError(`anthropic mt HTTP ${res.status}`);
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
          // `event:` lines carry no information the `data:` payload lacks.
          if (!line.startsWith('data:')) continue;
          const payload = line.slice('data:'.length).trim();
          let parsed: { type?: unknown; delta?: { type?: unknown; text?: unknown } };
          try {
            parsed = JSON.parse(payload) as typeof parsed;
          } catch {
            continue; // tolerate malformed frames
          }
          // No [DONE] sentinel: message_stop (or the body closing) ends it.
          if (parsed.type === 'message_stop') break outer;
          if (parsed.type !== 'content_block_delta') continue;
          if (parsed.delta?.type !== 'text_delta') continue;
          const chunk = parsed.delta.text;
          if (typeof chunk === 'string' && chunk.length > 0) yield chunk;
        }
        if (done) break;
      }
    } finally {
      abortWatch.dispose();
      reader.cancel().catch(() => {});
    }
  }
}
