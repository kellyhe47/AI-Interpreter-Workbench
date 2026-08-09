/**
 * TICKET 041 — a LiveSession that produced NOTHING is stored, never aggregated.
 *
 * THE OBSERVATION: of the operator's 12 sessions, most carry `utterances: []`
 * and `totalUsd: 0` — cascade takes that could never start (ticket 039) and
 * realtime takes stopped before the first turn. Pooling one into a column adds
 * a session to `sessions`, zero latency samples and zero dollars: the card then
 * reports more sessions behind the same figures, which reads as evidence. That
 * is the "a zero reads as a measurement" trap AGENTS.md names.
 *
 * THE DECISION PINNED HERE: STORE IT, NEVER AGGREGATE IT — exactly how a failed
 * Run is treated (§17 22d, ticket 027). The gate is a named export beside its
 * two siblings so the three read as ONE rule with three shapes:
 *
 *   isAggregatableRun(run)                    — ticket 010
 *   isAggregatableUtterance(run, utterance?)  — ticket 032
 *   isAggregatableLiveSession(session)        — THIS
 *
 *   isAggregatableLiveSession = isRealLiveSession(session)
 *                               AND session.utterances.length > 0
 *
 * ADDITIVE to the locked derive.test.ts and deriveLive.fixture.test.ts: every
 * session that produced a column there has utterances, so no figure moves.
 */

import { describe, expect, it } from 'vitest';
import { DEFAULT_CASCADE_TRIPLE, REALTIME_MODEL } from '../../../core/arms';
import {
  RunLedger,
  isAggregatableLiveSession,
  isAggregatableRun,
  isRealLiveSession,
  type LiveSession,
} from '../../state/ledger';
import { deriveLiveModel } from './derive';
import { makeLiveSessionEntity, seedLiveSessions } from './testRecords';

const FIXTURE_TRIPLE = { stt: 'fixture', mt: 'fixture', tts: 'fixture' };

/** The operator's take: connected, stopped, produced nothing. */
function emptySession(overrides: Partial<LiveSession> = {}): LiveSession {
  return makeLiveSessionEntity({
    id: 'live-empty',
    architecture: 'cascade',
    providerTriple: { ...DEFAULT_CASCADE_TRIPLE },
    modelSnapshots: { ...DEFAULT_CASCADE_TRIPLE },
    utterances: [],
    latency: { p50: null, p95: null, driftMinute1ToEnd: null },
    cost: { totalUsd: 0, perMinuteMinute1: null, perMinuteFinalMinute: null },
    stability: { utterancesCompleted: 0, disconnects: 0, heapStart: null, heapEnd: null },
    ...overrides,
  });
}

/** A real take with one measured utterance. */
function measuredSession(overrides: Partial<LiveSession> = {}): LiveSession {
  return makeLiveSessionEntity({
    id: 'live-measured',
    architecture: 'cascade',
    providerTriple: { ...DEFAULT_CASCADE_TRIPLE },
    modelSnapshots: { ...DEFAULT_CASCADE_TRIPLE },
    utterances: [{ id: 'lu-1', timings: { speech_end: 0, audio_queued: 900 }, costUsd: 0.02 }],
    latency: { p50: 900, p95: 900, driftMinute1ToEnd: 30 },
    cost: { totalUsd: 0.02, perMinuteMinute1: 0.004, perMinuteFinalMinute: 0.005 },
    stability: { utterancesCompleted: 1, disconnects: 0, heapStart: null, heapEnd: null },
    ...overrides,
  });
}

describe('ticket 041 — isAggregatableLiveSession, the third sibling of the gate', () => {
  it('is a named export beside isAggregatableRun, so the rules are visibly one concept', () => {
    expect(typeof isAggregatableLiveSession).toBe('function');
    expect(typeof isAggregatableRun).toBe('function');
  });

  const CASES: ReadonlyArray<{ name: string; session: LiveSession; aggregatable: boolean }> = [
    { name: 'a real session with one utterance', session: measuredSession(), aggregatable: true },
    { name: 'a real session with no utterances', session: emptySession(), aggregatable: false },
    {
      name: 'a fixture session WITH utterances',
      session: measuredSession({
        providerTriple: { ...FIXTURE_TRIPLE },
        modelSnapshots: { ...FIXTURE_TRIPLE },
      }),
      aggregatable: false,
    },
    {
      name: 'a fixture session with no utterances (both clauses fail)',
      session: emptySession({
        providerTriple: { ...FIXTURE_TRIPLE },
        modelSnapshots: { ...FIXTURE_TRIPLE },
      }),
      aggregatable: false,
    },
    {
      name: 'a realtime session with one utterance',
      session: measuredSession({
        architecture: 'realtime',
        providerTriple: undefined,
        modelSnapshots: { realtime: REALTIME_MODEL },
      }),
      aggregatable: true,
    },
  ];

  it.each(CASES)('$name → aggregatable: $aggregatable', ({ session, aggregatable }) => {
    expect(isAggregatableLiveSession(session)).toBe(aggregatable);
  });

  it('an EMPTY session is nevertheless REAL — the two rules answer different questions', () => {
    // "Not a fixture" and "produced a measurement" are separate claims; folding
    // the second into isRealLiveSession would change ticket 018's rule.
    expect(isRealLiveSession(emptySession())).toBe(true);
    expect(isAggregatableLiveSession(emptySession())).toBe(false);
  });
});

