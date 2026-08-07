/**
 * TICKET 034 — the WER-scores REST router.
 *
 * ============================ WIRE SHAPE (normative) =======================
 * POST /api/wer-scores   body: one complete WerScore  -> 201 WerScore
 * GET  /api/wer-scores                                -> 200 WerScore[]
 *
 * A malformed body answers 400 `{ code: 'invalid-wer-score', message }`.
 * ==========================================================================
 *
 * WHERE SCORES LAND: their OWN append-only file, `wer-scores.jsonl`, beside
 * `ledger.jsonl` and never inside it — `readLedger()` is typed `Run[]` and is
 * unioned into the exported run set, so a score sharing that file would be
 * counted in `totals.runs`.
 *
 * THE RULE THIS SUITE EXISTS FOR: `not applicable` and `0` must be impossible
 * to confuse at the wire. Cantonese is improvised from English prompt cards and
 * has no written script (PRD §9); a WER of 0 is a PERFECT score.
 *
 * Every test runs against a `mkdtemp`-backed Storage.
 */
import fs from 'node:fs/promises';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterEach, describe, expect, it } from 'vitest';

import { createApp } from '../index';
import type { Run, WerScore } from '../storage';
import {
  LAYOUT,
  makeNotApplicableWerScore,
  makeRun,
  makeWerScore,
} from '../storage/test-support';
import type { ApiHarness } from './test-support';
import { errorBody, getWerScores, postRun, postWerScore, startApi } from './test-support';

let api: ApiHarness;

afterEach(async () => {
  await api?.close();
});

async function boot(): Promise<ApiHarness> {
  api = await startApi();
  return api;
}

/** Every parsed line of the append-only score file, in write order. */
async function scoreLines(dir: string): Promise<WerScore[]> {
  const text = await fs.readFile(LAYOUT.werScores(dir), 'utf8');
  return text
    .split('\n')
    .filter((line) => line.trim().length > 0)
    .map((line) => JSON.parse(line) as WerScore);
}

/* ===================================================== POST + GET round trip */

describe('ticket 034 — POST /api/wer-scores + GET /api/wer-scores', () => {
  it('AC1: a posted score is persisted and listed back FIELD-FOR-FIELD', async () => {
    await boot();
    const score = makeWerScore();

    const res = await postWerScore(api, score);
    expect(res.status).toBe(201);
    expect((await res.json()) as WerScore).toEqual(score);

    const listed = await getWerScores(api);
    expect(listed.status).toBe(200);
    expect(listed.body).toEqual([score]);
  });

  it('AC1: it reaches the SERVER-OWNED store, not only the response', async () => {
    await boot();
    const score = makeWerScore({ utteranceId: 'u-on-disk' });

    expect((await postWerScore(api, score)).status).toBe(201);

    expect(await api.storage.listWerScores()).toEqual([score]);
    expect(await scoreLines(api.dir)).toEqual([score]);
  });

  it('AC1: an empty store lists an empty array, not a 404', async () => {
    await boot();
    const listed = await getWerScores(api);
    expect(listed.status).toBe(200);
    expect(listed.body).toEqual([]);
  });

  it('AC3: a NOT-APPLICABLE score is accepted and stored as null, never 0', async () => {
    await boot();
    const na = makeNotApplicableWerScore();

    expect((await postWerScore(api, na)).status).toBe(201);
    const [stored] = (await getWerScores(api)).body;
    expect(stored!.wer).toBeNull();
    expect(stored!.wer).not.toBe(0);
    expect(stored!.notApplicableReason).toBe('no-reference-text');
  });

  it('AC4: a score for a FIXTURE-sourced or FAILED run is stored (excluded later, not refused)', async () => {
    await boot();
    // Ticket 018's rule is about REPORTING, not writing. The realness rule and
    // the aggregation gate keep this out of a figure; the route keeps the
    // record.
    const score = makeWerScore({ runId: 'run-fixture', utteranceId: 'u-1' });
    expect((await postWerScore(api, score)).status).toBe(201);
    expect((await getWerScores(api)).body).toEqual([score]);
  });

  it('AC4: an UNCLAMPED wer above 1.0 is accepted', async () => {
    await boot();
    expect((await postWerScore(api, makeWerScore({ wer: 2.5 }))).status).toBe(201);
    expect((await getWerScores(api)).body[0]!.wer).toBe(2.5);
  });
});

