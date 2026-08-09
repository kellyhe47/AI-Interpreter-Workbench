import { beforeEach, describe, expect, it } from 'vitest';
import { DEFAULT_CASCADE_TRIPLE, REALTIME_MODEL, type ProviderTriple } from '../../core/arms';
import type { UtteranceRecord } from '../../core/timing';
import {
  LEDGER_STORAGE_KEY,
  RunLedger,
  isAggregatableRun,
  isAggregatableUtterance,
  isRealRecord,
  isRealRun,
  runArmTag,
  runSamples,
  type LiveSession,
  type Recording,
  type Run,
  type StorageAdapter,
} from './ledger';

let seq = 0;
let entitySeq = 0;
beforeEach(() => {
  seq = 0;
  entitySeq = 0;
});

/** Build a REAL UtteranceRecord by default; override fields to make it fake. */
function makeRecord(overrides: Partial<UtteranceRecord> = {}): UtteranceRecord {
  seq += 1;
  return {
    id: `utt-${seq}`,
    arm: 'A',
    mode: 'cascade',
    languagePair: 'EN↔ES',
    direction: 'EN→ES',
    sourcePartials: ['hel', 'hello'],
    sourceFinal: 'hello',
    targetPartials: ['ho', 'hola'],
    targetFinal: 'hola',
    audioState: 'ready',
    audioDurationMs: 900,
    timings: { speech_end: 1_000, audio_queued: 1_500 },
    speechEndSource: 'corpus',
    providers: { stt: 'gpt-4o-transcribe', mt: 'anthropic', tts: 'elevenlabs' },
    costUnits: 0.01,
    corpusId: 'corpus-greeting-1',
    runId: 'run-1',
    ...overrides,
  };
}

/** Real record whose perceived latency (audio_queued − speech_end) is `ms`. */
function withLatency(ms: number, overrides: Partial<UtteranceRecord> = {}): UtteranceRecord {
  return makeRecord({ timings: { speech_end: 1_000, audio_queued: 1_000 + ms }, ...overrides });
}

function fakeStorage(): { adapter: StorageAdapter; setCalls: Array<{ key: string; value: string }> } {
  const map = new Map<string, string>();
  const setCalls: Array<{ key: string; value: string }> = [];
  return {
    setCalls,
    adapter: {
      getItem: (key) => map.get(key) ?? null,
      setItem: (key, value) => {
        setCalls.push({ key, value });
        map.set(key, value);
      },
    },
  };
}

describe('append-only store', () => {
  it('append + getRecords returns records in append order', () => {
    const ledger = new RunLedger();
    const a = makeRecord();
    const b = makeRecord();
    ledger.append(a);
    ledger.append(b);
    expect(ledger.getRecords().map((r) => r.id)).toEqual([a.id, b.id]);
  });

  it('getRecords(runId) filters to that run', () => {
    const ledger = new RunLedger();
    const a = makeRecord({ runId: 'run-1' });
    const b = makeRecord({ runId: 'run-2' });
    const c = makeRecord({ runId: 'run-1' });
    for (const r of [a, b, c]) ledger.append(r);
    expect(ledger.getRecords('run-1').map((r) => r.id)).toEqual([a.id, c.id]);
    expect(ledger.getRecords('run-2').map((r) => r.id)).toEqual([b.id]);
    expect(ledger.getRecords('run-none')).toEqual([]);
  });

  it('mutating the returned array does not affect the store', () => {
    const ledger = new RunLedger();
    ledger.append(makeRecord());
    const out = ledger.getRecords();
    out.pop();
    out.push(makeRecord());
    expect(ledger.getRecords()).toHaveLength(1);
  });

  it('mutating a returned record does not affect the store', () => {
    const ledger = new RunLedger();
    ledger.append(makeRecord({ sourceFinal: 'original', sourcePartials: ['orig'] }));
    const out = ledger.getRecords();
    const first = out[0]!;
    first.sourceFinal = 'tampered';
    first.sourcePartials.push('tampered');
    first.providers.stt = 'tampered';
    const fresh = ledger.getRecords()[0]!;
    expect(fresh.sourceFinal).toBe('original');
    expect(fresh.sourcePartials).toEqual(['orig']);
    expect(fresh.providers.stt).toBe('gpt-4o-transcribe');
  });

  it('mutating a record after append does not affect the store', () => {
    const ledger = new RunLedger();
    const rec = makeRecord({ targetFinal: 'hola' });
    ledger.append(rec);
    rec.targetFinal = 'tampered';
    expect(ledger.getRecords()[0]!.targetFinal).toBe('hola');
  });
});

describe('realness rule', () => {
  it('isRealRecord: real by default; fixture provider, placeholder corpus, or fixture arm make it fake', () => {
    expect(isRealRecord(makeRecord())).toBe(true);
    expect(isRealRecord(makeRecord({ providers: { stt: 'fixture', mt: 'anthropic', tts: 'elevenlabs' } }))).toBe(false);
    expect(isRealRecord(makeRecord({ providers: { stt: 'gpt-4o-transcribe', mt: 'fixture', tts: 'elevenlabs' } }))).toBe(false);
    expect(isRealRecord(makeRecord({ providers: { stt: 'gpt-4o-transcribe', mt: 'anthropic', tts: 'fixture' } }))).toBe(false);
    expect(isRealRecord(makeRecord({ corpusId: 'placeholder-1' }))).toBe(false);
    expect(isRealRecord(makeRecord({ arm: 'fixture' }))).toBe(false);
  });

  it('hasRuns is false when empty and false with only fixture/placeholder records', () => {
    const ledger = new RunLedger();
    expect(ledger.hasRuns).toBe(false);
    ledger.append(makeRecord({ providers: { stt: 'fixture', mt: 'fixture', tts: 'fixture' } }));
    ledger.append(makeRecord({ corpusId: 'placeholder-dev' }));
    expect(ledger.hasRuns).toBe(false);
  });

  it('hasRuns is true once a real record exists', () => {
    const ledger = new RunLedger();
    ledger.append(makeRecord({ corpusId: 'placeholder-dev' }));
    ledger.append(makeRecord());
    expect(ledger.hasRuns).toBe(true);
  });

  it('fixture records are stored and exported but never aggregated', () => {
    const ledger = new RunLedger();
    const fixture = withLatency(5, {
      arm: 'F',
      providers: { stt: 'fixture', mt: 'fixture', tts: 'fixture' },
    });
    const real = withLatency(500, { arm: 'A' });
    ledger.append(fixture);
    ledger.append(real);

    expect(ledger.getRecords().map((r) => r.id)).toEqual([fixture.id, real.id]);
    const exported = ledger.exportRuns();
    const exportedIds = exported.runs.flatMap((run) => run.records.map((r) => r.id));
    expect(exportedIds).toContain(fixture.id);

    const { perArm } = ledger.aggregates();
    expect(perArm['F'], 'fixture-only arm must not appear in aggregates').toBeUndefined();
    expect(perArm['A']).toMatchObject({ count: 1, p50Ms: 500 });
  });

  it('fixture records mixed into a real arm do not pollute its numbers', () => {
    const ledger = new RunLedger();
    ledger.append(withLatency(400, { arm: 'A' }));
    ledger.append(withLatency(5, { arm: 'A', corpusId: 'placeholder-x' }));
    ledger.append(withLatency(600, { arm: 'A' }));
    const agg = ledger.aggregates().perArm['A']!;
    expect(agg.count).toBe(2);
    expect(agg.p50Ms).toBe(400);
    expect(agg.p95Ms).toBe(600);
  });
});

