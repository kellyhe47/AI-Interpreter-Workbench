/**
 * Ticket 011 — FixtureTransport acceptance tests (fake timers).
 * Ticket 008 — plus the REPLAY path: a fixture driven from a Recording.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { isRealRun, type Run } from '../state/ledger';
import {
  FIXTURE_PROVIDERS,
  FixtureTransport,
  createReplayFixtureTransport,
  replayFixtureScript,
  type FixtureScriptEvent,
  type ReplayRecordingLike,
} from './fixture';
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

/* ===========================================================================
 * Ticket 008 — the fixture serves REPLAY as well as Live.
 * ======================================================================== */

const RECORDING: ReplayRecordingLike = { id: 'rec-1', durationMs: 4000, speechEndMs: 3200 };

/** Cascade + realtime timestamp names from src/core/timing.ts. */
const CASCADE_MARKS = ['speech_end', 'vad_fired', 'stt_final', 'mt_first_token', 'tts_first_byte'];
const REALTIME_MARKS = ['speech_end', 'server_speech_stopped', 'first_audio_delta'];

function play(transport: FixtureTransport) {
  const events = collect(transport);
  return {
    events,
    async run() {
      await transport.start(config);
      vi.advanceTimersByTime(60_000);
      return events;
    },
  };
}

describe('FixtureTransport — driven from a Recording (Replay)', () => {
  it('derives a script from the Recording, answering only AFTER its speech end', () => {
    const script = replayFixtureScript({ recording: RECORDING });

    expect(script.length).toBeGreaterThan(0);
    for (const ev of script) {
      expect(ev.at).toBeGreaterThanOrEqual(RECORDING.speechEndMs);
      expect(Number.isFinite(ev.at)).toBe(true);
    }
    // A different Recording moves the whole timeline with it.
    const shorter = replayFixtureScript({
      recording: { id: 'rec-2', durationMs: 1000, speechEndMs: 800 },
    });
    expect(Math.min(...shorter.map((e) => e.at))).toBeLessThan(
      Math.min(...script.map((e) => e.at)),
    );
  });

  it('produces a well-formed cascade utterance timeline over the handler surface', async () => {
    const t = createReplayFixtureTransport({ recording: RECORDING });
    const events = await play(t).run();

    const kinds = events.map((e) => e.kind);
    expect(kinds[0]).toBe('connection');
    expect(events[0]!.payload).toMatchObject({ state: 'connected' });

    const source = events.filter((e) => e.kind === 'source').map((e) => e.payload as { kind: string; text: string; utt: number });
    const target = events.filter((e) => e.kind === 'target').map((e) => e.payload as { kind: string; text: string; utt: number });
    const marks = events.filter((e) => e.kind === 'timing').map((e) => e.payload as { event: string; t: number; utt: number });
    const audio = events.filter((e) => e.kind === 'audio').map((e) => e.payload as { pcm: Int16Array; utt: number });
    const completes = events.filter((e) => e.kind === 'complete');

    // source: at least one partial, then exactly one final, last.
    expect(source.filter((s) => s.kind === 'partial').length).toBeGreaterThanOrEqual(1);
    expect(source.filter((s) => s.kind === 'final')).toHaveLength(1);
    expect(source.at(-1)!.kind).toBe('final');
    expect(source.at(-1)!.text.length).toBeGreaterThan(0);

    // target: at least one delta, then exactly one final, last.
    expect(target.filter((s) => s.kind === 'delta').length).toBeGreaterThanOrEqual(1);
    expect(target.filter((s) => s.kind === 'final')).toHaveLength(1);
    expect(target.at(-1)!.kind).toBe('final');
    expect(target.at(-1)!.text.length).toBeGreaterThan(0);

    // timing marks: canonical cascade vocabulary only, in non-decreasing order.
    expect(marks.length).toBeGreaterThanOrEqual(4);
    for (const m of marks) expect(CASCADE_MARKS).toContain(m.event);
    for (const name of ['vad_fired', 'stt_final', 'mt_first_token', 'tts_first_byte']) {
      expect(marks.map((m) => m.event)).toContain(name);
    }
    const ts = marks.map((m) => m.t);
    expect([...ts].sort((a, b) => a - b)).toEqual(ts);

    // audio, then exactly one utterance completion, last of everything.
    expect(audio.length).toBeGreaterThanOrEqual(1);
    for (const a of audio) {
      expect(a.pcm).toBeInstanceOf(Int16Array);
      expect(a.pcm.length).toBeGreaterThan(0);
    }
    expect(completes).toHaveLength(1);
    expect(kinds.at(-1)).toBe('complete');

    // One utterance, numbered 0.
    for (const e of [...source, ...target, ...marks, ...audio]) expect(e.utt).toBe(0);
    // A replay produces no errors and no reconnects.
    expect(kinds.filter((k) => k === 'error')).toHaveLength(0);
    expect(kinds.filter((k) => k === 'connection')).toHaveLength(1);
  });

  it('speaks the realtime timing vocabulary when kind is realtime', async () => {
    const t = createReplayFixtureTransport({ recording: RECORDING, kind: 'realtime' });
    expect(t.kind).toBe('realtime');
    const events = await play(t).run();

    const names = events
      .filter((e) => e.kind === 'timing')
      .map((e) => (e.payload as { event: string }).event);
    expect(names).toContain('server_speech_stopped');
    expect(names).toContain('first_audio_delta');
    for (const name of names) expect(REALTIME_MARKS).toContain(name);
    // No cascade-only stage marks leak into a realtime replay.
    expect(names).not.toContain('stt_final');
    expect(names).not.toContain('tts_first_byte');
  });

  it('advertises fixture-named providers, so nothing it produces can be reported', () => {
    const t = createReplayFixtureTransport({ recording: RECORDING });
    expect(t.providers).toEqual({ stt: 'fixture', mt: 'fixture', tts: 'fixture' });
    expect(t.providers).toEqual(FIXTURE_PROVIDERS);
    // Plain FixtureTransports are fixture-named too, by default.
    expect(new FixtureTransport({ armId: 'arm-fx', script: [] }).providers).toEqual(
      FIXTURE_PROVIDERS,
    );

    // The ledger's realness rule rejects a Run carrying that triple.
    const run: Run = {
      id: 'run-fx',
      recordingId: RECORDING.id,
      architecture: 'cascade',
      providerTriple: t.providers,
      modelSnapshots: { ...t.providers },
      armTag: 'ad-hoc',
      origin: 'manual',
      status: 'complete',
      timings: { speech_end: 0, audio_queued: 500 },
      transcripts: { source: 'hello', target: 'hola' },
      cost: 0,
      errors: [],
      createdAt: 0,
    };
    expect(isRealRun(run)).toBe(false);
  });

  it('stop() silences a replay script mid-flight, like any other', async () => {
    const t = createReplayFixtureTransport({ recording: RECORDING });
    const events = collect(t);
    await t.start(config);
    vi.advanceTimersByTime(RECORDING.speechEndMs);
    t.stop();
    const count = events.length;
    vi.advanceTimersByTime(60_000);
    expect(events.length).toBe(count);
  });
});
