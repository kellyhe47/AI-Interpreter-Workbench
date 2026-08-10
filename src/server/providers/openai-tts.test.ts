/**
 * Ticket 006 — OpenAI speech adapter (TTS, non-streaming input).
 *
 * Fake chunked-body fetch replays the raw-PCM16 response shape verified in
 * the 2026-08-04 live spike; no network.
 */

import { afterEach, describe, expect, it, vi } from 'vitest';
import { collect, describeTtsContract } from '../../core/contracts/index';
import { RateLimitError } from '../../core/types';
import { OpenAiTts } from './openai-tts';
import {
  asyncIterableOf,
  chunkedBodyResponse,
  concatSamples,
  hangingBodyResponse,
  int16ToBytes,
  recordingFetch,
} from './test-support';

const PCM_SAMPLES = new Int16Array([100, -200, 300, -400, 500]); // 10 bytes LE

function okPcmFetch(bodyChunks?: readonly Uint8Array[]) {
  const chunks = bodyChunks ?? [int16ToBytes(PCM_SAMPLES)];
  return recordingFetch(() => chunkedBodyResponse(chunks));
}

afterEach(() => {
  vi.unstubAllEnvs();
});

// ---------------------------------------------------------------------------
// Shared TTS contract suite, registered UNCHANGED with a mocked transport
// (ticket 006 AC 1). streamingInput=false, so the early-yield case is skipped
// by the suite itself and empty input must complete with no audio.
// ---------------------------------------------------------------------------
describeTtsContract(
  'OpenAiTts (mocked fetch)',
  () => new OpenAiTts({ apiKey: 'test-key' }, { fetchImpl: okPcmFetch().fetchImpl }),
);

describe('OpenAiTts adapter specifics', () => {
  it('is a NON-streaming-input provider named "openai"', () => {
    const tts = new OpenAiTts({ apiKey: 'k' }, { fetchImpl: okPcmFetch().fetchImpl });
    expect(tts.name).toBe('openai');
    expect(tts.streamingInput).toBe(false);
  });

  it('concatenates a 3-chunk input into exactly ONE speech request', async () => {
    const { calls, fetchImpl } = okPcmFetch();
    const tts = new OpenAiTts({ apiKey: 'test-key', voice: 'nova' }, { fetchImpl });
    await collect(tts.synthesize(asyncIterableOf(['Hello ', 'wor', 'ld!'])));

    expect(calls).toHaveLength(1);
    const call = calls[0]!;
    expect(call.url).toBe('https://api.openai.com/v1/audio/speech');
    expect(call.init?.method).toBe('POST');
    const headers = new Headers(call.init?.headers);
    expect(headers.get('authorization')).toBe('Bearer test-key');

    const body = JSON.parse(String(call.init?.body)) as {
      model: string;
      voice: string;
      input: string;
      response_format: string;
    };
    expect(body.model).toBe('gpt-4o-mini-tts');
    expect(body.voice).toBe('nova');
    // PRD: less capable providers concatenate internally.
    expect(body.input).toBe('Hello world!');
    expect(body.response_format).toBe('pcm');
  });

  it('resolves the API key from OPENAI_API_KEY at construction when config omits it', async () => {
    vi.stubEnv('OPENAI_API_KEY', 'env-key');
    const { calls, fetchImpl } = okPcmFetch();
    const tts = new OpenAiTts({}, { fetchImpl });
    vi.unstubAllEnvs();
    await collect(tts.synthesize(asyncIterableOf(['hi'])));
    const headers = new Headers(calls[0]!.init?.headers);
    expect(headers.get('authorization')).toBe('Bearer env-key');
  });

  it('carries the remainder byte across odd-length body chunks (Int16 never misaligned)', async () => {
    const bytes = int16ToBytes(PCM_SAMPLES); // 10 bytes
    // Split at an ODD byte offset: 3 bytes, then 7 bytes.
    const { fetchImpl } = okPcmFetch([bytes.slice(0, 3), bytes.slice(3)]);
    const tts = new OpenAiTts({ apiKey: 'test-key' }, { fetchImpl });
    const chunks = await collect(tts.synthesize(asyncIterableOf(['hello'])));

    for (const c of chunks) expect(c).toBeInstanceOf(Int16Array);
    const all = concatSamples(chunks);
    expect(all.length).toBe(PCM_SAMPLES.length);
    expect(Array.from(all)).toEqual(Array.from(PCM_SAMPLES));
  });

  it('makes no fetch and yields nothing when the concatenated input is empty', async () => {
    const { calls, fetchImpl } = okPcmFetch();
    const tts = new OpenAiTts({ apiKey: 'test-key' }, { fetchImpl });
    const chunks = await collect(tts.synthesize(asyncIterableOf([])));
    expect(chunks).toEqual([]);
    expect(calls).toHaveLength(0);
  });

  it('throws RateLimitError on HTTP 429 (withRetry-compatible)', async () => {
    const { fetchImpl } = recordingFetch(
      () =>
        new Response(JSON.stringify({ error: { message: 'rate limited' } }), {
          status: 429,
        }),
    );
    const tts = new OpenAiTts({ apiKey: 'test-key' }, { fetchImpl });
    const err = await collect(tts.synthesize(asyncIterableOf(['hi']))).then(
      () => null,
      (e: unknown) => e,
    );
    expect(err).toBeInstanceOf(RateLimitError);
    expect((err as RateLimitError).status).toBe(429);
  });

  it('abort mid-stream: fetch signal observes the abort and the generator returns cleanly', async () => {
    // Body yields 2 samples then hangs forever; only abort can end it.
    const { calls, fetchImpl } = recordingFetch(() =>
      hangingBodyResponse([int16ToBytes(new Int16Array([7, 8]))]),
    );
    const tts = new OpenAiTts({ apiKey: 'test-key' }, { fetchImpl });
    const ac = new AbortController();
    const gen = tts.synthesize(asyncIterableOf(['hello']), { signal: ac.signal });

    const first = await gen.next();
    expect(first.done).toBe(false);
    expect(first.value).toBeInstanceOf(Int16Array);

    ac.abort();
    const after = await gen.next();
    expect(after.done).toBe(true);
    expect(calls[0]!.init?.signal?.aborted).toBe(true);
  });

  it('performs no fetch for an already-aborted signal', async () => {
    const { calls, fetchImpl } = okPcmFetch();
    const tts = new OpenAiTts({ apiKey: 'test-key' }, { fetchImpl });
    const ac = new AbortController();
    ac.abort();
    const chunks = await collect(
      tts.synthesize(asyncIterableOf(['hi']), { signal: ac.signal }),
    );
    expect(chunks).toEqual([]);
    expect(calls).toHaveLength(0);
  });
});

