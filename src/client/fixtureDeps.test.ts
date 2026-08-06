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
import type { LiveRunConfig, SessionDeps } from './views/useSessionController';

beforeEach(() => vi.useFakeTimers());
afterEach(() => vi.useRealTimers());

const CONFIG: TransportConfig = {
  languagePair: 'EN↔ES',
  direction: 'en→es',
  targetLanguage: 'Spanish',
};

/** Ticket 012: the factory takes a resolved LiveRunConfig, not an arm def. */
const CASCADE: LiveRunConfig = {
  architecture: 'cascade',
  providers: { stt: 'gpt-4o-transcribe', mt: 'gpt-4o-mini', tts: 'gpt-4o-mini-tts' },
  contextPolicy: 'default',
};
const CASCADE_ALT: LiveRunConfig = {
  architecture: 'cascade',
  providers: { stt: 'gpt-4o-transcribe', mt: 'gpt-4o-mini', tts: 'eleven_flash_v2_5' },
  contextPolicy: 'default',
};
const REALTIME: LiveRunConfig = {
  architecture: 'realtime',
  realtimeModel: 'gpt-realtime',
  contextPolicy: 'default',
};

interface CollectedEvents {
  source: SourceTextEvent[];
  target: TargetTextEvent[];
  timings: TimingMark[];
  completions: UtteranceCompletion[];
  errors: TransportError[];
}

/** Start one fixture arm, run its script for `ms`, and collect every event. */
async function runArm(deps: SessionDeps, config: LiveRunConfig, ms = 10_000) {
  const transport = deps.transportFactory(config);
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

  it("builds a transport whose kind follows the config's architecture", () => {
    const deps = buildFixtureDeps();
    expect(deps.transportFactory(CASCADE).kind).toBe('cascade');
    expect(deps.transportFactory(REALTIME).kind).toBe('realtime');
  });
});

describe('buildFixtureDeps — scripted utterances', () => {
  it('cascade arm: transcripts flow and completions carry fixture providers + 5-stage timings', async () => {
    const { events } = await runArm(buildFixtureDeps(), CASCADE);

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
    const { transport, events } = await runArm(buildFixtureDeps(), REALTIME);
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
    const { events } = await runArm(buildFixtureDeps(), CASCADE);
    const ledger = new RunLedger();
    for (const completion of events.completions) {
      ledger.append(completion as UtteranceRecord);
    }
    expect(ledger.getRecords().length).toBeGreaterThan(0); // stored as dev data…
    expect(ledger.hasRuns).toBe(false); // …but never "real"
    expect(ledger.aggregates().perArm).toEqual({}); // and never aggregated
  });

  it("fault 'fail-mt' injects one scripted mt-stage error on a cascade transport; default has none", async () => {
    const clean = await runArm(buildFixtureDeps(), CASCADE);
    expect(clean.events.errors).toHaveLength(0);

    const faulty = await runArm(buildFixtureDeps({ fault: 'fail-mt' }), CASCADE);
    expect(faulty.events.errors.length).toBeGreaterThan(0);
    const error = faulty.events.errors[0]!;
    expect(error.opaque).toBe(false);
    expect(error.stage).toBe('mt');
    expect(error.message).toMatch(/mt/);
  });
});

describe('Ticket 021 — fixture scripts loop until stop()', () => {
  it('a 2-utterance loop keeps producing utterances: unique incrementing numbering, all settling', async () => {
    const deps = buildFixtureDeps({ utterancesPerLoop: 2, utteranceSpacingMs: 1500 });
    const { events } = await runArm(deps, CASCADE, 8_000);

    const ids = events.completions.map((r) => (r as UtteranceRecord).id);
    // Wrapped past the 2-utterance script — the session never runs dry.
    expect(ids.length).toBeGreaterThanOrEqual(3);
    // Every started utterance settled, in order, with ids unique and
    // contiguous from utt-0 (numbering keeps incrementing across loops —
    // no repeats, no dangling utterance at the wrap).
    expect(ids).toEqual(ids.map((_, i) => `utt-${i}`));
    const finalUtts = events.source.filter((e) => e.kind === 'final').map((e) => e.utt);
    expect(new Set(finalUtts).size).toBe(finalUtts.length);
  });

  it('the default script loops too (production fixture mode never wedges in processing)', async () => {
    const { events } = await runArm(buildFixtureDeps(), CASCADE, 40_000);
    const ids = events.completions.map((r) => (r as UtteranceRecord).id);
    expect(ids.length).toBeGreaterThanOrEqual(9); // beyond the base 8-utterance script
    expect(ids).toContain('utt-8');
  });

  it('stop() halts the loop — no events after stop', async () => {
    const deps = buildFixtureDeps({ utterancesPerLoop: 2, utteranceSpacingMs: 1500 });
    const transport = deps.transportFactory(CASCADE);
    const completions: UtteranceCompletion[] = [];
    const sources: SourceTextEvent[] = [];
    transport.setHandlers({
      onUtteranceComplete: (record) => completions.push(record),
      onSourceText: (e) => sources.push(e),
    });
    await transport.start(CONFIG);
    await vi.advanceTimersByTimeAsync(4_000);
    expect(completions.length).toBeGreaterThan(0);

    transport.stop();
    const completionCount = completions.length;
    const sourceCount = sources.length;
    await vi.advanceTimersByTimeAsync(10_000);
    expect(completions.length).toBe(completionCount);
    expect(sources.length).toBe(sourceCount);
  });
});

describe('Ticket 022 / 012 — one shared utterance timeline per deps bag', () => {
  interface Done {
    tag: string;
    id: string;
    uttIndex: number;
    sourceFinal: string;
  }

  /** Start a fixture transport and record every completion. */
  async function startTransport(
    deps: SessionDeps,
    config: LiveRunConfig,
    tag: string,
    sink: Done[],
  ) {
    const transport = deps.transportFactory(config);
    transport.setHandlers({
      onUtteranceComplete: (completion) => {
        const record = completion as UtteranceRecord;
        sink.push({
          tag,
          id: record.id,
          uttIndex: Number(record.id.replace('utt-', '')),
          sourceFinal: record.sourceFinal,
        });
      },
    });
    await transport.start(CONFIG);
    return transport;
  }

  // Live now switches ONE transport for another mid-session (an architecture
  // or provider change), so the replacement must pick up where the session
  // was rather than restarting the conversation from sentence one.
  it('a transport built mid-session joins the NEXT shared utterance, not index 0', async () => {
    const deps = buildFixtureDeps({ utterancesPerLoop: 2, utteranceSpacingMs: 1500 });
    const done: Done[] = [];

    const first = await startTransport(deps, CASCADE, 'first', done);
    await vi.advanceTimersByTimeAsync(2_250); // ~1.5 utterances into the timeline
    first.stop();
    const second = await startTransport(deps, CASCADE_ALT, 'second', done);
    await vi.advanceTimersByTimeAsync(4_500);
    second.stop();

    const later = done.filter((d) => d.tag === 'second');
    expect(later.length).toBeGreaterThan(0);
    const join = later[0]!;

    // The replacement does NOT replay the script from index 0…
    expect(join.uttIndex).toBeGreaterThan(0);
    // …and it continues contiguously from its join point.
    expect(later.map((d) => d.uttIndex)).toEqual(later.map((_, i) => join.uttIndex + i));
    // …on the shared sentence rotation, not a fresh one.
    expect(join.sourceFinal.length).toBeGreaterThan(0);
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
