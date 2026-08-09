/**
 * Ticket 005 — Anthropic messages translation adapter (MT), Claude Haiku 4.5.
 *
 * Fake SSE fetch replays the Anthropic streaming-messages wire shape; no
 * network. Anthropic frames are NAMED events — an `event: <name>` line paired
 * with a `data: {...}` line whose JSON repeats the name in `type` — and there
 * is NO `[DONE]` sentinel: the stream ends with `message_stop` and the body
 * closing.
 *
 * Registry wiring and the shared MT contract suite are ticket 006; this file
 * covers adapter specifics only.
 */

import { afterEach, describe, expect, it, vi } from 'vitest';
import { collect } from '../../core/contracts/index';
import { ProviderError, RateLimitError } from '../../core/types';
import { AnthropicMt } from './anthropic-mt';
import { chunkedBodyResponse, hangingBodyResponse, recordingFetch } from './test-support';

const MESSAGES_URL = 'https://api.anthropic.com/v1/messages';

/**
 * Anthropic SSE body: `event: <type>` + `data: <json>` per frame. Built here as
 * literal text rather than via test-support's `sseBody` (which emits bare
 * `data:` lines and is shared with the OpenAI adapter tests).
 */
function anthropicSseBody(frames: readonly Record<string, unknown>[]): string {
  return frames
    .map((f) => `event: ${String(f['type'])}\ndata: ${JSON.stringify(f)}\n\n`)
    .join('');
}

function textDelta(text: string): Record<string, unknown> {
  return { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text } };
}

/** Realistic full stream translating to 'Hola mundo'. */
const FRAMES: readonly Record<string, unknown>[] = [
  { type: 'message_start', message: { id: 'msg_1', role: 'assistant', content: [] } },
  { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } },
  { type: 'ping' },
  textDelta('Hola'),
  textDelta(' mun'),
  textDelta('do'),
  { type: 'content_block_stop', index: 0 },
  { type: 'message_delta', delta: { stop_reason: 'end_turn' }, usage: { output_tokens: 3 } },
  { type: 'message_stop' },
];

function okSseFetch(body: string = anthropicSseBody(FRAMES)) {
  return recordingFetch(() => chunkedBodyResponse([body]));
}

afterEach(() => {
  vi.unstubAllEnvs();
});

