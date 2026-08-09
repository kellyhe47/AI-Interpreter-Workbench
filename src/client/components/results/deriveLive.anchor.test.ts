/**
 * TICKET 051 ROUND 2 (R2-2) — the anchor fix must not stop at LiveView.
 *
 * `deriveLiveModel` reads `u.timings?.speech_end`, which Live NEVER has (option
 * (c) deliberately never stamps it). So `samples` was always empty and the
 * column fell through to `meanOf(sessions.map(s => s.latency.p50))` — a MEAN OF
 * PER-SESSION p50s, which is not a percentile of anything. Before this ticket
 * that path produced `null` and the card was blank, so nothing showed. Now
 * `saveLiveSession` writes real numbers, and Results begins publishing an
 * endpointer-anchored figure, computed by the wrong statistic, immediately
 * beside Replay's corpus-anchored p50 — the exact confusion this ticket exists
 * to prevent, one file over.
 *
 * Both directions were vacuous against the round-1 code: forcing the fallback
 * left the suite green, and switching to the anchored rule ALSO left it green.
 * These fixtures make the two answers differ by construction:
 *
 *   session 1 utterances  1000 / 1200 / 5000     (its own reported p50: 1200)
 *   session 2 utterance   1100                   (its own reported p50: 1100)
 *   POOLED nearest-rank   p50 1100 · p95 5000
 *   mean of the p50s      1150                   <- the wrong statistic
 *
 * The same rule as everywhere else in 051: the sample runs from the detected
 * end of speech to the FIRST audio.
 */

import { describe, expect, it } from 'vitest';
import { REALTIME_MODEL } from '../../../core/arms';
import { RunLedger } from '../../state/ledger';
import { deriveLiveModel } from './derive';
import {
  ARM_B_TRIPLE,
  LIVE_A_COST,
  LIVE_A_DEFAULT_ONLY_P50_MS,
  LIVE_A_POOLED_P50_MS,
  LIVE_A_TRIMMED_COST,
  LIVE_A_TRIMMED_P50_MS,
  LIVE_A_TRIMMED_P95_MS,
  makeLiveSessionEntity,
  seedLiveSessions,
  seedTrimmedLiveSession,
} from './testRecords';

type Marks = Record<string, number | null>;

function utterance(id: string, timings: Marks) {
  return { id, timings, costUsd: 0.01 };
}

/** Arm A marks: the endpointer's decision, then the first audio. */
function realtimeMarks(latencyMs: number): Marks {
  return { server_speech_stopped: 500, audio_queued: 500 + latencyMs };
}

/**
 * Arm B marks. `audio_queued` trails `tts_first_byte` by 2 600 ms — that tail
 * is playout of a long sentence, and pooling it against Arm A's
 * time-to-first-audio is what makes cascade look several times slower.
 */
function cascadeMarks(latencyMs: number): Marks {
  return {
    vad_fired: 500,
    stt_final: 700,
    mt_first_token: 900,
    tts_first_byte: 500 + latencyMs,
    audio_queued: 500 + latencyMs + 2_600,
  };
}

function realtimeSession(id: string, latencies: number[], reported: { p50: number; p95: number }) {
  return makeLiveSessionEntity({
    id,
    architecture: 'realtime',
    providerTriple: undefined,
    modelSnapshots: { realtime: REALTIME_MODEL },
    utterances: latencies.map((ms, i) => utterance(`${id}-u${i + 1}`, realtimeMarks(ms))),
    latency: { p50: reported.p50, p95: reported.p95, driftMinute1ToEnd: null },
    stability: {
      utterancesCompleted: latencies.length,
      disconnects: 0,
      heapStart: null,
      heapEnd: null,
    },
  });
}

function cascadeSession(id: string, latencies: number[], reported: { p50: number; p95: number }) {
  return makeLiveSessionEntity({
    id,
    architecture: 'cascade',
    providerTriple: { ...ARM_B_TRIPLE },
    modelSnapshots: { ...ARM_B_TRIPLE },
    utterances: latencies.map((ms, i) => utterance(`${id}-u${i + 1}`, cascadeMarks(ms))),
    latency: { p50: reported.p50, p95: reported.p95, driftMinute1ToEnd: null },
    stability: {
      utterancesCompleted: latencies.length,
      disconnects: 0,
      heapStart: null,
      heapEnd: null,
    },
  });
}

