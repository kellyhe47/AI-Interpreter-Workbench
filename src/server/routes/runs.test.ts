/**
 * TDD tests for the Runs REST router (Ticket 003).
 *
 * ============================ WIRE SHAPE (normative) =======================
 * POST /api/runs                Content-Type: application/json
 *        body: the complete client-produced Run record (PRD §7 — the Realtime
 *        arm's Run is built in the browser and POSTed back; the id comes with
 *        it)  -> 201 Run
 * GET  /api/runs                -> 200 Run[]   (`?recordingId=` filters)
 * GET  /api/runs/:id/audio      -> 200 WAV bytes, Content-Type audio/wav
 *
 * Failures respond `{ code, message }` with the StorageErrorCode.
 * ==========================================================================
 */
import { afterEach, describe, expect, it } from 'vitest';

import type { Run, RunStatus } from '../storage';
import { makeRun, wavBytes as runWavBytes } from '../storage/test-support';
import type { ApiHarness } from './test-support';
import { bodyBytes, errorBody, postRun, startApi } from './test-support';

let api: ApiHarness;

afterEach(async () => {
  await api?.close();
});

async function boot(): Promise<ApiHarness> {
  api = await startApi();
  return api;
}

async function listRuns(query = ''): Promise<Run[]> {
  const res = await fetch(`${api.base}/api/runs${query}`);
  expect(res.status).toBe(200);
  return (await res.json()) as Run[];
}

describe('POST /api/runs + GET /api/runs', () => {
  it.each<RunStatus>(['complete', 'failed'])(
    'AC8: a %s run is appended, returned, and listed identically',
    async (status) => {
      await boot();
      const run = makeRun({
        id: `run-${status}`,
        status,
        errors: status === 'failed' ? ['tts stage timed out'] : [],
      });

      const res = await postRun(api, run);
      expect(res.status).toBe(201);
      expect((await res.json()) as Run).toEqual(run);

      const listed = await listRuns();
      expect(listed).toHaveLength(1);
      expect(listed[0]).toEqual(run);
      expect(listed[0]!.status).toBe(status);
    },
  );

  it('AC9: ?recordingId= returns only that Recording’s runs', async () => {
    await boot();
    const mine = makeRun({ id: 'run-a', recordingId: 'rec-A' });
    const alsoMine = makeRun({ id: 'run-b', recordingId: 'rec-A' });
    const other = makeRun({ id: 'run-c', recordingId: 'rec-B' });
    for (const run of [mine, alsoMine, other]) {
      expect((await postRun(api, run)).status).toBe(201);
    }

    expect((await listRuns('?recordingId=rec-A')).map((r) => r.id).sort()).toEqual([
      'run-a',
      'run-b',
    ]);
    expect((await listRuns('?recordingId=rec-B')).map((r) => r.id)).toEqual(['run-c']);
    expect((await listRuns()).map((r) => r.id).sort()).toEqual(['run-a', 'run-b', 'run-c']);
  });

  it('AC10: posting the same Run twice never rewrites the earlier ledger line', async () => {
    await boot();
    const first = makeRun({ id: 'run-dup', cost: 0.0011, transcripts: { source: 'one' } });
    const second: Run = { ...first, cost: 0.0099, transcripts: { source: 'two' } };

    expect((await postRun(api, first)).status).toBe(201);
    expect((await postRun(api, second)).status).toBe(201);

    // The ledger is append-only: two lines, and line 0 is byte-for-byte the
    // record that was posted first.
    const ledger = await api.storage.readLedger();
    expect(ledger).toHaveLength(2);
    expect(ledger[0]).toEqual(first);
    expect(ledger[1]).toEqual(second);
  });
});

describe('GET /api/runs/:id/audio', () => {
  it('returns the run’s output WAV bytes with Content-Type audio/wav', async () => {
    await boot();
    const run = makeRun({ id: 'run-with-audio' });
    expect((await postRun(api, run)).status).toBe(201);

    // Cascade runs are orchestrated server-side, so the output WAV lands in the
    // store rather than over this router (PRD §7).
    const audio = runWavBytes(5, 80);
    await api.storage.writeRunAudio(run.id, audio);

    const res = await fetch(`${api.base}/api/runs/${run.id}/audio`);
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toContain('audio/wav');
    expect(Array.from(await bodyBytes(res))).toEqual(Array.from(audio));
  });

  it('a run with no output WAV answers 404/410 with code run-audio-missing', async () => {
    await boot();
    const run = makeRun({ id: 'run-no-audio' });
    expect((await postRun(api, run)).status).toBe(201);

    const res = await fetch(`${api.base}/api/runs/${run.id}/audio`);
    expect([404, 410]).toContain(res.status);
    expect(res.headers.get('content-type')).toContain('application/json');
    expect((await errorBody(res)).code).toBe('run-audio-missing');
  });
});
