/**
 * TDD tests for the Recordings REST router (Ticket 003).
 *
 * ============================ WIRE SHAPE (normative) =======================
 * POST   /api/recordings        Content-Type: application/json
 *          { label, sourceLanguage, durationMs, speechEndMs, origin,
 *            createdAt?, audioBase64 }      <- WAV bytes ride as base64
 *        -> 201 Recording (with the store-generated `id`)
 * GET    /api/recordings        -> 200 Recording[]   (soft-deleted omitted)
 * GET    /api/recordings/:id    -> 200 Recording | 404
 * GET    /api/recordings/:id/audio -> 200 WAV bytes, Content-Type audio/wav
 * PATCH  /api/recordings/:id    { label } -> 200 Recording  (label ONLY)
 * DELETE /api/recordings/:id    -> 200 Recording | 409 for a corpus Recording
 *
 * Every failure responds with a JSON envelope `{ code, message }` where `code`
 * is the StorageErrorCode — machine-readable, never a bare status page and
 * never an unhandled throw (PRD §12).
 * ==========================================================================
 */
import fs from 'node:fs/promises';
import { afterEach, describe, expect, it } from 'vitest';

import type { Recording } from '../storage';
import { LAYOUT, makeRun } from '../storage/test-support';
import type { ApiHarness } from './test-support';
import {
  bodyBytes,
  createRecording,
  errorBody,
  postRecording,
  postRun,
  startApi,
  wavBytes,
} from './test-support';

let api: ApiHarness;

afterEach(async () => {
  await api?.close();
});

async function boot(): Promise<ApiHarness> {
  api = await startApi();
  return api;
}

async function listRecordings(): Promise<Recording[]> {
  const res = await fetch(`${api.base}/api/recordings`);
  expect(res.status).toBe(200);
  return (await res.json()) as Recording[];
}

describe('POST /api/recordings', () => {
  it('AC1: returns 201 with a generated id, and the audio round-trips byte-identically', async () => {
    await boot();
    const audio = wavBytes(7, 128);

    const res = await postRecording(api, { label: 'first clip', audio });
    expect(res.status).toBe(201);

    const rec = (await res.json()) as Recording;
    expect(typeof rec.id).toBe('string');
    expect(rec.id.length).toBeGreaterThan(0);
    expect(rec.label).toBe('first clip');
    expect(rec.origin).toBe('mic');
    expect(rec.durationMs).toBe(4200);
    expect(rec.speechEndMs).toBe(3800);

    const audioRes = await fetch(`${api.base}/api/recordings/${rec.id}/audio`);
    expect(audioRes.status).toBe(200);
    expect(audioRes.headers.get('content-type')).toContain('audio/wav');
    expect(Array.from(await bodyBytes(audioRes))).toEqual(Array.from(audio));
  });

  it('AC1: GET /api/recordings/:id returns the same Recording that was created', async () => {
    await boot();
    const created = await createRecording(api, { label: 'fetch me' });

    const res = await fetch(`${api.base}/api/recordings/${created.id}`);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual(created);
  });
});

describe('GET /api/recordings', () => {
  it('AC2: lists created Recordings and omits soft-deleted ones', async () => {
    await boot();
    const kept = await createRecording(api, { label: 'kept' });
    const gone = await createRecording(api, { label: 'gone' });

    expect((await listRecordings()).map((r) => r.id).sort()).toEqual(
      [kept.id, gone.id].sort(),
    );

    const del = await fetch(`${api.base}/api/recordings/${gone.id}`, { method: 'DELETE' });
    expect(del.status).toBeGreaterThanOrEqual(200);
    expect(del.status).toBeLessThan(300);

    const after = await listRecordings();
    expect(after.map((r) => r.id)).toEqual([kept.id]);
  });
});

describe('PATCH /api/recordings/:id', () => {
  it('AC3: updates the label and returns the updated Recording', async () => {
    await boot();
    const created = await createRecording(api, { label: 'before' });

    const res = await fetch(`${api.base}/api/recordings/${created.id}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ label: 'after' }),
    });
    expect(res.status).toBe(200);
    expect((await res.json()) as Recording).toEqual({ ...created, label: 'after' });

    const reread = await fetch(`${api.base}/api/recordings/${created.id}`);
    expect(((await reread.json()) as Recording).label).toBe('after');
  });

  it('AC3: changes nothing but the label — durationMs/speechEndMs/origin and the audio are immutable', async () => {
    await boot();
    const audio = wavBytes(3, 96);
    const created = await createRecording(api, { label: 'before', audio });

    const res = await fetch(`${api.base}/api/recordings/${created.id}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        label: 'after',
        durationMs: 999_999,
        speechEndMs: 111,
        origin: 'corpus',
        createdAt: 1,
        id: 'hijacked',
        audioBase64: Buffer.from(wavBytes(9, 96)).toString('base64'),
      }),
    });
    expect(res.status).toBe(200);

    const updated = (await res.json()) as Recording;
    expect(updated).toEqual({ ...created, label: 'after' });

    // Audio is immutable (PRD §7): the original bytes are still what is served.
    const audioRes = await fetch(`${api.base}/api/recordings/${created.id}/audio`);
    expect(Array.from(await bodyBytes(audioRes))).toEqual(Array.from(audio));
  });
});

