/**
 * TICKET 019 — the hydration seam, unit level (no DOM, no network).
 *
 * QA F2: Replay reads the server over REST; Results reads a disjoint
 * browser-local RunLedger. Two stores, so after a real batch sweep the
 * project's primary deliverable renders "No runs recorded".
 *
 * PRD §8: "One ledger under every view. Every screen reads from a single
 * append-only run ledger… the ledger is the source of truth, so a metric
 * cannot drift between screens or between a screen and the write-up."
 *
 * These tests pin the seam's SIGNATURE and its append-only semantics. Not one
 * of them may touch the network: the source is injected, exactly as
 * ReplayView's clients are.
 */

import { afterEach, describe, expect, it, vi } from 'vitest';
import { ApiError } from '../replay/recordingsClient';
import { hydrateLedger, type LedgerHydrationSource } from './hydrateLedger';
import {
  FIXTURE_RECORDING,
  FIXTURE_RUN,
  RUN_IDS,
  SERVER_RECORDINGS,
  SERVER_RECORDING_IDS,
  SERVER_RUNS,
  staticHydrationSource,
} from './hydrationFixtures';
import { RunLedger, isAggregatableLiveSession, type LiveSession, type Recording, type Run } from './ledger';
import { makeLiveSessionEntity } from '../components/results/testRecords';

afterEach(() => vi.restoreAllMocks());

describe('ticket 019 — hydrateLedger loads the server store into the ledger', () => {
  it('appends every server Recording and Run, in the order the server returned them', async () => {
    const ledger = new RunLedger();
    const { source } = staticHydrationSource();

    await hydrateLedger(ledger, source);

    expect(ledger.getRecordings().map((r) => r.id)).toEqual(
      SERVER_RECORDINGS.map((r) => r.id),
    );
    expect(ledger.getRuns().map((r) => r.id)).toEqual(SERVER_RUNS.map((r) => r.id));
  });

  it('lists runs UNFILTERED — Results aggregates across every Recording', async () => {
    const ledger = new RunLedger();
    const { source, calls } = staticHydrationSource();

    await hydrateLedger(ledger, source);

    expect(calls.recordings).toBe(1);
    expect(calls.runs).toEqual([undefined]);
  });

  it('per-Recording listing still works: getRuns(id) filters the hydrated Runs', async () => {
    const ledger = new RunLedger();
    await hydrateLedger(ledger, staticHydrationSource().source);

    expect(ledger.getRuns(SERVER_RECORDING_IDS.failed).map((r) => r.id)).toEqual([
      RUN_IDS.failed,
    ]);
    expect(ledger.getRuns(SERVER_RECORDING_IDS.adhoc).map((r) => r.id)).toEqual([
      RUN_IDS.adhoc,
    ]);
  });

  it('touches NO network — globalThis.fetch is never called', async () => {
    const fetchSpy = vi.fn();
    vi.stubGlobal('fetch', fetchSpy);
    try {
      await hydrateLedger(new RunLedger(), staticHydrationSource().source);
      expect(fetchSpy).not.toHaveBeenCalled();
    } finally {
      vi.unstubAllGlobals();
    }
  });
});

describe('ticket 019 — hydration ADDS to the ledger, it never replaces it', () => {
  it('leaves locally-appended records, LiveSessions and blind comparisons alone', async () => {
    const ledger = new RunLedger();
    const localSession = makeLiveSessionEntity({ id: 'live-local' });
    ledger.appendLiveSession(localSession);

    await hydrateLedger(ledger, staticHydrationSource().source);

    expect(ledger.getLiveSessions().map((s) => s.id)).toEqual(['live-local']);
    expect(ledger.getRuns().length).toBe(SERVER_RUNS.length);
  });

  it('a locally-appended Run is preserved beside the hydrated ones', async () => {
    const ledger = new RunLedger();
    const local: Run = { ...(SERVER_RUNS[0] as Run), id: 'run-local-1' };
    ledger.appendRun(local);

    await hydrateLedger(ledger, staticHydrationSource().source);

    const ids = ledger.getRuns().map((r) => r.id);
    expect(ids).toContain('run-local-1');
    for (const run of SERVER_RUNS) expect(ids).toContain(run.id);
  });

  it('is idempotent: hydrating twice does not double any entity', async () => {
    const ledger = new RunLedger();
    const { source } = staticHydrationSource();

    await hydrateLedger(ledger, source);
    await hydrateLedger(ledger, source);

    expect(ledger.getRuns().map((r) => r.id)).toEqual(SERVER_RUNS.map((r) => r.id));
    expect(ledger.getRecordings().map((r) => r.id)).toEqual(
      SERVER_RECORDINGS.map((r) => r.id),
    );
  });

  it('does not re-append an entity the ledger already holds under the same id', async () => {
    const ledger = new RunLedger();
    ledger.appendRecording({ ...(SERVER_RECORDINGS[0] as Recording) });
    ledger.appendRun({ ...(SERVER_RUNS[0] as Run) });

    await hydrateLedger(ledger, staticHydrationSource().source);

    expect(ledger.getRecordings().map((r) => r.id)).toEqual(
      SERVER_RECORDINGS.map((r) => r.id),
    );
    expect(ledger.getRuns().map((r) => r.id)).toEqual(SERVER_RUNS.map((r) => r.id));
  });
});

