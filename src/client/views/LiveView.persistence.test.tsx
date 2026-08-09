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
