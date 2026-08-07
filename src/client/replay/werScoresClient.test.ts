/**
 * TICKET 034 — the WER-scores REST client.
 *
 * Same discipline as blindComparisonsClient.test.ts: `fetch` is INJECTED, so no
 * test may reach the network. The wire shape is pinned against the ticket-034
 * router, and a server failure must arrive as a TYPED ApiError.
 *
 * WHY THIS CLIENT EXISTS: WER had no server representation at all, so a score
 * computed in one browser could reach neither `data/`, nor the exported bundle,
 * nor a second machine. PRD §7 — "the server owns the store; the client reads
 * and writes it over REST".
 */
import { describe, expect, it } from 'vitest';

import { WER_NORMALIZATION_VERSION, type WerScore } from '../../core/wer';
import { ApiError, createWerScoresClient, type WerScoresClient } from './recordingsClient';

const SCORE: WerScore = {
  runId: 'run-1',
  utteranceId: 'u-1',
  wer: 0.25,
  referenceText: 'The quick brown fox.',
  hypothesisText: 'the quick brown ox',
  normalizationVersion: WER_NORMALIZATION_VERSION,
  scoredAt: 1_700_000_000_000,
};

const NOT_APPLICABLE: WerScore = {
  ...SCORE,
  runId: 'run-yue',
  utteranceId: 'y-1',
  wer: null,
  notApplicableReason: 'no-reference-text',
  referenceText: null,
  hypothesisText: '你好嗎',
};

interface Call {
  url: string;
  init: RequestInit | undefined;
}

/** A response stub — deliberately NOT a real Response, so nothing leaks out. */
function jsonResponse(status: number, body: unknown): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => body,
    text: async () => JSON.stringify(body),
    arrayBuffer: async () => new ArrayBuffer(0),
  } as unknown as Response;
}

function harness(response: Response, baseUrl?: string) {
  const calls: Call[] = [];
  const fetchImpl = (async (url: string, init?: RequestInit) => {
    calls.push({ url, init });
    return response;
  }) as unknown as typeof fetch;
  const client: WerScoresClient = createWerScoresClient(
    baseUrl === undefined ? { fetchImpl } : { fetchImpl, baseUrl },
  );
  return { calls, client };
}

describe('ticket 034 — createWerScoresClient', () => {
  it('AC1: create() POSTs the whole score as JSON to /api/wer-scores', async () => {
    const { calls, client } = harness(jsonResponse(201, SCORE));

    expect(await client.create(SCORE)).toEqual(SCORE);
    expect(calls).toHaveLength(1);
    expect(calls[0]!.url).toBe('/api/wer-scores');
    expect(calls[0]!.init?.method).toBe('POST');
    expect(JSON.parse(String(calls[0]!.init?.body))).toEqual(SCORE);
  });

  it('AC3: a NOT-APPLICABLE score survives the wire as null, never as 0 or absent', async () => {
    const { calls, client } = harness(jsonResponse(201, NOT_APPLICABLE));

    const sent = JSON.parse(String((await client.create(NOT_APPLICABLE), calls[0]!.init?.body)));
    expect(Object.keys(sent)).toContain('wer');
    expect(sent.wer).toBeNull();
    expect(sent.wer).not.toBe(0);
    expect(sent.notApplicableReason).toBe('no-reference-text');
  });

  it('AC1: list() GETs the bare path — no filter, and no empty query string', async () => {
    const { calls, client } = harness(jsonResponse(200, [SCORE, NOT_APPLICABLE]));

    expect(await client.list()).toEqual([SCORE, NOT_APPLICABLE]);
    expect(calls[0]!.url).toBe('/api/wer-scores');
    expect(calls[0]!.init?.method).toBe('GET');
  });

  it('AC6: list() is UNCOLLAPSED — a re-scored atom comes back twice', async () => {
    const first = { ...SCORE, wer: 0.9, scoredAt: 1 };
    const second = { ...SCORE, wer: 0.1, scoredAt: 2 };
    const { client } = harness(jsonResponse(200, [first, second]));

    // Last-write-wins is a READ-SIDE collapse in the ledger; the transport
    // hands over the history unmodified.
    expect(await client.list()).toEqual([first, second]);
  });

  it('AC1: baseUrl is honoured', async () => {
    const { calls, client } = harness(jsonResponse(200, []), 'http://example.test');
    await client.list();
    expect(calls[0]!.url).toBe('http://example.test/api/wer-scores');
  });

  it('AC1: a refused body arrives as a typed ApiError carrying the server message', async () => {
    const { client } = harness(
      jsonResponse(400, {
        code: 'invalid-wer-score',
        message: 'not a wer score — a numeric wer must not carry notApplicableReason',
      }),
    );

    // `invalid-wer-score` is a request-shape complaint, not one of the four
    // states a caller branches on, so it surfaces as 'http-error' rather than
    // widening the closed ApiErrorCode vocabulary.
    const err = await client.create(SCORE).then(
      () => undefined,
      (e: unknown) => e,
    );
    expect(err).toBeInstanceOf(ApiError);
    expect((err as ApiError).code).toBe('http-error');
    expect((err as ApiError).status).toBe(400);
    expect((err as ApiError).message).toContain('notApplicableReason');
  });
});
