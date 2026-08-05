/**
 * Ticket 011 — ArmRouter acceptance tests, driven by hand-rolled fake
 * transports (capture setHandlers, spy on sendAudio/stop).
 */
import { describe, expect, it, vi } from 'vitest';
import { ArmRouter } from './router';
import type {
  InterpreterTransport,
  TransportConfig,
  TransportHandlers,
} from './types';

class FakeTransport implements InterpreterTransport {
  readonly kind = 'cascade' as const;
  readonly label: string;
  readonly costPerMinUsd = 0;
  handlers: TransportHandlers = {};
  sendAudio = vi.fn();
  stop = vi.fn();
  started: TransportConfig[] = [];
  constructor(readonly armId: string) {
    this.label = `Fake ${armId}`;
  }
  async start(config: TransportConfig): Promise<void> {
    this.started.push(config);
  }
  setHandlers(handlers: TransportHandlers): void {
    this.handlers = handlers;
  }
}

function makeHarness(armIds: string[]) {
  const router = new ArmRouter();
  const transports = armIds.map((id) => new FakeTransport(id));
  for (const t of transports) router.addArm(t);
  return { router, transports };
}

describe('ArmRouter audio fan-out', () => {
  it('fans the SAME chunk reference out to every arm, in insertion order', () => {
    const { router, transports } = makeHarness(['arm-1', 'arm-2', 'arm-3']);
    const chunk = new Int16Array([1, 2, 3]);
    router.sendAudio(chunk);
    for (const t of transports) {
      expect(t.sendAudio).toHaveBeenCalledTimes(1);
      expect(t.sendAudio.mock.calls[0]![0]).toBe(chunk); // identity, no copy
    }
  });

  it('removeArm stops ONLY that arm; the rest keep receiving audio', () => {
    const { router, transports } = makeHarness(['arm-1', 'arm-2', 'arm-3']);
    const [t1, t2, t3] = transports;
    router.removeArm('arm-2');
    expect(t2!.stop).toHaveBeenCalledTimes(1);
    expect(t1!.stop).not.toHaveBeenCalled();
    expect(t3!.stop).not.toHaveBeenCalled();

    const chunk = new Int16Array([9]);
    router.sendAudio(chunk);
    expect(t1!.sendAudio).toHaveBeenCalledTimes(1);
    expect(t2!.sendAudio).not.toHaveBeenCalled();
    expect(t3!.sendAudio).toHaveBeenCalledTimes(1);
    expect(router.armIds).toEqual(['arm-1', 'arm-3']);
  });
});

describe('ArmRouter event funnel', () => {
  it('injects armId into every callback', () => {
    const { router, transports } = makeHarness(['arm-1', 'arm-2']);
    const [t1, t2] = transports;
    const seen: { cb: string; armId: string; extra?: unknown }[] = [];
    router.setHandlers({
      onSourceText: (e) => seen.push({ cb: 'source', armId: e.armId, extra: e.text }),
      onTargetText: (e) => seen.push({ cb: 'target', armId: e.armId, extra: e.text }),
      onAudio: (e) => seen.push({ cb: 'audio', armId: e.armId, extra: e.utt }),
      onTiming: (e) => seen.push({ cb: 'timing', armId: e.armId, extra: e.event }),
      onUtteranceComplete: (e) => seen.push({ cb: 'complete', armId: e.armId }),
      onError: (e) => seen.push({ cb: 'error', armId: e.armId, extra: e.message }),
      onConnectionState: (e) => seen.push({ cb: 'connection', armId: e.armId, extra: e.state }),
    });

    t1!.handlers.onSourceText?.({ kind: 'partial', text: 'a', utt: 0 });
    t2!.handlers.onTargetText?.({ kind: 'delta', text: 'b', utt: 0 });
    t1!.handlers.onAudio?.(new Int16Array([1]), 4);
    t2!.handlers.onTiming?.({ event: 'stt_final', t: 5, utt: 0 });
    t1!.handlers.onUtteranceComplete?.({ utt: 0 });
    t2!.handlers.onError?.({ message: 'boom', opaque: false });
    t1!.handlers.onConnectionState?.('reconnecting', 2);

    expect(seen).toEqual([
      { cb: 'source', armId: 'arm-1', extra: 'a' },
      { cb: 'target', armId: 'arm-2', extra: 'b' },
      { cb: 'audio', armId: 'arm-1', extra: 4 },
      { cb: 'timing', armId: 'arm-2', extra: 'stt_final' },
      { cb: 'complete', armId: 'arm-1' },
      { cb: 'error', armId: 'arm-2', extra: 'boom' },
      { cb: 'connection', armId: 'arm-1', extra: 'reconnecting' },
    ]);
  });

  it('forwards connection attempt numbers', () => {
    const { router, transports } = makeHarness(['arm-1']);
    const states: { armId: string; state: string; attempt?: number }[] = [];
    router.setHandlers({ onConnectionState: (e) => states.push(e) });
    transports[0]!.handlers.onConnectionState?.('reconnecting', 3);
    expect(states).toEqual([{ armId: 'arm-1', state: 'reconnecting', attempt: 3 }]);
  });

  it('setHandlers works when called BEFORE arms are added', () => {
    const router = new ArmRouter();
    const seen: string[] = [];
    router.setHandlers({ onSourceText: (e) => seen.push(`${e.armId}:${e.text}`) });
    const t = new FakeTransport('arm-late');
    router.addArm(t);
    t.handlers.onSourceText?.({ kind: 'partial', text: 'x', utt: 0 });
    expect(seen).toEqual(['arm-late:x']);
  });

  it('events from a removed arm no longer reach the router handlers', () => {
    const { router, transports } = makeHarness(['arm-1', 'arm-2']);
    const seen: string[] = [];
    router.setHandlers({ onSourceText: (e) => seen.push(e.armId) });
    router.removeArm('arm-1');
    // A late event from the removed arm's captured handlers must not leak.
    transports[0]!.handlers.onSourceText?.({ kind: 'partial', text: 'late', utt: 0 });
    transports[1]!.handlers.onSourceText?.({ kind: 'partial', text: 'ok', utt: 0 });
    expect(seen).toEqual(['arm-2']);
  });
});

describe('ArmRouter registry', () => {
  it('tracks armIds in insertion order and exposes getArm', () => {
    const { router, transports } = makeHarness(['arm-1', 'arm-2']);
    expect(router.armIds).toEqual(['arm-1', 'arm-2']);
    expect(router.getArm('arm-2')).toBe(transports[1]);
    expect(router.getArm('nope')).toBeUndefined();
  });

  it('rejects duplicate armIds', () => {
    const { router } = makeHarness(['arm-1']);
    expect(() => router.addArm(new FakeTransport('arm-1'))).toThrow();
  });

  it('removeArm of an unknown id is a no-op', () => {
    const { router } = makeHarness(['arm-1']);
    expect(() => router.removeArm('ghost')).not.toThrow();
    expect(router.armIds).toEqual(['arm-1']);
  });

  it('stopAll stops and removes every arm', () => {
    const { router, transports } = makeHarness(['arm-1', 'arm-2', 'arm-3']);
    router.stopAll();
    for (const t of transports) expect(t.stop).toHaveBeenCalledTimes(1);
    expect(router.armIds).toEqual([]);
    router.sendAudio(new Int16Array([1]));
    for (const t of transports) expect(t.sendAudio).not.toHaveBeenCalled();
  });
});
