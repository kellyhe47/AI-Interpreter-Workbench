/**
 * TDD tests for the Blind-comparisons REST router (TICKET 023 — QA F6).
 *
 * ============================ WIRE SHAPE (normative) =======================
 * POST /api/blind-comparisons   Content-Type: application/json
 *        body: the COMPLETE client-produced BlindComparison — the draw, the
 *        scores and the evaluator's language are decided in the browser, so
 *        the `id` arrives with it (same discipline as POST /api/runs).
 *      -> 201 BlindComparison
 * GET  /api/blind-comparisons   -> 200 BlindComparison[]  (`?recordingId=`
 *        filters)
 *
 * A malformed body answers 400 with the `{ code, message }` envelope every
 * other route uses (PRD §12).
 * ==========================================================================
 *
 * WHERE COMPARISONS LAND: their OWN append-only file, `comparisons.jsonl`,
 * beside `ledger.jsonl` — NOT inside it. `readLedger()` is typed `Run[]` and is
 * read as runs by exportResults, so a comparison sharing that file would be
 * counted as a run in `totals.runs` and derived into an arm. Same append-only
 * discipline (PRD §17 20b), separate stream.
 *
 * THE BUG THIS SUITE EXISTS FOR: scores reached `localStorage` and nowhere
 * else. They never touched `data/`, so they were absent from the exported
 * bundle the write-up cites, lost with browser storage, and unreachable from
 * the second machine PRD §10 explicitly describes.
 *
 * Every test runs against a `mkdtemp`-backed Storage — nothing here writes into
 * the repo's data/.
 */
import fs from 'node:fs/promises';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterEach, describe, expect, it } from 'vitest';

import { createApp } from '../index';
import type { BlindComparison, Run } from '../storage';
import { LAYOUT, makeBlindComparison, makeRun } from '../storage/test-support';
import type { ApiHarness } from './test-support';
import {
  errorBody,
  getBlindComparisons,
  postBlindComparison,
  postRun,
  startApi,
} from './test-support';

let api: ApiHarness;

afterEach(async () => {
  await api?.close();
});

async function boot(): Promise<ApiHarness> {
  api = await startApi();
  return api;
}

/** Every parsed line of the append-only comparisons file, in write order. */
async function comparisonLines(dir: string): Promise<BlindComparison[]> {
  const text = await fs.readFile(LAYOUT.comparisons(dir), 'utf8');
  return text
    .split('\n')
    .filter((line) => line.trim().length > 0)
    .map((line) => JSON.parse(line) as BlindComparison);
}

async function listRuns(): Promise<Run[]> {
  const res = await fetch(`${api.base}/api/runs`);
  expect(res.status).toBe(200);
  return (await res.json()) as Run[];
}

/* ===================================================== POST + GET + filter = */