describe('DELETE /api/recordings/:id', () => {
  it('AC4: a mic Recording is soft-deleted — gone from the list, its Runs still retrievable', async () => {
    await boot();
    const rec = await createRecording(api, { label: 'mic clip' });
    const run = makeRun({ id: 'run-of-deleted', recordingId: rec.id });
    expect((await postRun(api, run)).status).toBe(201);

    const del = await fetch(`${api.base}/api/recordings/${rec.id}`, { method: 'DELETE' });
    expect(del.status).toBeGreaterThanOrEqual(200);
    expect(del.status).toBeLessThan(300);

    expect((await listRecordings()).map((r) => r.id)).not.toContain(rec.id);

    const runsRes = await fetch(`${api.base}/api/runs?recordingId=${rec.id}`);
    expect(runsRes.status).toBe(200);
    expect(((await runsRes.json()) as Array<{ id: string }>).map((r) => r.id)).toEqual([
      run.id,
    ]);
  });

  it('AC5: a corpus Recording is refused with 409 and stays listed', async () => {
    await boot();
    const rec = await createRecording(api, { label: 'corpus clip', origin: 'corpus' });

    const del = await fetch(`${api.base}/api/recordings/${rec.id}`, { method: 'DELETE' });
    expect(del.status).toBe(409);
    const body = await errorBody(del);
    expect(body.code).toBe('corpus-undeletable');
    expect(typeof body.message).toBe('string');
    expect(body.message!.length).toBeGreaterThan(0);

    expect((await listRecordings()).map((r) => r.id)).toContain(rec.id);
  });
});

/**
 * AC6 / AC7: storage failures are mapped to status codes with a machine-readable
 * `code`, never a 500 and never an unhandled throw (PRD §12 — the client marks
 * the Recording unplayable off this signal).
 */
interface FailureCase {
  name: string;
  method: 'GET' | 'DELETE';
  code: string;
  allowed: number[];
  arrange(harness: ApiHarness): Promise<string>;
}

const failureCases: FailureCase[] = [
  {
    name: 'GET an unknown recording id -> 404 recording-not-found',
    method: 'GET',
    code: 'recording-not-found',
    allowed: [404],
    arrange: async () => '/api/recordings/rec_nope_00000000',
  },
  {
    name: 'GET audio for an unknown recording id -> 404/410',
    method: 'GET',
    code: 'recording-audio-missing',
    allowed: [404, 410],
    arrange: async () => '/api/recordings/rec_nope_00000000/audio',
  },
  {
    name: 'GET audio whose WAV has vanished from disk -> 404/410 recording-audio-missing',
    method: 'GET',
    code: 'recording-audio-missing',
    allowed: [404, 410],
    arrange: async (harness) => {
      const rec = await createRecording(harness, { label: 'orphan metadata' });
      await fs.rm(LAYOUT.recordingWav(harness.dir, rec.id));
      return `/api/recordings/${rec.id}/audio`;
    },
  },
  {
    name: 'DELETE a corpus Recording -> 409 corpus-undeletable',
    method: 'DELETE',
    code: 'corpus-undeletable',
    allowed: [409],
    arrange: async (harness) => {
      const rec = await createRecording(harness, { origin: 'corpus' });
      return `/api/recordings/${rec.id}`;
    },
  },
];

describe('AC6/AC7: storage failures map to status codes with a machine-readable code', () => {
  it.each(failureCases)('$name', async (testCase) => {
    await boot();
    const target = await testCase.arrange(api);

    const res = await fetch(`${api.base}${target}`, { method: testCase.method });
    expect(testCase.allowed).toContain(res.status);
    expect(res.headers.get('content-type')).toContain('application/json');
    expect((await errorBody(res)).code).toBe(testCase.code);
  });
});

/**
 * Ticket 030 — the PRD §9 corpus manifest on a Recording.
 *
 * A corpus Recording is a <=45 s take holding ~4 utterances, each with its OWN
 * category and reference text (SS9: "categories are distributed across the
 * recordings, not grouped"). Unlike the runs route, recordings VALIDATE the
 * manifest rather than passing unknown keys through: a malformed manifest does
 * not fail loudly later, it silently mis-attributes every category and WER
 * figure derived from it.
 */
