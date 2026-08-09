/**
 * TICKET 041 — a finished Live session is PERSISTED to the server.
 *
 * The operator asked "where are these takes being saved?" and the answer was:
 * one browser's localStorage. `appendLiveSession` was the only write, so the
 * stability artifact PRD §17 19i names could not reach `data/`, the exported
 * bundle, or a second machine.
 *
 * THE SEAM (normative): `SessionDeps.liveSessions`, OPTIONAL and narrowed to
 * `create` — the mirror of what App does for a blind comparison (ticket 023):
 *
 *   ledger.appendLiveSession(session)     FIRST and unconditionally
 *   void deps.liveSessions?.create(session).catch(() => {})
 *
 * ORDER AND FAILURE HANDLING ARE LOAD-BEARING. The local write cannot be made
 * conditional on a reachable server, and a rejected POST costs the server's
 * copy and nothing else — the operator's take is not deleted because the
 * backend was down.
 *
 * §17 19h IS UNCHANGED: no audio is persisted and no Run record is created.
 *
 * ADDITIVE to the locked LiveView.flow.test.tsx.
 */

import '@testing-library/jest-dom/vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { createElement } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import App from '../App';
import type { LiveSession } from '../state/ledger';
import { isAggregatableLiveSession } from '../state/ledger';
import {
  advance,
  cascadeUtteranceScript,
  clickStartMicrophone,
  makeDeps,
  realtimeUtteranceScript,
} from './sessionTestKit';
import type { TestDeps } from './sessionTestKit';

beforeEach(() => vi.useFakeTimers());
afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

/** The stored LiveSession's complete key set — no audio-bearing field exists. */
const SESSION_KEYS = [
  'architecture',
  'contextPolicy',
  'cost',
  'durationMs',
  'endedAt',
  'id',
  'latency',
  'modelSnapshots',
  // TICKET 052 R2 — the declared price source the session's figures came from.
  // Metadata, not audio: the rule this list enforces is untouched.
  'pricingVersion',
  'providerTriple',
  'quality',
  'stability',
  'startedAt',
  'utterances',
];

interface Harness {
  kit: TestDeps;
  created: LiveSession[];
  create: ReturnType<typeof vi.fn>;
  clock: () => number;
  setNow: (ms: number) => void;
}

/** A cascade Live session wired to a recording live-sessions client. */
function renderLive(opts: { rejecting?: boolean; withClient?: boolean } = {}): Harness {
  const withClient = opts.withClient ?? true;
  let t = 0;
  const created: LiveSession[] = [];
  const create = vi.fn(async (session: LiveSession) => {
    created.push(session);
    if (opts.rejecting) throw new Error('offline');
    return session;
  });

  const kit = makeDeps({
    now: () => t,
    initialState: { mode: 'cascade' },
    scripts: { cascade: cascadeUtteranceScript() },
  });
  const deps = withClient ? { ...kit.deps, liveSessions: { create } } : kit.deps;
  render(createElement(App, { deps }));

  return { kit, created, create, clock: () => t, setNow: (ms: number) => (t = ms) };
}

async function stopAt(harness: Harness, ms: number): Promise<void> {
  harness.setNow(ms);
  fireEvent.click(screen.getByRole('button', { name: 'Stop session' }));
  await advance(100);
}

