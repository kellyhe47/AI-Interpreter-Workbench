import { beforeEach, describe, expect, it } from 'vitest';
import type { UtteranceRecord } from '../../core/timing';
import {
  LEDGER_STORAGE_KEY,
  RunLedger,
  isRealRecord,
  type StorageAdapter,
} from './ledger';

let seq = 0;
beforeEach(() => {
  seq = 0;
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
    providers: { stt: 'deepgram', mt: 'anthropic', tts: 'elevenlabs' },
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
    expect(fresh.providers.stt).toBe('deepgram');
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
    expect(isRealRecord(makeRecord({ providers: { stt: 'deepgram', mt: 'fixture', tts: 'elevenlabs' } }))).toBe(false);
    expect(isRealRecord(makeRecord({ providers: { stt: 'deepgram', mt: 'anthropic', tts: 'fixture' } }))).toBe(false);
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