describe('aggregates', () => {
  it('nearest-rank percentiles over 10 samples: p50 = 5th, p95 = 10th', () => {
    const ledger = new RunLedger();
    // Insert out of order to prove sorting happens inside.
    const latencies = [700, 100, 1000, 300, 900, 500, 200, 800, 400, 600];
    for (const ms of latencies) ledger.append(withLatency(ms, { arm: 'A', costUnits: 0.02 }));

    const agg = ledger.aggregates().perArm['A']!;
    expect(agg.count).toBe(10);
    expect(agg.p50Ms).toBe(500);
    expect(agg.p95Ms).toBe(1000);
    expect(agg.costUsd).toBeCloseTo(0.2, 10);
  });

  it('nearest-rank percentiles over 3 samples: p50 = 2nd, p95 = 3rd', () => {
    const ledger = new RunLedger();
    for (const ms of [300, 100, 200]) ledger.append(withLatency(ms));
    const agg = ledger.aggregates().perArm['A']!;
    expect(agg.p50Ms).toBe(200);
    expect(agg.p95Ms).toBe(300);
  });

  it('a single sample is both p50 and p95', () => {
    const ledger = new RunLedger();
    ledger.append(withLatency(432));
    const agg = ledger.aggregates().perArm['A']!;
    expect(agg.p50Ms).toBe(432);
    expect(agg.p95Ms).toBe(432);
  });

  it('arms are aggregated separately', () => {
    const ledger = new RunLedger();
    ledger.append(withLatency(100, { arm: 'A', costUnits: 0.01 }));
    ledger.append(withLatency(900, { arm: 'B', costUnits: 0.05 }));
    const { perArm } = ledger.aggregates();
    expect(perArm['A']).toMatchObject({ count: 1, p50Ms: 100, costUsd: 0.01 });
    expect(perArm['B']).toMatchObject({ count: 1, p50Ms: 900, costUsd: 0.05 });
  });

  it('no latency samples → p50/p95 are null, never 0', () => {
    const ledger = new RunLedger();
    // Real record but audio never queued — counts, contributes cost, no latency.
    ledger.append(makeRecord({ timings: { speech_end: 1_000 }, costUnits: 0.03 }));
    const agg = ledger.aggregates().perArm['A']!;
    expect(agg.count).toBe(1);
    expect(agg.p50Ms).toBeNull();
    expect(agg.p95Ms).toBeNull();
    expect(agg.costUsd).toBeCloseTo(0.03, 10);
  });

  it('empty ledger aggregates to an empty perArm map', () => {
    expect(new RunLedger().aggregates()).toEqual({ perArm: {} });
  });

  it('aggregates(runId) only considers that run', () => {
    const ledger = new RunLedger();
    ledger.append(withLatency(100, { arm: 'A', runId: 'run-1' }));
    ledger.append(withLatency(900, { arm: 'A', runId: 'run-2' }));
    expect(ledger.aggregates('run-1').perArm['A']).toMatchObject({ count: 1, p50Ms: 100 });
    expect(ledger.aggregates('run-2').perArm['A']).toMatchObject({ count: 1, p50Ms: 900 });
    expect(ledger.aggregates().perArm['A']!.count).toBe(2);
  });
});

describe('blind draws', () => {
  it('draws are grouped under the run of the utterance they reference', () => {
    const ledger = new RunLedger();
    const r1 = makeRecord({ runId: 'run-1' });
    const r2 = makeRecord({ runId: 'run-2' });
    ledger.append(r1);
    ledger.append(r2);
    ledger.recordBlindDraw({ id: 'draw-1', utteranceId: r2.id, order: ['B', 'A'], createdAt: 5_000 });

    const exported = ledger.exportRuns();
    const run1 = exported.runs.find((r) => r.runId === 'run-1')!;
    const run2 = exported.runs.find((r) => r.runId === 'run-2')!;
    expect(run1.blindDraws).toEqual([]);
    expect(run2.blindDraws).toEqual([
      { id: 'draw-1', utteranceId: r2.id, order: ['B', 'A'], createdAt: 5_000 },
    ]);
  });

  it('recordBlindScores attaches scores and revealedAt to the draw', () => {
    const ledger = new RunLedger();
    const rec = makeRecord();
    ledger.append(rec);
    ledger.recordBlindDraw({ id: 'draw-1', utteranceId: rec.id, order: ['A', 'B'], createdAt: 5_000 });
    ledger.recordBlindScores({ drawId: 'draw-1', scores: { A: 4, B: 2 }, revealedAt: 6_000 });

    const exported = ledger.exportRuns();
    const draw = exported.runs.flatMap((r) => r.blindDraws).find((d) => d.id === 'draw-1')!;
    expect(draw.scores).toEqual({ A: 4, B: 2 });
    expect(draw.revealedAt).toBe(6_000);
  });

  it('recordBlindScores on an unknown drawId throws naming the id', () => {
    const ledger = new RunLedger();
    expect(() =>
      ledger.recordBlindScores({ drawId: 'nope-9', scores: { A: 1 }, revealedAt: 1 }),
    ).toThrowError(/nope-9/);
  });
});

