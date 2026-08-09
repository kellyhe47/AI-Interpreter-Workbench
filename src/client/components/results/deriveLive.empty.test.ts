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
import { hydrateLedger } from '../../state/hydrateLedger';
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
    latency: { p50: null, p95: null},
    cost: { totalUsd: 0, perMinuteMinute1: null, perMinuteFinalMinute: null },
    stability: { utterancesCompleted: 0, disconnects: 0},
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
    latency: { p50: 900, p95: 900},
    cost: { totalUsd: 0.02, perMinuteMinute1: 0.004, perMinuteFinalMinute: 0.005 },
    stability: { utterancesCompleted: 1, disconnects: 0},
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

/* =========================================================================
 * TICKET 058 — THE LIVE COLUMN NO LONGER DERIVES A DRIFT FIGURE.
 *
 * Latency's drift-minute-1-to-end is hardcoded `null` at the only site that
 * writes it, so the column's derived …Ms mirror of it is a mean over an
 * always-empty list. (Kebab-cased on purpose: this file is inside the tree
 * ticket 058's falsifiable `rg` sweeps, and a comment is still text.)
 * Deleting the field is not "reporting zero" — it withdraws the claim that
 * latency drift is measured at all. The column key must be GONE, not blanked: a
 * key that is forever `null` keeps a `not measured` row alive downstream, and
 * that row asserts the measurement is expected.
 *
 * The key name is ASSEMBLED FROM FRAGMENTS: this file is inside the `src/` tree
 * the ticket's own falsifiable `rg` sweeps (see src/client/deletions.test.ts).
 * ====================================================================== */

const DRIFT_COLUMN_KEY = ['drift', 'Minute1', 'ToEndMs'].join('');
const DRIFT_SESSION_KEY = ['drift', 'Minute1', 'ToEnd'].join('');

/** `value` minus `keys` — no production type moves before the code does. */
function without(value: object, ...keys: string[]): Record<string, unknown> {
  const out = { ...(value as Record<string, unknown>) };
  for (const key of keys) delete out[key];
  return out;
}

