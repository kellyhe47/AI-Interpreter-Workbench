/**
 * Ticket 011 — FixtureTransport acceptance tests (fake timers).
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { FixtureTransport, type FixtureScriptEvent } from './fixture';
import type { TransportConfig, TransportError } from './types';

const config: TransportConfig = {
  languagePair: 'EN↔ES',
  direction: 'en→es',
  targetLanguage: 'Spanish',
};

beforeEach(() => {
  vi.useFakeTimers();
});
afterEach(() => {
  vi.useRealTimers();
});

function collect(transport: FixtureTransport) {
  const events: { kind: string; payload: unknown }[] = [];
  transport.setHandlers({
    onSourceText: (e) => events.push({ kind: 'source', payload: e }),
    onTargetText: (e) => events.push({ kind: 'target', payload: e }),
    onAudio: (pcm, utt) => events.push({ kind: 'audio', payload: { pcm, utt } }),
    onTiming: (m) => events.push({ kind: 'timing', payload: m }),
    onUtteranceComplete: (r) => events.push({ kind: 'complete', payload: r }),
    onError: (e) => events.push({ kind: 'error', payload: e }),
    onConnectionState: (state, attempt) =>
      events.push({ kind: 'connection', payload: { state, attempt } }),
  });
  return events;
}

describe('FixtureTransport', () => {
  it('plays the script on timers, in at-order, over the shared handler surface', async () => {
    const pcm = new Int16Array([1, 2, 3]);
    const script: FixtureScriptEvent[] = [
      { at: 10, type: 'sourceText', kind: 'partial', text: 'hel', utt: 0 },
      { at: 20, type: 'targetText', kind: 'delta', text: 'ho', utt: 0 },
      { at: 30, type: 'audio', pcm, utt: 0 },
      { at: 40, type: 'timing', event: 'tts_first_byte', utt: 0, t: 700, stage: 'tts' },
      { at: 50, type: 'utteranceComplete', record: { utt: 0 } },
    ];
    const t = new FixtureTransport({ armId: 'arm-fx', script });
    const events = collect(t);
    await t.start(config);

    expect(events.map((e) => e.kind)).toEqual(['connection']); // connected up-front
    expect(events[0]!.payload).toMatchObject({ state: 'connected' });

    vi.advanceTimersByTime(10);
    expect(events.at(-1)).toEqual({
      kind: 'source',
      payload: { kind: 'partial', text: 'hel', utt: 0 },
    });
    vi.advanceTimersByTime(40);
    expect(events.map((e) => e.kind)).toEqual([
      'connection',
      'source',
      'target',
      'audio',
      'timing',
      'complete',
    ]);
    expect(events[3]!.payload).toMatchObject({ utt: 0 });
    expect(events[4]!.payload).toMatchObject({ event: 'tts_first_byte', t: 700, stage: 'tts' });
  });

  it('injects faults via error script events (verbatim) and failStart', async () => {
    const script: FixtureScriptEvent[] = [
      { at: 5, type: 'error', message: 'STT provider 429 · stage: stt', opaque: false, stage: 'stt' },
      { at: 10, type: 'connection', state: 'reconnecting', attempt: 1 },
    ];
    const t = new FixtureTransport({ armId: 'arm-fx', script });
    const events = collect(t);
    await t.start(config);
    vi.advanceTimersByTime(10);
    const err = events.find((e) => e.kind === 'error')?.payload as TransportError;
    expect(err).toMatchObject({ message: 'STT provider 429 · stage: stt', opaque: false, stage: 'stt' });
    expect(events.at(-1)!.payload).toMatchObject({ state: 'reconnecting', attempt: 1 });

    // failStart fault: start still resolves (no unhandled rejection), error surfaces.
    const failing = new FixtureTransport({ armId: 'arm-bad', script: [], failStart: true });
    const failEvents = collect(failing);
    await expect(failing.start(config)).resolves.toBeUndefined();
    expect(failEvents.some((e) => e.kind === 'error')).toBe(true);
    expect(
      failEvents.some(
        (e) => e.kind === 'connection' && (e.payload as { state: string }).state === 'disconnected',
      ),
    ).toBe(true);
  });

  it('stop() cancels pending timers — no events after stop', async () => {
    const script: FixtureScriptEvent[] = [
      { at: 10, type: 'sourceText', kind: 'partial', text: 'a', utt: 0 },
      { at: 100, type: 'sourceText', kind: 'final', text: 'ab', utt: 0 },
    ];
    const t = new FixtureTransport({ armId: 'arm-fx', script });
    const events = collect(t);
    await t.start(config);
    vi.advanceTimersByTime(10);
    const countAtStop = events.length;
    t.stop();
    vi.advanceTimersByTime(1000);
    expect(events.length).toBe(countAtStop);
  });

  it('records sendAudio chunks in `received` for fan-out assertions', () => {
    const t = new FixtureTransport({ armId: 'arm-fx', script: [] });
    const a = new Int16Array([1]);
    const b = new Int16Array([2]);
    t.sendAudio(a);
    t.sendAudio(b);
    expect(t.received).toEqual([a, b]);
    expect(t.received[0]).toBe(a); // same reference, not a copy
  });
});
