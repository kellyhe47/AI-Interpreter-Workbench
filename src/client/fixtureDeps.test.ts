/**
 * Ticket 018 — dev-only browser fixture mode: fixture-deps factory +
 * fixture-mode selector. Unit-level only (no browser automation) — locks
 * the contract documented in fixtureDeps.ts.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  deriveCascadeIntervals,
  deriveRealtimeIntervals,
  type CascadeTimestamps,
  type RealtimeTimestamps,
  type UtteranceRecord,
} from '../core/timing';
import { buildFixtureDeps, isFixtureMode } from './fixtureDeps';
import { RunLedger, isRealRecord } from './state/ledger';
import type {
  SourceTextEvent,
  TargetTextEvent,
  TimingMark,
  TransportConfig,
  TransportError,
  UtteranceCompletion,
} from './transport/types';
import { ARM_CATALOG, type ArmDef, type SessionDeps } from './views/useSessionController';

beforeEach(() => vi.useFakeTimers());
afterEach(() => vi.useRealTimers());

const CONFIG: TransportConfig = {
  languagePair: 'EN↔ES',
  direction: 'en→es',
  targetLanguage: 'Spanish',
};

function armDef(id: string): ArmDef {
  const def = ARM_CATALOG.find((d) => d.id === id);
  if (!def) throw new Error(`unknown catalog arm: ${id}`);
  return def;
}

interface CollectedEvents {
  source: SourceTextEvent[];
  target: TargetTextEvent[];
  timings: TimingMark[];
  completions: UtteranceCompletion[];
  errors: TransportError[];
}

/** Start one fixture arm, run its script for `ms`, and collect every event. */
async function runArm(deps: SessionDeps, id: string, ms = 10_000) {
  const transport = deps.transportFactory(armDef(id));
  const events: CollectedEvents = {
    source: [],
    target: [],
    timings: [],
    completions: [],
    errors: [],
  };
  transport.setHandlers({
    onSourceText: (e) => events.source.push(e),
    onTargetText: (e) => events.target.push(e),
    onTiming: (e) => events.timings.push(e),
    onUtteranceComplete: (record) => events.completions.push(record),
    onError: (e) => events.errors.push(e),
  });
  await transport.start(CONFIG);
  await vi.advanceTimersByTimeAsync(ms);
  transport.stop();
  return { transport, events };
}

describe('isFixtureMode — flag selector', () => {
  it('production default: empty search (and unrelated params) → disabled, no fault', () => {
    expect(isFixtureMode('')).toEqual({ enabled: false });
    const unrelated = isFixtureMode('?other=1');
    expect(unrelated.enabled).toBe(false);
    expect(unrelated.fault).toBeUndefined();
  });

  it("'?fixture=1' enables fixture mode without a fault", () => {
    const sel = isFixtureMode('?fixture=1');
    expect(sel.enabled).toBe(true);
    expect(sel.fault).toBeUndefined();
  });

  it("'?fixture=fail-mt' enables fixture mode and names the fault", () => {
    expect(isFixtureMode('?fixture=fail-mt')).toEqual({ enabled: true, fault: 'fail-mt' });
  });
});

describe('buildFixtureDeps — SessionDeps shape App accepts', () => {
  it('returns the full SessionDeps bag: in-memory ledger, clock, playback context', () => {
    // Type-level seam check: the same type buildBrowserDeps feeds <App deps>.
    const deps: SessionDeps = buildFixtureDeps();

    expect(typeof deps.transportFactory).toBe('function');
    expect(typeof deps.startCapture).toBe('function');
    expect(deps.ledger).toBeInstanceOf(RunLedger);
    expect(deps.ledger.hasRuns).toBe(false); // fresh, in-memory
    expect(typeof deps.now()).toBe('number');

    const ctx = deps.playbackContextFactory();
    const buffer = ctx.createBuffer(1, 480, 24000);
    expect(buffer.getChannelData(0)).toHaveLength(480);
    const source = ctx.createBufferSource();
    expect(typeof source.connect).toBe('function');
    expect(typeof source.start).toBe('function');
    expect(typeof source.stop).toBe('function');
    expect(() => {
      void ctx.resume();
      void ctx.suspend();
    }).not.toThrow();
  });

  it('builds a transport for every catalog arm carrying the def identity', () => {
    const deps = buildFixtureDeps();
    for (const def of ARM_CATALOG) {
      const transport = deps.transportFactory(def);
      expect(transport.armId).toBe(def.id);
      expect(transport.kind).toBe(def.mode);
      expect(transport.label).toBe(def.label);
      expect(transport.costPerMinUsd).toBe(def.costPerMinUsd);
    }
  });
});