describe('AnthropicMt adapter specifics', () => {
  it('is a streaming provider named "anthropic"', () => {
    const mt = new AnthropicMt({ apiKey: 'k' }, { fetchImpl: okSseFetch().fetchImpl });
    expect(mt.name).toBe('anthropic');
    expect(mt.streaming).toBe(true);
  });

  it('POSTs to the Anthropic messages endpoint with x-api-key and anthropic-version (not Bearer)', async () => {
    const { calls, fetchImpl } = okSseFetch();
    const mt = new AnthropicMt({ apiKey: 'test-key' }, { fetchImpl });
    await collect(mt.translate('hello world'));

    expect(calls).toHaveLength(1);
    const call = calls[0]!;
    expect(call.url).toBe(MESSAGES_URL);
    expect(call.init?.method).toBe('POST');
    const headers = new Headers(call.init?.headers);
    expect(headers.get('x-api-key')).toBe('test-key');
    expect(headers.get('anthropic-version')).toBe('2023-06-01');
    expect(headers.get('content-type')).toMatch(/application\/json/);
    // Anthropic authenticates with x-api-key, NOT an OpenAI-style bearer token.
    expect(headers.get('authorization')).toBeNull();
  });

  it('resolves the API key from ANTHROPIC_API_KEY at construction when config omits it', async () => {
    vi.stubEnv('ANTHROPIC_API_KEY', 'env-anthropic-key');
    const { calls, fetchImpl } = okSseFetch();
    const mt = new AnthropicMt({}, { fetchImpl });
    vi.unstubAllEnvs();
    await collect(mt.translate('hello world'));
    expect(new Headers(calls[0]!.init?.headers).get('x-api-key')).toBe('env-anthropic-key');
  });

  it('sends stream:true, temperature:0, max_tokens, the default haiku model and the source text', async () => {
    const { calls, fetchImpl } = okSseFetch();
    const mt = new AnthropicMt({ apiKey: 'test-key' }, { fetchImpl });
    await collect(mt.translate('hello world'));

    const body = JSON.parse(String(calls[0]!.init?.body)) as {
      model: string;
      stream: boolean;
      temperature: number;
      max_tokens: unknown;
      system: string;
      messages: Array<{ role: string; content: string }>;
    };
    expect(body.model).toBe('claude-haiku-4-5');
    expect(body.stream).toBe(true);
    // PRD §8 controlled variable: translations must be reproducible run to run.
    expect(body.temperature).toBe(0);
    expect(typeof body.max_tokens).toBe('number');
    expect(body.messages).toHaveLength(1);
    expect(body.messages[0]).toEqual({ role: 'user', content: 'hello world' });
  });

  it('config.model overrides the default model', async () => {
    const { calls, fetchImpl } = okSseFetch();
    const mt = new AnthropicMt({ apiKey: 'k', model: 'claude-sonnet-4-5' }, { fetchImpl });
    await collect(mt.translate('hello world'));
    const body = JSON.parse(String(calls[0]!.init?.body)) as { model: string };
    expect(body.model).toBe('claude-sonnet-4-5');
  });

  it.each(['Spanish', 'French'])(
    'the system prompt names the configured target language (%s)',
    async (targetLang) => {
      const { calls, fetchImpl } = okSseFetch();
      const mt = new AnthropicMt({ apiKey: 'k', targetLang }, { fetchImpl });
      await collect(mt.translate('hello world'));
      const body = JSON.parse(String(calls[0]!.init?.body)) as { system: string };
      expect(typeof body.system).toBe('string');
      expect(body.system).toContain(targetLang);
    },
  );

  it('streams the text deltas in order; their concatenation is the translation', async () => {
    const { fetchImpl } = okSseFetch();
    const mt = new AnthropicMt({ apiKey: 'k' }, { fetchImpl });
    const chunks = await collect(mt.translate('hello world'));
    expect(chunks).toEqual(['Hola', ' mun', 'do']);
    expect(chunks.join('')).toBe('Hola mundo');
  });

  it('skips non-text events and malformed frames without throwing or yielding', async () => {
    // Everything here is a non-text event, plus one unparseable data frame and
    // one unknown event type: nothing may be yielded and nothing may throw.
    const body =
      anthropicSseBody([
        { type: 'message_start', message: { id: 'msg_2' } },
        { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } },
        { type: 'ping' },
        { type: 'some_future_event', whatever: true },
        { type: 'content_block_stop', index: 0 },
        { type: 'message_delta', delta: { stop_reason: 'end_turn' } },
        { type: 'message_stop' },
      ]) + 'event: content_block_delta\ndata: {not valid json\n\n';
    const { fetchImpl } = okSseFetch(body);
    const mt = new AnthropicMt({ apiKey: 'k' }, { fetchImpl });
    await expect(collect(mt.translate('hello world'))).resolves.toEqual([]);
  });

  it('reassembles an SSE event split across two HTTP body chunks', async () => {
    const full = anthropicSseBody(FRAMES);
    // Cut in the middle of the first text delta's JSON payload.
    const cut = full.indexOf('Hola') + 2;
    const { fetchImpl } = recordingFetch(() =>
      chunkedBodyResponse([full.slice(0, cut), full.slice(cut)]),
    );
    const mt = new AnthropicMt({ apiKey: 'k' }, { fetchImpl });
    const chunks = await collect(mt.translate('hello world'));
    expect(chunks).toEqual(['Hola', ' mun', 'do']);
    expect(chunks.join('')).toBe('Hola mundo');
  });

  it('throws RateLimitError on HTTP 429 (withRetry-compatible)', async () => {
    const { fetchImpl } = recordingFetch(
      () =>
        new Response(JSON.stringify({ type: 'error', error: { type: 'rate_limit_error' } }), {
          status: 429,
        }),
    );
    const mt = new AnthropicMt({ apiKey: 'k' }, { fetchImpl });
    const err = await collect(mt.translate('hello world')).then(
      () => null,
      (e: unknown) => e,
    );
    expect(err).toBeInstanceOf(RateLimitError);
    expect((err as RateLimitError).status).toBe(429);
  });

  it('throws ProviderError (not RateLimitError) on another non-ok status', async () => {
    const { fetchImpl } = recordingFetch(
      () => new Response(JSON.stringify({ type: 'error' }), { status: 500 }),
    );
    const mt = new AnthropicMt({ apiKey: 'k' }, { fetchImpl });
    const err = await collect(mt.translate('hello world')).then(
      () => null,
      (e: unknown) => e,
    );
    expect(err).toBeInstanceOf(ProviderError);
    expect(err).not.toBeInstanceOf(RateLimitError);
  });

  it('abort mid-stream: fetch signal observes the abort and the generator returns cleanly', async () => {
    // Body yields the first delta then hangs forever; only abort can end it.
    const { calls, fetchImpl } = recordingFetch(() =>
      hangingBodyResponse([anthropicSseBody([textDelta('Hola')])]),
    );
    const mt = new AnthropicMt({ apiKey: 'k' }, { fetchImpl });
    const ac = new AbortController();
    const gen = mt.translate('hello world', { signal: ac.signal });

    const first = await gen.next();
    expect(first.done).toBe(false);
    expect(first.value).toBe('Hola');

    ac.abort();
    const after = await gen.next();
    expect(after.done).toBe(true);
    expect(calls[0]!.init?.signal?.aborted).toBe(true);
  });

  it('performs no fetch and yields nothing for an already-aborted signal', async () => {
    const { calls, fetchImpl } = okSseFetch();
    const mt = new AnthropicMt({ apiKey: 'k' }, { fetchImpl });
    const ac = new AbortController();
    ac.abort();
    const chunks = await collect(mt.translate('hello world', { signal: ac.signal }));
    expect(chunks).toEqual([]);
    expect(calls).toHaveLength(0);
  });
});

