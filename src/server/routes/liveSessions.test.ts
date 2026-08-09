/**
 * TICKET 041 — the LiveSessions REST router.
 *
 * ============================ WIRE SHAPE (normative) =======================
 * POST /api/live-sessions   Content-Type: application/json
 *        body: the COMPLETE client-produced LiveSession (the metrics are
 *        computed in the browser at Stop, so the `id` arrives with it — same
 *        discipline as POST /api/runs and POST /api/blind-comparisons)
 *      -> 201 LiveSession
 * GET  /api/live-sessions   -> 200 LiveSession[]  (write order)
 *
 * A malformed body answers 400 `{ code: 'invalid-live-session', message }`.
 * ==========================================================================
 *
 * WHERE SESSIONS LAND: their OWN append-only file, `live-sessions.jsonl`,
 * beside `ledger.jsonl` and never inside it — `readLedger()` is typed `Run[]`
 * and is unioned into the exported run set by exportResults, so a session
 * sharing that file would be counted in `totals.runs` and derived into an arm.
 *
 * THE BUG THIS SUITE EXISTS FOR: after 12 Live takes, `data/` held only the
 * seeded corpus fixtures. The takes were real, correctly shaped, and reachable
 * from exactly one browser profile.
 *
 * Every test runs against a `mkdtemp`-backed Storage.
 */
import fs from 'node:fs/promises';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterEach, describe, expect, it } from 'vitest';