function columnFor(ledger: RunLedger, arm: 'A' | 'B') {
  const model = deriveLiveModel(ledger);
  const column = model.columns.find((c) => c.arm === arm);
  expect(column, `expected a column for arm ${arm}`).toBeDefined();
  return column!;
}

describe('deriveLiveModel — the statistic', () => {
  it('pools the utterances of every session and takes a nearest-rank percentile', () => {
    const ledger = new RunLedger();
    ledger.appendLiveSession(realtimeSession('live-a1', [1_000, 1_200, 5_000], { p50: 1_200, p95: 5_000 }));
    ledger.appendLiveSession(realtimeSession('live-a2', [1_100], { p50: 1_100, p95: 1_100 }));

    const a = columnFor(ledger, 'A');
    expect(a.sessions).toBe(2);
    // nearest rank over [1000, 1100, 1200, 5000].
    expect(a.p50Ms).toBe(1_100);
    expect(a.p95Ms).toBe(5_000);
    // The mean of the two sessions' own p50s. A session-weighted average lets
    // a one-utterance take count as much as a fifty-utterance one.
    expect(a.p50Ms).not.toBe(1_150);
  });

  it('reads the SAME anchor the rest of the ticket does — detected end of speech', () => {
    const ledger = new RunLedger();
    // The reported p50 is deliberately a number the utterances cannot produce,
    // so a column that still answers 9999 is reading the wrong field.
    ledger.appendLiveSession(realtimeSession('live-a1', [1_240], { p50: 9_999, p95: 9_999 }));

    expect(columnFor(ledger, 'A').p50Ms).toBe(1_240);
  });

  it('ends the cascade sample at the FIRST audio, so the two arms are comparable', () => {
    const ledger = new RunLedger();
    ledger.appendLiveSession(realtimeSession('live-a1', [1_240], { p50: 1_240, p95: 1_240 }));
    ledger.appendLiveSession(cascadeSession('live-b1', [1_240], { p50: 3_840, p95: 3_840 }));

    // Identical time-to-first-audio must read as identical latency.
    expect(columnFor(ledger, 'A').p50Ms).toBe(1_240);
    expect(columnFor(ledger, 'B').p50Ms).toBe(1_240);
    // audio_queued − vad_fired would be 3840 for the cascade column: mostly
    // playout duration of a longer utterance.
    expect(columnFor(ledger, 'B').p50Ms).not.toBe(3_840);
  });

  it('refuses to average per-session p50s when no utterance carries usable marks', () => {
    const ledger = new RunLedger();
    ledger.appendLiveSession(
      makeLiveSessionEntity({
        id: 'live-unmeasurable',
        utterances: [utterance('u-1', {}), utterance('u-2', { audio_queued: 900 })],
        latency: { p50: 900, p95: 900, driftMinute1ToEnd: null },
        stability: { utterancesCompleted: 2, disconnects: 0, heapStart: null, heapEnd: null },
      }),
    );

    const b = columnFor(ledger, 'B');
    // A session's self-reported summary is not a measurement of the utterances
    // it carries, and a percentile computed from no samples is not a figure.
    expect(b.p50Ms).toBeNull();
    expect(b.p95Ms).toBeNull();
    // The session is still counted — it happened.
    expect(b.sessions).toBe(1);
    expect(b.utterancesCompleted).toBe(2);
  });

  it('GUARD: a corpus-anchored session (speech_end present) still answers from speech_end', () => {
    const ledger = new RunLedger();
    ledger.appendLiveSession(
      makeLiveSessionEntity({
        id: 'live-corpus',
        utterances: [
          utterance('u-1', { speech_end: 0, vad_fired: 500, audio_queued: 1_053 }),
        ],
        latency: { p50: 1_053, p95: 1_053, driftMinute1ToEnd: null },
        stability: { utterancesCompleted: 1, disconnects: 0, heapStart: null, heapEnd: null },
      }),
    );

    expect(columnFor(ledger, 'B').p50Ms).toBe(1_053);
  });
});