/**
 * TICKET 074 — the pronunciation instruction.
 *
 * Mandarin and Cantonese share written characters; the same characters are
 * read with different pronunciation. So the cascade's EN→YUE defect was never
 * a text-form or voice-id problem — it is pronunciation selection at the TTS.
 * `gpt-4o-mini-tts` takes a natural-language `instructions` field documented to
 * steer accent, intonation and tone, and that is the ONE lever that reaches
 * Cantonese. A direction needing nothing special sends NO field at all.
 */
describe('TICKET 074 — OpenAiTts sends `instructions` when, and only when, it has one', () => {
  function bodyOf(config: ConstructorParameters<typeof OpenAiTts>[0]): Promise<
    Record<string, unknown>
  > {
    const { calls, fetchImpl } = okPcmFetch();
    const tts = new OpenAiTts({ apiKey: 'k', ...config }, { fetchImpl });
    return collect(tts.synthesize(asyncIterableOf(['你好']))).then(
      () => JSON.parse(String(calls[0]!.init?.body)) as Record<string, unknown>,
    );
  }

  it('puts a configured instruction on the wire as the API `instructions` field', async () => {
    const body = await bodyOf({ instructions: 'Read aloud with Cantonese pronunciation.' });
    expect(body.instructions).toBe('Read aloud with Cantonese pronunciation.');
    // Added beside the rest of the request, never instead of it.
    expect(body.model).toBe('gpt-4o-mini-tts');
    expect(body.input).toBe('你好');
  });

  it('sends NO `instructions` key at all when none is configured — absence, not a guess', async () => {
    const body = await bodyOf({});
    expect('instructions' in body).toBe(false);
  });

  it('an EMPTY instruction is the same absence as none', async () => {
    const body = await bodyOf({ instructions: '' });
    expect('instructions' in body).toBe(false);
  });
});
