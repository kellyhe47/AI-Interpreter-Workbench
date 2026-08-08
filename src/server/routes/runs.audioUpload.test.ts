/**
 * TICKET 045 — the WRITE path for a run's output audio.
 *
 * ============================ WIRE SHAPE (normative) =======================
 * POST /api/runs/:id/audio      Content-Type: application/json
 *        body: { audioBase64 }  — the 24 kHz mono PCM16 WAV, base64
 *      -> 201 { id, outputAudioPath, bytes }
 *      -> 400 { code: 'invalid-run-audio', message }  for a missing, non-string
 *              or EMPTY audioBase64 — an empty upload must never create an
 *              empty runs/<id>.out.wav, because a zero-byte file would make
 *              GET /audio answer 200 with nothing instead of the honest 404.
 * ==========================================================================
 *
 * ITS OWN ENDPOINT IS THE WHOLE POINT. `POST /api/runs` stores its body
 * verbatim and `appendRun` writes the entire Run as ONE LINE of ledger.jsonl,
 * so base64 audio riding that body would put megabytes into every line of the
 * append-only benchmark history. The load-bearing test here is
 * `the ledger line stays small and carries no base64`: it fails the moment
 * anyone "simplifies" this back into the Run body.
 *
 * THE UPLOAD DOES NOT REQUIRE THE RUN TO EXIST YET. The client uploads FIRST
 * and POSTs the Run second, so that `Run.outputAudioPath` is only ever claimed
 * once the bytes are really on disk (see runner.outputAudio.test.ts). A route
 * that insisted on a prior POST would force the opposite order and with it a
 * Run that promises audio a failed upload never wrote.
 *
 * FAILED RUNS UPLOAD LIKE ANY OTHER (PRD §12). A failed run's partial audio is
 * diagnostic, and this route gets no `status` to branch on at all.
 */
import fs from 'node:fs/promises';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

import type { Run } from '../storage';
import { makeRun } from '../storage/test-support';
import type { ApiHarness } from './test-support';
import { bodyBytes, errorBody, postRun, startApi } from './test-support';

let api: ApiHarness;

afterEach(async () => {
  await api?.close();
});

interface UploadResponse {
  id?: string;
  outputAudioPath?: string;
  bytes?: number;
}

/** POST /api/runs/:id/audio in the pinned wire format. */
async function postRunAudio(id: string, body: unknown): Promise<Response> {
  return fetch(`${api.base}/api/runs/${encodeURIComponent(id)}/audio`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
}

async function uploadWav(id: string, wav: Uint8Array): Promise<Response> {
  return postRunAudio(id, { audioBase64: Buffer.from(wav).toString('base64') });
}

/** Deterministic, incompressible-enough bytes; the route treats them as opaque. */
function bigWav(length: number): Uint8Array {
  const out = new Uint8Array(length);
  for (let i = 0; i < length; i += 1) out[i] = (i * 97 + 31) % 256;
  return out;
}

async function ledgerLines(): Promise<string[]> {
  const raw = await fs.readFile(path.join(api.dir, 'ledger.jsonl'), 'utf8');
  return raw.split('\n').filter((line) => line.length > 0);
}

describe('POST /api/runs/:id/audio', () => {
  it('stores the bytes and GET /api/runs/:id/audio returns those exact bytes', async () => {
    api = await startApi();
    const run = makeRun({ id: 'run-with-output' });
    expect((await postRun(api, run)).status).toBe(201);

    const wav = bigWav(2048);
    const res = await uploadWav(run.id, wav);
    expect(res.status).toBe(201);
    expect((await res.json()) as UploadResponse).toEqual({
      id: run.id,
      // PRD §7 storage layout — the SERVER owns the path, so the Run never
      // claims one the client invented.
      outputAudioPath: `runs/${run.id}.out.wav`,
      bytes: wav.length,
    });

    const read = await fetch(`${api.base}/api/runs/${run.id}/audio`);
    expect(read.status).toBe(200);
    expect(read.headers.get('content-type')).toContain('audio/wav');
    expect(Array.from(await bodyBytes(read))).toEqual(Array.from(wav));
  });

  /**
   * THE LOAD-BEARING STRUCTURAL TEST. A megabyte of audio crosses the wire and
   * lands on disk in full, and ledger.jsonl still holds one short line of pure
   * metadata. Move the audio into the POST /api/runs body and this fails.
   */
  it('the ledger line stays small and carries no base64 of the audio', async () => {
    api = await startApi();
    const run = makeRun({ id: 'run-big-output' });
    expect((await postRun(api, run)).status).toBe(201);

    const wav = bigWav(1_000_000);
    expect((await uploadWav(run.id, wav)).status).toBe(201);

    // The bytes really are on disk, in full.
    expect((await api.storage.readRunAudio(run.id)).length).toBe(wav.length);

    const lines = await ledgerLines();
    expect(lines).toHaveLength(1);
    const line = lines[0]!;
    // A base64 payload of a 1 MB WAV is ~1.33 MB; metadata is a few hundred
    // bytes. 4 kB is loose enough for a Run to grow fields and tight enough
    // that audio can never hide in it.
    expect(line.length).toBeLessThan(4096);
    // ...and specifically, no fragment of the encoded audio.
    expect(line).not.toContain(Buffer.from(wav.subarray(0, 96)).toString('base64').slice(0, 64));
    expect(JSON.parse(line) as Run).toEqual(run);
  });

  it('a FAILED run uploads and serves its partial audio like any other (PRD §12)', async () => {
    api = await startApi();
    const run = makeRun({
      id: 'run-failed-output',
      status: 'failed',
      errors: ['tts: stage timed out'],
    });
    expect((await postRun(api, run)).status).toBe(201);

    const wav = bigWav(512);
    expect((await uploadWav(run.id, wav)).status).toBe(201);

    const read = await fetch(`${api.base}/api/runs/${run.id}/audio`);
    expect(read.status).toBe(200);
    expect(Array.from(await bodyBytes(read))).toEqual(Array.from(wav));
  });

  it('accepts an upload for a Run that has not been POSTed yet (upload first, claim second)', async () => {
    api = await startApi();
    const wav = bigWav(256);
    expect((await uploadWav('run-not-yet-posted', wav)).status).toBe(201);

    const read = await fetch(`${api.base}/api/runs/run-not-yet-posted/audio`);
    expect(read.status).toBe(200);
    expect(Array.from(await bodyBytes(read))).toEqual(Array.from(wav));
  });

  it.each<{ label: string; body: unknown }>([
    { label: 'no audioBase64 at all', body: {} },
    { label: 'a non-string audioBase64', body: { audioBase64: 42 } },
    { label: 'an EMPTY audioBase64', body: { audioBase64: '' } },
  ])('$label is a 400 invalid-run-audio and writes no file', async ({ body }) => {
    api = await startApi();
    const run = makeRun({ id: 'run-bad-upload' });
    expect((await postRun(api, run)).status).toBe(201);

    const res = await postRunAudio(run.id, body);
    expect(res.status).toBe(400);
    expect(res.headers.get('content-type')).toContain('application/json');
    expect((await errorBody(res)).code).toBe('invalid-run-audio');

    // NO empty runs/<id>.out.wav: a zero-byte file would answer 200 with
    // nothing, which reads to the player as "audio that plays silence" rather
    // than the honest "there is none".
    const read = await fetch(`${api.base}/api/runs/${run.id}/audio`);
    expect(read.status).toBe(404);
    expect((await errorBody(read)).code).toBe('run-audio-missing');
  });
});