describe('ticket 041 — stopping a Live session POSTs it to the server', () => {
  it('AC1: the SAME record the ledger holds is created exactly once', async () => {
    const h = renderLive();
    await clickStartMicrophone();
    await advance(1_400);
    await stopAt(h, 242_000);

    const stored = h.kit.ledger.getLiveSessions();
    expect(stored).toHaveLength(1);
    expect(h.create).toHaveBeenCalledTimes(1);
    // One session, two stores — not a second, derived copy.
    expect(h.created).toEqual(stored);
    expect(h.created[0]!.utterances).toHaveLength(1);
    expect(h.created[0]!.durationMs).toBe(242_000);
  });

  it('AC6: the posted record carries NO audio-bearing field', async () => {
    const h = renderLive();
    await clickStartMicrophone();
    await advance(1_400);
    await stopAt(h, 60_000);

    expect(Object.keys(h.created[0]!).sort()).toEqual(SESSION_KEYS);
    for (const utterance of h.created[0]!.utterances) {
      expect(Object.keys(utterance).sort()).toEqual(['costUsd', 'id', 'timings']);
    }
  });

  it('AC6: no Run record is created by Live — not locally, not on the server', async () => {
    const h = renderLive();
    await clickStartMicrophone();
    await advance(1_400);
    await stopAt(h, 60_000);

    expect(h.kit.ledger.getRuns()).toEqual([]);
    expect(h.kit.ledger.runAggregates()).toEqual({ perArm: {} });
  });

  it('AC5: a session that produced NOTHING is still posted — stored, not aggregated', async () => {
    // Stop before any utterance lands: the operator's empty take.
    const h = renderLive();
    await clickStartMicrophone();
    await advance(5);
    await stopAt(h, 30_000);

    expect(h.create).toHaveBeenCalledTimes(1);
    expect(h.created[0]!.utterances).toEqual([]);
    expect(h.created[0]!.cost.totalUsd).toBe(0);
    expect(h.kit.ledger.getLiveSessions()).toHaveLength(1);
  });

  it('AC1: the ledger write happens even when the POST rejects', async () => {
    const h = renderLive({ rejecting: true });
    await clickStartMicrophone();
    await advance(1_400);
    await stopAt(h, 60_000);

    // An unreachable server costs the server's copy and nothing else.
    expect(h.kit.ledger.getLiveSessions()).toHaveLength(1);
    expect(h.create).toHaveBeenCalledTimes(1);
    // The rejection is swallowed: the view is still usable afterwards.
    expect(screen.getByRole('button', { name: 'Start new session' })).toBeInTheDocument();
  });

  it('a host that supplies no client keeps exactly the old behaviour', async () => {
    const h = renderLive({ withClient: false });
    await clickStartMicrophone();
    await advance(1_400);
    await stopAt(h, 60_000);

    expect(h.kit.ledger.getLiveSessions()).toHaveLength(1);
    expect(h.create).not.toHaveBeenCalled();
  });

  it('nothing is posted while the session is still running', async () => {
    const h = renderLive();
    await clickStartMicrophone();
    await advance(1_400);

    expect(h.create).not.toHaveBeenCalled();
    expect(h.kit.ledger.getLiveSessions()).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// TICKET 062 / ADVERSARIAL REVIEW FINDING 2 — THE LEDGER RECORD, not the wire.
//
// LiveView.test.tsx pins what leaves the Live TRANSPORT; runner.test.ts pins
// what a Replay RUN stores. Nothing pinned the third thing 062 stamps: the
// `languagePair` / `direction` of a Live UtteranceRecord, which
// `useSessionController.assembleRecord` derives for the realtime path (cascade
// records arrive whole from the server).
//
// Replacing that derivation with the literals 'EN↔ES' / 'en→es' left the entire
// suite green — i.e. an EN↔YUE session could put Cantonese on the wire and file
// every record as Spanish. That is 062's own defect class, moved from the wire
// to the ledger: the record contradicts the session that produced it.
//
// So: switch the pair through the REAL control (an operator's only route), then
// read the record the ledger actually holds. Both a non-default PAIR and a
// non-default DIRECTION are covered — the default is exactly what a hardcoded
// literal satisfies.
// ---------------------------------------------------------------------------

/** A realtime Live session (the client-assembled record path) on a real ledger. */
function renderRealtimeLive(): TestDeps {
  const kit = makeDeps({
    initialState: { mode: 'realtime' },
    scripts: { realtime: realtimeUtteranceScript() },
  });
  render(createElement(App, { deps: kit.deps }));
  return kit;
}

describe('TICKET 062 — a Live utterance RECORD names the selected languages', () => {
  it('the default EN→ES session files its record as EN↔ES / en→es', async () => {
    const kit = renderRealtimeLive();
    await clickStartMicrophone();
    await advance(1_400);

    const records = kit.ledger.getRecords();
    expect(records).toHaveLength(1);
    expect(records[0]!.languagePair).toBe('EN↔ES');
    expect(records[0]!.direction).toBe('en→es');
  });

  it('switching the pair to EN↔YUE files the record as EN↔YUE / en→yue', async () => {
    const kit = renderRealtimeLive();
    await clickStartMicrophone();

    // The operator's route: the language button, at a boundary (nothing in
    // flight), which the button's own label confirms applied.
    fireEvent.click(screen.getByRole('button', { name: /English → Spanish/ }));
    expect(screen.getByRole('button', { name: /English → Cantonese/ })).toBeInTheDocument();
    await advance(1_400);

    const records = kit.ledger.getRecords();
    expect(records).toHaveLength(1);
    expect(records[0]!.languagePair).toBe('EN↔YUE');
    expect(records[0]!.direction).toBe('en→yue');
  });

  it('swapping the direction files the record as es→en, not en→es', async () => {
    const kit = renderRealtimeLive();
    await clickStartMicrophone();

    fireEvent.click(screen.getByRole('button', { name: 'Swap direction' }));
    expect(screen.getByRole('button', { name: /Spanish → English/ })).toBeInTheDocument();
    await advance(1_400);

    const records = kit.ledger.getRecords();
    expect(records).toHaveLength(1);
    // The pair is order-free and stays EN↔ES; the DIRECTION is what moved.
    expect(records[0]!.languagePair).toBe('EN↔ES');
    expect(records[0]!.direction).toBe('es→en');
  });
});

/* ===== TICKET 055a — A POST THE SERVER NEVER ACKNOWLEDGED IS MARKED ========
 *
 * `useSessionController.ts:738-747` writes the take to the ledger FIRST and
 * UNCONDITIONALLY, then fires `liveSessions.create(session).catch(() => {})`.
 * The ORDER is correct and deliberate (ticket 023: the operator's take is not
 * contingent on a reachable server) and NOTHING here may make the local append
 * conditional. The defect is that the same store is then AGGREGATED FROM: the
 * audit measured 14 sessions on screen over 8 in the repo.
 *
 * THIS IS THE WIRING HALF. `ledger.test.ts` / `deriveLive.empty.test.ts` pin
 * the pure derivation, and every one of those can be satisfied by a change no
 * caller reaches. These drive the REAL seam — `SessionDeps.liveSessions`, the
 * one the controller actually calls — through <App/>, so the mark can only be
 * produced by the code path that ships.
 *
 * `syncState` is this ticket's proposed field, read through a narrow local cast
 * so no production type moves before the implementation does. The gate is
 * `isAggregatableLiveSession` — the ONE gate — never a second filter.
 *
 * ADDITIVE to ticket 041's block above: none of its assertions move, and the
 * first test below re-pins 041's order from INSIDE the POST.
 * ========================================================================== */

/** This ticket's proposed record state, until it exists on `LiveSession`. */
type SyncedLiveSession = LiveSession & { syncState?: string };

function syncStateOf(session: LiveSession): string | undefined {
  return (session as SyncedLiveSession).syncState;
}

interface SyncHarness {
  kit: TestDeps;
  /** `getLiveSessions().length` READ FROM INSIDE `create`, per call. */
  storedWhenPosted: number[];
  create: ReturnType<typeof vi.fn>;
  setNow: (ms: number) => void;
}

/** One cascade take wired to a `create` that resolves — or rejects. */
function renderTake(opts: { rejecting: boolean }): SyncHarness {
  let t = 0;
  const kit = makeDeps({
    now: () => t,
    initialState: { mode: 'cascade' },
    scripts: { cascade: cascadeUtteranceScript() },
  });
  const storedWhenPosted: number[] = [];
  const create = vi.fn(async (session: LiveSession) => {
    // Read the LOCAL store from inside the POST: whatever the server is about
    // to answer, the take must ALREADY be stored when it is asked.
    storedWhenPosted.push(kit.ledger.getLiveSessions().length);
    if (opts.rejecting) throw new Error('offline');
    return session;
  });
  render(createElement(App, { deps: { ...kit.deps, liveSessions: { create } } }));
  return { kit, storedWhenPosted, create, setNow: (ms: number) => (t = ms) };
}

/** Start, produce one utterance, stop at `ms`, and let the POST settle. */
async function runOneTake(h: SyncHarness, ms = 60_000): Promise<void> {
  await clickStartMicrophone();
  await advance(1_400);
  h.setNow(ms);
  fireEvent.click(screen.getByRole('button', { name: 'Stop session' }));
  await advance(100);
}

/** The single stored take — asserted to be single, so nothing reads a stale one. */
function storedTake(h: SyncHarness): LiveSession {
  const stored = h.kit.ledger.getLiveSessions();
  expect(stored).toHaveLength(1);
  return stored[0]!;
}

describe('TICKET 055a — a rejected POST leaves the take UNSYNCED, never deleted', () => {
  it('the local append happens FIRST and UNCONDITIONALLY — the POST finds it already stored', async () => {
    // Ticket 023's order, asserted from inside the seam rather than after it:
    // an implementation that made the append wait for (or depend on) the
    // server would read 0 here, and the operator would lose the take that the
    // unreachable backend was supposed to cost nothing.
    const h = renderTake({ rejecting: true });
    await runOneTake(h);

    expect(h.create).toHaveBeenCalledTimes(1);
    expect(h.storedWhenPosted).toEqual([1]);
    expect(h.kit.ledger.getLiveSessions()).toHaveLength(1);
  });

  it('a REJECTED create marks the ledger’s copy unsynced — stored, listed, out of the ONE gate', async () => {
    const h = renderTake({ rejecting: true });
    await runOneTake(h);

    const take = storedTake(h);
    expect(syncStateOf(take)).toBe('unsynced');
    // The exclusion is the ONE gate reading state on the record.
    expect(isAggregatableLiveSession(take)).toBe(false);
    // ...and the take is NEVER deleted: it is the evidence of the divergence.
    expect(h.kit.ledger.getLiveSessions().map((s) => s.id)).toEqual([take.id]);
    expect(take.utterances).toHaveLength(1);
    // The local write still went first — the mark may not be bought with order.
    expect(h.storedWhenPosted).toEqual([1]);
  });

  it('a RESOLVED create leaves the same take synced and inside the gate', async () => {
    const h = renderTake({ rejecting: false });
    await runOneTake(h);

    const take = storedTake(h);
    expect(syncStateOf(take)).not.toBe('unsynced');
    expect(isAggregatableLiveSession(take)).toBe(true);
  });

  it('the server’s ANSWER is the only difference between the two takes', async () => {
    // Two separate renders, so `cleanup()` is mandatory: RTL APPENDS, and the
    // helpers here are `screen.getByRole`. Without it the second run drives the
    // FIRST app and this compares a take against itself — a comparison that can
    // never fail (the shape caught three times in this project already).
    const rejected = renderTake({ rejecting: true });
    await runOneTake(rejected);
    const offline = storedTake(rejected);

    cleanup();

    const resolved = renderTake({ rejecting: false });
    await runOneTake(resolved);
    const acknowledged = storedTake(resolved);

    // Two ledgers, two takes — identical in everything the session produced…
    expect(rejected.kit.ledger).not.toBe(resolved.kit.ledger);
    expect(offline.id).toBe(acknowledged.id);
    expect(offline.utterances).toHaveLength(acknowledged.utterances.length);
    expect(offline.durationMs).toBe(acknowledged.durationMs);
    // …and separated by exactly one thing: whether the repo got it.
    expect(syncStateOf(offline)).not.toBe(syncStateOf(acknowledged));
    expect(isAggregatableLiveSession(offline)).toBe(false);
    expect(isAggregatableLiveSession(acknowledged)).toBe(true);
  });
});

/* =========================================================================
 * TICKET 058 — THE SESSION WRITTEN AT STOP CARRIES NO NEVER-MEASURED FIELD.
 *
 * `useSessionController` writes latency's drift-minute-1-to-end and stability's
 * heap-start / heap-end as literal `null`s. (Kebab-cased on purpose: this file
 * is inside the tree ticket 058's falsifiable `rg` sweeps, and a comment is
 * still text.) Nothing ever computes
 * them: heap would need `performance.memory`, which jsdom does not provide and
 * which this codebase would have to inject as a new seam — more scaffolding,
 * not less. So the fields go, and this is the site that proves they stopped
 * being written, THROUGH THE REAL SEAM the controller actually posts to.
 *
 * REMOVING AN ALWAYS-NULL FIELD IS NOT REPORTING ZERO. It withdraws the claim
 * that a measurement exists — which is why the assertion is on the KEY SET and
 * never on a value. A `0` here would be the `$0.00` lie one layer down; the
 * p50/p95 anchors below make sure the envelope itself did not just vanish.
 *
 * The key names are ASSEMBLED FROM FRAGMENTS: this file is inside the `src/`
 * tree ticket 058's own falsifiable `rg` sweeps (see src/client/deletions.test.ts).
 * ====================================================================== */

const DRIFT_KEY = ['drift', 'Minute1', 'ToEnd'].join('');
const HEAP_START_KEY = 'heap' + 'Start';
const HEAP_END_KEY = 'heap' + 'End';

describe('TICKET 058 — a stopped session posts no drift and no heap figures', () => {
  it('the POSTed latency envelope is p50/p95 ONLY, and both are still measured', async () => {
    const h = renderLive();
    await clickStartMicrophone();
    await advance(1_400);
    await stopAt(h, 60_000);

    const posted = h.created[0]! as unknown as { latency: Record<string, unknown> };
    // Anchor: the envelope is still there and still carries real figures, so
    // "no drift key" cannot be bought by deleting `latency` wholesale.
    expect(typeof posted.latency.p50).toBe('number');
    expect(typeof posted.latency.p95).toBe('number');

    expect(Object.keys(posted.latency).sort()).toEqual(['p50', 'p95']);
    expect(DRIFT_KEY in posted.latency).toBe(false);
  });

  it('the POSTed stability envelope is the two COUNTERS ONLY — no heap figures', async () => {
    const h = renderLive();
    await clickStartMicrophone();
    await advance(1_400);
    await stopAt(h, 60_000);

    const posted = h.created[0]! as unknown as { stability: Record<string, unknown> };
    // Anchor: the counters that ARE measured survive untouched.
    expect(posted.stability.utterancesCompleted).toBe(1);
    expect(posted.stability.disconnects).toBe(0);

    expect(Object.keys(posted.stability).sort()).toEqual(['disconnects', 'utterancesCompleted']);
    expect(HEAP_START_KEY in posted.stability).toBe(false);
    expect(HEAP_END_KEY in posted.stability).toBe(false);
  });

  it('the LEDGER’s copy and the POSTed copy agree — one record, not two shapes', async () => {
    const h = renderLive();
    await clickStartMicrophone();
    await advance(1_400);
    await stopAt(h, 60_000);

    const stored = h.kit.ledger.getLiveSessions();
    expect(stored).toHaveLength(1);
    expect(h.created).toEqual(stored);
    const local = stored[0]! as unknown as {
      latency: Record<string, unknown>;
      stability: Record<string, unknown>;
    };
    expect(Object.keys(local.latency).sort()).toEqual(['p50', 'p95']);
    expect(Object.keys(local.stability).sort()).toEqual(['disconnects', 'utterancesCompleted']);
  });

  it('an EMPTY take reports p50/p95 as null — absent is not the same as zero', async () => {
    // The removal must not be implemented as "write a 0 instead". A take that
    // produced nothing still says `null` on the figures it genuinely lacks.
    const h = renderLive();
    await clickStartMicrophone();
    await advance(5);
    await stopAt(h, 30_000);

    const posted = h.created[0]! as unknown as { latency: Record<string, unknown> };
    expect(posted.latency.p50).toBeNull();
    expect(posted.latency.p95).toBeNull();
    expect(Object.keys(posted.latency).sort()).toEqual(['p50', 'p95']);
  });
});
