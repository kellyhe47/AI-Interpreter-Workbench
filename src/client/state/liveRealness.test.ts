/**
 * TICKET 018 — the realness rule for LiveSessions.
 *
 * PRD §8, hard rule: "No number reported in the write-up may come from a
 * fixture run. Fixture latency is a configured constant." The Run path
 * enforces it (`isRealRun`); the LiveSession path had no equivalent, so a
 * `?fixture=1` soak painted a constant-delay fixture into the
 * conversation-length card as p50 AND p95.
 *
 * These tests pin the predicate itself. Two halves run through all of them:
 *
 *  1. EXCLUDED. A fixture-named LiveSession is not real, so nothing derives
 *     a figure from it.
 *  2. STILL STORED. Fixture data is dev data, not garbage: the ledger keeps
 *     it, lists it and exports it (the same treatment fixture Runs and
 *     fixture UtteranceRecords already get). An implementation that drops
 *     fixture sessions on the floor passes half of this rule and breaks the
 *     ledger's append-only contract.
 *
 * This file is ADDITIVE — it does not touch the locked ledger.test.ts.
 */

import { describe, expect, it } from 'vitest';
import { DEFAULT_CASCADE_TRIPLE, REALTIME_MODEL, type ProviderTriple } from '../../core/arms';
import { makeLiveSessionEntity, makeRunEntity } from '../components/results/testRecords';
import { RunLedger, isRealLiveSession, isRealRun, type LiveSession } from './ledger';

const FIXTURE_TRIPLE: ProviderTriple = { stt: 'fixture', mt: 'fixture', tts: 'fixture' };

/**
 * The rule, spelled out case by case. Each row is the DEFAULT (real, Arm B
 * cascade) session minus exactly one thing, which is what makes the table
 * honest about which clause did the excluding.
 */
const CASES: ReadonlyArray<{
  name: string;
  overrides: Partial<LiveSession>;
  real: boolean;
}> = [
  {
    name: 'a cascade session on the default Arm B triple',
    overrides: {},
    real: true,
  },
  {
    name: 'a realtime session on the real speech-to-speech model',
    overrides: {
      architecture: 'realtime',
      providerTriple: undefined,
      modelSnapshots: { realtime: REALTIME_MODEL },
    },
    real: true,
  },
  {
    name: 'every provider named fixture (what `?fixture=1` produces)',
    overrides: { providerTriple: { ...FIXTURE_TRIPLE }, modelSnapshots: { ...FIXTURE_TRIPLE } },
    real: false,
  },
  {
    name: 'only the STT stage named fixture',
    overrides: { providerTriple: { ...DEFAULT_CASCADE_TRIPLE, stt: 'fixture' } },
    real: false,
  },
  {
    name: 'only the MT stage named fixture',
    overrides: { providerTriple: { ...DEFAULT_CASCADE_TRIPLE, mt: 'fixture' } },
    real: false,
  },
  {
    name: 'only the TTS stage named fixture',
    overrides: { providerTriple: { ...DEFAULT_CASCADE_TRIPLE, tts: 'fixture' } },
    real: false,
  },
  {
    name: 'a real triple but a fixture model snapshot',
    overrides: { modelSnapshots: { ...DEFAULT_CASCADE_TRIPLE, tts: 'fixture' } },
    real: false,
  },
  {
    name: 'a realtime session whose model snapshot is fixture',
    overrides: {
      architecture: 'realtime',
      providerTriple: undefined,
      modelSnapshots: { realtime: 'fixture' },
    },
    real: false,
  },
];

describe('ticket 018 — isRealLiveSession is a named export beside isRealRun', () => {
  it('is exported from the ledger module, so the two rules are visibly one concept', () => {
    expect(typeof isRealLiveSession).toBe('function');
    expect(typeof isRealRun).toBe('function');
  });

  it.each(CASES)('$name → real: $real', ({ overrides, real }) => {
    expect(isRealLiveSession(makeLiveSessionEntity(overrides))).toBe(real);
  });

  it('agrees with isRealRun on every recipe the two shapes share', () => {
    for (const { overrides, real } of CASES) {
      const session = makeLiveSessionEntity(overrides);
      const run = makeRunEntity({
        architecture: session.architecture,
        providerTriple: session.providerTriple,
        modelSnapshots: session.modelSnapshots,
      });
      expect(
        isRealLiveSession(session),
        `LiveSession and Run disagree on: ${JSON.stringify(session.modelSnapshots)}`,
      ).toBe(isRealRun(run));
      expect(isRealRun(run)).toBe(real);
    }
  });
});

describe('ticket 018 — an excluded LiveSession is still STORED (dev data, not garbage)', () => {
  function fixtureSession(): LiveSession {
    return makeLiveSessionEntity({
      id: 'live-fixture',
      providerTriple: { ...FIXTURE_TRIPLE },
      modelSnapshots: { ...FIXTURE_TRIPLE },
      stability: { utterancesCompleted: 20, disconnects: 0, heapStart: null, heapEnd: null },
      latency: { p50: 980, p95: 980, driftMinute1ToEnd: null },
    });
  }

  // Already-passing guard: the ledger is append-only, so this holds today and
  // must keep holding — an implementation that "fixes" 018 by refusing to
  // store fixture sessions breaks the append-only contract instead.
  it('appendLiveSession keeps it, and getLiveSessions still lists it', () => {
    const ledger = new RunLedger();
    const session = fixtureSession();
    ledger.appendLiveSession(session);

    expect(ledger.getLiveSessions()).toEqual([session]);
  });

  it('and it is nevertheless NOT real', () => {
    expect(isRealLiveSession(fixtureSession())).toBe(false);
  });

  it('it survives export → import, exactly like a fixture Run does', () => {
    const source = new RunLedger();
    source.appendLiveSession(fixtureSession());

    const target = new RunLedger();
    target.importRuns(source.exportRuns());

    expect(target.getLiveSessions().map((s) => s.id)).toEqual(['live-fixture']);
  });
});