/* ======================================================= TICKET 064 — policy */

/**
 * TICKET 064 — THE COLUMN IS A PAIR, NOT AN ARM.
 *
 * `deriveLiveModel` grouped on `liveArmTag(session)` alone and never read
 * `contextPolicy` — the string did not appear in derive.ts at all. The two
 * trimmed sessions on disk are `architecture: realtime` with
 * `modelSnapshots.realtime = 'gpt-realtime'`, so they derive arm A, and every
 * one of their utterances carries `server_speech_stopped` + `audio_queued`, so
 * every one produces a latency sample. They were therefore not MISSING from the
 * card: they were SILENTLY POOLED INTO `realtime · default`, whose p50 was
 * really "realtime, all policies". That is a WRONG NUMBER, not a blank one, and
 * it is the number §7's controllability claim rests on.
 *
 * The dominant assertion in this block is the DEFAULT column's p50, not the
 * trimmed one's: a test that only checks that `realtime · trimmed` stopped
 * showing '—' is satisfied by a fix that leaves the contamination in place.
 *
 * The fixture numbers are hand-derived in `testRecords.ts` beside
 * `LIVE_A_TRIMMED_LATENCIES`; nearest rank, sorted[⌈p·n⌉−1]:
 *
 *   default only  [1000, 1100, 1200]              -> p50 1100
 *   trimmed only  [4000, 4100]                    -> p50 4000
 *   POOLED        [1000, 1100, 1200, 4000, 4100]  -> p50 1200
 */

/**
 * `contextPolicy` is not on `LiveArmColumn` yet. Read it narrowly HERE rather
 * than widening the production type to make a red test compile.
 */
function policyOf(column: unknown): string | undefined {
  return (column as { contextPolicy?: string }).contextPolicy;
}

/** Arm A · default (3 utterances) + arm B · n/a, plus arm A · trimmed (2). */
function policyLedger(): RunLedger {
  const ledger = new RunLedger();
  seedLiveSessions(ledger);
  seedTrimmedLiveSession(ledger);
  return ledger;
}

/** A pre-012 session: real, measured, arm A — and declaring NO policy at all. */
function prePolicySession() {
  return makeLiveSessionEntity({
    id: 'live-pre-012',
    architecture: 'realtime',
    providerTriple: undefined,
    // The field is optional on LiveSession precisely so these still parse.
    contextPolicy: undefined,
    modelSnapshots: { realtime: REALTIME_MODEL },
    utterances: [9_000, 9_100].map((ms, i) => utterance(`lu-pre-${i + 1}`, realtimeMarks(ms))),
    latency: { p50: 9_000, p95: 9_100, driftMinute1ToEnd: 700 },
    cost: { totalUsd: 2, perMinuteMinute1: 0.9, perMinuteFinalMinute: 0.9 },
    stability: { utterancesCompleted: 2, disconnects: 0, heapStart: null, heapEnd: null },
  });
}