/* ============================================================ append-only == */

describe('ticket 034 — the WER stream is APPEND-ONLY and last-write-wins on READ', () => {
  it('AC6: re-scoring the same (runId, utteranceId) never rewrites the earlier record', async () => {
    await boot();
    const first = makeWerScore({ wer: 0.5, scoredAt: 1 });
    const second = makeWerScore({ wer: 0.1, scoredAt: 2 });

    expect((await postWerScore(api, first)).status).toBe(201);
    expect((await postWerScore(api, second)).status).toBe(201);

    // Both on disk, both listed: the GET is deliberately UNCOLLAPSED so the
    // history survives and last-write-wins lives in exactly one place.
    expect(await scoreLines(api.dir)).toEqual([first, second]);
    expect((await getWerScores(api)).body).toEqual([first, second]);
  });

  it('AC1: an unparseable line costs that line alone, not the whole file', async () => {
    await boot();
    expect((await postWerScore(api, makeWerScore({ utteranceId: 'u-good' }))).status).toBe(201);
    await fs.appendFile(LAYOUT.werScores(api.dir), '{"runId":"run-tor\n', 'utf8');
    expect((await postWerScore(api, makeWerScore({ utteranceId: 'u-after' }))).status).toBe(201);

    const listed = await getWerScores(api);
    expect(listed.status).toBe(200);
    expect(listed.body.map((s) => s.utteranceId)).toEqual(['u-good', 'u-after']);
  });
});

/* ============================================ a score is not, and never edits, a run */

describe('ticket 034 — a WER score is not a Run and never mutates one', () => {
  it('AC2: posting a score leaves the run listing and the ledger untouched', async () => {
    await boot();
    const run = makeRun({ id: 'run-only' });
    expect((await postRun(api, run)).status).toBe(201);
    const before = await fs.readFile(LAYOUT.ledger(api.dir), 'utf8');

    expect((await postWerScore(api, makeWerScore({ runId: 'run-only' }))).status).toBe(201);

    const listedRuns = (await (await fetch(`${api.base}/api/runs`)).json()) as Run[];
    expect(listedRuns).toEqual([run]);
    expect(await fs.readFile(LAYOUT.ledger(api.dir), 'utf8')).toBe(before);
    expect(before).not.toContain('normalizationVersion');
  });
});

/* =============================================== the malformed-body envelope */

