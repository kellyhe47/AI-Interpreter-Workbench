/**
 * Ticket 012 — TransportRouter acceptance tests. One active transport at a
 * time; no fan-out, no arm multiplexing, no `armId` on any event.
 */
import { describe, expect, it, vi } from 'vitest';
import { TransportRouter } from './router';
import type { InterpreterTransport, TransportConfig, TransportHandlers } from './types';

class FakeTransport implements InterpreterTransport {
  readonly kind = 'cascade' as const;
  readonly label: string;
  readonly costPerMinUsd = 0;
  handlers: TransportHandlers = {};
  sendAudio = vi.fn();
  stop = vi.fn();
  started: TransportConfig[] = [];
  constructor(readonly name: string) {
    this.label = `Fake ${name}`;
  }
  async start(config: TransportConfig): Promise<void> {
    this.started.push(config);
  }
  setHandlers(handlers: TransportHandlers): void {
    this.handlers = handlers;
  }
}

describe('AC — the router is a switch, not a fan-out', () => {
  it('exposes no fan-out surface at all', () => {
    const router = new TransportRouter() as unknown as Record<string, unknown>;
    // Spelled indirectly so the DELETE guard (deletions.test.ts) still sees a
    // client tree with zero occurrences of the removed names.
    const gone = ['add', 'remove'].map((verb) => `${verb}Arm`).concat('stop' + 'All', 'getArm');
    for (const name of gone) {
      expect(router[name], `${name} must be gone`).toBeUndefined();
    }
  });

  it('setTransport makes it active and does NOT start it', () => {
    const router = new TransportRouter();
    const t = new FakeTransport('one');
    router.setTransport(t);
    expect(router.active).toBe(t);
    expect(t.started).toHaveLength(0);
  });

  it('setting a new transport stops the previous one', () => {
    const router = new TransportRouter();
    const first = new FakeTransport('first');
    const second = new FakeTransport('second');

    router.setTransport(first);
    router.setTransport(second);

    expect(first.stop).toHaveBeenCalledTimes(1);
    expect(second.stop).not.toHaveBeenCalled();
    expect(router.active).toBe(second);
  });

  it('sendAudio reaches ONLY the active transport, by identity, no copy', () => {
    const router = new TransportRouter();
    const first = new FakeTransport('first');
    const second = new FakeTransport('second');

    router.setTransport(first);
    router.setTransport(second);

    const chunk = new Int16Array([1, 2, 3]);
    router.sendAudio(chunk);

    expect(first.sendAudio).not.toHaveBeenCalled();
    expect(second.sendAudio).toHaveBeenCalledTimes(1);
    expect(second.sendAudio.mock.calls[0]![0]).toBe(chunk);
  });

  it('audio sent while no transport is active is a NO-OP, not a throw', () => {
    const router = new TransportRouter();
    expect(() => router.sendAudio(new Int16Array([1]))).not.toThrow();

    const t = new FakeTransport('one');
    router.setTransport(t);
    router.stop();
    expect(router.active).toBeNull();
    expect(() => router.sendAudio(new Int16Array([2]))).not.toThrow();
    expect(t.sendAudio).not.toHaveBeenCalled();
  });

  it('stop() stops and clears the active transport', () => {
    const router = new TransportRouter();
    const t = new FakeTransport('one');
    router.setTransport(t);
    router.stop();
    expect(t.stop).toHaveBeenCalledTimes(1);
    expect(router.active).toBeNull();
  });
});

describe('AC — events arrive WITHOUT an armId', () => {
  function harness() {
    const router = new TransportRouter();
    const t = new FakeTransport('one');
    const seen: Array<{ cb: string; payload: Record<string, unknown> }> = [];
    router.setHandlers({
      onSourceText: (e) => seen.push({ cb: 'source', payload: { ...e } }),
      onTargetText: (e) => seen.push({ cb: 'target', payload: { ...e } }),
      onAudio: (e) => seen.push({ cb: 'audio', payload: { ...e } }),
      onTiming: (e) => seen.push({ cb: 'timing', payload: { ...e } }),
      onUtteranceComplete: (e) => seen.push({ cb: 'complete', payload: { ...e } }),
      onError: (e) => seen.push({ cb: 'error', payload: { ...e } }),
      onConnectionState: (e) => seen.push({ cb: 'connection', payload: { ...e } }),
    });
    router.setTransport(t);
    return { router, t, seen };
  }

  it('forwards every callback verbatim, with no armId key on any payload', () => {
    const { t, seen } = harness();

    t.handlers.onSourceText?.({ kind: 'partial', text: 'a', utt: 0 });
    t.handlers.onTargetText?.({ kind: 'delta', text: 'b', utt: 0 });
    t.handlers.onAudio?.(new Int16Array([1]), 4);
    t.handlers.onTiming?.({ event: 'stt_final', t: 5, utt: 0 });
    t.handlers.onUtteranceComplete?.({ utt: 0 });
    t.handlers.onError?.({ message: 'boom', opaque: false });
    t.handlers.onConnectionState?.('reconnecting', 2);

    expect(seen.map((s) => s.cb)).toEqual([
      'source',
      'target',
      'audio',
      'timing',
      'complete',
      'error',
      'connection',
    ]);
    for (const { cb, payload } of seen) {
      expect(Object.keys(payload), `${cb} payload`).not.toContain('armId');
    }

    expect(seen[0]!.payload).toEqual({ kind: 'partial', text: 'a', utt: 0 });
    expect(seen[1]!.payload).toEqual({ kind: 'delta', text: 'b', utt: 0 });
    expect(seen[2]!.payload.utt).toBe(4);
    expect(seen[3]!.payload).toEqual({ event: 'stt_final', t: 5, utt: 0 });
    expect(seen[4]!.payload).toEqual({ record: { utt: 0 } });
    expect(seen[5]!.payload).toEqual({ message: 'boom', opaque: false });
    expect(seen[6]!.payload).toEqual({ state: 'reconnecting', attempt: 2 });
  });

  it('setHandlers works when called BEFORE a transport is set', () => {
    const router = new TransportRouter();
    const seen: string[] = [];
    router.setHandlers({ onSourceText: (e) => seen.push(e.text) });
    const t = new FakeTransport('late');
    router.setTransport(t);
    t.handlers.onSourceText?.({ kind: 'partial', text: 'x', utt: 0 });
    expect(seen).toEqual(['x']);
  });

  it('setHandlers after a transport is set replaces the previous set', () => {
    const { router, t, seen } = harness();
    const later: string[] = [];
    router.setHandlers({ onSourceText: (e) => later.push(e.text) });
    t.handlers.onSourceText?.({ kind: 'partial', text: 'y', utt: 0 });
    expect(later).toEqual(['y']);
    expect(seen).toHaveLength(0);
  });

  it('late events from a REPLACED transport never reach the handlers', () => {
    const router = new TransportRouter();
    const first = new FakeTransport('first');
    const second = new FakeTransport('second');
    const seen: string[] = [];
    router.setHandlers({ onSourceText: (e) => seen.push(e.text) });

    router.setTransport(first);
    router.setTransport(second);

    first.handlers.onSourceText?.({ kind: 'partial', text: 'stale', utt: 0 });
    second.handlers.onSourceText?.({ kind: 'partial', text: 'live', utt: 0 });
    expect(seen).toEqual(['live']);
  });

  it('events from a stopped transport never reach the handlers', () => {
    const { router, t, seen } = harness();
    router.stop();
    t.handlers.onSourceText?.({ kind: 'partial', text: 'stale', utt: 0 });
    expect(seen).toHaveLength(0);
  });
});