describe('deriveLiveModel — the context-policy axis (TICKET 064)', () => {
  it('groups by the PAIR (arm, contextPolicy): two policies on one arm are two columns', () => {
    const model = deriveLiveModel(policyLedger());

    const armA = model.columns.filter((c) => c.arm === 'A');
    expect(armA).toHaveLength(2);
    // Both are arm A. The column identity therefore CANNOT be the arm, and no
    // `column.arm as ArmTag` coercion in the view can recover this distinction
    // — a coerced arm finds one of the two and shows it under both labels.
    expect(armA.map(policyOf).sort()).toEqual(['default', 'trimmed']);
  });

  it('DOMINANT — realtime · default is computed from DEFAULT-policy samples only', () => {
    const model = deriveLiveModel(policyLedger());
    const dflt = model.columns.find((c) => c.arm === 'A' && policyOf(c) === 'default');
    expect(dflt, 'expected a realtime · default column').toBeDefined();

    // Hand-derived from [1000, 1100, 1200] alone.
    expect(dflt!.p50Ms).toBe(LIVE_A_DEFAULT_ONLY_P50_MS);
    // ...and NOT the figure the pool produces. This is the defect: the number
    // was wrong, not missing.
    expect(dflt!.p50Ms).not.toBe(LIVE_A_POOLED_P50_MS);
    // The trimmed session's turns are not counted here either.
    expect(dflt!.sessions).toBe(1);
    expect(dflt!.utterancesCompleted).toBe(3);
    expect(dflt!.disconnects).toBe(1);
  });

  it('realtime · trimmed is a real column carrying its own p50 / p95 / turns / disconnects', () => {
    const model = deriveLiveModel(policyLedger());
    const trimmed = model.columns.find((c) => c.arm === 'A' && policyOf(c) === 'trimmed');
    expect(trimmed, 'expected a realtime · trimmed column').toBeDefined();

    // Hand-derived from [4000, 4100]: n=2, ⌈0.5·2⌉−1 = 0 and ⌈0.95·2⌉−1 = 1.
    expect(trimmed!.p50Ms).toBe(LIVE_A_TRIMMED_P50_MS);
    expect(trimmed!.p95Ms).toBe(LIVE_A_TRIMMED_P95_MS);
    expect(trimmed!.sessions).toBe(1);
    expect(trimmed!.utterancesCompleted).toBe(2);
    expect(trimmed!.disconnects).toBe(2);
  });

  it('the COST SLOPES split with the pair too — they are not read from a pooled column', () => {
    const model = deriveLiveModel(policyLedger());
    const dflt = model.columns.find((c) => c.arm === 'A' && policyOf(c) === 'default');
    const trimmed = model.columns.find((c) => c.arm === 'A' && policyOf(c) === 'trimmed');
    expect(dflt, 'expected a realtime · default column').toBeDefined();
    expect(trimmed, 'expected a realtime · trimmed column').toBeDefined();

    expect(dflt!.costPerMinuteMinute1).toBe(LIVE_A_COST.perMinuteMinute1);
    expect(dflt!.costPerMinuteFinalMinute).toBe(LIVE_A_COST.perMinuteFinalMinute);
    expect(trimmed!.costPerMinuteMinute1).toBe(LIVE_A_TRIMMED_COST.perMinuteMinute1);
    expect(trimmed!.costPerMinuteFinalMinute).toBe(LIVE_A_TRIMMED_COST.perMinuteFinalMinute);

    // Pooled, the slope rows are the MEAN of the two policies — 0.31 / 0.55.
    // The slope IS the finding for Arm A, so this is the row that carries it.
    expect(dflt!.costPerMinuteMinute1).not.toBeCloseTo(0.31, 6);
    expect(dflt!.costPerMinuteFinalMinute).not.toBeCloseTo(0.55, 6);
  });

  it("'n/a' does not fragment cascade — arm B keeps exactly ONE column", () => {
    const ledger = policyLedger();
    // A second cascade take. 'n/a' says "this arm has no policy axis", so it
    // joins the existing cascade column rather than opening a `cascade · n/a`.
    ledger.appendLiveSession(
      makeLiveSessionEntity({
        id: 'live-arm-b2',
        architecture: 'cascade',
        providerTriple: { ...ARM_B_TRIPLE },
        contextPolicy: 'n/a',
        modelSnapshots: { ...ARM_B_TRIPLE },
        utterances: [utterance('lu-b2-1', cascadeMarks(700))],
        latency: { p50: 700, p95: 700, driftMinute1ToEnd: null },
        stability: { utterancesCompleted: 1, disconnects: 0, heapStart: null, heapEnd: null },
      }),
    );

    const model = deriveLiveModel(ledger);
    expect(model.columns.filter((c) => c.arm === 'B')).toHaveLength(1);
    expect(model.columns.find((c) => c.arm === 'B')!.sessions).toBe(2);
    // Three columns in total: A·default, A·trimmed, B. Never a fourth.
    expect(model.columns).toHaveLength(3);
  });

  it('a session declaring NO policy opens no column and is counted in NEITHER', () => {
    const ledger = new RunLedger();
    seedLiveSessions(ledger);
    ledger.appendLiveSession(prePolicySession());

    const model = deriveLiveModel(ledger);
    const armA = model.columns.filter((c) => c.arm === 'A');
    expect(armA).toHaveLength(1);
    expect(policyOf(armA[0])).toBe('default');
    // `undefined` is an EXCLUSION, not a synonym for 'default'. Folded in, the
    // pool [1000, 1100, 1200, 9000, 9100] would answer 1200 and the session
    // would add 2 to the turn count.
    expect(armA[0]!.p50Ms).toBe(LIVE_A_DEFAULT_ONLY_P50_MS);
    expect(armA[0]!.sessions).toBe(1);
    expect(armA[0]!.utterancesCompleted).toBe(3);
    // ...and it opens no column of its own either.
    expect(model.columns.every((c) => policyOf(c) !== undefined)).toBe(true);
    expect(model.columns).toHaveLength(2);
  });

  it('a ledger of nothing but policy-less sessions derives no column at all', () => {
    const ledger = new RunLedger();
    ledger.appendLiveSession(prePolicySession());

    const model = deriveLiveModel(ledger);
    expect(model.columns).toHaveLength(0);
    expect(model.empty).toBe(true);
  });
});

