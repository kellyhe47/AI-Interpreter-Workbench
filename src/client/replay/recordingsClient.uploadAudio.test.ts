/**
 * TICKET 045 — `RunsClient.uploadAudio`, the client half of the run-audio
 * WRITE path.
 *
 * `fetch` is INJECTED exactly as in recordingsClient.test.ts; no test here may
 * reach the network. Two things are pinned: the wire shape (its OWN endpoint,
 * `audioBase64` in a JSON body — the recordings precedent) and that a rejection
 * arrives as a typed ApiError carrying the server's message rather than a raw
 * Response.
 *
 * NO per-endpoint fallback code is declared. `invalid-run-audio` is a
 * request-shape complaint, not one of the states a caller branches on, so it
 * surfaces as a plain 'http-error' — the same decision the blind-comparisons,
 * live-sessions and wer-scores clients already made.
 */
import { describe, expect, it } from 'vitest';

import { ApiError, createRunsClient, type RunAudioUpload } from './recordingsClient';

interface Call {
  url: string;
  init: RequestInit | undefined;
}

function harness(response: Response) {
  const calls: Call[] = [];
  const fetchImpl = (async (url: string, init?: RequestInit) => {
    calls.push({ url, init });
    return response;
  }) as unknown as typeof fetch;
  return { calls, runs: createRunsClient({ fetchImpl }) };
}

function jsonResponse(status: number, body: unknown): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => body,
    text: async () => JSON.stringify(body),
    arrayBuffer: async () => new ArrayBuffer(0),
  } as unknown as Response;
}

const WAV = new Uint8Array([0x52, 0x49, 0x46, 0x46, 9, 8, 7, 6, 5, 4]);
const UPLOADED: RunAudioUpload = {
  id: 'run-1',
  outputAudioPath: 'runs/run-1.out.wav',
  bytes: WAV.length,
};

describe('RunsClient.uploadAudio — the ticket-045 wire shape', () => {
  it('POSTs the WAV as base64 to the run’s OWN audio endpoint', async () => {
    const h = harness(jsonResponse(201, UPLOADED));
    const result = await h.runs.uploadAudio('run-1', WAV);

    expect(h.calls).toHaveLength(1);
    const call = h.calls[0]!;
    expect(call.url).toBe('/api/runs/run-1/audio');
    expect((call.init?.method ?? 'GET').toUpperCase()).toBe('POST');

    const body = JSON.parse(String(call.init?.body ?? 'null')) as { audioBase64?: string };
    // The bytes ride as base64 in the JSON body (the POST /api/recordings
    // precedent) — and nowhere near the Run record.
    expect(Object.keys(body)).toEqual(['audioBase64']);
    expect(Uint8Array.from(atob(body.audioBase64!), (c) => c.charCodeAt(0))).toEqual(WAV);

    expect(result).toEqual(UPLOADED);
  });

  it('URL-encodes the run id', async () => {
    const h = harness(jsonResponse(201, UPLOADED));
    await h.runs.uploadAudio('run/1 2', WAV);
    expect(h.calls[0]!.url).toBe('/api/runs/run%2F1%202/audio');
  });

  it('a rejected upload is a typed ApiError carrying the server’s message', async () => {
    const h = harness(
      jsonResponse(400, { code: 'invalid-run-audio', message: 'audioBase64 must not be empty' }),
    );

    const err = await h.runs.uploadAudio('run-1', WAV).then(
      () => null,
      (e: unknown) => e,
    );
    expect(err).toBeInstanceOf(ApiError);
    expect((err as ApiError).status).toBe(400);
    // Outside the closed vocabulary on purpose — see the header.
    expect((err as ApiError).code).toBe('http-error');
    expect((err as ApiError).message).toBe('audioBase64 must not be empty');
  });
});
