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
import { RunLedger, isAggregatableLiveSession, type LiveSession } from './ledger';
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

/* ===== TICKET 055a — THE LISTING IS THE SERVER'S ACKNOWLEDGEMENT ===========
 *
 * `deriveLive.empty.test.ts`'s 055a block turns on ONE asymmetry: a session the
 * browser appended locally versus a session the server NAMED in its listing.
 * Hydration is where that answer arrives, so hydration is where the mark has to
 * be settled.
 *
 * THE TRAP THIS BLOCK EXISTS FOR: `hydrateLedger.ts:137-142` is ADD-ONLY and
 * NEVER REPLACES — a session already in the store is skipped on id. A stale
 * `localStorage` blob therefore survives every reload untouched, so an
 * implementation that expects re-hydration to overwrite the local copy fixes
 * nothing on the machine that has the problem. The second test below is exactly
 * that case: the server DOES hold the session, the browser's copy says
 * otherwise, and dedupe alone leaves it wrong forever.
 *
 * AND IT CUTS BOTH WAYS (third test). Hydration may not silently UN-mark: a
 * session the listing does not name is still one the repo never received, and
 * "we loaded some sessions" is not an acknowledgement of a different one.
 *
 * `syncState` is this ticket's proposed field, read through a narrow local cast.
 * ========================================================================== */

/** This ticket's proposed record state, until it exists on `LiveSession`. */
type SyncedLiveSession = LiveSession & { syncState?: string };

function syncStateOf(session: LiveSession): string | undefined {
  return (session as SyncedLiveSession).syncState;
}

/** The same record, as the local-first append leaves it when the POST failed. */
function unsyncedCopy(session: LiveSession): LiveSession {
  const copy: SyncedLiveSession = { ...session, syncState: 'unsynced' };
  return copy;
}

/** A measured take that exists ONLY in this browser. */
function localOnlyTake(id: string): LiveSession {
  return unsyncedCopy(
    makeLiveSessionEntity({
      id,
      utterances: [{ id: `${id}-u1`, timings: { speech_end: 0, audio_queued: 900 }, costUsd: 0.01 }],
    }),
  );
}

function serverSource(): LedgerHydrationSource {
  return staticHydrationSource(SERVER_RECORDINGS, SERVER_RUNS, SERVER_LIVE_SESSIONS).source;
}

describe('TICKET 055a — hydration settles the mark, and dedupe alone cannot', () => {
  it('a session hydrated FROM the server is synced and reaches the gate', async () => {
    const ledger = new RunLedger();

    await hydrateLedger(ledger, serverSource());

    const stored = ledger.getLiveSessions();
    expect(stored.map((s) => s.id)).toEqual(SERVER_LIVE_SESSIONS.map((s) => s.id));
    for (const session of stored) {
      expect(syncStateOf(session)).not.toBe('unsynced');
      // Both server fixtures carry a measured utterance, so the gate's OTHER
      // clause cannot be what is answering here.
      expect(isAggregatableLiveSession(session)).toBe(true);
    }
  });

  it('the server’s acknowledgement REACHES a copy the ledger already holds', async () => {
    const ledger = new RunLedger();
    const acknowledged = SERVER_LIVE_SESSIONS[0]!;
    // The POST failed at Stop; the server got this take another way (a retry, a
    // second tab, the export). The browser's copy is stale and add-only dedupe
    // will skip it — which is why re-hydration cannot be the mechanism.
    ledger.appendLiveSession(unsyncedCopy(acknowledged));

    await hydrateLedger(ledger, serverSource());

    const copies = ledger.getLiveSessions().filter((s) => s.id === acknowledged.id);
    // Still ONE record: 041's dedupe is untouched.
    expect(copies).toHaveLength(1);
    expect(syncStateOf(copies[0]!)).not.toBe('unsynced');
    expect(isAggregatableLiveSession(copies[0]!)).toBe(true);
  });

  it('hydration cannot silently UN-mark a session the listing never named', async () => {
    const ledger = new RunLedger();
    ledger.appendLiveSession(localOnlyTake('live-never-posted'));

    await hydrateLedger(ledger, serverSource());

    const local = ledger.getLiveSessions().find((s) => s.id === 'live-never-posted');
    expect(local).toBeDefined();
    expect(syncStateOf(local!)).toBe('unsynced');
    expect(isAggregatableLiveSession(local!)).toBe(false);
    // Stored and listed beside the server's own, exactly as before.
    expect(ledger.getLiveSessions().map((s) => s.id)).toEqual([
      'live-never-posted',
      ...SERVER_LIVE_SESSIONS.map((s) => s.id),
    ]);
  });

  it('hydrating twice re-marks nothing — the second pass changes no state', async () => {
    const ledger = new RunLedger();
    ledger.appendLiveSession(localOnlyTake('live-never-posted'));

    await hydrateLedger(ledger, serverSource());
    const afterFirst = ledger.getLiveSessions().map((s) => [s.id, syncStateOf(s)]);
    await hydrateLedger(ledger, serverSource());

    expect(ledger.getLiveSessions().map((s) => [s.id, syncStateOf(s)])).toEqual(afterFirst);
  });
});
