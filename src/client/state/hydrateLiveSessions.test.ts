/**
 * TICKET 041 — hydrateLedger restores the server's LiveSessions.
 *
 * Ticket 019's header said "LIVESESSIONS ARE NOT HYDRATED. They have no server
 * representation." That was true, and it is the defect: PRD §8 wants one ledger
 * under every view, and half of it was per-browser. With the sessions
 * server-owned, hydration must load them like the other two entities — so
 * Results shows Live metrics after a reload, and on another machine.
 *
 * THE SEAM (normative): `LedgerHydrationSource.liveSessions` — OPTIONAL and
 * narrowed to `list`, exactly like the other two. A source that omits it is a
 * host with no live-session backend, and the LiveSession store is left
 * untouched (ticket 019's behaviour, unchanged).
 *
 * The contract hydration already had and must keep: ATOMIC ON FAILURE (all
 * listings awaited before anything is appended) and IDEMPOTENT ON ENTITY ID.
 *
 * ADDITIVE to the locked hydrateLedger.test.ts. No network, ever.
 */

import { afterEach, describe, expect, it, vi } from 'vitest';
import { ApiError } from '../replay/recordingsClient';
import { hydrateLedger, type LedgerHydrationSource } from './hydrateLedger';
import {
  EMPTY_LIVE_SESSION,
  LIVE_SESSION_IDS,
  SERVER_LIVE_SESSIONS,
  SERVER_RECORDINGS,
  SERVER_RUNS,
  staticHydrationSource,
} from './hydrationFixtures';
import { RunLedger, type LiveSession } from './ledger';
import { makeLiveSessionEntity } from '../components/results/testRecords';

afterEach(() => vi.restoreAllMocks());

const ALL_SESSIONS: readonly LiveSession[] = [...SERVER_LIVE_SESSIONS, EMPTY_LIVE_SESSION];

/** A source whose live-session listing rejects; the other two resolve. */
function failingLiveSource(): LedgerHydrationSource {
  return {
    recordings: { list: async () => SERVER_RECORDINGS.map((r) => ({ ...r })) },
    runs: { list: async () => SERVER_RUNS.map((r) => ({ ...r })) },
    liveSessions: { list: () => Promise.reject(new ApiError('http-error', 500, 'HTTP 500')) },
  };
}

describe('ticket 041 — hydrateLedger loads the server’s LiveSessions', () => {
  it('AC2: every server session is appended, in the order the server returned them', async () => {
    const ledger = new RunLedger();
    const { source } = staticHydrationSource(SERVER_RECORDINGS, SERVER_RUNS, ALL_SESSIONS);

    await hydrateLedger(ledger, source);

    expect(ledger.getLiveSessions().map((s) => s.id)).toEqual(ALL_SESSIONS.map((s) => s.id));
    // Field-for-field, not a summarised copy: the stored record IS the artifact.
    expect(ledger.getLiveSessions()).toEqual(ALL_SESSIONS.map((s) => ({ ...s })));
  });

  it('AC2: the listing is UNFILTERED and asked for exactly once', async () => {
    const ledger = new RunLedger();
    const { source, calls } = staticHydrationSource(
      SERVER_RECORDINGS,
      SERVER_RUNS,
      SERVER_LIVE_SESSIONS,
    );

    await hydrateLedger(ledger, source);

    expect(calls.liveSessions).toBe(1);
    expect(calls.recordings).toBe(1);
    expect(calls.runs).toEqual([undefined]);
  });

  it('AC2: Recordings and Runs still hydrate exactly as before', async () => {
    const ledger = new RunLedger();

    await hydrateLedger(
      ledger,
      staticHydrationSource(SERVER_RECORDINGS, SERVER_RUNS, SERVER_LIVE_SESSIONS).source,
    );

    expect(ledger.getRuns().map((r) => r.id)).toEqual(SERVER_RUNS.map((r) => r.id));
    expect(ledger.getRecordings().map((r) => r.id)).toEqual(SERVER_RECORDINGS.map((r) => r.id));
  });

  it('touches NO network — globalThis.fetch is never called', async () => {
    const fetchSpy = vi.fn();
    vi.stubGlobal('fetch', fetchSpy);
    try {
      await hydrateLedger(
        new RunLedger(),
        staticHydrationSource(SERVER_RECORDINGS, SERVER_RUNS, ALL_SESSIONS).source,
      );
      expect(fetchSpy).not.toHaveBeenCalled();
    } finally {
      vi.unstubAllGlobals();
    }
  });
});

