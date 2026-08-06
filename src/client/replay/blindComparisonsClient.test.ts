/**
 * TICKET 023 (QA F6) — the blind-comparisons REST client.
 *
 * Same discipline as recordingsClient.test.ts: `fetch` is INJECTED into every
 * client here, so no test may reach the network. One table pins the request
 * each method makes against the ticket-023 wire shape; the other pins that a
 * server failure arrives as a TYPED ApiError carrying the `{ code }` envelope.
 *
 * WHY THIS CLIENT EXISTS: scores used to land in
 * `localStorage["workbench.runLedger.v1"].blindComparisons` and nowhere else.
 * PRD §7 — "the server owns the store; the client reads and writes it over
 * REST".
 */
import { describe, expect, it } from 'vitest';
import type { BlindComparison } from '../state/ledger';
import {
  ApiError,
  createBlindComparisonsClient,
  type ApiErrorCode,
  type BlindComparisonsClient,
} from './recordingsClient';

const COMPARISON: BlindComparison = {
  id: 'cmp-1',
  recordingId: 'rec-1',
  runIds: ['run-adhoc-1', 'run-b-sweep-1'],
  order: ['run-b-sweep-1', 'run-adhoc-1'],
  evaluatorLanguage: 'es',
  scores: { A: { adequacy: 4, fluency: 5 }, B: { adequacy: 2, fluency: 3 } },
  createdAt: 1_700_000_000_000,
  revealedAt: 1_700_000_000_500,
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
  const client: BlindComparisonsClient = createBlindComparisonsClient(
    baseUrl === undefined ? { fetchImpl } : { fetchImpl, baseUrl },
  );
  return { calls, client };
}

/* ============================================================ wire shape == */

describe('ticket 023 — createBlindComparisonsClient: the wire shape', () => {
  it('AC4: create() POSTs the whole comparison as JSON to /api/blind-comparisons', async () => {
    const { calls, client } = harness(jsonResponse(201, COMPARISON));

    const created = await client.create(COMPARISON);

    expect(calls).toHaveLength(1);
    expect(calls[0]!.url).toBe('/api/blind-comparisons');
    expect(calls[0]!.init?.method).toBe('POST');
    expect(JSON.parse(String(calls[0]!.init?.body))).toEqual(COMPARISON);
    expect(created).toEqual(COMPARISON);
  });

  it('AC1: list() GETs the unfiltered collection with a bare path', async () => {
    const { calls, client } = harness(jsonResponse(200, [COMPARISON]));

    expect(await client.list()).toEqual([COMPARISON]);
    expect(calls[0]!.url).toBe('/api/blind-comparisons');
    expect(calls[0]!.init?.method).toBe('GET');
    expect(calls[0]!.init?.body).toBeUndefined();
  });

  it('AC1: list(recordingId) filters via ?recordingId=, URL-encoded', async () => {
    const { calls, client } = harness(jsonResponse(200, []));

    await client.list('rec a/1');

    expect(calls[0]!.url).toBe(`/api/blind-comparisons?recordingId=${encodeURIComponent('rec a/1')}`);
  });

  it('honours baseUrl like every other client', async () => {
    const { calls, client } = harness(jsonResponse(200, []), 'http://example.test');

    await client.list();

    expect(calls[0]!.url).toBe('http://example.test/api/blind-comparisons');
  });
});

/* ============================================================ failures ==== */

describe('ticket 023 — failures arrive as a typed ApiError', () => {
  const cases: Array<{
    reason: string;
    status: number;
    body: unknown;
    code: ApiErrorCode;
    message: string;
  }> = [
    {
      reason: 'the server rejected the body',
      status: 400,
      body: { code: 'invalid-blind-comparison', message: 'scores must name both samples' },
      code: 'http-error',
      message: 'scores must name both samples',
    },
    {
      reason: 'the store failed',
      status: 500,
      body: { code: 'internal-error', message: 'disk is full' },
      code: 'http-error',
      message: 'disk is full',
    },
    {
      reason: 'the body is not an envelope at all',
      status: 502,
      body: '<html>bad gateway</html>',
      code: 'http-error',
      message: '<html>bad gateway</html>',
    },
  ];

  it.each(cases)('$reason -> ApiError, never a raw Response', async (testCase) => {
    const { client } = harness(jsonResponse(testCase.status, testCase.body));

    const err: unknown = await client.create(COMPARISON).then(
      () => undefined,
      (e: unknown) => e,
    );

    expect(err).toBeInstanceOf(ApiError);
    expect((err as ApiError).status).toBe(testCase.status);
    expect((err as ApiError).code).toBe(testCase.code);
    expect((err as ApiError).message).toBe(testCase.message);
  });

  it('a failing list() rejects rather than resolving to an empty array', async () => {
    const { client } = harness(jsonResponse(500, { code: 'internal-error', message: 'nope' }));

    await expect(client.list()).rejects.toBeInstanceOf(ApiError);
  });
});