describe('ticket 023 — POST /api/blind-comparisons + GET /api/blind-comparisons', () => {
  it('AC1: a posted comparison is persisted and listed back FIELD-FOR-FIELD', async () => {
    await boot();
    const comparison = makeBlindComparison({
      id: 'cmp-round-trip',
      recordingId: 'rec-clinic',
      runIds: ['run-adhoc-1', 'run-b-sweep-1'],
      order: ['run-b-sweep-1', 'run-adhoc-1'],
      evaluatorLanguage: 'es',
      scores: { A: { adequacy: 4, fluency: 5 }, B: { adequacy: 2, fluency: 3 } },
    });

    const res = await postBlindComparison(api, comparison);
    expect(res.status).toBe(201);
    expect((await res.json()) as BlindComparison).toEqual(comparison);

    const listed = await getBlindComparisons(api);
    expect(listed.status).toBe(200);
    expect(listed.body).toEqual([comparison]);
  });

  it('AC1: it reaches the SERVER-OWNED store, not just the response', async () => {
    await boot();
    const comparison = makeBlindComparison({ id: 'cmp-on-disk' });

    expect((await postBlindComparison(api, comparison)).status).toBe(201);

    // The store the routers were built with — read through its own API...
    expect(await api.storage.listBlindComparisons()).toEqual([comparison]);
    // ...and on disk, in its OWN append-only file (never ledger.jsonl).
    expect(await comparisonLines(api.dir)).toEqual([comparison]);
  });

  it('AC1: comparisons never enter the RUN ledger — a run listing is unaffected', async () => {
    await boot();
    const run = makeRun({ id: 'run-only' });
    expect((await postRun(api, run)).status).toBe(201);
    expect(
      (await postBlindComparison(api, makeBlindComparison({ id: 'cmp-not-a-run' }))).status,
    ).toBe(201);

    expect((await listRuns()).map((r) => r.id)).toEqual(['run-only']);
    const ledger = await fs.readFile(LAYOUT.ledger(api.dir), 'utf8');
    expect(ledger).not.toContain('cmp-not-a-run');
  });

  it('AC1: ?recordingId= returns only that Recording’s comparisons', async () => {
    await boot();
    const mine = makeBlindComparison({ id: 'cmp-a', recordingId: 'rec-A' });
    const alsoMine = makeBlindComparison({ id: 'cmp-b', recordingId: 'rec-A' });
    const other = makeBlindComparison({ id: 'cmp-c', recordingId: 'rec-B' });
    for (const comparison of [mine, alsoMine, other]) {
      expect((await postBlindComparison(api, comparison)).status).toBe(201);
    }

    const forA = await getBlindComparisons(api, '?recordingId=rec-A');
    expect(forA.status).toBe(200);
    expect(forA.body.map((c) => c.id).sort()).toEqual(['cmp-a', 'cmp-b']);

    const forB = await getBlindComparisons(api, '?recordingId=rec-B');
    expect(forB.body.map((c) => c.id)).toEqual(['cmp-c']);

    const all = await getBlindComparisons(api);
    expect(all.body.map((c) => c.id).sort()).toEqual(['cmp-a', 'cmp-b', 'cmp-c']);
  });

  it('AC1: an empty store lists an empty array, not a 404', async () => {
    await boot();
    const listed = await getBlindComparisons(api);
    expect(listed.status).toBe(200);
    expect(listed.body).toEqual([]);
  });
});

/* ============================================================ append-only = */

describe('ticket 023 — the comparison store is APPEND-ONLY', () => {
  it('AC2: posting the same comparison id twice never rewrites the earlier record', async () => {
    await boot();
    const first = makeBlindComparison({
      id: 'cmp-dup',
      scores: { A: { adequacy: 4, fluency: 5 }, B: { adequacy: 2, fluency: 3 } },
      createdAt: 1_000,
    });
    // Same id, DIFFERENT judgement. A read-modify-write store would lose the
    // first evaluator's scores entirely.
    const second = makeBlindComparison({
      id: 'cmp-dup',
      scores: { A: { adequacy: 1, fluency: 1 }, B: { adequacy: 5, fluency: 5 } },
      createdAt: 2_000,
    });

    expect((await postBlindComparison(api, first)).status).toBe(201);
    expect((await postBlindComparison(api, second)).status).toBe(201);

    // The FIRST line is byte-for-byte what was posted, and the second is a
    // second line rather than a replacement.
    const lines = await comparisonLines(api.dir);
    expect(lines).toEqual([first, second]);

    // ...and both are readable through the API: nothing was dropped.
    const listed = await getBlindComparisons(api);
    expect(listed.body).toHaveLength(2);
    expect(listed.body).toContainEqual(first);
    expect(listed.body).toContainEqual(second);
  });

  it('AC2: an unparseable line costs that line alone, not the whole file', async () => {
    await boot();
    const good = makeBlindComparison({ id: 'cmp-good' });
    expect((await postBlindComparison(api, good)).status).toBe(201);
    // A process killed mid-write leaves a torn line behind.
    await fs.appendFile(LAYOUT.comparisons(api.dir), '{"id":"cmp-tor\n', 'utf8');
    const after = makeBlindComparison({ id: 'cmp-after' });
    expect((await postBlindComparison(api, after)).status).toBe(201);

    const listed = await getBlindComparisons(api);
    expect(listed.status).toBe(200);
    expect(listed.body.map((c) => c.id).sort()).toEqual(['cmp-after', 'cmp-good']);
  });
});

/* =============================================== the malformed-body envelope */