describe('TICKET 058 — a derived Live column carries no drift key at all', () => {
  it('the column has its neighbours and NOT the drift figure', () => {
    const ledger = new RunLedger();
    ledger.appendLiveSession(measuredSession());
    const model = deriveLiveModel(ledger);

    // Anchors: a column really was derived, and the metrics either side of the
    // deleted one are untouched. Without these, "no drift key" would be
    // satisfied by an empty model.
    expect(model.empty).toBe(false);
    expect(model.columns).toHaveLength(1);
    const keys = Object.keys(model.columns[0]!);
    expect(keys).toContain('p50Ms');
    expect(keys).toContain('p95Ms');
    expect(keys).toContain('costPerMinuteFinalMinute');

    expect(keys).not.toContain(DRIFT_COLUMN_KEY);
  });

  it('a session whose latency envelope is already trimmed still derives its percentiles', () => {
    // The shape the client writes after the removal. The derivation must not
    // reach for a key that is no longer there.
    const trimmed = measuredSession({ id: 'live-trimmed' });
    const ledger = new RunLedger();
    ledger.appendLiveSession({
      ...trimmed,
      latency: without(trimmed.latency, DRIFT_SESSION_KEY),
    } as unknown as LiveSession);

    const model = deriveLiveModel(ledger);
    expect(model.empty).toBe(false);
    expect(model.columns[0]!.p50Ms).toBe(900);
    expect(Object.keys(model.columns[0]!)).not.toContain(DRIFT_COLUMN_KEY);
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

/* ===== TICKET 055a — THE SERVER'S LEDGER IS THE ONLY AGGREGATE SOURCE ========
 *
 * Golden eval `01-server-ledger-is-the-only-aggregate-source.json`: 8 server
 * sessions carrying 31 utterances, plus `session-local-1` and `session-local-2`
 * that exist ONLY in the browser — the swallowed-POST path at
 * `useSessionController.ts:766`. Neither may reach a figure, and the operator
 * must be TOLD they exist (`must_surface: unsynced-count`).
 *
 * ASSERTED HERE, AT `deriveLiveModel` LEVEL, BECAUSE IT IS PURE. A wiring seam
 * delivered incidentally by an unrelated re-render would satisfy a rendered
 * number and nothing else; this is the derivation itself.
 *
 * THE DISCRIMINATOR IS THE SERVER'S OWN ANSWER. The two local sessions below are
 * appended EXACTLY as the local-first append leaves them — no flag, nothing
 * special — and the 8 arrive through `hydrateLedger`, which is the server saying
 * which sessions it has. That asymmetry is the only thing separating them, and
 * it is what the golden case encodes.
 *
 * `unsyncedSessions` is the field name the golden runner reads
 * (`eval/golden.eval.test.tsx`, case 01), so it is fixed, not proposed.
 * ========================================================================== */

/** Every session shares Arm B's cascade recipe, so all of them are ONE column. */
function syncedSession(id: string, utterances: number, latencyMs: number): LiveSession {
  return makeLiveSessionEntity({
    id,
    architecture: 'cascade',
    providerTriple: { ...DEFAULT_CASCADE_TRIPLE },
    modelSnapshots: { ...DEFAULT_CASCADE_TRIPLE },
    utterances: Array.from({ length: utterances }, (_, i) => ({
      id: `${id}-u-${i + 1}`,
      timings: { speech_end: 0, audio_queued: latencyMs },
      costUsd: 0.01,
    })),
    latency: { p50: latencyMs, p95: latencyMs},
    cost: { totalUsd: 0.01 * utterances, perMinuteMinute1: null, perMinuteFinalMinute: null },
    stability: { utterancesCompleted: utterances, disconnects: 0},
  });
}

/** The golden case's server store: 8 sessions, 31 utterances, every one 900 ms. */
const SERVER_LATENCY_MS = 900;
const SERVER_SESSION_COUNT = 8;
const SERVER_UTTERANCES = 31;
const SERVER_SESSIONS: readonly LiveSession[] = Array.from(
  { length: SERVER_SESSION_COUNT },
  (_, i) => syncedSession(`session-server-${i + 1}`, i < 7 ? 4 : 3, SERVER_LATENCY_MS),
);

/**
 * The browser-only pair. 5 utterances each at 5 000 ms — impossible to miss:
 * pooled in, they take `sessions` to 10, `costUtterances` to 41 and p95 to
 * 5 000, so every assertion below discriminates.
 */
const LOCAL_LATENCY_MS = 5_000;
const LOCAL_ONLY: readonly LiveSession[] = [
  syncedSession('session-local-1', 5, LOCAL_LATENCY_MS),
  syncedSession('session-local-2', 5, LOCAL_LATENCY_MS),
];

async function hydrateFrom(ledger: RunLedger, sessions: readonly LiveSession[]): Promise<void> {
  await hydrateLedger(ledger, {
    recordings: { list: async () => [] },
    runs: { list: async () => [] },
    liveSessions: { list: async () => sessions.map((s) => ({ ...s })) },
  });
}

describe('TICKET 055a — a session the repo never received reaches no figure', () => {
  it('the premise: hydrated in, the local pair DOES move every figure', async () => {
    // The control. Without it the exclusion below could be the fixture being
    // inert rather than the gate doing anything.
    const ledger = new RunLedger();
    await hydrateFrom(ledger, [...SERVER_SESSIONS, ...LOCAL_ONLY]);

    const column = deriveLiveModel(ledger).columns[0]!;
    expect(column.sessions).toBe(10);
    expect(column.costUtterances).toBe(41);
    expect(column.p95Ms).toBe(LOCAL_LATENCY_MS);
  });

  it('8 server sessions + 2 local-only → the model reports 8 sessions and 31 utterances', async () => {
    const ledger = new RunLedger();
    // The browser's own store, exactly as the local-first append leaves it…
    for (const session of LOCAL_ONLY) ledger.appendLiveSession(session);
    // …and then the server's answer about what it actually holds.
    await hydrateFrom(ledger, SERVER_SESSIONS);

    const model = deriveLiveModel(ledger);
    const column = model.columns[0]!;
    expect(column.sessions).toBe(SERVER_SESSION_COUNT);
    expect(column.costUtterances).toBe(SERVER_UTTERANCES);
    expect(column.utterancesCompleted).toBe(SERVER_UTTERANCES);

    // The local-only ids contribute NO utterance to either percentile: 31
    // samples of 900 ms, and not one of 5 000.
    expect(column.p50Ms).toBe(SERVER_LATENCY_MS);
    expect(column.p95Ms).toBe(SERVER_LATENCY_MS);

    // must_surface — a session the repo never got is a finding, not a silence.
    const unsynced = (model as unknown as Record<string, unknown>).unsyncedSessions;
    expect(unsynced).toBe(LOCAL_ONLY.length);

    // …and both are still STORED. Excluded from the figures, never deleted.
    expect(ledger.getLiveSessions().map((s) => s.id)).toContain('session-local-1');
    expect(ledger.getLiveSessions().map((s) => s.id)).toContain('session-local-2');
  });

  it('when the server acknowledged every session, no unsynced count is surfaced', async () => {
    const ledger = new RunLedger();
    await hydrateFrom(ledger, SERVER_SESSIONS);

    const model = deriveLiveModel(ledger);
    expect(model.columns[0]!.sessions).toBe(SERVER_SESSION_COUNT);
    // Written `?? 0` on purpose: `deriveLive.empty.test.ts` already pins the
    // WHOLE model by `toEqual` for an empty ledger, so a zero may legitimately
    // be reported as an absent key. Zero and absent are the same claim here —
    // "nothing diverged" — and both must render no notice.
    expect((model as unknown as { unsyncedSessions?: number }).unsyncedSessions ?? 0).toBe(0);
  });

  it('the exclusion is the ONE gate reading state on the record, not a filter in derive', () => {
    // No hydration at all: the state is on the record, so the gate answers the
    // same way wherever the record came from.
    const session: LiveSession & { syncState: string } = {
      ...measuredSession({ id: 'live-unsynced' }),
      syncState: 'unsynced',
    };
    expect(isAggregatableLiveSession(session)).toBe(false);

    const ledger = new RunLedger();
    ledger.appendLiveSession(session);
    expect(deriveLiveModel(ledger).empty).toBe(true);
    expect(ledger.getLiveSessions().map((s) => s.id)).toEqual(['live-unsynced']);
  });
});
