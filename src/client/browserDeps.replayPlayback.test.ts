/**
 * Ticket 049 — Replay's play presses must not accumulate AudioContexts.
 *
 * `playRun` / `playTake` each did `new AudioContext()` per press and never
 * released it. Chrome caps contexts per document (~6), so a QA pass playing a
 * dozen Replay runs exhausts the cap and the NEXT `new AudioContext()` anywhere
 * in the document throws — which is what makes the hostile-context path of this
 * ticket reachable in practice rather than theoretically.
 *
 * ============================ THE DECISION =================================
 * ONE REUSED CONTEXT per deps bag, created lazily on the first press, shared by
 * `playRun` and `playTake` — NOT close()-per-press.
 *
 * Why reuse and not close: `close()` is asynchronous and returns a promise the
 * press path does not await, so closing "the previous one" races the source
 * that is still sounding — the audible failure mode is a clip that cuts itself
 * off. Reuse has neither problem, matches what the `remoteAudioSink` element
 * already does (one element per bag, re-attached), and a suspended-by-policy
 * context is resumed by `ArmPlayback.play()` on every press anyway.
 *
 * LAZILY, not at bag construction: `buildReplayDeps()` runs at module wiring
 * time, and a context built there would be built on a page that may never press
 * play — which is the same "nothing in Replay autoplays" rule (PRD §7) seen from
 * the resource side.
 * ==========================================================================
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { writeWav } from '../harness/wav';
import { buildBrowserDeps, buildReplayDeps } from './browserDeps';
import type { RecordedTake } from './replay/capture';
import type { ReplayDeps } from './views/ReplayView';
import { matchingLines, readSource } from './testSource';

/**
 * A fake `AudioContext` standing in for the real constructor, with an optional
 * per-document CAP — the actual Chrome behaviour this ticket is about.
 */
class FakeAudioContext {
  static constructed = 0;
  static limit = Infinity;
  static instances: FakeAudioContext[] = [];

  destination = { fake: 'destination' };
  currentTime = 0;
  closed = false;
  /** Every buffer length this context was asked to create, in order. */
  buffers: number[] = [];
  started = 0;

  constructor() {
    FakeAudioContext.constructed += 1;
    if (FakeAudioContext.constructed > FakeAudioContext.limit) {
      const err = new Error('the number of hardware contexts reached the maximum');
      err.name = 'NotSupportedError';
      throw err;
    }
    FakeAudioContext.instances.push(this);
  }

  createBuffer(_channels: number, length: number) {
    this.buffers.push(length);
    return { getChannelData: () => new Float32Array(length) };
  }
  createBufferSource() {
    return {
      buffer: null,
      connect: () => {},
      start: () => {
        this.started += 1;
      },
      stop: () => {},
      onended: null,
    };
  }
  resume(): void {}
  suspend(): void {}
  async close(): Promise<void> {
    this.closed = true;
  }
}

function installFakeAudioContext(limit = Infinity): void {
  FakeAudioContext.constructed = 0;
  FakeAudioContext.instances = [];
  FakeAudioContext.limit = limit;
  (globalThis as unknown as Record<string, unknown>).AudioContext = FakeAudioContext;
}

afterEach(() => {
  delete (globalThis as unknown as Record<string, unknown>).AudioContext;
  vi.unstubAllGlobals();
});

/** `playTake` is optional on ReplayDeps; the production bag always wires it. */
function takePlayer(replay: ReplayDeps): (t: RecordedTake) => void {
  const fn = replay.playTake;
  if (!fn) throw new Error('buildReplayDeps() published no playTake');
  return fn;
}

function take(samples: number): RecordedTake {
  const pcm = new Int16Array(samples).fill(1000);
  return { samples: pcm, wav: writeWav(pcm, 24000), durationMs: (samples / 24000) * 1000 };
}

describe('Replay playback reuses ONE AudioContext (ticket 049)', () => {
  it('TEN playTake presses construct exactly ONE context — and all ten are played', () => {
    installFakeAudioContext();
    const replay = buildReplayDeps();

    // Nothing built until a press: the bag is constructed at page wiring time.
    expect(FakeAudioContext.constructed).toBe(0);

    const play = takePlayer(replay);
    for (let i = 0; i < 10; i++) {
      expect(() => play(take(240 + i))).not.toThrow();
    }

    expect(FakeAudioContext.constructed).toBe(1);
    // ...and the one context really did every press — a bag that quietly played
    // nothing would also construct one context (or none).
    const ctx = FakeAudioContext.instances[0]!;
    expect(ctx.buffers).toEqual([240, 241, 242, 243, 244, 245, 246, 247, 248, 249]);
    expect(ctx.started).toBe(10);
    // Reuse, not close-per-press: a closed context cannot sound the next press.
    expect(ctx.closed).toBe(false);
  });

  it('playRun shares that SAME context — one per bag, not one per seam', async () => {
    installFakeAudioContext();
    const wav = writeWav(new Int16Array(480).fill(1000), 24000);
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => ({
        ok: true,
        status: 200,
        arrayBuffer: async () => wav.buffer.slice(wav.byteOffset, wav.byteOffset + wav.byteLength),
      })),
    );
    const replay = buildReplayDeps();

    takePlayer(replay)(take(240));
    replay.playRun('run-1');
    await vi.waitFor(() => expect(FakeAudioContext.instances[0]!.buffers).toHaveLength(2));

    expect(FakeAudioContext.constructed).toBe(1);
    expect(FakeAudioContext.instances[0]!.buffers).toEqual([240, 480]);
  });

  it('TEN Replay presses, THEN a Live session — the sequence that motivated this ticket', async () => {
    // Chrome's real cap. Before this ticket the 7th press threw out of the click
    // handler and every `new AudioContext()` after it — including Live's — threw
    // too, which is exactly how the hostile-context path was reached in QA.
    installFakeAudioContext(6);
    const deps = buildBrowserDeps();

    const play = takePlayer(deps.replay);
    for (let i = 0; i < 10; i++) {
      expect(() => play(take(240))).not.toThrow();
    }

    // Now go to Live and start a session: the playback context still builds.
    expect(() => deps.playbackContextFactory()).not.toThrow();
    expect(FakeAudioContext.constructed).toBeLessThanOrEqual(6);
  });
});

describe('the comment that justifies the sink’s play()/pause() states the real reason', () => {
  it('SOURCE GUARD: it no longer claims Replay drives this object', () => {
    // Narrow, and scoped to the CLAIM rather than the vocabulary (the 047 R3-4
    // precedent). Every non-test caller of the sink was grepped: the only one in
    // the client is `realtime.ts` `remoteAudioSink?.attach(stream)`. Replay does
    // NOT call play() or pause() — those methods survive because they sit on the
    // shared `RemoteAudioSink` interface, which ticket 047 permitted on the
    // seam. A comment that misnames its own reason sends the next reader to
    // delete the wrong half.
    expect(
      matchingLines(readSource('src/client/browserDeps.ts'), /muted sink is this same object/i),
    ).toEqual([]);
  });
});
