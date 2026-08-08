/**
 * Ticket 035 — record a Replay TAKE to 24 kHz mono PCM16 + WAV.
 *
 * ============================ API DESIGN (normative) =======================
 * This module REUSES src/client/audio/capture.ts (`startCapture`) — there is
 * exactly one getUserMedia path in the client. It accumulates the 480-sample
 * 24 kHz Int16 frames that `startCapture` already emits instead of streaming
 * them to a transport.
 *
 * ============ THE CORPUS INHERITS LIVE_CAPTURE_CONSTRAINTS ================
 * TICKET 047. `startCapture` now hardcodes LIVE_CAPTURE_CONSTRAINTS
 * ({ echoCancellation, noiseSuppression, autoGainControl }, all true), so a
 * CORPUS take is recorded under exactly those constraints too. That follows
 * from "one microphone path in the client" and is what we want — the corpus
 * should be recorded the way Live hears — but the constant is NAMED for Live,
 * so say it here: tuning "the Live mic control" silently changes how the
 * corpus recordings sound, and every WER and latency number in the experiment
 * is computed downstream of those recordings. Change it with both in mind.
 * ==========================================================================
 *
 * startTake(opts) -> Promise<TakeRecorder | CaptureDenied>
 *   - the union is discriminated by `'status' in result`: a recorder has no
 *     `status` field, a denial is the four-value model UNCHANGED
 *     ({ status: 'denied', reason: 'blocked' | 'unavailable' }) and starts no
 *     context, no pipeline and no timer;
 *   - on grant, schedules a single cap timer through the injected `timers`
 *     seam at min(opts.maxDurationMs ?? MAX_TAKE_MS, MAX_TAKE_MS). When it
 *     fires the take STOPS ITSELF (mic released, no further frames retained)
 *     and `opts.onMaxDuration` is invoked with the finished take. PRD §7's
 *     1-minute cap is enforced here, not merely captioned.
 *   - the take is frozen exactly once — by stop(), by cancel(), or by the cap
 *     — so stop() is idempotent and every later call returns the same object.
 *     durationMs = round(samples.length / 24000 * 1000) and
 *     wav = writeWav(samples, 24_000): 24 kHz, never 16 kHz (AGENTS.md).
 *
 * TWO DELIBERATE CALLS the tests leave unpinned:
 *
 * 1. TRAILING SUB-FRAME REMAINDER. `startCapture`'s chunker carries a
 *    remainder and is never flushed, so up to 479 samples (< 20 ms) of the
 *    tail are dropped. Flushing would mean changing audio/capture.ts, which is
 *    on the Live path and pinned by its own tests. We ACCEPT the drop: < 20 ms
 *    is under one analysis frame of segment.ts and well inside its stated
 *    tolerance, and the alternative (a second chunker here, fed from a second
 *    subscription) would be exactly the duplicated capture path this ticket
 *    forbids.
 *
 * 2. stop() AFTER cancel(). cancel() ABANDONS the take: it discards every
 *    buffered frame and freezes an EMPTY take. A subsequent stop() therefore
 *    resolves — it never throws and never hands back partial audio — to
 *    { samples: length 0, wav: a valid 44-byte header, durationMs: 0 }. An
 *    empty take is the honest answer to "what did the abandoned recording
 *    capture", and keeping stop() total means a UI that races cancel against
 *    stop cannot end up with an unhandled rejection.
 * ==========================================================================
 */

import { writeWav } from '../../harness/wav';
import {
  startCapture,
  type CaptureAudioContextLike,
  type CaptureConstraints,
  type CapturePipeline,
  type CaptureResult,
  type MediaStreamLike,
} from '../audio/capture';

/** Every take is 24 kHz mono PCM16 — src/core/protocol.ts SAMPLE_RATE. */
const TAKE_RATE = 24_000;

/** PRD §7 hard cap: a Replay clip is at most one minute. */
export const MAX_TAKE_MS = 60_000;

/** PRD §9 guidance for a corpus take (~4 utterances). */
export const CORPUS_TAKE_MS = 45_000;