describe('export / import', () => {
  function populated(): RunLedger {
    const ledger = new RunLedger();
    const r1 = withLatency(250, { arm: 'A', runId: 'run-1' });
    const r2 = withLatency(750, { arm: 'B', runId: 'run-1' });
    const r3 = withLatency(400, { arm: 'A', runId: 'run-2' });
    const fx = makeRecord({ runId: 'run-2', corpusId: 'placeholder-dev' });
    for (const r of [r1, r2, r3, fx]) ledger.append(r);
    ledger.recordBlindDraw({ id: 'draw-1', utteranceId: r1.id, order: ['A', 'B'], createdAt: 100 });
    ledger.recordBlindScores({ drawId: 'draw-1', scores: { A: 5, B: 3 }, revealedAt: 200 });
    return ledger;
  }

  it('exportRuns shape: one entry per run with its records and draws', () => {
    const exported = populated().exportRuns();
    expect(exported.runs.map((r) => r.runId).sort()).toEqual(['run-1', 'run-2']);
    const run1 = exported.runs.find((r) => r.runId === 'run-1')!;
    const run2 = exported.runs.find((r) => r.runId === 'run-2')!;
    expect(run1.records).toHaveLength(2);
    expect(run2.records).toHaveLength(2);
    expect(run1.blindDraws).toHaveLength(1);
  });

  it('export is JSON-serializable and survives a JSON round trip', () => {
    const exported = populated().exportRuns();
    expect(JSON.parse(JSON.stringify(exported))).toEqual(exported);
  });

  it('importRuns(exportRuns()) round-trips deep-equal', () => {
    const source = populated();
    const target = new RunLedger();
    target.importRuns(source.exportRuns());
    expect(target.exportRuns()).toEqual(source.exportRuns());
    expect(target.getRecords()).toEqual(source.getRecords());
    expect(target.aggregates()).toEqual(source.aggregates());
    expect(target.hasRuns).toBe(true);
  });

  it('importRuns replaces existing content', () => {
    const source = populated();
    const target = new RunLedger();
    target.append(makeRecord({ runId: 'stale-run', id: 'stale-1' }));
    target.importRuns(source.exportRuns());
    expect(target.getRecords('stale-run')).toEqual([]);
    expect(target.exportRuns()).toEqual(source.exportRuns());
  });
});

describe('storage adapter', () => {
  it('every append, draw, and score persists via setItem under the ledger key', () => {
    const { adapter, setCalls } = fakeStorage();
    const ledger = new RunLedger(adapter);
    const baseline = setCalls.length;

    const rec = makeRecord();
    ledger.append(rec);
    expect(setCalls.length).toBe(baseline + 1);

    ledger.recordBlindDraw({ id: 'draw-1', utteranceId: rec.id, order: ['A'], createdAt: 1 });
    expect(setCalls.length).toBe(baseline + 2);

    ledger.recordBlindScores({ drawId: 'draw-1', scores: { A: 4 }, revealedAt: 2 });
    expect(setCalls.length).toBe(baseline + 3);

    for (const call of setCalls.slice(baseline)) {
      expect(call.key).toBe(LEDGER_STORAGE_KEY);
      expect(() => JSON.parse(call.value)).not.toThrow();
    }
  });

  it('constructor restores previously persisted state from storage', () => {
    const { adapter } = fakeStorage();
    const first = new RunLedger(adapter);
    const rec = withLatency(300);
    first.append(rec);
    first.recordBlindDraw({ id: 'draw-1', utteranceId: rec.id, order: ['A', 'B'], createdAt: 9 });
    first.recordBlindScores({ drawId: 'draw-1', scores: { A: 3, B: 1 }, revealedAt: 10 });

    const second = new RunLedger(adapter);
    expect(second.exportRuns()).toEqual(first.exportRuns());
    expect(second.getRecords()).toEqual(first.getRecords());
    expect(second.hasRuns).toBe(true);
    expect(second.aggregates().perArm['A']).toMatchObject({ count: 1, p50Ms: 300 });
  });

  it('a fresh adapter with no stored blob yields an empty ledger', () => {
    const { adapter } = fakeStorage();
    const ledger = new RunLedger(adapter);
    expect(ledger.getRecords()).toEqual([]);
    expect(ledger.hasRuns).toBe(false);
  });
});

/* ==========================================================================
 * Ticket 010 — the ledger as the client's view over Recording / Run /
 * LiveSession, and the aggregation gate.
 * ======================================================================== */

const ARM_B_TRIPLE: ProviderTriple = { ...DEFAULT_CASCADE_TRIPLE };
const ARM_C_TRIPLE: ProviderTriple = { ...DEFAULT_CASCADE_TRIPLE, tts: 'eleven_flash_v2_5' };
/** Every stage is a legal menu choice, but the combination is no frozen arm. */
const OFF_ARM_TRIPLE: ProviderTriple = {
  stt: 'gpt-4o-mini-transcribe',
  mt: 'claude-haiku-4-5',
  tts: 'eleven_multilingual_v2',
};
const FIXTURE_TRIPLE: ProviderTriple = { stt: 'fixture', mt: 'fixture', tts: 'fixture' };

function makeRecording(overrides: Partial<Recording> = {}): Recording {
  entitySeq += 1;
  return {
    id: `rec-${entitySeq}`,
    label: `clip ${entitySeq}`,
    sourceLanguage: 'en',
    durationMs: 4_200,
    speechEndMs: 3_800,
    origin: 'mic',
    createdAt: 1_700_000_000_000 + entitySeq,
    ...overrides,
  };
}

/**
 * A Run that PASSES the gate by default: Arm-B triple, sweep origin, complete
 * status, recorded languages, real providers. Every exclusion case is this
 * minus one thing.
 *
 * TICKET 061 — the languages are a DEFAULT of the builder, for the same reason
 * `origin: 'sweep'` is: the gate now requires them, so a builder that omitted
 * them would make every exclusion test pass for the wrong reason. The tests
 * that are ABOUT the languages strip or overwrite them explicitly.
 */
function makeRun(overrides: Partial<Run> = {}): Run {
  entitySeq += 1;
  return {
    id: `run-${entitySeq}`,
    recordingId: 'rec-1',
    architecture: 'cascade',
    providerTriple: { ...ARM_B_TRIPLE },
    modelSnapshots: { ...ARM_B_TRIPLE },
    armTag: 'B',
    origin: 'sweep',
    status: 'complete',
    languagePair: 'EN↔ES',
    direction: 'en→es',
    timings: { speech_end: 1_000, audio_queued: 1_500 },
    transcripts: { source: 'hello', target: 'hola' },
    outputAudioPath: `runs/run-${entitySeq}.out.wav`,
    cost: 0.01,
    errors: [],
    createdAt: 1_700_000_000_000 + entitySeq,
    ...overrides,
  };
}