/**
 * TICKET 062 — same defect, same adapter shape (Arm C's MT stage).
 *
 * `resolveTriple` builds this with `{ model }` only, so the system prompt says
 * "into Spanish" for every pair and both directions.
 */
describe('TICKET 062 — translate() honours the session target language', () => {
  function systemPromptOf(calls: { init?: RequestInit }[]): string {
    const body = JSON.parse(String(calls[0]!.init?.body)) as { system: string };
    return body.system;
  }

  it.each(['Spanish', 'English', 'Cantonese'])(
    'a call for %s instructs %s, overriding the construction default',
    async (targetLanguage) => {
      const { calls, fetchImpl } = okSseFetch();
      const mt = new AnthropicMt({ apiKey: 'k' }, { fetchImpl });
      await collect(mt.translate('hello world', { targetLanguage } as never));
      expect(systemPromptOf(calls)).toContain(targetLanguage);
    },
  );

  it('a call for English does NOT still say Spanish', async () => {
    const { calls, fetchImpl } = okSseFetch();
    const mt = new AnthropicMt({ apiKey: 'k' }, { fetchImpl });
    await collect(mt.translate('hola mundo', { targetLanguage: 'English' } as never));
    expect(systemPromptOf(calls)).not.toContain('Spanish');
  });

  // ADVERSARIAL REVIEW FINDING 1 — see openai-mt.test.ts. The cases above never
  // set `config.targetLang`, so "overriding the construction default" was a claim
  // the test could not see: swapping `opts ?? config` for `config ?? opts` kept
  // them all green. This one sets a DIFFERENT default and watches the call win.
  it('a construction-time targetLang loses to the call — the precedence is real', async () => {
    const { calls, fetchImpl } = okSseFetch();
    const mt = new AnthropicMt({ apiKey: 'k', targetLang: 'German' }, { fetchImpl });
    await collect(mt.translate('hello world', { targetLanguage: 'English' } as never));
    const system = systemPromptOf(calls);
    expect(system).toContain('English');
    expect(system).not.toContain('German');
  });
});