describe('ticket 019 — the gate is unchanged by hydration (it is still the ledger’s)', () => {
  it('only the two sweep/complete/named-arm Runs reach runAggregates', async () => {
    const ledger = new RunLedger();
    await hydrateLedger(
      ledger,
      staticHydrationSource([...SERVER_RECORDINGS, FIXTURE_RECORDING], [
        ...SERVER_RUNS,
        FIXTURE_RUN,
      ]).source,
    );

    const perArm = ledger.runAggregates().perArm;
    expect(Object.keys(perArm).sort()).toEqual(['B', 'C']);
    expect(perArm['B']!.n).toBe(1);
    expect(perArm['C']!.n).toBe(1);

    // ...and every excluded Run is nevertheless STORED and listable.
    const ids = ledger.getRuns().map((r) => r.id);
    expect(ids).toContain(RUN_IDS.failed);
    expect(ids).toContain(RUN_IDS.adhoc);
    expect(ids).toContain(RUN_IDS.fixture);
  });
});

describe('ticket 019 — a failed listing REJECTS (empty is not the same as unreachable)', () => {
  const FAILURES: ReadonlyArray<{ name: string; build: () => LedgerHydrationSource }> = [
    {
      name: 'recordings.list rejects',
      build: () => ({
        recordings: {
          list: () => Promise.reject(new ApiError('http-error', 500, 'HTTP 500')),
        },
        runs: { list: async () => [] },
      }),
    },
    {
      name: 'runs.list rejects',
      build: () => ({
        recordings: { list: async () => [] },
        runs: { list: () => Promise.reject(new ApiError('http-error', 500, 'HTTP 500')) },
      }),
    },
  ];

  it.each(FAILURES)('$name → the returned promise rejects with the ApiError', async ({ build }) => {
    const ledger = new RunLedger();
    await expect(hydrateLedger(ledger, build())).rejects.toBeInstanceOf(ApiError);
  });

  it('a rejection does not leave the ledger half-written with a silent success', async () => {
    const ledger = new RunLedger();
    const source: LedgerHydrationSource = {
      recordings: { list: async () => SERVER_RECORDINGS.map((r) => ({ ...r })) },
      runs: { list: () => Promise.reject(new ApiError('http-error', 500, 'HTTP 500')) },
    };

    await expect(hydrateLedger(ledger, source)).rejects.toBeInstanceOf(ApiError);
    // Whatever the implementation writes, it must not claim it has the Runs.
    expect(ledger.getRuns()).toEqual([]);
  });
});

/* ===== TICKET 055a — A HOST WITH NO LIVE LISTING LEARNS NOTHING ============
 *
 * The pre-041 source shape (recordings + runs, no `liveSessions` key) is a host
 * with NO live-session backend. It carries no statement about which sessions the
 * repo received, so hydrating it may not move a mark in either direction —
 * neither promoting a local take to "the server has it" (which would invent an
 * acknowledgement out of a listing that was never asked for), nor demoting one.
 *
 * AND THE SECOND TEST FENCES THE TICKET'S SCOPE. Runs canNOT diverge —
 * `appendRun` has exactly one caller, `hydrateLedger.ts:131` — so no Run figure
 * may move when unsynced LiveSessions are present. A fix that reached for
 * "anything the server did not acknowledge is out" would take the Runs with it.
 * ========================================================================== */

/** This ticket's proposed record state, until it exists on `LiveSession`. */
type SyncedLiveSession = LiveSession & { syncState?: string };

function syncStateOf(session: LiveSession): string | undefined {
  return (session as SyncedLiveSession).syncState;
}

/** A measured take, optionally marked as one the server never acknowledged. */
function take(id: string, unsynced: boolean): LiveSession {
  const session: SyncedLiveSession = makeLiveSessionEntity({
    id,
    utterances: [{ id: `${id}-u1`, timings: { speech_end: 0, audio_queued: 900 }, costUsd: 0.01 }],
  });
  if (unsynced) session.syncState = 'unsynced';
  return session;
}

describe('TICKET 055a — hydration with no live listing moves no mark', () => {
  it('a source with no `liveSessions` key leaves both marks exactly as they were', async () => {
    const ledger = new RunLedger();
    ledger.appendLiveSession(take('live-acknowledged', false));
    ledger.appendLiveSession(take('live-unsynced', true));

    // The pre-041 source shape: recordings + runs and nothing else.
    await hydrateLedger(ledger, staticHydrationSource().source);

    const [first, second] = ledger.getLiveSessions();
    expect([first?.id, second?.id]).toEqual(['live-acknowledged', 'live-unsynced']);
    expect(syncStateOf(first!)).not.toBe('unsynced');
    expect(isAggregatableLiveSession(first!)).toBe(true);
    expect(syncStateOf(second!)).toBe('unsynced');
    expect(isAggregatableLiveSession(second!)).toBe(false);
  });

  it('and no Run figure moves because unsynced sessions are present', async () => {
    const withUnsynced = new RunLedger();
    withUnsynced.appendLiveSession(take('live-unsynced-1', true));
    withUnsynced.appendLiveSession(take('live-unsynced-2', true));
    const clean = new RunLedger();

    await hydrateLedger(withUnsynced, staticHydrationSource().source);
    await hydrateLedger(clean, staticHydrationSource().source);

    expect(withUnsynced.getRuns().map((r) => r.id)).toEqual(clean.getRuns().map((r) => r.id));
    expect(withUnsynced.runAggregates()).toEqual(clean.runAggregates());
  });
});
