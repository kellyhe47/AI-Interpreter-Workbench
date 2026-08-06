/**
 * Ticket 008 — recordingsClient acceptance tests.
 *
 * `fetch` is INJECTED into every client here; no test may reach the network.
 * The two tables below are the whole point of the file: one pins the request
 * each method makes against the ticket-003 wire shape, the other pins that
 * every server failure arrives as a TYPED ApiError carrying the `{ code }`
 * envelope — never a thrown raw Response, which the caller would have to
 * sniff at (and which would defeat the "unplayable recording blocks the run"
 * check in runner.ts).
 */
import { describe, expect, it } from 'vitest';
import type { Recording, Run } from '../state/ledger';
import {
  ApiError,
  createRecordingsClient,
  createRunsClient,
  type ApiErrorCode,
  type NewRecordingInput,
} from './recordingsClient';

const RECORDING: Recording = {
  id: 'rec-1',
  label: 'clip one',
  sourceLanguage: 'en',
  durationMs: 4000,
  speechEndMs: 3200,
  origin: 'mic',
  createdAt: 1_700_000_000_000,
};

const RUN: Run = {
  id: 'run-1',
  recordingId: 'rec-1',
  architecture: 'cascade',
  providerTriple: { stt: 'gpt-4o-transcribe', mt: 'gpt-4o-mini', tts: 'gpt-4o-mini-tts' },
  modelSnapshots: { stt: 'gpt-4o-transcribe', mt: 'gpt-4o-mini', tts: 'gpt-4o-mini-tts' },
  armTag: 'B',
  origin: 'manual',
  status: 'complete',
  timings: { speech_end: 100, audio_queued: 900 },
  transcripts: { source: 'hello', target: 'hola' },
  cost: 0.004,
  errors: [],
  createdAt: 1_700_000_000_000,
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

function bytesResponse(status: number, bytes: Uint8Array): Response {
  const buf = new ArrayBuffer(bytes.byteLength);
  new Uint8Array(buf).set(bytes);
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => {
      throw new Error('not json');
    },
    text: async () => '',
    arrayBuffer: async () => buf,
  } as unknown as Response;
}

function harness(response: Response) {
  const calls: Call[] = [];
  const fetchImpl = (async (url: string, init?: RequestInit) => {
    calls.push({ url, init });
    return response;
  }) as unknown as typeof fetch;
  return {
    calls,
    recordings: createRecordingsClient({ fetchImpl }),
    runs: createRunsClient({ fetchImpl }),
  };
}

function bodyOf(call: Call): unknown {
  return JSON.parse(String(call.init?.body ?? 'null')) as unknown;
}

const NEW_RECORDING: NewRecordingInput = {
  label: 'clip one',
  sourceLanguage: 'en',
  durationMs: 4000,
  speechEndMs: 3200,
  origin: 'mic',
  audioBase64: 'AAECAw==',
};

// ---------------------------------------------------------------------------

