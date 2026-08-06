/**
 * Ticket 007 — Replay pacer. STUB ONLY (test-first: no implementation yet).
 *
 * ============================ API DESIGN (normative) =======================
 * Locked by pacer.test.ts:
 *
 * FRAME_MS       — frame duration in ms (20).
 * FRAME_SAMPLES  — samples per frame, DERIVED from SAMPLE_RATE and FRAME_MS
 *                  (SAMPLE_RATE * FRAME_MS / 1000 = 480 at 24 kHz). The two
 *                  constants must never be able to desynchronize.
 *
 * createPacer({ samples, onFrame, signal?, deps? }): Pacer
 *   - samples: 24 kHz mono PCM16 clip to feed.
 *   - onFrame: receives each frame, in order. May be async.
 *   - signal:  optional AbortSignal; aborting behaves like cancel().
 *   - deps:    injected seams, each defaulting to the real one —
 *              now() (ms clock), setTimeout(fn, ms) -> handle,
 *              clearTimeout(handle). The pacer NEVER reaches for
 *              Date.now/setTimeout directly, so tests drive virtual time.
 *
 * Pacer.start(): resolves once the clip has been fully emitted (or once the
 *   pacer is cancelled/aborted). Pacing is WALL-CLOCK ANCHORED: frame n is
 *   due at t0 + n * FRAME_MS, so a slow consumer cannot accumulate drift.
 * Pacer.cancel(): stops emission promptly, emits nothing further, leaks no
 *   timer, and lets start() settle cleanly.
 * ==========================================================================
 */

/** Frame duration in ms. STUB VALUE. */
export const FRAME_MS: number = 0;

/** Samples per frame at SAMPLE_RATE. STUB VALUE. */
export const FRAME_SAMPLES: number = 0;

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

export function createPacer(_options: PacerOptions): Pacer {
  return {
    async start(): Promise<void> {
      // STUB — no implementation.
    },
    cancel(): void {
      // STUB — no implementation.
    },
  };
}