/* ========================================== TICKET 064 — ADVERSARIAL REVIEW */

/**
 * FINDING 3 — `sessionsWithoutContextPolicy` WAS NEVER ASSERTED ON ITS NONZERO
 * PATH.
 *
 * The tests above pin that a policy-less session opens no column and joins none.
 * NOTHING pinned the number the card then prints. Replacing the count with a
 * constant (`count > 0 ? 99 : 0`) left the whole suite green, and the card
 * published "99 sessions excluded from every column" — a fabricated count, on
 * the one line whose entire job is to size the hole in the evidence, in the
 * ticket whose thesis is that a wrong number is worse than a missing one.
 *
 * The count is a MEASUREMENT of the ledger, so it is asserted the way every
 * other measurement here is: against hand-counted ledgers whose answers differ.
 */

/** A pre-012 session under a caller-chosen id, so a ledger can hold several. */
function prePolicySessionNamed(id: string) {
  return makeLiveSessionEntity({
    id,
    architecture: 'realtime',
    providerTriple: undefined,
    contextPolicy: undefined,
    modelSnapshots: { realtime: REALTIME_MODEL },
    utterances: [utterance(`${id}-u1`, realtimeMarks(8_000))],
    latency: { p50: 8_000, p95: 8_000, driftMinute1ToEnd: null },
    stability: { utterancesCompleted: 1, disconnects: 0, heapStart: null, heapEnd: null },
  });
}

describe('deriveLiveModel — the exclusion COUNT is derived, not a flag (TICKET 064)', () => {
  it('DOMINANT — one policy-less session among real ones counts exactly 1', () => {
    const ledger = new RunLedger();
    seedLiveSessions(ledger);
    ledger.appendLiveSession(prePolicySession());

    // The card prints this number verbatim. Any constant on the nonzero path
    // publishes a count nobody measured.
    expect(deriveLiveModel(ledger).sessionsWithoutContextPolicy).toBe(1);
  });

  it('counts each excluded session — two of them read 2, not "some"', () => {
    const ledger = new RunLedger();
    seedLiveSessions(ledger);
    ledger.appendLiveSession(prePolicySession());
    ledger.appendLiveSession(prePolicySessionNamed('live-pre-012-b'));

    const model = deriveLiveModel(ledger);
    expect(model.sessionsWithoutContextPolicy).toBe(2);
    // ...and the columns are untouched by either of them.
    expect(model.columns.filter((c) => c.arm === 'A')).toHaveLength(1);
    expect(model.columns.find((c) => c.arm === 'A')!.utterancesCompleted).toBe(3);
  });

  it('a ledger of NOTHING BUT policy-less sessions counts all of them', () => {
    const ledger = new RunLedger();
    ledger.appendLiveSession(prePolicySession());
    ledger.appendLiveSession(prePolicySessionNamed('live-pre-012-b'));

    const model = deriveLiveModel(ledger);
    expect(model.empty).toBe(true);
    // The count survives the empty state — it is what the empty card discloses.
    expect(model.sessionsWithoutContextPolicy).toBe(2);
  });

  it('GUARD: a ledger where every session declares a policy counts 0', () => {
    // Otherwise the assertions above are satisfiable by a nonzero constant.
    expect(deriveLiveModel(policyLedger()).sessionsWithoutContextPolicy).toBe(0);
    expect(deriveLiveModel(new RunLedger()).sessionsWithoutContextPolicy).toBe(0);
  });
});

