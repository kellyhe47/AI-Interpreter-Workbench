/**
 * Ticket 035 — record a Replay TAKE to 24 kHz mono PCM16 + WAV.
 *
 * STUB — types and constants only. The implementation lands with ticket 035's
 * green pass; every behavior below is pinned by capture.test.ts.
 *
 * ============================ API DESIGN (normative) =======================
 * This module REUSES src/client/audio/capture.ts (`startCapture`) — there is
 * exactly one getUserMedia path in the client. It accumulates the 480-sample
 * 24 kHz Int16 frames that `startCapture` already emits instead of streaming
 * them to a transport.
 *
 * startTake(opts) -> Promise<TakeRecorder | CaptureDenied>
 *   - denial propagates `startCapture`'s four-value model UNCHANGED
 *     ({ status: 'denied', reason: 'blocked' | 'unavailable' }) and starts no
 *     context and no pipeline;
 *   - on grant, schedules a single cap timer through the injected `timers`
 *     seam at min(opts.maxDurationMs ?? MAX_TAKE_MS, MAX_TAKE_MS). When it
 *     fires the take STOPS ITSELF (mic released, no further frames retained)
 *     and `opts.onMaxDuration` is invoked with the finished take. PRD §7's
 *     1-minute cap is enforced here, not merely captioned.
 * ==========================================================================
 */

import {
  startCapture,
  type CaptureAudioContextLike,
  type CapturePipeline,
  type CaptureResult,
  type MediaStreamLike,
} from '../audio/capture';

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
  getUserMedia: (constraints: { audio: true }) => Promise<MediaStreamLike>;
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

export async function startTake(
  _opts: StartTakeOptions,
): Promise<TakeRecorder | CaptureDenied> {
  void startCapture;
  throw new Error('startTake is not implemented (ticket 035)');
}