/** Gate-passing Run whose perceived latency (audio_queued − speech_end) is `ms`. */
function runWithLatency(ms: number, overrides: Partial<Run> = {}): Run {
  return makeRun({ timings: { speech_end: 1_000, audio_queued: 1_000 + ms }, ...overrides });
}

function makeLiveSession(overrides: Partial<LiveSession> = {}): LiveSession {
  entitySeq += 1;
  return {
    id: `live-${entitySeq}`,
    startedAt: 1_700_000_000_000,
    endedAt: 1_700_000_300_000,
    durationMs: 300_000,
    architecture: 'cascade',
    providerTriple: { ...ARM_B_TRIPLE },
    modelSnapshots: { ...ARM_B_TRIPLE },
    utterances: [
      { id: 'lu-1', timings: { speech_end: 0, audio_queued: 700 }, costUsd: 0.004 },
      { id: 'lu-2', timings: { speech_end: 0, audio_queued: 900 }, costUsd: 0.006 },
    ],
    latency: { p50: 700, p95: 900, driftMinute1ToEnd: 200 },
    cost: { totalUsd: 0.01, perMinuteMinute1: 0.002, perMinuteFinalMinute: 0.003 },
    stability: { utterancesCompleted: 2, disconnects: 0, heapStart: 10, heapEnd: 12 },
    quality: { wer: null, subjectiveNotes: 'clean' },
    ...overrides,
  };
}

describe('v2 entities are stored alongside utterance records', () => {
  it('recordings, runs and live sessions each have their own getter', () => {
    const ledger = new RunLedger();
    const rec = makeRecording();
    const run = makeRun({ recordingId: rec.id });
    const live = makeLiveSession();

    ledger.appendRecording(rec);
    ledger.appendRun(run);
    ledger.appendLiveSession(live);

    expect(ledger.getRecordings()).toEqual([rec]);
    expect(ledger.getRuns()).toEqual([run]);
    expect(ledger.getLiveSessions()).toEqual([live]);
  });

  it('utterance records and the entity stores do not bleed into each other', () => {
    const ledger = new RunLedger();
    ledger.append(makeRecord());
    ledger.appendRun(makeRun());
    expect(ledger.getRecords()).toHaveLength(1);
    expect(ledger.getRuns()).toHaveLength(1);
    expect(ledger.getRecordings()).toEqual([]);
    expect(ledger.getLiveSessions()).toEqual([]);
  });

  it('empty ledger returns empty entity lists', () => {
    const ledger = new RunLedger();
    expect(ledger.getRecordings()).toEqual([]);
    expect(ledger.getRuns()).toEqual([]);
    expect(ledger.getLiveSessions()).toEqual([]);
  });
});

describe('Runs are queryable by recordingId', () => {
  it('getRuns(recordingId) returns that Recording’s runs, in append order', () => {
    const ledger = new RunLedger();
    const a = makeRun({ recordingId: 'rec-a' });
    const b = makeRun({ recordingId: 'rec-b' });
    const c = makeRun({ recordingId: 'rec-a' });
    for (const r of [a, b, c]) ledger.appendRun(r);

    expect(ledger.getRuns('rec-a').map((r) => r.id)).toEqual([a.id, c.id]);
    expect(ledger.getRuns('rec-b').map((r) => r.id)).toEqual([b.id]);
    expect(ledger.getRuns('rec-none')).toEqual([]);
    expect(ledger.getRuns().map((r) => r.id)).toEqual([a.id, b.id, c.id]);
  });
});

describe('armTag is derived, never declared', () => {
  it('runArmTag reads the configuration, not the stored tag', () => {
    expect(runArmTag(makeRun({ armTag: 'ad-hoc', providerTriple: { ...ARM_B_TRIPLE } }))).toBe('B');
    expect(runArmTag(makeRun({ armTag: 'ad-hoc', providerTriple: { ...ARM_C_TRIPLE } }))).toBe('C');
    // Declared B, configured off-arm: the derived value wins.
    expect(runArmTag(makeRun({ armTag: 'B', providerTriple: { ...OFF_ARM_TRIPLE } }))).toBe('ad-hoc');
    // A cascade run with no triple at all cannot be a named arm.
    expect(runArmTag(makeRun({ armTag: 'B', providerTriple: undefined }))).toBe('ad-hoc');
  });

  it('a realtime run derives from its pinned model snapshot', () => {
    const armA = makeRun({
      architecture: 'realtime',
      armTag: 'ad-hoc',
      providerTriple: undefined,
      modelSnapshots: { realtime: REALTIME_MODEL },
    });
    expect(runArmTag(armA)).toBe('A');

    const offSnapshot = makeRun({
      architecture: 'realtime',
      armTag: 'A',
      providerTriple: undefined,
      modelSnapshots: { realtime: 'gpt-realtime-mini' },
    });
    expect(runArmTag(offSnapshot)).toBe('ad-hoc');
  });

  it('a run declared B but configured off-arm aggregates as ad-hoc — i.e. not at all', () => {
    const ledger = new RunLedger();
    const liar = runWithLatency(500, { armTag: 'B', providerTriple: { ...OFF_ARM_TRIPLE } });
    ledger.appendRun(liar);

    const { perArm } = ledger.runAggregates();
    expect(perArm['B'], 'the declared tag must not create a B aggregate').toBeUndefined();
    expect(perArm['ad-hoc'], 'ad-hoc is never a named arm').toBeUndefined();
    // …and it is still visible where ad-hoc runs live.
    expect(ledger.getRuns(liar.recordingId).map((r) => r.id)).toEqual([liar.id]);
  });
});