describe('ticket 041 — deriveLiveModel refuses a session that produced nothing', () => {
  it('a ledger holding only empty sessions derives the EXPLICIT empty state', () => {
    const ledger = new RunLedger();
    ledger.appendLiveSession(emptySession({ id: 'live-empty-1' }));
    ledger.appendLiveSession(
      emptySession({
        id: 'live-empty-2',
        architecture: 'realtime',
        providerTriple: undefined,
        modelSnapshots: { realtime: REALTIME_MODEL },
      }),
    );

    // Byte-for-byte the model an untouched ledger derives — not a column of
    // zeros, and not "2 sessions" behind no numbers.
    // TICKET 064 — `sessionsWithoutContextPolicy` is 0, not 2: these sessions
    // DO declare a policy and are refused by the ONE aggregation gate for
    // producing nothing. The policy axis must not become a second way in, nor a
    // second reason to report an exclusion.
    expect(deriveLiveModel(ledger)).toEqual({
      columns: [],
      empty: true,
      sessionsWithoutContextPolicy: 0,
    });
    expect(deriveLiveModel(ledger)).toEqual(deriveLiveModel(new RunLedger()));
  });

  /**
   * TICKET 064 — the case that makes the comment above load-bearing.
   *
   * Both sessions in the previous test declare a policy (`makeLiveSessionEntity`
   * auto-assigns one from the architecture), so `sessionsWithoutContextPolicy`
   * is 0 whichever order `deriveLiveModel` applies its two refusals in. Only a
   * session that produced nothing AND declares no policy separates them: read
   * policy-first, this one is disclosed as "1 session excluded: no context
   * policy recorded", when it was really refused by the ONE aggregation gate
   * for producing nothing. `isAggregatableLiveSession` stays the only gate;
   * the policy axis is not a second one, nor a second reason to report.
   */
  it('a session that produced nothing AND declares no policy is refused by the GATE, not the policy check', () => {
    const ledger = new RunLedger();
    ledger.appendLiveSession(
      // Honoured rather than auto-filled: the helper only assigns when the key
      // is absent from overrides, so this is a genuine pre-012 session.
      emptySession({ id: 'live-empty-pre-012', contextPolicy: undefined }),
    );

    expect(deriveLiveModel(ledger)).toEqual({
      columns: [],
      empty: true,
      sessionsWithoutContextPolicy: 0,
    });
    expect(deriveLiveModel(ledger)).toEqual(deriveLiveModel(new RunLedger()));
  });

  it('an empty session cannot move the figures of a real session sharing its arm', () => {
    const ledger = new RunLedger();
    ledger.appendLiveSession(measuredSession());
    const before = deriveLiveModel(ledger);

    ledger.appendLiveSession(emptySession());

    const after = deriveLiveModel(ledger);
    expect(after).toEqual(before);
    // Most visibly: the session COUNT does not climb.
    expect(after.columns[0]!.sessions).toBe(1);
    expect(after.columns[0]!.utterancesCompleted).toBe(1);
  });

  it('it is still STORED — excluded from the model, never deleted', () => {
    const ledger = new RunLedger();
    ledger.appendLiveSession(emptySession());

    expect(ledger.getLiveSessions().map((s) => s.id)).toEqual(['live-empty']);
    expect(deriveLiveModel(ledger).empty).toBe(true);
  });

  it('REGRESSION: the seeded real sessions still derive both arm columns', () => {
    const ledger = new RunLedger();
    seedLiveSessions(ledger);
    const model = deriveLiveModel(ledger);

    expect(model.empty).toBe(false);
    expect(model.columns.map((c) => c.arm).sort()).toEqual(['A', 'B']);
    expect(model.columns.find((c) => c.arm === 'A')!.p50Ms).toBe(1100);
    expect(model.columns.find((c) => c.arm === 'B')!.p50Ms).toBe(700);
  });
});
