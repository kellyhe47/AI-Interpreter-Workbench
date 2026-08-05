/**
 * Ticket 006 — OpenAI chat-completions translation adapter (MT).
 *
 * Fake SSE fetch replays the streamed chat-completions shape verified in the
 * 2026-08-04 live spike; no network.
 */

import { afterEach, describe, expect, it, vi } from 'vitest';
import { collect, describeMtContract } from '../../core/contracts/index';
import { RateLimitError } from '../../core/types';
import { OpenAiMt } from './openai-mt';
import {
  chunkedBodyResponse,
  hangingBodyResponse,
  recordingFetch,
  sseBody,
} from './test-support';

function delta(content: string): string {
  return JSON.stringify({ choices: [{ delta: { content } }] });
}

/** Full realistic SSE payload sequence translating to 'hola mundo'. */
const SSE_PAYLOADS: readonly string[] = [
  // role-only delta (no content) — must be skipped silently
  JSON.stringify({ choices: [{ delta: { role: 'assistant' } }] }),
  delta('hola'),
  delta(' mundo'),
  // empty-delta finish frame
  JSON.stringify({ choices: [{ delta: {}, finish_reason: 'stop' }] }),
  // usage frame with empty choices — must be skipped silently
  JSON.stringify({ choices: [], usage: { prompt_tokens: 9, completion_tokens: 3 } }),
  '[DONE]',
];

function okSseFetch(payloads: readonly string[] = SSE_PAYLOADS) {
  return recordingFetch(() => chunkedBodyResponse([sseBody(payloads)]));
}

afterEach(() => {
  vi.unstubAllEnvs();
});

// ---------------------------------------------------------------------------
// Shared MT contract suite, registered UNCHANGED with a mocked transport
// (ticket 006 AC 1). streaming=true, so >=2 chunks concatenating exactly.
// ---------------------------------------------------------------------------
describeMtContract(
  'OpenAiMt (mocked SSE)',
  () => new OpenAiMt({ apiKey: 'test-key' }, { fetchImpl: okSseFetch().fetchImpl }),
  { expected: 'hola mundo' },
);

describe('OpenAiMt adapter specifics', () => {
  it('is a streaming provider named "openai"', () => {
    const mt = new OpenAiMt({ apiKey: 'k' }, { fetchImpl: okSseFetch().fetchImpl });
    expect(mt.name).toBe('openai');
    expect(mt.streaming).toBe(true);
  });

  it('POSTs a streaming gpt-4o-mini chat request with system translate instruction + user text', async () => {
    const { calls, fetchImpl } = okSseFetch();
    const mt = new OpenAiMt(
      { apiKey: 'test-key', targetLang: 'Spanish' },
      { fetchImpl },
    );
    await collect(mt.translate('hello world'));

    expect(calls).toHaveLength(1);
    const call = calls[0]!;
    expect(call.url).toBe('https://api.openai.com/v1/chat/completions');
    expect(call.init?.method).toBe('POST');
    const headers = new Headers(call.init?.headers);
    expect(headers.get('authorization')).toBe('Bearer test-key');
    expect(headers.get('content-type')).toMatch(/application\/json/);

    const body = JSON.parse(String(call.init?.body)) as {
      model: string;
      stream: boolean;
      messages: Array<{ role: string; content: string }>;
    };
    expect(body.model).toBe('gpt-4o-mini');
    expect(body.stream).toBe(true);
    expect(body.messages).toHaveLength(2);
    expect(body.messages[0]!.role).toBe('system');
    // The translate instruction must carry the configured target language.
    expect(body.messages[0]!.content).toMatch(/Spanish/);
    expect(body.messages[1]).toEqual({ role: 'user', content: 'hello world' });
  });

  it('resolves the API key from OPENAI_API_KEY at construction when config omits it', async () => {
    vi.stubEnv('OPENAI_API_KEY', 'env-key');
    const { calls, fetchImpl } = okSseFetch();
    const mt = new OpenAiMt({}, { fetchImpl });
    vi.unstubAllEnvs();
    await collect(mt.translate('hello world'));
    const headers = new Headers(calls[0]!.init?.headers);
    expect(headers.get('authorization')).toBe('Bearer env-key');
  });

  it('skips role-only deltas, usage frames and [DONE]; concatenation equals the translation', async () => {
    const { fetchImpl } = okSseFetch();
    const mt = new OpenAiMt({ apiKey: 'test-key' }, { fetchImpl });
    const chunks = await collect(mt.translate('hello world'));
    expect(chunks).toEqual(['hola', ' mundo']);
    expect(chunks.join('')).toBe('hola mundo');
  });

  it('reassembles SSE events split across HTTP body chunk boundaries', async () => {
    const full = sseBody(SSE_PAYLOADS);
    // Split in the middle of the 'hola' event's JSON payload.
    const cut = full.indexOf('hola') + 2;
    const { fetchImpl } = recordingFetch(() =>
      chunkedBodyResponse([full.slice(0, cut), full.slice(cut)]),
    );
    const mt = new OpenAiMt({ apiKey: 'test-key' }, { fetchImpl });
    const chunks = await collect(mt.translate('hello world'));
    expect(chunks.join('')).toBe('hola mundo');
  });

  it('throws RateLimitError on HTTP 429 (withRetry-compatible)', async () => {
    const { fetchImpl } = recordingFetch(
      () =>
        new Response(JSON.stringify({ error: { message: 'rate limited' } }), {
          status: 429,
        }),
    );
    const mt = new OpenAiMt({ apiKey: 'test-key' }, { fetchImpl });
    const err = await collect(mt.translate('hello world')).then(
      () => null,
      (e: unknown) => e,
    );
    expect(err).toBeInstanceOf(RateLimitError);
    expect((err as RateLimitError).status).toBe(429);
  });

  it('abort mid-stream: fetch signal observes the abort and the generator returns cleanly', async () => {
    // Body yields the first delta then hangs forever; only abort can end it.
    const { calls, fetchImpl } = recordingFetch(() =>
      hangingBodyResponse([sseBody([delta('hola')])]),
    );
    const mt = new OpenAiMt({ apiKey: 'test-key' }, { fetchImpl });
    const ac = new AbortController();
    const gen = mt.translate('hello world', { signal: ac.signal });

    const first = await gen.next();
    expect(first.done).toBe(false);
    expect(first.value).toBe('hola');

    ac.abort();
    const after = await gen.next();
    expect(after.done).toBe(true);
    // The transport must observe the abort (caller signal propagated to fetch).
    expect(calls[0]!.init?.signal?.aborted).toBe(true);
  });

  it('performs no fetch for an already-aborted signal', async () => {
    const { calls, fetchImpl } = okSseFetch();
    const mt = new OpenAiMt({ apiKey: 'test-key' }, { fetchImpl });
    const ac = new AbortController();
    ac.abort();
    const chunks = await collect(mt.translate('hello world', { signal: ac.signal }));
    expect(chunks).toEqual([]);
    expect(calls).toHaveLength(0);
  });
});