describe('ticket 030 — corpus utterance manifest', () => {
  const MANIFEST = [
    { id: 'en-1-1', index: 1, category: 'short-reply', trueSpeechEndMs: 4000, referenceText: 'Yes.' },
    { id: 'en-1-2', index: 2, category: 'numbers-dates', trueSpeechEndMs: 16000, referenceText: 'Take 250 milligrams.' },
    { id: 'en-1-3', index: 3, category: 'disfluency', trueSpeechEndMs: 27500, referenceText: 'I— sorry, Tuesday.' },
    { id: 'en-1-4', index: 4, category: 'proper-nouns', trueSpeechEndMs: 41000, referenceText: 'Doctor Nguyen.' },
  ];
  const CORPUS = {
    origin: 'corpus' as const,
    durationMs: 45000,
    speechEndMs: 41000,
    utterances: MANIFEST,
    corpusVersion: 'corpus-v1',
  };

  it('persists the manifest and returns it on the full round trip', async () => {
    const api = await boot();
    const created = await createRecording(api, CORPUS);

    expect(created.utterances).toEqual(MANIFEST);
    expect(created.corpusVersion).toBe('corpus-v1');

    // Survives the store, not just the response body.
    const onDisk = JSON.parse(
      await fs.readFile(LAYOUT.recordingJson(api.dir, created.id), 'utf8'),
    ) as Recording;
    expect(onDisk.utterances).toEqual(MANIFEST);
    expect(onDisk.corpusVersion).toBe('corpus-v1');

    const fetched = (await (await fetch(`${api.base}/api/recordings/${created.id}`)).json()) as Recording;
    expect(fetched.utterances).toEqual(MANIFEST);
    expect(fetched.corpusVersion).toBe('corpus-v1');
  });

  it('a Cantonese take carries no referenceText — improvised, no written script (SS9)', async () => {
    const api = await boot();
    const yue = MANIFEST.map(({ referenceText: _drop, ...rest }) => rest);
    const created = await createRecording(api, { ...CORPUS, sourceLanguage: 'yue', utterances: yue });
    expect(created.utterances).toEqual(yue);
    for (const u of created.utterances ?? []) expect(u).not.toHaveProperty('referenceText');
  });

  it('a mic Recording carries NO manifest key at all — not an empty array', async () => {
    const api = await boot();
    const created = await createRecording(api);
    expect(created).not.toHaveProperty('utterances');
    expect(created).not.toHaveProperty('corpusVersion');

    const onDisk = JSON.parse(
      await fs.readFile(LAYOUT.recordingJson(api.dir, created.id), 'utf8'),
    ) as Recording;
    expect(onDisk).not.toHaveProperty('utterances');
  });

  it('a corpus Recording with a manifest is still undeletable (SS17 25c)', async () => {
    const api = await boot();
    const created = await createRecording(api, CORPUS);
    const res = await fetch(`${api.base}/api/recordings/${created.id}`, { method: 'DELETE' });
    expect(res.status).toBe(409);
  });

  // Each rejection exists because breaking the rule yields a plausible WRONG
  // number rather than an obvious failure.
  const bad: Array<{ name: string; utterances: unknown; match: RegExp }> = [
    { name: 'a non-array manifest', utterances: { id: 'x' }, match: /must be an array/ },
    { name: 'an empty manifest', utterances: [], match: /must not be empty/ },
    {
      name: 'a duplicate utterance id',
      utterances: [MANIFEST[0], { ...MANIFEST[1], id: 'en-1-1' }],
      match: /duplicate utterance id/,
    },
    {
      name: 'a gap in the indices',
      utterances: [MANIFEST[0], { ...MANIFEST[1], index: 9 }],
      match: /indices must be 1\.\.2/,
    },
    {
      name: 'an unknown category',
      utterances: [{ ...MANIFEST[0], category: 'numbers' }],
      match: /unknown category/,
    },
    {
      name: 'a boundary beyond the clip duration',
      utterances: [{ ...MANIFEST[0], trueSpeechEndMs: 45001 }],
      match: /beyond the clip duration/,
    },
    {
      name: 'a non-monotonic boundary',
      utterances: [MANIFEST[0], { ...MANIFEST[1], trueSpeechEndMs: 3000 }],
      match: /does not advance past the previous speech end/,
    },
  ];

  for (const { name, utterances, match } of bad) {
    it(`rejects ${name} with 400 and a named reason`, async () => {
      const api = await boot();
      const res = await postRecording(api, { ...CORPUS, utterances });
      expect(res.status).toBe(400);
      const body = await errorBody(res);
      expect(body.code).toBe('invalid-recording');
      expect(body.message).toMatch(match);
    });
  }

  it('rejects an empty corpusVersion rather than storing a blank provenance', async () => {
    const api = await boot();
    const res = await postRecording(api, { ...CORPUS, corpusVersion: '' });
    expect(res.status).toBe(400);
    expect((await errorBody(res)).message).toMatch(/corpusVersion/);
  });

  it('a rejected manifest writes NOTHING — no orphan wav, no metadata', async () => {
    const api = await boot();
    await postRecording(api, { ...CORPUS, utterances: [] });
    const listed = (await (await fetch(`${api.base}/api/recordings`)).json()) as Recording[];
    expect(listed).toEqual([]);
  });
});