describe('the aggregation gate', () => {
  interface GateCase {
    name: string;
    overrides: Partial<Run>;
    aggregated: boolean;
    /** Derived arm the run should land under when aggregated. */
    arm?: string;
  }

  const GATE_CASES: GateCase[] = [
    {
      name: 'named arm + sweep + complete → aggregated',
      overrides: {},
      aggregated: true,
      arm: 'B',
    },
    {
      name: 'Arm C recipe, sweep, complete → aggregated under C',
      overrides: { providerTriple: { ...ARM_C_TRIPLE }, armTag: 'C' },
      aggregated: true,
      arm: 'C',
    },
    {
      name: 'identical but origin === "manual" → excluded',
      overrides: { origin: 'manual' },
      aggregated: false,
    },
    {
      name: 'identical but status === "failed" → excluded',
      overrides: { status: 'failed', errors: ['tts timeout'] },
      aggregated: false,
    },
    {
      name: 'identical but off-arm triple (derives ad-hoc) → excluded',
      overrides: { providerTriple: { ...OFF_ARM_TRIPLE } },
      aggregated: false,
    },
    {
      name: 'declared armTag "B" contradicted by an off-arm triple → excluded',
      overrides: { armTag: 'B', providerTriple: { ...OFF_ARM_TRIPLE } },
      aggregated: false,
    },
    {
      name: 'Arm-B-shaped, sweep, complete, but fixture model snapshots → excluded',
      overrides: { modelSnapshots: { ...FIXTURE_TRIPLE } },
      aggregated: false,
    },
    {
      name: 'Arm-A-shaped realtime run whose providers are fixtures → excluded',
      overrides: {
        architecture: 'realtime',
        armTag: 'A',
        providerTriple: { ...FIXTURE_TRIPLE },
        modelSnapshots: { realtime: REALTIME_MODEL },
      },
      aggregated: false,
    },
    {
      name: 'Arm-B-shaped run over a placeholder recording → excluded',
      overrides: { recordingId: 'placeholder-dev' },
      aggregated: false,
    },
  ];

  for (const testCase of GATE_CASES) {
    it(testCase.name, () => {
      const ledger = new RunLedger();
      const run = runWithLatency(500, testCase.overrides);
      ledger.appendRun(run);

      const { perArm } = ledger.runAggregates();
      if (testCase.aggregated) {
        expect(isAggregatableRun(run)).toBe(true);
        expect(perArm[testCase.arm!]).toMatchObject({ n: 1, p50Ms: 500, p95Ms: 500 });
      } else {
        expect(isAggregatableRun(run)).toBe(false);
        expect(Object.keys(perArm)).toEqual([]);
      }

      // Either way the Run is STORED and listed under its Recording.
      expect(ledger.getRuns(run.recordingId).map((r) => r.id)).toEqual([run.id]);
      expect(ledger.getRuns().map((r) => r.id)).toEqual([run.id]);
    });
  }

  it('excluded runs stay visible in the per-Recording listing alongside the aggregated ones', () => {
    const ledger = new RunLedger();
    const good = runWithLatency(500, { recordingId: 'rec-1' });
    const manual = runWithLatency(500, { recordingId: 'rec-1', origin: 'manual' });
    const failed = runWithLatency(500, { recordingId: 'rec-1', status: 'failed' });
    const adHoc = runWithLatency(500, {
      recordingId: 'rec-1',
      providerTriple: { ...OFF_ARM_TRIPLE },
    });
    for (const r of [good, manual, failed, adHoc]) ledger.appendRun(r);

    expect(ledger.getRuns('rec-1').map((r) => r.id)).toEqual([
      good.id,
      manual.id,
      failed.id,
      adHoc.id,
    ]);
    expect(ledger.runAggregates().perArm['B']).toMatchObject({ n: 1 });
  });

  it('isRealRun mirrors isRealRecord: fixture providers, fixture snapshots, placeholder recording', () => {
    expect(isRealRun(makeRun())).toBe(true);
    expect(isRealRun(makeRun({ providerTriple: { ...FIXTURE_TRIPLE } }))).toBe(false);
    expect(
      isRealRun(makeRun({ providerTriple: { ...ARM_B_TRIPLE, tts: 'fixture' } })),
    ).toBe(false);
    expect(isRealRun(makeRun({ modelSnapshots: { stt: 'fixture' } }))).toBe(false);
    expect(isRealRun(makeRun({ recordingId: 'placeholder-dev' }))).toBe(false);
  });

  it('fixture-backed runs are stored and exported but never aggregated', () => {
    const ledger = new RunLedger();
    const fixture = runWithLatency(5, {
      recordingId: 'placeholder-dev',
      armTag: 'B',
    });
    const real = runWithLatency(500, { recordingId: 'rec-1' });
    ledger.appendRun(fixture);
    ledger.appendRun(real);

    expect(ledger.getRuns().map((r) => r.id)).toEqual([fixture.id, real.id]);
    expect(ledger.exportRuns().entities.runs.map((r) => r.id)).toEqual([fixture.id, real.id]);
    expect(ledger.runAggregates().perArm['B']).toMatchObject({ n: 1, p50Ms: 500 });
  });
});

describe('run aggregates report actual N', () => {
  it('a 5-rep sweep with one failure aggregates 4, not 5', () => {
    const ledger = new RunLedger();
    const latencies = [400, 500, 600, 700];
    for (const ms of latencies) ledger.appendRun(runWithLatency(ms, { cost: 0.01 }));
    ledger.appendRun(runWithLatency(9_999, { status: 'failed', cost: 0.01 }));

    const agg = ledger.runAggregates().perArm['B']!;
    expect(agg.n).toBe(4);
    expect(agg.p50Ms).toBe(500);
    expect(agg.p95Ms).toBe(700);
    expect(agg.costUsd).toBeCloseTo(0.04, 10);
    // All five reps are still on record.
    expect(ledger.getRuns('rec-1')).toHaveLength(5);
  });

  it('N counts gate-passing runs even when they carry no latency sample', () => {
    const ledger = new RunLedger();
    ledger.appendRun(makeRun({ timings: { speech_end: 1_000, audio_queued: null }, cost: 0.02 }));
    ledger.appendRun(makeRun({ timings: {}, cost: 0.03 }));

    const agg = ledger.runAggregates().perArm['B']!;
    expect(agg.n).toBe(2);
    expect(agg.p50Ms).toBeNull();
    expect(agg.p95Ms).toBeNull();
    expect(agg.costUsd).toBeCloseTo(0.05, 10);
  });
});

