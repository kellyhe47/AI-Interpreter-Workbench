/**
 * TICKET 018 — deriveLiveModel applies the LiveSession realness rule.
 *
 * QA F1: `/?fixture=1` → Live → ~20 utterances → Stop → Results rendered
 * "20 utterances completed / 0 disconnects / p50 0.98 s / p95 0.98 s" under a
 * provenance line that claimed a measurement, with no illustrative badge. The
 * identical p50 and p95 are the signature of a constant-delay fixture.
 *
 * PRD §8: no reported number may come from a fixture run.
 * PRD §17 15g: the mandatory empty states exist so "polished placeholders can
 * never be mistaken for measured evidence" — so a fixture-only ledger must
 * derive the SAME explicit empty state an untouched ledger derives, not a
 * column of zeros.
 *
 * ADDITIVE to the locked derive.test.ts.
 */

import { describe, expect, it } from 'vitest';
import { DEFAULT_CASCADE_TRIPLE, REALTIME_MODEL, type ProviderTriple } from '../../../core/arms';
import { RunLedger, type LiveSession } from '../../state/ledger';
import { deriveLiveModel } from './derive';
import {
  LIVE_A_DRIFT_MS,
  makeLiveSessionEntity,
  seedLiveSessions,
} from './testRecords';

const FIXTURE_TRIPLE: ProviderTriple = { stt: 'fixture', mt: 'fixture', tts: 'fixture' };

/** The figures the QA repro rendered — every one of them a fixture constant. */
const FIXTURE_UTTERANCES_COMPLETED = 20;
const FIXTURE_CONSTANT_LATENCY_MS = 980;

/**
 * A LiveSession shaped like the one `?fixture=1` writes: fat, complete and
 * entirely fabricated. Every field is populated on purpose — an implementation
 * that leaks it moves a number visibly.
 */
function fixtureLiveSession(overrides: Partial<LiveSession> = {}): LiveSession {
  return makeLiveSessionEntity({
    id: 'live-fixture-1',
    providerTriple: { ...FIXTURE_TRIPLE },
    modelSnapshots: { ...FIXTURE_TRIPLE },
    utterances: Array.from({ length: FIXTURE_UTTERANCES_COMPLETED }, (_, i) => ({
      id: `lu-${i + 1}`,
      timings: { speech_end: 0, audio_queued: FIXTURE_CONSTANT_LATENCY_MS },
      costUsd: 0.001,
    })),
    latency: {
      p50: FIXTURE_CONSTANT_LATENCY_MS,
      p95: FIXTURE_CONSTANT_LATENCY_MS,
      driftMinute1ToEnd: 0,
    },
    cost: { totalUsd: 0.02, perMinuteMinute1: 0.004, perMinuteFinalMinute: 0.004 },
    stability: {
      utterancesCompleted: FIXTURE_UTTERANCES_COMPLETED,
      disconnects: 0,
      heapStart: null,
      heapEnd: null,
    },
    ...overrides,
  });
}

/** Each row is one way a session can be fixture-sourced. */
const FIXTURE_SHAPES: ReadonlyArray<{ name: string; overrides: Partial<LiveSession> }> = [
  { name: 'every provider named fixture', overrides: {} },
  {
    name: 'only the TTS stage named fixture',
    overrides: {
      providerTriple: { ...DEFAULT_CASCADE_TRIPLE, tts: 'fixture' },
      modelSnapshots: { ...DEFAULT_CASCADE_TRIPLE, tts: 'fixture' },
    },
  },
  {
    name: 'a realtime session with a fixture model snapshot',
    overrides: {
      architecture: 'realtime',
      providerTriple: undefined,
      modelSnapshots: { realtime: 'fixture' },
    },
  },
];