describe('recordingsClient — the ticket-003 wire shape', () => {
  const cases: {
    label: string;
    response: Response;
    call: (h: ReturnType<typeof harness>) => Promise<unknown>;
    method: string;
    url: string;
    body?: unknown;
    expected?: unknown;
  }[] = [
    {
      label: 'list',
      response: jsonResponse(200, [RECORDING]),
      call: (h) => h.recordings.list(),
      method: 'GET',
      url: '/api/recordings',
      expected: [RECORDING],
    },
    {
      label: 'get',
      response: jsonResponse(200, RECORDING),
      call: (h) => h.recordings.get('rec-1'),
      method: 'GET',
      url: '/api/recordings/rec-1',
      expected: RECORDING,
    },
    {
      label: 'create',
      response: jsonResponse(201, RECORDING),
      call: (h) => h.recordings.create(NEW_RECORDING),
      method: 'POST',
      url: '/api/recordings',
      body: NEW_RECORDING,
      expected: RECORDING,
    },
    {
      label: 'patch-label (label ONLY — audio and metadata are immutable)',
      response: jsonResponse(200, { ...RECORDING, label: 'renamed' }),
      call: (h) => h.recordings.patchLabel('rec-1', 'renamed'),
      method: 'PATCH',
      url: '/api/recordings/rec-1',
      body: { label: 'renamed' },
      expected: { ...RECORDING, label: 'renamed' },
    },
    {
      label: 'delete',
      response: jsonResponse(200, { ...RECORDING, deletedAt: 5 }),
      call: (h) => h.recordings.remove('rec-1'),
      method: 'DELETE',
      url: '/api/recordings/rec-1',
      expected: { ...RECORDING, deletedAt: 5 },
    },
    {
      label: 'runs.create',
      response: jsonResponse(201, RUN),
      call: (h) => h.runs.create(RUN),
      method: 'POST',
      url: '/api/runs',
      body: RUN,
      expected: RUN,
    },
    {
      label: 'runs.list',
      response: jsonResponse(200, [RUN]),
      call: (h) => h.runs.list(),
      method: 'GET',
      url: '/api/runs',
      expected: [RUN],
    },
  ];

  it.each(cases)('$label issues $method $url and returns the parsed body', async (c) => {
    const h = harness(c.response);
    const result = await c.call(h);

    expect(h.calls).toHaveLength(1);
    const call = h.calls[0]!;
    expect(call.url).toBe(c.url);
    expect((call.init?.method ?? 'GET').toUpperCase()).toBe(c.method);
    if (c.body !== undefined) expect(bodyOf(call)).toEqual(c.body);
    expect(result).toEqual(c.expected);
  });

  it('runs.list(recordingId) filters through the query string', async () => {
    const h = harness(jsonResponse(200, [RUN]));
    await h.runs.list('rec-1');
    expect(h.calls[0]!.url).toContain('/api/runs');
    expect(h.calls[0]!.url).toContain('recordingId=rec-1');
  });

  it('get-audio returns the raw WAV bytes', async () => {
    const wav = new Uint8Array([0x52, 0x49, 0x46, 0x46, 1, 2, 3, 4]);
    const h = harness(bytesResponse(200, wav));
    const bytes = await h.recordings.getAudio('rec-1');

    expect(h.calls[0]!.url).toBe('/api/recordings/rec-1/audio');
    expect(bytes).toBeInstanceOf(Uint8Array);
    expect(Array.from(bytes)).toEqual(Array.from(wav));
  });

  it('runs get-audio returns the raw output WAV bytes', async () => {
    const wav = new Uint8Array([9, 8, 7, 6]);
    const h = harness(bytesResponse(200, wav));
    const bytes = await h.runs.getAudio('run-1');

    expect(h.calls[0]!.url).toBe('/api/runs/run-1/audio');
    expect(Array.from(bytes)).toEqual(Array.from(wav));
  });
});

// ---------------------------------------------------------------------------

describe('recordingsClient — failures are typed, never a raw Response', () => {
  const cases: {
    label: string;
    status: number;
    code: ApiErrorCode;
    call: (h: ReturnType<typeof harness>) => Promise<unknown>;
  }[] = [
    {
      label: '404 on an unknown recording id',
      status: 404,
      code: 'recording-not-found',
      call: (h) => h.recordings.get('nope'),
    },
    {
      label: '404 when the audio is gone (an unplayable Recording)',
      status: 404,
      code: 'recording-audio-missing',
      call: (h) => h.recordings.getAudio('rec-1'),
    },
    {
      label: '409 on a corpus delete',
      status: 409,
      code: 'corpus-undeletable',
      call: (h) => h.recordings.remove('corpus-1'),
    },
    {
      label: '404 when a run has no output audio',
      status: 404,
      code: 'run-audio-missing',
      call: (h) => h.runs.getAudio('run-1'),
    },
    {
      label: '404 on an unknown id via patch-label',
      status: 404,
      code: 'recording-not-found',
      call: (h) => h.recordings.patchLabel('nope', 'x'),
    },
  ];

  it.each(cases)('$label rejects with ApiError { code: $code }', async (c) => {
    const h = harness(jsonResponse(c.status, { code: c.code, message: 'boom' }));

    const err: unknown = await c.call(h).then(
      () => null,
      (e: unknown) => e,
    );

    expect(err).toBeInstanceOf(ApiError);
    expect(err).toBeInstanceOf(Error);
    const api = err as ApiError;
    expect(api.code).toBe(c.code);
    expect(api.status).toBe(c.status);
    // Whatever the copy is, it must be a real message — not '[object Object]'.
    expect(typeof api.message).toBe('string');
    expect(api.message.length).toBeGreaterThan(0);
    // The raw Response must not escape: no ok/arrayBuffer surface on the error.
    expect((err as { ok?: unknown }).ok).toBeUndefined();
    expect((err as { arrayBuffer?: unknown }).arrayBuffer).toBeUndefined();
  });

  it('an unenveloped failure is still an ApiError, not a Response', async () => {
    const h = harness(jsonResponse(500, 'kaboom'));
    const err: unknown = await h.recordings.list().then(
      () => null,
      (e: unknown) => e,
    );
    expect(err).toBeInstanceOf(ApiError);
    expect((err as ApiError).status).toBe(500);
  });
});