describe('run aggregate percentiles', () => {
  it('nearest-rank over 10 samples: p50 = 5th, p95 = 10th', () => {
    const ledger = new RunLedger();
    for (const ms of [700, 100, 1000, 300, 900, 500, 200, 800, 400, 600]) {
      ledger.appendRun(runWithLatency(ms, { cost: 0.02 }));
    }
    const agg = ledger.runAggregates().perArm['B']!;
    expect(agg.n).toBe(10);
    expect(agg.p50Ms).toBe(500);
    expect(agg.p95Ms).toBe(1000);
    expect(agg.costUsd).toBeCloseTo(0.2, 10);
  });

  it('a single sample is both p50 and p95', () => {
    const ledger = new RunLedger();
    ledger.appendRun(runWithLatency(432));
    expect(ledger.runAggregates().perArm['B']).toMatchObject({ p50Ms: 432, p95Ms: 432 });
  });

  it('arms are aggregated separately', () => {
    const ledger = new RunLedger();
    ledger.appendRun(runWithLatency(100, { providerTriple: { ...ARM_B_TRIPLE }, cost: 0.01 }));
    ledger.appendRun(runWithLatency(900, { providerTriple: { ...ARM_C_TRIPLE }, cost: 0.05 }));
    const { perArm } = ledger.runAggregates();
    expect(perArm['B']).toMatchObject({ n: 1, p50Ms: 100, costUsd: 0.01 });
    expect(perArm['C']).toMatchObject({ n: 1, p50Ms: 900, costUsd: 0.05 });
  });

  it('an empty ledger has no run aggregates', () => {
    expect(new RunLedger().runAggregates()).toEqual({ perArm: {} });
  });
});

describe('LiveSessions are never pooled with Runs', () => {
  it('a LiveSession on Arm B’s configuration contributes nothing to any aggregate', () => {
    const ledger = new RunLedger();
    ledger.appendRun(runWithLatency(500, { cost: 0.01 }));
    ledger.appendLiveSession(makeLiveSession());
    ledger.appendLiveSession(
      makeLiveSession({ architecture: 'realtime', providerTriple: undefined }),
    );

    const agg = ledger.runAggregates().perArm['B']!;
    expect(agg.n).toBe(1);
    expect(agg.p50Ms).toBe(500);
    expect(agg.costUsd).toBeCloseTo(0.01, 10);
    expect(ledger.getLiveSessions()).toHaveLength(2);
  });

  it('live sessions never appear in the Run listing, at any recordingId', () => {
    const ledger = new RunLedger();
    const live = makeLiveSession();
    ledger.appendLiveSession(live);
    expect(ledger.getRuns()).toEqual([]);
    expect(ledger.getRuns(live.id)).toEqual([]);
    expect(new RunLedger().runAggregates().perArm).toEqual({});
  });

  it('live sessions alone produce no aggregates at all', () => {
    const ledger = new RunLedger();
    ledger.appendLiveSession(makeLiveSession());
    expect(ledger.runAggregates()).toEqual({ perArm: {} });
  });
});

describe('entities are append-only and returned as deep copies', () => {
  it('mutating the returned arrays does not affect the store', () => {
    const ledger = new RunLedger();
    ledger.appendRecording(makeRecording());
    ledger.appendRun(makeRun());
    ledger.appendLiveSession(makeLiveSession());

    ledger.getRecordings().pop();
    ledger.getRuns().pop();
    ledger.getLiveSessions().pop();

    expect(ledger.getRecordings()).toHaveLength(1);
    expect(ledger.getRuns()).toHaveLength(1);
    expect(ledger.getLiveSessions()).toHaveLength(1);
  });

  it('mutating a returned Run does not affect the store', () => {
    const ledger = new RunLedger();
    ledger.appendRun(makeRun({ origin: 'sweep', status: 'complete' }));
    const out = ledger.getRuns()[0]!;
    out.status = 'failed';
    out.origin = 'manual';
    out.errors.push('tampered');
    out.providerTriple!.tts = 'tampered';
    out.timings.audio_queued = 999_999;

    const fresh = ledger.getRuns()[0]!;
    expect(fresh.status).toBe('complete');
    expect(fresh.origin).toBe('sweep');
    expect(fresh.errors).toEqual([]);
    expect(fresh.providerTriple).toEqual(ARM_B_TRIPLE);
    expect(ledger.runAggregates().perArm['B']).toMatchObject({ n: 1, p50Ms: 500 });
  });

  it('mutating an entity after appending it does not affect the store', () => {
    const ledger = new RunLedger();
    const run = makeRun();
    const rec = makeRecording();
    const live = makeLiveSession();
    ledger.appendRun(run);
    ledger.appendRecording(rec);
    ledger.appendLiveSession(live);

    run.status = 'failed';
    rec.label = 'tampered';
    live.stability.disconnects = 42;

    expect(ledger.getRuns()[0]!.status).toBe('complete');
    expect(ledger.getRecordings()[0]!.label).not.toBe('tampered');
    expect(ledger.getLiveSessions()[0]!.stability.disconnects).toBe(0);
  });
});