describe('ticket 034 — a malformed body is a 4xx with a machine-readable envelope', () => {
  /** Each case is a body that is NOT a WerScore, and why. */
  const malformed: Array<{ reason: string; body: unknown }> = [
    { reason: 'empty object', body: {} },
    // `strict: false` on the JSON parser, so a scalar reaches OUR gate and gets
    // the envelope rather than express's HTML error page (PRD §12).
    { reason: 'not an object at all', body: 'score-1' },
    {
      reason: 'missing runId',
      body: (() => {
        const { runId: _runId, ...rest } = makeWerScore();
        return rest;
      })(),
    },
    { reason: 'blank utteranceId', body: { ...makeWerScore(), utteranceId: '' } },
    {
      reason: 'wer is absent entirely',
      body: (() => {
        const { wer: _wer, ...rest } = makeWerScore();
        return rest;
      })(),
    },
    { reason: 'wer is a string', body: { ...makeWerScore(), wer: '0.25' } },
    { reason: 'wer is negative', body: { ...makeWerScore(), wer: -0.1 } },
    { reason: 'wer is NaN', body: { ...makeWerScore(), wer: Number.NaN } },
    { reason: 'scoredAt is not a number', body: { ...makeWerScore(), scoredAt: 'noon' } },
    {
      reason: 'no normalizationVersion — the number could never be recomputed',
      body: { ...makeWerScore(), normalizationVersion: '' },
    },
    {
      reason: 'a numeric wer with no referenceText to have measured it against',
      body: { ...makeWerScore(), referenceText: null },
    },
    // THE LOAD-BEARING PAIR. `not applicable` and `0` must be impossible to
    // confuse: 0 is a PERFECT score.
    {
      reason: 'wer 0 carrying a notApplicableReason — the exact confusion this ticket prevents',
      body: { ...makeWerScore(), wer: 0, notApplicableReason: 'no-reference-text' },
    },
    {
      reason: 'a null wer with NO reason — indistinguishable from "not scored yet"',
      body: { ...makeWerScore(), wer: null, referenceText: null, notApplicableReason: undefined },
    },
    {
      reason: 'a null wer with an unknown reason',
      body: { ...makeWerScore(), wer: null, referenceText: null, notApplicableReason: 'because' },
    },
    {
      reason: 'no-reference-text contradicted by a referenceText that is present',
      body: { ...makeNotApplicableWerScore(), referenceText: 'a script that exists' },
    },
  ];

  it.each(malformed)('AC1: $reason -> 4xx { code, message }', async ({ body }) => {
    await boot();

    const res = await postWerScore(api, body);
    expect(res.status).toBeGreaterThanOrEqual(400);
    expect(res.status).toBeLessThan(500);

    const envelope = await errorBody(res);
    expect(typeof envelope.code).toBe('string');
    expect((envelope.code ?? '').length).toBeGreaterThan(0);
    expect(typeof envelope.message).toBe('string');
    expect((envelope.message ?? '').length).toBeGreaterThan(0);

    // Rejected means NOT stored: a half-record in an append-only stream cannot
    // be repaired later.
    expect((await getWerScores(api)).body).toEqual([]);
  });

  it('AC1: the rejection code is stable and namespaced like the other routes', async () => {
    await boot();
    expect((await errorBody(await postWerScore(api, {}))).code).toBe('invalid-wer-score');
  });

  it('AC3: a wer of exactly 0 WITHOUT a reason is a perfectly legal measurement', async () => {
    await boot();
    // The rule is about the CONTRADICTION, not about the value: a transcript
    // that matched the script exactly really does score 0.
    expect((await postWerScore(api, makeWerScore({ wer: 0 }))).status).toBe(201);
    expect((await getWerScores(api)).body[0]!.wer).toBe(0);
  });
});

/* ================================================ mounted on the real app = */

describe('ticket 034 — the router is mounted by createApp', () => {
  it('AC1: createApp({ storage }) serves /api/wer-scores against the INJECTED store', async () => {
    await boot();
    const server = http.createServer(createApp({ storage: api.storage }));
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const { port } = server.address() as AddressInfo;
    const base = `http://127.0.0.1:${port}`;

    try {
      const score = makeWerScore({ utteranceId: 'u-mounted' });
      const posted = await fetch(`${base}/api/wer-scores`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(score),
      });
      expect(posted.status).toBe(201);

      const listed = await fetch(`${base}/api/wer-scores`);
      expect(listed.status).toBe(200);
      expect((await listed.json()) as WerScore[]).toEqual([score]);

      // The existing mounts still answer: the new router shadows nothing.
      expect((await fetch(`${base}/api/health`)).status).toBe(200);
      expect((await fetch(`${base}/api/blind-comparisons`)).status).toBe(200);
      expect((await fetch(`${base}/api/live-sessions`)).status).toBe(200);
      expect((await fetch(`${base}/api/runs`)).status).toBe(200);
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });
});