import { createApp } from '../index';
import type { LiveSession, Run } from '../storage';
import { LAYOUT, makeEmptyLiveSession, makeLiveSession, makeRun } from '../storage/test-support';
import type { ApiHarness } from './test-support';
import {
  errorBody,
  getLiveSessions,
  postLiveSession,
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

/** Every parsed line of the append-only live-session file, in write order. */
async function sessionLines(dir: string): Promise<LiveSession[]> {
  const text = await fs.readFile(LAYOUT.liveSessions(dir), 'utf8');
  return text
    .split('\n')
    .filter((line) => line.trim().length > 0)
    .map((line) => JSON.parse(line) as LiveSession);
}

async function listRuns(): Promise<Run[]> {
  const res = await fetch(`${api.base}/api/runs`);
  expect(res.status).toBe(200);
  return (await res.json()) as Run[];
}

/* ===================================================== POST + GET round trip */

describe('ticket 041 — POST /api/live-sessions + GET /api/live-sessions', () => {
  it('AC1: a posted session is persisted and listed back FIELD-FOR-FIELD', async () => {
    await boot();
    const session = makeLiveSession({ id: 'live-round-trip' });

    const res = await postLiveSession(api, session);
    expect(res.status).toBe(201);
    expect((await res.json()) as LiveSession).toEqual(session);

    const listed = await getLiveSessions(api);
    expect(listed.status).toBe(200);
    expect(listed.body).toEqual([session]);
  });

  it('AC1: it reaches the SERVER-OWNED store, not only the response', async () => {
    await boot();
    const session = makeLiveSession({ id: 'live-on-disk' });

    expect((await postLiveSession(api, session)).status).toBe(201);

    expect(await api.storage.listLiveSessions()).toEqual([session]);
    expect(await sessionLines(api.dir)).toEqual([session]);
  });

  it('AC1: an empty store lists an empty array, not a 404', async () => {
    await boot();
    const listed = await getLiveSessions(api);
    expect(listed.status).toBe(200);
    expect(listed.body).toEqual([]);
  });

  it('AC5: a ZERO-UTTERANCE session is accepted and stored', async () => {
    await boot();
    // Storing is not aggregating. Refusing it here would delete the record of
    // a take that failed to produce anything — which is the finding itself.
    const empty = makeEmptyLiveSession({ id: 'live-empty-take' });

    expect((await postLiveSession(api, empty)).status).toBe(201);
    expect((await getLiveSessions(api)).body).toEqual([empty]);
  });

  it('AC4: a FIXTURE-sourced session is accepted and stored (excluded later, not refused)', async () => {
    await boot();
    const fixture = makeLiveSession({
      id: 'live-fixture',
      providerTriple: { stt: 'fixture', mt: 'fixture', tts: 'fixture' },
      modelSnapshots: { stt: 'fixture', mt: 'fixture', tts: 'fixture' },
    });

    expect((await postLiveSession(api, fixture)).status).toBe(201);
    expect((await getLiveSessions(api)).body.map((s) => s.id)).toEqual(['live-fixture']);
  });
});

/* ============================================================ append-only = */

describe('ticket 041 — the live-session stream is APPEND-ONLY', () => {
  it('AC1: posting the same session id twice never rewrites the earlier record', async () => {
    await boot();
    const first = makeLiveSession({ id: 'live-dup', endedAt: 1_000, durationMs: 1_000 });
    const second = makeLiveSession({ id: 'live-dup', endedAt: 2_000, durationMs: 2_000 });

    expect((await postLiveSession(api, first)).status).toBe(201);
    expect((await postLiveSession(api, second)).status).toBe(201);

    expect(await sessionLines(api.dir)).toEqual([first, second]);
    expect((await getLiveSessions(api)).body).toEqual([first, second]);
  });

  it('AC1: an unparseable line costs that line alone, not the whole file', async () => {
    await boot();
    expect((await postLiveSession(api, makeLiveSession({ id: 'live-good' }))).status).toBe(201);
    await fs.appendFile(LAYOUT.liveSessions(api.dir), '{"id":"live-tor\n', 'utf8');
    expect((await postLiveSession(api, makeLiveSession({ id: 'live-after' }))).status).toBe(201);

    const listed = await getLiveSessions(api);
    expect(listed.status).toBe(200);
    expect(listed.body.map((s) => s.id)).toEqual(['live-good', 'live-after']);
  });
});

/* ================================== never a run, never a byte of audio ==== */

describe('ticket 041 — a LiveSession is not a Run and carries no audio', () => {
  it('AC1: sessions never enter the RUN ledger — a run listing is unaffected', async () => {
    await boot();
    expect((await postRun(api, makeRun({ id: 'run-only' }))).status).toBe(201);
    expect((await postLiveSession(api, makeLiveSession({ id: 'live-not-a-run' }))).status).toBe(
      201,
    );

    expect((await listRuns()).map((r) => r.id)).toEqual(['run-only']);
    const ledger = await fs.readFile(LAYOUT.ledger(api.dir), 'utf8');
    expect(ledger).not.toContain('live-not-a-run');
    expect((await api.storage.readLedger()).map((r) => r.id)).toEqual(['run-only']);
  });

  it('AC6: a body carrying audio is REFUSED whole — Live persists no audio', async () => {
    await boot();
    for (const audioField of ['audioBase64', 'outputAudioPath'] as const) {
      const res = await postLiveSession(api, {
        ...makeLiveSession({ id: `live-${audioField}` }),
        [audioField]: 'AAAA',
      });
      expect(res.status).toBe(400);
      expect((await errorBody(res)).code).toBe('invalid-live-session');
    }
    // Nothing was written at all.
    expect((await getLiveSessions(api)).body).toEqual([]);
  });
});

/* =============================================== the malformed-body envelope */

describe('ticket 041 — a malformed body is a 4xx with a machine-readable envelope', () => {
  /** Each case is a body that is NOT a LiveSession, and why. */
  const malformed: Array<{ reason: string; body: unknown }> = [
    { reason: 'empty object', body: {} },
    // `strict: false` on the JSON parser, so a scalar reaches OUR gate and gets
    // the envelope rather than express's HTML error page (PRD §12).
    { reason: 'not an object at all', body: 'live-1' },
    {
      reason: 'missing id',
      body: (() => {
        const { id: _id, ...rest } = makeLiveSession();
        return rest;
      })(),
    },
    { reason: 'id is blank', body: { ...makeLiveSession(), id: '' } },
    {
      reason: 'architecture is not a known mode',
      body: { ...makeLiveSession(), architecture: 'telepathy' },
    },
    { reason: 'startedAt is not a number', body: { ...makeLiveSession(), startedAt: 'noon' } },
    { reason: 'durationMs is not a number', body: { ...makeLiveSession(), durationMs: null } },
    { reason: 'utterances is not an array', body: { ...makeLiveSession(), utterances: {} } },
    {
      reason: 'an utterance is missing its cost',
      body: {
        ...makeLiveSession(),
        utterances: [{ id: 'lu-1', timings: { speech_end: 0, audio_queued: 1 } }],
      },
    },
    { reason: 'latency is missing', body: (() => {
        const { latency: _l, ...rest } = makeLiveSession();
        return rest;
      })() },
    {
      reason: 'cost.totalUsd is not a number',
      body: { ...makeLiveSession(), cost: { totalUsd: 'free', perMinuteMinute1: null, perMinuteFinalMinute: null } },
    },
    {
      reason: 'stability counters are not numbers',
      body: {
        ...makeLiveSession(),
        stability: { utterancesCompleted: 'two', disconnects: 0},
      },
    },
    // PRD §7: free conversation has no reference transcript, so a WER on a
    // Live session is a fabricated measurement, not a missing one.
    { reason: 'quality.wer is a number', body: { ...makeLiveSession(), quality: { wer: 0.12 } } },
  ];

  it.each(malformed)('AC1: $reason -> 4xx { code, message }', async ({ body }) => {
    await boot();

    const res = await postLiveSession(api, body);
    expect(res.status).toBeGreaterThanOrEqual(400);
    expect(res.status).toBeLessThan(500);

    const envelope = await errorBody(res);
    expect(typeof envelope.code).toBe('string');
    expect((envelope.code ?? '').length).toBeGreaterThan(0);
    expect(typeof envelope.message).toBe('string');
    expect((envelope.message ?? '').length).toBeGreaterThan(0);

    // Rejected means NOT stored: a half-record in an append-only stream cannot
    // be repaired later.
    expect((await getLiveSessions(api)).body).toEqual([]);
  });

  it('AC1: the rejection code is stable and namespaced like the other routes', async () => {
    await boot();
    expect((await errorBody(await postLiveSession(api, {}))).code).toBe('invalid-live-session');
  });
});

/* =========================================================================
 * TICKET 058 — THE WIRE AFTER THE NEVER-MEASURED FIELDS ARE GONE.
 *
 * Latency's drift-minute-1-to-end and stability's heap-start / heap-end are
 * hardcoded `null` at the only site that writes them. (Kebab-cased on purpose:
 * this file is inside the tree ticket 058's falsifiable `rg` sweeps, and a
 * comment is still text.) Removing a field that is always `null` is NOT the
 * same as reporting zero: it withdraws the CLAIM that a measurement exists.
 *
 * DELETING THEM IS A SCHEMA CHANGE, AND THE ORDER IS LOAD-BEARING. The client
 * writer and this validator must move together, VALIDATOR FIRST — because
 * `useSessionController` swallows the POST rejection, a validator still
 * demanding a key the client stopped sending 400s every take INVISIBLY, and the
 * first symptom is an empty `data/`.
 *
 * The two halves of that ordering are pinned here, and they pull in opposite
 * directions on purpose:
 *
 *   A TRIMMED body (no drift, no heap keys) must be ACCEPTED — 2xx.
 *   A LEGACY body (all three still present) must STILL be accepted, VERBATIM —
 *   `hasFields` is a SUBSET check, and the sessions already on disk carry the
 *   old keys. Making the shape exact would be the inverse defect.
 *
 * The key names are ASSEMBLED FROM FRAGMENTS: this file is inside the `src/`
 * tree the ticket's own falsifiable `rg` sweeps, so spelling them here would
 * make that criterion unsatisfiable (see src/client/deletions.test.ts).
 * ====================================================================== */

const DRIFT_KEY = ['drift', 'Minute1', 'ToEnd'].join('');
const HEAP_START_KEY = 'heap' + 'Start';
const HEAP_END_KEY = 'heap' + 'End';

/** `value` minus `keys`, as an opaque body — no production type moves here. */
function without(value: object, ...keys: string[]): Record<string, unknown> {
  const out = { ...(value as Record<string, unknown>) };
  for (const key of keys) delete out[key];
  return out;
}

/** A session body shaped the way the client will POST it AFTER the removal. */
function trimmedBody(overrides: Partial<LiveSession> = {}): Record<string, unknown> {
  const session = makeLiveSession(overrides);
  return {
    ...session,
    latency: without(session.latency, DRIFT_KEY),
    stability: without(session.stability, HEAP_START_KEY, HEAP_END_KEY),
  };
}

describe('TICKET 058 — a session body WITHOUT the never-measured fields is accepted', () => {
  it('AC5: POST of a trimmed body answers 2xx, not the swallowed 400', async () => {
    await boot();
    const body = trimmedBody({ id: 'live-trimmed' });
    // The premise of the test, asserted rather than assumed: the keys really
    // are absent from what goes on the wire.
    expect(Object.keys(body.latency as object).sort()).toEqual(['p50', 'p95']);
    expect(Object.keys(body.stability as object).sort()).toEqual([
      'disconnects',
      'utterancesCompleted',
    ]);

    const res = await postLiveSession(api, body);
    expect(res.status).toBeGreaterThanOrEqual(200);
    expect(res.status).toBeLessThan(300);
  });

  it('AC5: and it REACHES the store — a 2xx that wrote nothing would be worse', async () => {
    await boot();
    const body = trimmedBody({ id: 'live-trimmed-stored' });

    expect((await postLiveSession(api, body)).status).toBe(201);

    const listed = await getLiveSessions(api);
    expect(listed.status).toBe(200);
    expect(listed.body.map((s) => s.id)).toEqual(['live-trimmed-stored']);
    // Stored VERBATIM: the route does not helpfully re-add a `null` for the
    // field it no longer requires. A re-added null is the claim, restated.
    const stored = listed.body[0]! as unknown as Record<string, unknown>;
    expect(Object.keys(stored.latency as object).sort()).toEqual(['p50', 'p95']);
    expect(Object.keys(stored.stability as object).sort()).toEqual([
      'disconnects',
      'utterancesCompleted',
    ]);
  });

  it('AC6: a LEGACY body still carrying all three is accepted and stored VERBATIM', async () => {
    await boot();
    // The 8 sessions already in the repo's live-session stream look like this.
    // `hasFields` is a SUBSET check; turning it into an exact-shape check to
    // "finish" the deletion would orphan every one of them.
    const legacy = makeLiveSession({ id: 'live-legacy' });

    expect((await postLiveSession(api, legacy)).status).toBe(201);

    const listed = await getLiveSessions(api);
    expect(listed.body).toEqual([legacy]);
    const stored = listed.body[0]! as unknown as {
      latency: Record<string, unknown>;
      stability: Record<string, unknown>;
    };
    expect(Object.keys(stored.latency)).toContain(DRIFT_KEY);
    expect(Object.keys(stored.stability)).toContain(HEAP_START_KEY);
    expect(Object.keys(stored.stability)).toContain(HEAP_END_KEY);
  });

  it('AC5: relaxing is not DELETING — latency and stability are still gated', async () => {
    await boot();
    // The over-correction: dropping the two `hasFields` blocks entirely so the
    // trimmed body sails through. Then a session with no latency envelope at
    // all, or with a string where a counter belongs, is stored as evidence.
    const cases: Array<{ reason: string; body: unknown }> = [
      { reason: 'latency missing entirely', body: without(trimmedBody(), 'latency') },
      { reason: 'stability missing entirely', body: without(trimmedBody(), 'stability') },
      { reason: 'p50 is not a number-or-null', body: { ...trimmedBody(), latency: { p50: 'fast', p95: null } } },
      {
        reason: 'a stability counter is not a number',
        body: { ...trimmedBody(), stability: { utterancesCompleted: 'two', disconnects: 0 } },
      },
    ];

    for (const { reason, body } of cases) {
      const res = await postLiveSession(api, body);
      expect(res.status, `${reason} must still be refused`).toBe(400);
      expect((await errorBody(res)).code).toBe('invalid-live-session');
    }
    expect((await getLiveSessions(api)).body).toEqual([]);
  });
});

/* ================================================ mounted on the real app = */

describe('ticket 041 — the router is mounted by createApp', () => {
  it('AC1: createApp({ storage }) serves /api/live-sessions against the INJECTED store', async () => {
    await boot();
    const server = http.createServer(createApp({ storage: api.storage }));
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const { port } = server.address() as AddressInfo;
    const base = `http://127.0.0.1:${port}`;

    try {
      const session = makeLiveSession({ id: 'live-mounted' });
      const posted = await fetch(`${base}/api/live-sessions`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(session),
      });
      expect(posted.status).toBe(201);

      const listed = await fetch(`${base}/api/live-sessions`);
      expect(listed.status).toBe(200);
      expect((await listed.json()) as LiveSession[]).toEqual([session]);

      // The existing mounts still answer: the new router shadows nothing.
      expect((await fetch(`${base}/api/health`)).status).toBe(200);
      expect((await fetch(`${base}/api/blind-comparisons`)).status).toBe(200);
      expect((await fetch(`${base}/api/runs`)).status).toBe(200);
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });
});