/**
 * FINDING 1 — THE ORDER OF THE POLICY CHECK AGAINST THE REALNESS GATE.
 *
 * `deriveLiveModel` runs `isMeasuredLiveSession` FIRST and only then reads
 * `contextPolicy`. `deriveLive.fixture.test.ts` and `deriveLive.empty.test.ts`
 * carry comments asserting that order — but every session they build declares a
 * policy (`makeLiveSessionEntity` auto-assigns one from the architecture), so
 * the count is 0 under BOTH orderings and neither test could see the swap.
 *
 * Swapped, a `?fixture=1` soak session stored before ticket 012 would be
 * disclosed on the card as an evidence hole — "1 session excluded: no context
 * policy recorded" — when it is really refused for being FABRICATED. That is a
 * false statement about why evidence is missing, and it makes the policy axis a
 * SECOND gate: `isAggregatableLiveSession` is the one gate, and this is the
 * assertion that keeps it that way.
 *
 * The two shapes live with their own gates (fixture → deriveLive.fixture.test.ts,
 * empty → deriveLive.empty.test.ts). Pinned here as well because this is where
 * the count is otherwise specified: refused BEFORE the policy is read.
 */
describe('deriveLiveModel — the realness gate runs BEFORE the policy is read (TICKET 064)', () => {
  const FIXTURE_TRIPLE = { stt: 'fixture', mt: 'fixture', tts: 'fixture' };

  it('DOMINANT — a pre-012 FIXTURE session is a fixture exclusion, never a policy one', () => {
    const ledger = new RunLedger();
    ledger.appendLiveSession(
      makeLiveSessionEntity({
        id: 'live-fixture-pre-012',
        // Explicitly absent: `makeLiveSessionEntity` only auto-assigns when the
        // key is missing from overrides, so this is a genuine pre-012 session.
        contextPolicy: undefined,
        providerTriple: { ...FIXTURE_TRIPLE },
        modelSnapshots: { ...FIXTURE_TRIPLE },
        utterances: [utterance('lu-fx-1', cascadeMarks(980))],
        latency: { p50: 980, p95: 980, driftMinute1ToEnd: 0 },
        stability: { utterancesCompleted: 1, disconnects: 0, heapStart: null, heapEnd: null },
      }),
    );

    // Reading the policy first would count 1 here and the card would say the
    // session was dropped for declaring no policy. It was dropped for being
    // fabricated, and PRD §8 does not want that renamed.
    expect(deriveLiveModel(ledger)).toEqual({
      columns: [],
      empty: true,
      sessionsWithoutContextPolicy: 0,
    });
  });

  it('a pre-012 session that produced NOTHING is an empty-session exclusion, not a policy one', () => {
    const ledger = new RunLedger();
    ledger.appendLiveSession(
      makeLiveSessionEntity({
        id: 'live-empty-pre-012',
        contextPolicy: undefined,
        architecture: 'realtime',
        providerTriple: undefined,
        modelSnapshots: { realtime: REALTIME_MODEL },
        utterances: [],
        latency: { p50: null, p95: null, driftMinute1ToEnd: null },
        cost: { totalUsd: 0, perMinuteMinute1: null, perMinuteFinalMinute: null },
        stability: { utterancesCompleted: 0, disconnects: 0, heapStart: null, heapEnd: null },
      }),
    );

    expect(deriveLiveModel(ledger)).toEqual({
      columns: [],
      empty: true,
      sessionsWithoutContextPolicy: 0,
    });
  });

  it('CONTROL — the same session, REAL and with utterances, IS a policy exclusion', () => {
    // Without this the two assertions above are satisfiable by never counting
    // anything. The only difference from the fixture case is the realness gate.
    const ledger = new RunLedger();
    ledger.appendLiveSession(prePolicySessionNamed('live-pre-012-control'));

    expect(deriveLiveModel(ledger).sessionsWithoutContextPolicy).toBe(1);
  });
});
