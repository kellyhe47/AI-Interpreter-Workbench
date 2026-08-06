/**
 * Replay pacer — feeds a recorded clip into a consumer at 1x real time, in the
 * same 20 ms framing live microphone capture uses.
 * Isomorphic TypeScript — no node/DOM imports.
 *
 * WHY THIS EXISTS (PRD §7, §17 19d):
 *   Replay only produces trustworthy numbers if the audio arrives the way a
 *   live microphone would deliver it. Dumping a Recording's buffer as fast as
 *   the socket accepts it would invalidate VAD, endpointing and every latency
 *   figure derived from them — and it would LOOK like it worked: the
 *   transcript would still come back, the run would still complete, and the
 *   measurements would silently be fiction. So pacing is not a nicety here;
 *   it is the entire reason a Replay run means anything.
 *
 * ============================ API DESIGN (normative) =======================
 * FRAME_MS       — frame duration in ms (20).
 * FRAME_SAMPLES  — samples per frame, DERIVED from SAMPLE_RATE and FRAME_MS
 *                  (SAMPLE_RATE * FRAME_MS / 1000 = 480 at 24 kHz). Derived,
 *                  never a second literal: the two constants must not be able
 *                  to desynchronize if the wire sample rate ever moves.
 *
 * createPacer({ samples, onFrame, signal?, deps? }): Pacer
 *   - samples: 24 kHz mono PCM16 clip to feed.
 *   - onFrame: receives each frame, in order. May be async; it is awaited, but
 *              awaiting it never moves the schedule anchor (see PACING).
 *              Frames are `subarray` views over the input, not copies.
 *   - signal:  optional AbortSignal; aborting behaves exactly like cancel().
 *   - deps:    injected seams, each defaulting to the real one —
 *              now() (ms clock), setTimeout(fn, ms) -> handle,
 *              clearTimeout(handle). The pacer NEVER reaches for
 *              Date.now/setTimeout directly once a seam is supplied, so tests
 *              drive a full second of playback in virtual time.
 *
 * FRAMING
 *   A clip of N samples becomes ceil(N / FRAME_SAMPLES) frames. Every frame
 *   but the last is exactly FRAME_SAMPLES; a trailing partial frame is emitted
 *   once, whole — never dropped, never zero-padded (padding would feed silence
 *   into VAD; dropping would truncate the utterance).
 *
 * PACING — WALL-CLOCK ANCHORED, NOT CUMULATIVE
 *   Frame n is due at `t0 + n * FRAME_MS`, and the pacer waits
 *   `max(0, due - now())`. It does NOT emit-then-sleep-20ms: with a cumulative
 *   anchor, a consumer that stalls for 50 ms on one frame pushes every later
 *   frame permanently 50 ms late, quietly stretching the clip past 1x. With a
 *   wall-clock anchor the stall makes the next frames overdue — they are
 *   emitted immediately, in order, and the schedule re-anchors on t0.
 *
 * CANCELLATION
 *   cancel() (or abort) is idempotent, stops emission promptly, emits no
 *   further frames, clears the pending timer through the injected
 *   clearTimeout (no leaked timer), and lets start() resolve cleanly — it
 *   never rejects on cancel. An already-cancelled/aborted pacer emits nothing.
 * ==========================================================================
 */

import { SAMPLE_RATE } from '../../core/protocol';

/** Frame duration in ms — the framing live capture uses. */
export const FRAME_MS = 20;

/** Samples per frame at SAMPLE_RATE (480 at 24 kHz). Derived, not a literal. */
export const FRAME_SAMPLES = (SAMPLE_RATE * FRAME_MS) / 1000;

export interface PacerDeps {
  /** Monotonic-ish ms clock (performance.now / Date.now style). */
  now: () => number;
  /** Schedules `fn` after `ms`; returns an opaque handle. */
  setTimeout: (fn: () => void, ms: number) => unknown;
  /** Cancels a handle previously returned by setTimeout. */
  clearTimeout: (handle: unknown) => void;
}

export interface PacerOptions {
  /** 24 kHz mono PCM16 clip. */
  samples: Int16Array;
  /** Receives each frame, in order. */
  onFrame: (frame: Int16Array) => void | Promise<void>;
  /** Optional external abort; aborting behaves like cancel(). */
  signal?: AbortSignal;
  /** Injected clock/scheduler seams; each defaults to the real one. */
  deps?: Partial<PacerDeps>;
}

export interface Pacer {
  /** Emits the clip at 1x; resolves when finished or cancelled. */
  start(): Promise<void>;
  /** Stops emission promptly. Idempotent. */
  cancel(): void;
}

/** Real seams, so production callers need not supply `deps` at all. */
const REAL_DEPS: PacerDeps = {
  now: () => Date.now(),
  setTimeout: (fn: () => void, ms: number): unknown => globalThis.setTimeout(fn, ms),
  clearTimeout: (handle: unknown): void => {
    globalThis.clearTimeout(handle as ReturnType<typeof globalThis.setTimeout>);
  },
};

export function createPacer(options: PacerOptions): Pacer {
  const { samples, onFrame, signal } = options;
  const deps: PacerDeps = { ...REAL_DEPS, ...options.deps };

  let cancelled = signal?.aborted ?? false;
  /** Handle of the timer we are currently waiting on, if any. */
  let pending: unknown = null;
  /** Resolves the in-flight wait early when cancelled. */
  let wake: (() => void) | null = null;

  function cancel(): void {
    if (cancelled) return;
    cancelled = true;
    if (pending !== null) {
      deps.clearTimeout(pending);
      pending = null;
    }
    const resume = wake;
    wake = null;
    resume?.();
  }

  if (signal !== undefined && !signal.aborted) {
    signal.addEventListener('abort', cancel, { once: true });
  }

  /** Waits `ms` through the injected scheduler; returns early on cancel. */
  function waitFor(ms: number): Promise<void> {
    return new Promise<void>((resolve) => {
      wake = resolve;
      pending = deps.setTimeout(() => {
        pending = null;
        wake = null;
        resolve();
      }, ms);
    });
  }

  return {
    async start(): Promise<void> {
      const total = samples.length;
      // The anchor. Every frame's due time is measured from here, never from
      // "when the previous frame finished" — that is the anti-drift property.
      const t0 = deps.now();

      for (let n = 0; n * FRAME_SAMPLES < total; n++) {
        if (cancelled) break;

        const delay = t0 + n * FRAME_MS - deps.now();
        if (delay > 0) {
          await waitFor(delay);
          if (cancelled) break;
        }

        const offset = n * FRAME_SAMPLES;
        // subarray, not slice: a view is enough and copying a clip frame per
        // 20 ms would be pure garbage churn.
        await onFrame(samples.subarray(offset, Math.min(offset + FRAME_SAMPLES, total)));
      }

      signal?.removeEventListener('abort', cancel);
    },
    cancel,
  };
}