describe('ticket 018 — deriveLiveModel excludes fixture-sourced LiveSessions', () => {
  it.each(FIXTURE_SHAPES)(
    'a ledger holding only a fixture session ($name) derives the EXPLICIT empty state',
    ({ overrides }) => {
      const ledger = new RunLedger();
      ledger.appendLiveSession(fixtureLiveSession(overrides));

      // Byte-for-byte the same model an untouched ledger derives (locked in
      // derive.test.ts: `{ columns: [], empty: true }`), not a zeroed column.
      expect(deriveLiveModel(ledger)).toEqual({ columns: [], empty: true });
      expect(deriveLiveModel(ledger)).toEqual(deriveLiveModel(new RunLedger()));
    },
  );

  it('contributes no figure to any column — not utterances, not disconnects, not latency', () => {
    const ledger = new RunLedger();
    ledger.appendLiveSession(fixtureLiveSession());
    const model = deriveLiveModel(ledger);

    expect(model.columns).toEqual([]);
    const serialized = JSON.stringify(model);
    expect(serialized).not.toContain(String(FIXTURE_UTTERANCES_COMPLETED));
    expect(serialized).not.toContain(String(FIXTURE_CONSTANT_LATENCY_MS));
  });

  it('a fixture session cannot move the figures of a REAL session sharing its arm', () => {
    const ledger = new RunLedger();
    seedLiveSessions(ledger); // real Arm A + Arm B sessions
    const before = deriveLiveModel(ledger);

    ledger.appendLiveSession(
      fixtureLiveSession({
        // The same derived arm as the real cascade session, so a leak pools.
        providerTriple: { ...DEFAULT_CASCADE_TRIPLE, tts: 'fixture' },
        modelSnapshots: { ...DEFAULT_CASCADE_TRIPLE, tts: 'fixture' },
      }),
    );

    expect(deriveLiveModel(ledger)).toEqual(before);
  });

  it('the fixture session is still STORED — excluded from the model, not deleted', () => {
    const ledger = new RunLedger();
    ledger.appendLiveSession(fixtureLiveSession());
    expect(ledger.getLiveSessions().map((s) => s.id)).toEqual(['live-fixture-1']);
    expect(deriveLiveModel(ledger).empty).toBe(true);
  });
});

describe('ticket 018 — regression guard: a REAL LiveSession still populates its column', () => {
  it('seeded real sessions derive both arm columns, unchanged by the new rule', () => {
    const ledger = new RunLedger();
    seedLiveSessions(ledger);
    const model = deriveLiveModel(ledger);

    expect(model.empty).toBe(false);
    expect(model.columns.map((c) => c.arm).sort()).toEqual(['A', 'B']);

    const a = model.columns.find((c) => c.arm === 'A')!;
    expect(a.sessions).toBe(1);
    expect(a.utterancesCompleted).toBe(3);
    expect(a.disconnects).toBe(1);
    expect(a.p50Ms).toBe(1100);
    expect(a.p95Ms).toBe(1200);
    expect(a.driftMinute1ToEndMs).toBe(LIVE_A_DRIFT_MS);

    const b = model.columns.find((c) => c.arm === 'B')!;
    expect(b.p50Ms).toBe(700);
    expect(b.disconnects).toBe(0);
  });

  it('a real session survives alongside a fixture one — only the fixture is dropped', () => {
    const ledger = new RunLedger();
    ledger.appendLiveSession(
      makeLiveSessionEntity({
        id: 'live-real-cascade',
        utterances: [
          { id: 'lu-1', timings: { speech_end: 0, audio_queued: 600 }, costUsd: 0.01 },
          { id: 'lu-2', timings: { speech_end: 0, audio_queued: 700 }, costUsd: 0.01 },
          { id: 'lu-3', timings: { speech_end: 0, audio_queued: 800 }, costUsd: 0.01 },
        ],
        latency: { p50: 700, p95: 800, driftMinute1ToEnd: 40 },
        stability: { utterancesCompleted: 3, disconnects: 0, heapStart: null, heapEnd: null },
      }),
    );
    ledger.appendLiveSession(
      fixtureLiveSession({
        architecture: 'realtime',
        providerTriple: undefined,
        modelSnapshots: { realtime: 'fixture' },
      }),
    );

    const model = deriveLiveModel(ledger);
    expect(model.empty).toBe(false);
    expect(model.columns.map((c) => c.arm)).toEqual(['B']);
    const b = model.columns[0]!;
    expect(b.sessions).toBe(1);
    expect(b.utterancesCompleted).toBe(3);
    expect(b.p50Ms).toBe(700);
    // The realtime column the fixture session would have filled stays absent.
    expect(model.columns.find((c) => c.arm === 'A')).toBeUndefined();
  });

  it('a real realtime session on the pinned model still derives Arm A', () => {
    const ledger = new RunLedger();
    ledger.appendLiveSession(
      makeLiveSessionEntity({
        id: 'live-real-realtime',
        architecture: 'realtime',
        providerTriple: undefined,
        modelSnapshots: { realtime: REALTIME_MODEL },
        utterances: [
          { id: 'lu-1', timings: { speech_end: 0, audio_queued: 1000 }, costUsd: 0.1 },
        ],
        latency: { p50: 1000, p95: 1000, driftMinute1ToEnd: 250 },
        stability: { utterancesCompleted: 1, disconnects: 0, heapStart: null, heapEnd: null },
      }),
    );
    const model = deriveLiveModel(ledger);
    expect(model.columns.map((c) => c.arm)).toEqual(['A']);
    expect(model.columns[0]!.p50Ms).toBe(1000);
  });
});