describe('ticket 023 — a malformed body is a 4xx with a machine-readable envelope', () => {
  /** Each case is a body that is NOT a BlindComparison, and why. */
  const malformed: Array<{ reason: string; body: unknown }> = [
    { reason: 'empty object', body: {} },
    { reason: 'not an object at all', body: 'cmp-1' },
    {
      reason: 'missing id',
      body: (() => {
        const { id: _id, ...rest } = makeBlindComparison();
        return rest;
      })(),
    },
    {
      reason: 'missing recordingId',
      body: (() => {
        const { recordingId: _r, ...rest } = makeBlindComparison();
        return rest;
      })(),
    },
    {
      reason: 'runIds is not a pair',
      body: { ...makeBlindComparison(), runIds: ['run-a'] },
    },
    {
      reason: 'order is not a pair',
      body: { ...makeBlindComparison(), order: ['run-a', 'run-b', 'run-c'] },
    },
    {
      reason: 'evaluatorLanguage is blank',
      body: { ...makeBlindComparison(), evaluatorLanguage: '' },
    },
    {
      reason: 'scores missing sample B',
      body: { ...makeBlindComparison(), scores: { A: { adequacy: 4, fluency: 5 } } },
    },
    {
      reason: 'a score is not a number',
      body: {
        ...makeBlindComparison(),
        scores: { A: { adequacy: 'four', fluency: 5 }, B: { adequacy: 2, fluency: 3 } },
      },
    },
    {
      reason: 'createdAt is not a number',
      body: { ...makeBlindComparison(), createdAt: 'yesterday' },
    },
  ];

  it.each(malformed)('AC3: $reason -> 4xx { code, message }', async ({ body }) => {
    await boot();

    const res = await postBlindComparison(api, body);
    expect(res.status).toBeGreaterThanOrEqual(400);
    expect(res.status).toBeLessThan(500);

    const envelope = await errorBody(res);
    expect(typeof envelope.code).toBe('string');
    expect((envelope.code ?? '').length).toBeGreaterThan(0);
    expect(typeof envelope.message).toBe('string');
    expect((envelope.message ?? '').length).toBeGreaterThan(0);

    // Rejected means NOT stored: a half-record is worse than none.
    expect((await getBlindComparisons(api)).body).toEqual([]);
  });

  it('AC3: the rejection code is stable and namespaced like the other routes', async () => {
    await boot();
    const res = await postBlindComparison(api, {});
    expect((await errorBody(res)).code).toBe('invalid-blind-comparison');
  });
});

/* ======================================== dangling runIds are still stored = */

describe('ticket 023 — a comparison whose runs do not exist is STILL stored', () => {
  it('AC6 (half one): the evaluator’s work is never silently discarded', async () => {
    await boot();
    // Not one of these runs was ever posted.
    const orphan = makeBlindComparison({
      id: 'cmp-orphan',
      recordingId: 'rec-vanished',
      runIds: ['run-gone-1', 'run-gone-2'],
      order: ['run-gone-2', 'run-gone-1'],
    });

    const res = await postBlindComparison(api, orphan);
    expect(res.status).toBe(201);
    expect((await res.json()) as BlindComparison).toEqual(orphan);

    expect((await getBlindComparisons(api)).body).toEqual([orphan]);
    expect(await comparisonLines(api.dir)).toEqual([orphan]);
  });
});

/* ================================================ mounted on the real app = */

describe('ticket 023 — the router is mounted by createApp', () => {
  it('AC1: createApp({ storage }) serves /api/blind-comparisons against the INJECTED store', async () => {
    await boot();
    const server = http.createServer(createApp({ storage: api.storage }));
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const { port } = server.address() as AddressInfo;
    const base = `http://127.0.0.1:${port}`;

    try {
      const comparison = makeBlindComparison({ id: 'cmp-mounted' });
      const posted = await fetch(`${base}/api/blind-comparisons`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(comparison),
      });
      expect(posted.status).toBe(201);

      const listed = await fetch(`${base}/api/blind-comparisons`);
      expect(listed.status).toBe(200);
      expect((await listed.json()) as BlindComparison[]).toEqual([comparison]);

      // The health route still answers: the new mount shadows nothing.
      expect((await fetch(`${base}/api/health`)).status).toBe(200);
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });
});