describe('export / import carries the three entities', () => {
  function populatedV2(): RunLedger {
    const ledger = new RunLedger();
    const rec = makeRecording({ id: 'rec-1' });
    ledger.appendRecording(rec);
    ledger.appendRecording(makeRecording({ id: 'rec-2', origin: 'corpus' }));
    ledger.appendRun(runWithLatency(300, { recordingId: 'rec-1' }));
    ledger.appendRun(runWithLatency(700, { recordingId: 'rec-1', origin: 'manual' }));
    ledger.appendRun(
      runWithLatency(500, { recordingId: 'rec-2', providerTriple: { ...ARM_C_TRIPLE } }),
    );
    ledger.appendLiveSession(makeLiveSession());
    // …plus the pre-existing utterance-record content.
    const utt = withLatency(250, { arm: 'A', runId: 'run-1' });
    ledger.append(utt);
    ledger.recordBlindDraw({ id: 'draw-1', utteranceId: utt.id, order: ['A', 'B'], createdAt: 1 });
    return ledger;
  }

  it('exportRuns includes recordings, runs and live sessions', () => {
    const exported = populatedV2().exportRuns();
    expect(exported.entities.recordings.map((r) => r.id)).toEqual(['rec-1', 'rec-2']);
    expect(exported.entities.runs).toHaveLength(3);
    expect(exported.entities.liveSessions).toHaveLength(1);
    // The utterance-record grouping is untouched.
    expect(exported.runs.map((r) => r.runId)).toEqual(['run-1']);
  });

  it('the export is JSON-serializable', () => {
    const exported = populatedV2().exportRuns();
    expect(JSON.parse(JSON.stringify(exported))).toEqual(exported);
  });

  it('importRuns(exportRuns()) round-trips deep-equal, entities included', () => {
    const source = populatedV2();
    const target = new RunLedger();
    target.importRuns(source.exportRuns());

    expect(target.exportRuns()).toEqual(source.exportRuns());
    expect(target.getRecordings()).toEqual(source.getRecordings());
    expect(target.getRuns()).toEqual(source.getRuns());
    expect(target.getLiveSessions()).toEqual(source.getLiveSessions());
    expect(target.runAggregates()).toEqual(source.runAggregates());
    expect(target.getRecords()).toEqual(source.getRecords());
  });

  it('importRuns replaces the entity stores too', () => {
    const source = populatedV2();
    const target = new RunLedger();
    target.appendRun(makeRun({ id: 'stale-run', recordingId: 'stale-rec' }));
    target.appendLiveSession(makeLiveSession({ id: 'stale-live' }));
    target.importRuns(source.exportRuns());

    expect(target.getRuns('stale-rec')).toEqual([]);
    expect(target.getRuns().map((r) => r.id)).not.toContain('stale-run');
    expect(target.getLiveSessions().map((s) => s.id)).not.toContain('stale-live');
    expect(target.exportRuns()).toEqual(source.exportRuns());
  });

  it('entities survive a storage-adapter round trip', () => {
    const { adapter } = fakeStorage();
    const first = new RunLedger(adapter);
    first.appendRecording(makeRecording({ id: 'rec-1' }));
    first.appendRun(runWithLatency(300, { recordingId: 'rec-1' }));
    first.appendLiveSession(makeLiveSession());

    const second = new RunLedger(adapter);
    expect(second.getRecordings()).toEqual(first.getRecordings());
    expect(second.getRuns()).toEqual(first.getRuns());
    expect(second.getLiveSessions()).toEqual(first.getLiveSessions());
    expect(second.runAggregates()).toEqual(first.runAggregates());
  });
});

/* --------------------------------------------------------------- ticket 028 */

/**
 * TICKET 028 — the Run gains an ANNOTATION ENVELOPE, and the gate does not.
 *
 * The batch runner knows which repetition it is executing; nothing carried that
 * index onto the Run, so `buildProvenance`'s denominator (distinct ATTEMPTED
 * rep indices) always collapsed onto its numerator and provenance could only
 * ever read "N of N". The client Run mirrors src/server/storage/types.ts
 * field-for-field, so the envelope has to exist on BOTH shapes.
 *
 * The envelope is DATA, never a second gate: `isAggregatableRun` is unchanged,
 * and the warmup — repIndex 0, origin 'manual' — still fails it.
 */
describe('ticket 028 — the annotation envelope on a Run', () => {
  it('the client Run declares an optional annotations envelope, mirroring the server', () => {
    // TYPE-LEVEL: this object literal is assigned to `Run` directly. It does
    // not compile until `Run` declares the field, which is the point.
    const annotated: Run = { ...makeRun({ id: 'run-annotated' }), annotations: { repIndex: 4 } };
    expect(annotated.annotations?.repIndex).toBe(4);

    // ...and it is optional: every Run written before this change still is one.
    const legacy: Run = makeRun({ id: 'run-legacy' });
    expect(legacy.annotations).toBeUndefined();
  });

  it('annotations survive the ledger’s deep copies and the storage-adapter round trip', () => {
    const { adapter } = fakeStorage();
    const first = new RunLedger(adapter);
    first.appendRun({ ...makeRun({ id: 'run-rep-2' }), annotations: { repIndex: 2 } });

    expect(first.getRuns()[0]!.annotations?.repIndex).toBe(2);
    expect(new RunLedger(adapter).getRuns()[0]!.annotations?.repIndex).toBe(2);
  });

  it('the gate is UNCHANGED: an annotated warmup is still not aggregatable', () => {
    // The warmup as the batch runner writes it: repIndex 0, origin 'manual'.
    const warmup: Run = {
      ...makeRun({ id: 'run-warmup', origin: 'manual' }),
      annotations: { repIndex: 0 },
    };
    expect(isAggregatableRun(warmup)).toBe(false);

    // An annotation cannot rescue any other excluded run either...
    const failed: Run = {
      ...makeRun({ id: 'run-failed', status: 'failed', errors: ['tts timeout'] }),
      annotations: { repIndex: 3 },
    };
    expect(isAggregatableRun(failed)).toBe(false);

    // ...nor is it needed by one that already passes.
    const retained: Run = { ...makeRun({ id: 'run-rep-1' }), annotations: { repIndex: 1 } };
    expect(isAggregatableRun(retained)).toBe(true);
    expect(isAggregatableRun(makeRun({ id: 'run-bare' }))).toBe(true);
  });
});

/* ============================ TICKET 061 — the gate learns about languages == */

/**
 * TICKET 061 — A CONTROLLED VARIABLE THAT IS NOT RECORDED IS NOT CONTROLLED.
 *
 * PRD §7's control register pins "language pair + direction — fixed per sweep".
 * A Run that does not say which direction it ran cannot be reproduced from the
 * ledger, cannot be grouped by the by-category view, and cannot be told apart
 * from a run of the OTHER direction — which is what runs 7acb0cc9 (Spanish) and
 * dbeb6d94 (German) are: two different experiments, byte-indistinguishable.
 * Every latency, cost and WER figure derived from such a row is a claim about a
 * language nobody can name.
 *
 * THE CHECK GOES INSIDE `isAggregatableRun` AND NOWHERE ELSE. It is the one
 * place that decides aggregation (PRD §17 22d); a second gate in
 * `groupByCategory`, `runSamples` or `exportResults` splits the rule across
 * five files and each copy is free to disagree. These tests therefore assert
 * the verdict AT THE GATE FUNCTION, so a rejection implemented anywhere else
 * leaves them red.
 */