describe('buildFixtureDeps — scripted utterances', () => {
  it('cascade arm: transcripts flow and completions carry fixture providers + 5-stage timings', async () => {
    const { events } = await runArm(buildFixtureDeps(), 'cascade-openai');

    expect(events.source.some((e) => e.kind === 'partial')).toBe(true);
    expect(events.source.some((e) => e.kind === 'final')).toBe(true);
    expect(events.target.some((e) => e.kind === 'final')).toBe(true);
    expect(events.completions.length).toBeGreaterThan(0);

    const record = events.completions[0] as UtteranceRecord;
    expect(record.providers).toEqual({ stt: 'fixture', mt: 'fixture', tts: 'fixture' });
    expect(isRealRecord(record)).toBe(false);

    const iv = deriveCascadeIntervals(record.timings as CascadeTimestamps);
    expect(iv.endpointing).not.toBeNull();
    expect(iv.stt).not.toBeNull();
    expect(iv.mt).not.toBeNull();
    expect(iv.tts).not.toBeNull();
    expect(iv.queue).not.toBeNull();
  });

  it('realtime arm: full fixture record with the 3-stage realtime timings', async () => {
    const { transport, events } = await runArm(buildFixtureDeps(), 'realtime');
    expect(transport.kind).toBe('realtime');
    expect(events.completions.length).toBeGreaterThan(0);

    const record = events.completions[0] as UtteranceRecord;
    expect(record.providers).toEqual({ stt: 'fixture', mt: 'fixture', tts: 'fixture' });
    expect(isRealRecord(record)).toBe(false);

    const iv = deriveRealtimeIntervals(record.timings as RealtimeTimestamps);
    expect(iv.endpointing).not.toBeNull();
    expect(iv.model).not.toBeNull();
    expect(iv.queue).not.toBeNull();
  });

  it('fixture records stay excluded from ledger aggregates (Results realness rule holds)', async () => {
    const { events } = await runArm(buildFixtureDeps(), 'cascade-openai');
    const ledger = new RunLedger();
    for (const completion of events.completions) {
      ledger.append(completion as UtteranceRecord);
    }
    expect(ledger.getRecords().length).toBeGreaterThan(0); // stored as dev data…
    expect(ledger.hasRuns).toBe(false); // …but never "real"
    expect(ledger.aggregates().perArm).toEqual({}); // and never aggregated
  });

  it("fault 'fail-mt' injects one scripted mt-stage error on the cascade arm; default has none", async () => {
    const clean = await runArm(buildFixtureDeps(), 'cascade-openai');
    expect(clean.events.errors).toHaveLength(0);

    const faulty = await runArm(buildFixtureDeps({ fault: 'fail-mt' }), 'cascade-openai');
    expect(faulty.events.errors.length).toBeGreaterThan(0);
    const error = faulty.events.errors[0]!;
    expect(error.opaque).toBe(false);
    expect(error.stage).toBe('mt');
    expect(error.message).toMatch(/mt/);
  });
});

describe('buildFixtureDeps — capture fake', () => {
  it('grants without getUserMedia and emits synthetic levels/chunks until stopped', async () => {
    const deps = buildFixtureDeps();
    const onChunk = vi.fn();
    const onLevel = vi.fn();

    const pending = deps.startCapture({ onChunk, onLevel });
    await vi.advanceTimersByTimeAsync(0);
    const result = await pending;
    expect(result.status).toBe('granted');
    if (result.status !== 'granted') throw new Error('unreachable');

    await vi.advanceTimersByTimeAsync(2_000);
    expect(onLevel).toHaveBeenCalled();
    const bars = onLevel.mock.calls[0]![0] as number;
    expect(bars).toBeGreaterThanOrEqual(0);
    expect(bars).toBeLessThanOrEqual(5);
    expect(onChunk).toHaveBeenCalled();
    expect(onChunk.mock.calls[0]![0]).toBeInstanceOf(Int16Array);

    result.handle.stop();
    const levels = onLevel.mock.calls.length;
    const chunks = onChunk.mock.calls.length;
    await vi.advanceTimersByTimeAsync(2_000);
    expect(onLevel.mock.calls.length).toBe(levels); // silence after stop
    expect(onChunk.mock.calls.length).toBe(chunks);
  });
});