describe('ticket 041 — hydration ADDS sessions, it never replaces them', () => {
  it('AC2: a locally-appended session survives beside the hydrated ones', async () => {
    const ledger = new RunLedger();
    // The take this very tab just finished — it must not be dropped.
    ledger.appendLiveSession(makeLiveSessionEntity({ id: 'live-local' }));

    await hydrateLedger(
      ledger,
      staticHydrationSource(SERVER_RECORDINGS, SERVER_RUNS, SERVER_LIVE_SESSIONS).source,
    );

    expect(ledger.getLiveSessions().map((s) => s.id)).toEqual([
      'live-local',
      ...SERVER_LIVE_SESSIONS.map((s) => s.id),
    ]);
  });

  it('AC2: it is idempotent on session id — hydrating twice doubles nothing', async () => {
    const ledger = new RunLedger();
    const { source } = staticHydrationSource(SERVER_RECORDINGS, SERVER_RUNS, ALL_SESSIONS);

    await hydrateLedger(ledger, source);
    await hydrateLedger(ledger, source);

    expect(ledger.getLiveSessions().map((s) => s.id)).toEqual(ALL_SESSIONS.map((s) => s.id));
  });

  it('AC2: a session the ledger already holds under the same id is not re-appended', async () => {
    const ledger = new RunLedger();
    // The same take, written locally at Stop and then POSTed: one record.
    ledger.appendLiveSession({ ...(SERVER_LIVE_SESSIONS[0] as LiveSession) });

    await hydrateLedger(
      ledger,
      staticHydrationSource(SERVER_RECORDINGS, SERVER_RUNS, SERVER_LIVE_SESSIONS).source,
    );

    expect(ledger.getLiveSessions().map((s) => s.id)).toEqual(
      SERVER_LIVE_SESSIONS.map((s) => s.id),
    );
  });

  it('AC5: the ZERO-UTTERANCE session is hydrated and listed — stored, not discarded', async () => {
    const ledger = new RunLedger();

    await hydrateLedger(
      ledger,
      staticHydrationSource(SERVER_RECORDINGS, SERVER_RUNS, ALL_SESSIONS).source,
    );

    const empty = ledger.getLiveSessions().find((s) => s.id === LIVE_SESSION_IDS.empty);
    expect(empty).toBeDefined();
    expect(empty!.utterances).toEqual([]);
    expect(empty!.cost.totalUsd).toBe(0);
  });

  it('AC6: hydration creates no Run records from the sessions', async () => {
    const ledger = new RunLedger();

    await hydrateLedger(ledger, staticHydrationSource([], [], ALL_SESSIONS).source);

    expect(ledger.getRuns()).toEqual([]);
    expect(ledger.runAggregates()).toEqual({ perArm: {} });
  });
});

describe('ticket 041 — a host that wires no live-session listing is unchanged', () => {
  it('AC2: with no `liveSessions` key, the LiveSession store is untouched', async () => {
    const ledger = new RunLedger();
    const local = makeLiveSessionEntity({ id: 'live-local-only' });
    ledger.appendLiveSession(local);

    // The pre-041 source shape: recordings + runs and nothing else.
    await hydrateLedger(ledger, staticHydrationSource().source);

    expect(ledger.getLiveSessions()).toEqual([local]);
    expect(ledger.getRuns().map((r) => r.id)).toEqual(SERVER_RUNS.map((r) => r.id));
  });
});

describe('ticket 041 — the load stays ATOMIC (empty is not the same as unreachable)', () => {
  it('AC2: a rejected liveSessions.list() rejects the whole hydration', async () => {
    await expect(hydrateLedger(new RunLedger(), failingLiveSource())).rejects.toBeInstanceOf(
      ApiError,
    );
  });

  it('AC2: and it leaves the ledger with NO half of the server view', async () => {
    const ledger = new RunLedger();

    await expect(hydrateLedger(ledger, failingLiveSource())).rejects.toBeInstanceOf(ApiError);

    // Recordings appended beside "the Live store did not answer" would read as
    // a real, empty Live history rather than a failed load.
    expect(ledger.getLiveSessions()).toEqual([]);
    expect(ledger.getRuns()).toEqual([]);
    expect(ledger.getRecordings()).toEqual([]);
  });

  it('AC2: a rejected runs.list() still leaves the LiveSession store empty too', async () => {
    const ledger = new RunLedger();
    const source: LedgerHydrationSource = {
      recordings: { list: async () => SERVER_RECORDINGS.map((r) => ({ ...r })) },
      runs: { list: () => Promise.reject(new ApiError('http-error', 500, 'HTTP 500')) },
      liveSessions: { list: async () => SERVER_LIVE_SESSIONS.map((s) => ({ ...s })) },
    };

    await expect(hydrateLedger(ledger, source)).rejects.toBeInstanceOf(ApiError);
    expect(ledger.getLiveSessions()).toEqual([]);
    expect(ledger.getRuns()).toEqual([]);
  });
});
