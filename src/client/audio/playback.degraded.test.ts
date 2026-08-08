/**
 * Ticket 049 — a hostile AudioContext DEGRADES playback; it never kills it.
 *
 * `ArmPlayback` builds its context lazily, inside `enqueue`. `new AudioContext()`
 * throws for real (Chrome at its ~6-per-document limit, reachable after a Replay
 * QA pass; Safari under some policy states), and that throw escaped from inside
 * the TRANSPORT'S `onAudio` callback — where nothing catches it. Ticket 047 R3-1
 * fixed only the Start-gesture path and said so in an in-file note.
 *
 * =============================== THE DESIGN ================================
 * A construction failure is REPORTED, not thrown, and it is reported from the
 * one place where sound was actually lost:
 *
 *   new ArmPlayback({ ..., onPlaybackUnavailable?: (error: unknown) => void })
 *   playback.playbackUnavailable: boolean
 *
 * - `enqueue` that cannot get a context still does ALL of its MEASUREMENT work
 *   (audioQueuedAt, durationMs), drops the sound, sets `playbackUnavailable`
 *   and calls `onPlaybackUnavailable` — ONCE per playback, however many chunks
 *   arrive and however many utterances follow.
 * - `play()` that cannot get a context does NOT report. This is what keeps
 *   REALTIME honest: the controller calls `play()` once inside the Start
 *   gesture (047 R2-3) purely to resume a possibly-suspended context, and a
 *   realtime session never enqueues a single PCM chunk — its audio rides the
 *   `remoteAudioSink` element. Reporting from `play()` would put "no audio
 *   output" on screen during a session that is audible.
 * - The factory is attempted ONCE. A context limit does not un-fill itself
 *   mid-session, and re-attempting per chunk means one throw per 20 ms frame.
 *
 * ROUND 2 — ...but not once per PAGE. `clearPlaybackFailure()` drops the latch
 * so the next attempt is made afresh; the controller calls it from
 * `newSession` and NEVER from `reset()`. A cap frees when some other context
 * closes and Safari's policy state changes, so "reload the tab" was the wrong
 * and only cure; between two sentences of one session, though, nothing has
 * changed and retrying would throw once per 20 ms frame.
 * ==========================================================================
 */
import { describe, expect, it, vi } from 'vitest';
import { matchingLines, readCode } from '../testSource';
import {
  ArmPlayback,
  type PlaybackAudioContextLike,
  type PlaybackBufferLike,
  type PlaybackSourceLike,
} from './playback';

const chunk = (len: number, value = 1000): Int16Array => new Int16Array(len).fill(value);

/** The real throw, verbatim from Chrome at its per-document context limit. */
function contextLimitError(): Error {
  const err = new Error('the number of hardware contexts reached the maximum');
  err.name = 'NotSupportedError';
  return err;
}

function hostileFactory() {
  return vi.fn((): PlaybackAudioContextLike => {
    throw contextLimitError();
  });
}

interface WorkingContext {
  context: PlaybackAudioContextLike;
  started: number[];
  resumes: number;
}

function workingContext(): WorkingContext {
  const rec: WorkingContext = {
    started: [],
    resumes: 0,
    context: null as unknown as PlaybackAudioContextLike,
  };
  let length = 0;
  rec.context = {
    createBuffer: (_ch: number, len: number): PlaybackBufferLike => {
      length = len;
      return { getChannelData: () => new Float32Array(len) };
    },
    createBufferSource: (): PlaybackSourceLike => {
      const captured = length;
      return {
        buffer: null,
        connect: () => {},
        start: () => rec.started.push(captured),
        stop: () => {},
        onended: null,
      };
    },
    destination: {},
    currentTime: 0,
    resume: () => {
      rec.resumes += 1;
    },
    suspend: () => {},
  };
  return rec;
}

function makeHostile() {
  const factory = hostileFactory();
  const onPlaybackUnavailable = vi.fn();
  const clock = { t: 1000 };
  const playback = new ArmPlayback({
    audioContextFactory: factory,
    autoplay: true,
    now: () => clock.t,
    onPlaybackUnavailable,
  });
  return { factory, onPlaybackUnavailable, playback, clock };
}