describe('TICKET 061 — a Run that does not record its languages cannot be aggregated', () => {
  /** Strips both fields no matter what `makeRun`'s defaults later become. */
  function withoutLanguages(run: Run, keep?: 'languagePair' | 'direction'): Run {
    const copy: Run = { ...run };
    if (keep !== 'languagePair') delete copy.languagePair;
    if (keep !== 'direction') delete copy.direction;
    return copy;
  }

  /** Gate-passing in every OTHER respect: Arm B, sweep, complete, real. */
  function directedRun(overrides: Partial<Run> = {}): Run {
    return runWithLatency(500, {
      languagePair: 'EN↔ES',
      direction: 'en→es',
      ...overrides,
    });
  }

  const REJECTED: { name: string; run: () => Run }[] = [
    {
      name: 'neither field — every Run written before this ticket',
      run: () => withoutLanguages(directedRun()),
    },
    {
      name: 'a direction but no pair',
      run: () => withoutLanguages(directedRun(), 'direction'),
    },
    {
      name: 'a pair but no direction — the pair alone does not say which way it ran',
      run: () => withoutLanguages(directedRun(), 'languagePair'),
    },
    {
      // The runner fills the transport config with `?? ''`, so '' is the shape
      // a language-less run has always taken. An empty string is a VALUE in an
      // append-only ledger and sails through any `!== undefined` check.
      name: "empty strings — '' is not a language, it is what dbeb6d94 stored",
      run: () => directedRun({ languagePair: '', direction: '' }),
    },
    {
      name: "an empty direction beside a real pair",
      run: () => directedRun({ direction: '' }),
    },
  ];

  it('POSITIVE CONTROL: the same Run WITH both fields is aggregated', () => {
    const ledger = new RunLedger();
    const run = directedRun();
    ledger.appendRun(run);

    expect(isAggregatableRun(run)).toBe(true);
    expect(isAggregatableUtterance(run)).toBe(true);
    expect(ledger.runAggregates().perArm['B']).toMatchObject({ n: 1, p50Ms: 500, p95Ms: 500 });
  });

  for (const testCase of REJECTED) {
    it(`${testCase.name} → excluded`, () => {
      const ledger = new RunLedger();
      const run = testCase.run();
      ledger.appendRun(run);

      // AT THE GATE. A rejection implemented in a derivation instead would
      // leave this line green and the rule in two places.
      expect(isAggregatableRun(run)).toBe(false);
      // …and therefore one level down, through the parent, with no check of
      // its own (ledger.ts: `isAggregatableUtterance` delegates).
      expect(isAggregatableUtterance(run)).toBe(false);
      expect(ledger.runAggregates().perArm).toEqual({});

      // STORED AND LISTED LIKE ANY OTHER RUN (PRD §12). Excluding a row from
      // the figures is not deleting it.
      expect(ledger.getRuns().map((r) => r.id)).toEqual([run.id]);
      expect(ledger.exportRuns().entities.runs.map((r) => r.id)).toEqual([run.id]);
      // And nothing invented the missing value on the way through.
      expect(ledger.getRuns()[0]!.direction ?? '').toBe(run.direction ?? '');
    });
  }

  it('the gate is not a language POLICE: any recorded direction is admitted', () => {
    // The gate asks whether the run RECORDED its direction, never which one it
    // is. A gate that admitted only 'en→es' would quietly delete the Cantonese
    // track — the direction whose asymmetry is the finding (PRD §7).
    const ledger = new RunLedger();
    const yue = directedRun({ languagePair: 'EN↔YUE', direction: 'en→yue' });
    const reverse = directedRun({ languagePair: 'EN↔ES', direction: 'es→en' });
    ledger.appendRun(yue);
    ledger.appendRun(reverse);

    expect(isAggregatableRun(yue)).toBe(true);
    expect(isAggregatableRun(reverse)).toBe(true);
    expect(ledger.runAggregates().perArm['B']).toMatchObject({ n: 2 });
  });

  it('languages are NOT part of the configuration the arm tag is derived from', () => {
    // Arm membership is DERIVED from configuration and languages are not part
    // of it: the same recipe is the same arm in either direction, which is what
    // makes the two directions comparable at all.
    const es = directedRun();
    const yue = directedRun({ languagePair: 'EN↔YUE', direction: 'en→yue' });
    expect(runArmTag(es)).toBe('B');
    expect(runArmTag(yue)).toBe(runArmTag(es));
    expect(runArmTag(withoutLanguages(es))).toBe('B');
  });
});

/**
 * TICKET 061 — THE THREE STORED RUNS ARE LEFT EXACTLY AS THEY ARE.
 *
 * No backfill and no inferred direction: all three of `data/runs/` carry
 * `origin: "manual"`, so the gate has ALREADY rejected them on a rule that
 * predates this ticket, and guessing a direction to write into an append-only
 * ledger would fabricate the very fact the ticket says is missing. What has to
 * keep working is READING them.
 */
describe('TICKET 061 — a fieldless Run stays readable, and stays excluded on the rule it already broke', () => {
  /** The shape of the three records in `data/runs/`. */
  function storedRun(): Run {
    const run: Run = makeRun({ origin: 'manual' });
    delete run.languagePair;
    delete run.direction;
    return run;
  }

  it('parses, lists and exports unchanged — nothing is dropped and nothing is invented', () => {
    const ledger = new RunLedger();
    const run = storedRun();
    ledger.appendRun(run);

    expect(ledger.getRuns()).toEqual([run]);
    // Through JSON, which is how the ledger actually reaches these tests.
    const roundTripped = JSON.parse(JSON.stringify(ledger.exportRuns())) as {
      entities: { runs: Run[] };
    };
    const read = roundTripped.entities.runs[0]!;
    expect(read).toEqual(run);
    expect(Object.keys(read)).not.toContain('languagePair');
    expect(Object.keys(read)).not.toContain('direction');
  });

  it('every reader still answers for it — no derivation throws on an absent direction', () => {
    const run = storedRun();
    expect(runArmTag(run)).toBe('B');
    expect(isRealRun(run)).toBe(true);
    // The measured atom still expands: one Run-level sample, as it always did.
    expect(runSamples(run)).toHaveLength(1);
    expect(runSamples(run)[0]!.latencyMs).toBe(500);
  });

  it('is excluded by the ORIGIN rule it already broke — no new mechanism is needed', () => {
    const run = storedRun();
    expect(run.origin).toBe('manual');
    expect(isAggregatableRun(run)).toBe(false);
    // The same Run as a sweep is still excluded, but on the new rule — which is
    // what proves the origin clause is not doing this ticket's work for it.
    const asSweep: Run = { ...run, origin: 'sweep' };
    expect(asSweep.languagePair).toBeUndefined();
    expect(isAggregatableRun(asSweep)).toBe(false);
  });
});