/** The denied half of the existing four-value permission model, unchanged. */
export type CaptureDenied = Extract<CaptureResult, { status: 'denied' }>;

/** Timer seam so the cap is testable without wall-clock time. */
export interface TakeTimers {
  setTimeout: (fn: () => void, ms: number) => number;
  clearTimeout: (id: number) => void;
}

export interface RecordedTake {
  /** 24 kHz mono PCM16. */
  samples: Int16Array;
  /** writeWav(samples, 24_000). */
  wav: Uint8Array;
  durationMs: number;
}

export interface TakeRecorder {
  /** Idempotent: repeated calls resolve to the same take and re-release nothing. */
  stop(): Promise<RecordedTake>;
  /** Abandons the take: releases the mic, clears the cap timer, yields nothing. */
  cancel(): void;
}

export interface StartTakeOptions {
  /**
   * Widened with startCapture's seam (ticket 047) — the request now carries
   * the declared audio constraints, and this forwards straight to it.
   */
  getUserMedia: (constraints: CaptureConstraints) => Promise<MediaStreamLike>;
  audioContextFactory: () => CaptureAudioContextLike;
  pipeline: CapturePipeline;
  /** Mic level bars 0..5, forwarded from startCapture. */
  onLevel?: (bars: number) => void;
  /** Cap in ms; defaults to MAX_TAKE_MS and is clamped down to it. */
  maxDurationMs?: number;
  /** Defaults to the global setTimeout/clearTimeout. */
  timers?: TakeTimers;
  /** Fired once when the cap stops the take by itself. */
  onMaxDuration?: (take: RecordedTake) => void;
}

/** Falls back to the ambient clock when no timer seam is injected. */
const globalTimers: TakeTimers = {
  // Cast: @types/node is on the compile path and widens the return to Timeout.
  setTimeout: (fn, ms) => setTimeout(fn, ms) as unknown as number,
  clearTimeout: (id) => {
    clearTimeout(id);
  },
};

function joinFrames(frames: readonly Int16Array[], total: number): Int16Array {
  const out = new Int16Array(total);
  let offset = 0;
  for (const f of frames) {
    out.set(f, offset);
    offset += f.length;
  }
  return out;
}

export async function startTake(
  opts: StartTakeOptions,
): Promise<TakeRecorder | CaptureDenied> {
  const timers = opts.timers ?? globalTimers;
  const capMs = Math.min(opts.maxDurationMs ?? MAX_TAKE_MS, MAX_TAKE_MS);

  let frames: Int16Array[] = [];
  let total = 0;

  const result = await startCapture({
    getUserMedia: opts.getUserMedia,
    audioContextFactory: opts.audioContextFactory,
    pipeline: opts.pipeline,
    onChunk: (frame) => {
      frames.push(frame);
      total += frame.length;
    },
    onLevel: (bars) => opts.onLevel?.(bars),
  });

  // Denial: no context, no pipeline, no cap timer — nothing to release.
  if (result.status === 'denied') return result;
  const handle = result.handle;

  let capId: number | null = null;
  let take: RecordedTake | null = null;

  const clearCap = (): void => {
    if (capId === null) return;
    timers.clearTimeout(capId);
    capId = null;
  };

  /** Releases the mic and freezes the take; every path funnels through here. */
  const finish = (): RecordedTake => {
    if (take) return take;
    clearCap();
    handle.stop();
    const samples = joinFrames(frames, total);
    take = {
      samples,
      wav: writeWav(samples, TAKE_RATE),
      durationMs: Math.round((samples.length / TAKE_RATE) * 1000),
    };
    return take;
  };

  capId = timers.setTimeout(() => {
    capId = null; // already fired; nothing left to clear
    if (take) return;
    opts.onMaxDuration?.(finish());
  }, capMs);

  return {
    async stop(): Promise<RecordedTake> {
      return finish();
    },
    cancel(): void {
      if (take) return;
      frames = [];
      total = 0;
      finish(); // freezes an empty take — see the header note on cancel/stop
    },
  };
}