describe('ArmPlayback survives a context that cannot be constructed (ticket 049)', () => {
  it('enqueue does not throw — the transport callback it runs inside is uncaught', () => {
    const { playback } = makeHostile();
    expect(() => playback.enqueue(chunk(480))).not.toThrow();
    expect(() => playback.enqueue(chunk(480))).not.toThrow();
  });

  it('MEASUREMENT IS UNTOUCHED: audioQueuedAt and durationMs match the healthy run exactly', () => {
    // Sound is not a measurement. The same three chunks through a working
    // context and through a hostile one must produce the same numbers.
    const measure = (factory: () => PlaybackAudioContextLike) => {
      const clock = { t: 1000 };
      const playback = new ArmPlayback({
        audioContextFactory: factory,
        autoplay: true,
        now: () => clock.t,
        onPlaybackUnavailable: () => {},
      });
      playback.enqueue(chunk(480));
      clock.t = 1500;
      playback.enqueue(chunk(480));
      playback.enqueue(chunk(240));
      return { queuedAt: playback.audioQueuedAt, durationMs: playback.durationMs };
    };

    const healthy = measure(() => workingContext().context);
    const hostile = measure(hostileFactory());

    expect(healthy).toEqual({ queuedAt: 1000, durationMs: 50 });
    expect(hostile).toEqual(healthy);
  });

  it('the operator is told EXACTLY ONCE — across chunks, and across utterances', () => {
    const { playback, onPlaybackUnavailable, factory } = makeHostile();

    playback.enqueue(chunk(480));
    expect(onPlaybackUnavailable).toHaveBeenCalledTimes(1);
    expect(onPlaybackUnavailable.mock.calls[0]![0]).toBeInstanceOf(Error);
    expect(playback.playbackUnavailable).toBe(true);

    playback.enqueue(chunk(480));
    playback.enqueue(chunk(480));
    // reset() = the next utterance. The context limit has not un-filled itself.
    playback.reset();
    playback.enqueue(chunk(480));
    playback.enqueue(chunk(480));

    expect(onPlaybackUnavailable).toHaveBeenCalledTimes(1);
    // ...and the state SURVIVES reset(): a notice that flickers off at every
    // utterance boundary is not a surfaced state.
    expect(playback.playbackUnavailable).toBe(true);
    // One attempt, ever: re-trying per 20 ms frame is one throw per frame.
    expect(factory).toHaveBeenCalledTimes(1);
  });

  it('play() alone does NOT report — this is what keeps REALTIME honest', () => {
    // The controller calls play() once inside the Start gesture (047 R2-3) to
    // resume a possibly-suspended context. A realtime session then enqueues
    // NOTHING — its audio rides the remoteAudioSink element — so a failure
    // here has cost the operator no sound at all and must not say it has.
    const { playback, onPlaybackUnavailable, factory } = makeHostile();

    expect(() => playback.play()).not.toThrow();

    expect(onPlaybackUnavailable).not.toHaveBeenCalled();
    expect(playback.playbackUnavailable).toBe(false);
    expect(factory).toHaveBeenCalledTimes(1);
  });

  it('...but a chunk arriving AFTER that failed play() does report — the cascade shape', () => {
    const { playback, onPlaybackUnavailable, factory } = makeHostile();

    playback.play();
    playback.enqueue(chunk(480));

    expect(onPlaybackUnavailable).toHaveBeenCalledTimes(1);
    expect(playback.playbackUnavailable).toBe(true);
    // Still ONE attempt in total — the failed play() is not retried by enqueue.
    expect(factory).toHaveBeenCalledTimes(1);
  });

  it('REGRESSION GUARD: a healthy context reports nothing and still plays every chunk', () => {
    const rec = workingContext();
    const onPlaybackUnavailable = vi.fn();
    const playback = new ArmPlayback({
      audioContextFactory: () => rec.context,
      autoplay: true,
      now: () => 1000,
      onPlaybackUnavailable,
    });

    playback.play();
    playback.enqueue(chunk(480));
    playback.enqueue(chunk(240));

    expect(rec.started).toEqual([480, 240]);
    expect(rec.resumes).toBe(1);
    expect(onPlaybackUnavailable).not.toHaveBeenCalled();
    expect(playback.playbackUnavailable).toBe(false);
  });
});

describe('a transient failure is recoverable — clearPlaybackFailure() (round 2, R2-6)', () => {
  it('retries the factory and sounds again, and the state goes back to healthy', () => {
    const rec = workingContext();
    let hostile = true;
    const factory = vi.fn((): PlaybackAudioContextLike => {
      if (hostile) throw contextLimitError();
      return rec.context;
    });
    const onPlaybackUnavailable = vi.fn();
    const playback = new ArmPlayback({
      audioContextFactory: factory,
      autoplay: true,
      now: () => 1000,
      onPlaybackUnavailable,
    });

    playback.enqueue(chunk(480));
    expect(playback.playbackUnavailable).toBe(true);
    expect(rec.started).toEqual([]);

    // The browser recovers; the operator starts a new session.
    hostile = false;
    playback.clearPlaybackFailure();
    playback.reset();
    playback.enqueue(chunk(240));

    expect(factory).toHaveBeenCalledTimes(2);
    expect(rec.started).toEqual([240]);
    expect(playback.playbackUnavailable).toBe(false);
    // The report stays a ONE-SHOT across the recovery: the operator was told
    // once, about the failure that happened.
    expect(onPlaybackUnavailable).toHaveBeenCalledTimes(1);
    // ...and the recovered context keeps sounding later chunks.
    playback.enqueue(chunk(480));
    expect(rec.started).toEqual([240, 480]);
  });

  it('M10 GUARD: reset() alone still clears NOTHING — between sentences nothing changed', () => {
    const { playback, factory, onPlaybackUnavailable } = makeHostile();
    playback.enqueue(chunk(480));
    playback.reset();
    playback.enqueue(chunk(480));

    expect(playback.playbackUnavailable).toBe(true);
    expect(factory).toHaveBeenCalledTimes(1);
    expect(onPlaybackUnavailable).toHaveBeenCalledTimes(1);
  });
});

describe('play() never DISCARDS queued audio on the failure path (round 2, R2-4)', () => {
  it('STRUCTURAL GUARD: the ctx === null branch clears no queue', () => {
    // The branch is UNREACHABLE — a queue exists only when a context was
    // successfully built, and a built context is cached — so there is no
    // behavioural partner for this one, and it is labelled accordingly. It is
    // pinned anyway because of what it READS as: "drop the queued audio and say
    // nothing", the single thing this ticket forbids. The honest failure path
    // is `if (ctx === null) return;`.
    //
    // KNOWN ESCAPE ROUTE, written down rather than implied: a different idiom
    // (`this.buffered.length = 0`, `this.buffered.splice(0)`) is not matched.
    const code = readCode('src/client/audio/playback.ts');
    const body = code.slice(code.indexOf('play(): void {'), code.indexOf('pause(): void {'));
    // Exactly ONE — the legitimate drain in the success path
    // (`const pending = this.buffered; this.buffered = [];`).
    expect(matchingLines(body, /this\.buffered\s*=\s*\[\]/)).toHaveLength(1);
  });
});
