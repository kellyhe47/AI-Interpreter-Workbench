/**
 * Ticket 010 — Mic capture with fully injectable seams (jsdom never needs a
 * real AudioContext or getUserMedia).
 *
 * ============================ API DESIGN (normative) =======================
 * Locked by capture.test.ts:
 *
 * startCapture(opts): Promise<CaptureResult>
 *
 * INJECTION SEAM: opts.pipeline is a function that wires
 * source -> processor for a granted stream and invokes `emit` with raw
 * Float32 frames at `context.sampleRate`. Production code passes a pipeline
 * built on AudioWorklet/ScriptProcessor; tests pass a fake that simply
 * captures `emit` and returns a teardown fn. startCapture itself NEVER
 * touches AudioNode APIs — everything DOM-audio-specific lives behind the
 * pipeline seam, which is why jsdom tests need no real AudioContext.
 *
 * ================== ECHO CANCELLATION IS A DECLARED CONTROL ================
 * TICKET 047. In Live the microphone stays open while the translation plays
 * out loud, so on speakers the model could hear its own output and transcribe
 * it as if the operator had spoken. Browsers default `echoCancellation: true`
 * for a bare `audio: true`, and the operator confirmed empirically that the
 * model never transcribed itself — but an implicit default is not a control.
 * A browser changing its default must not silently change the experiment, so
 * the constraints are REQUESTED explicitly and named:
 * LIVE_CAPTURE_CONSTRAINTS = { audio: { echoCancellation, noiseSuppression,
 * autoGainControl } }, all true. Same discipline as VAD
 * (`silence_duration_ms: 500`) and endpointing: pinned, named, asserted.
 *
 * INPUT GATING IS DELIBERATELY ABSENT. Muting the mic while output plays was
 * considered and REJECTED: it kills barge-in (hiding a real architectural
 * difference between the arms), it can silently drop real speech, and it
 * layers a second gate on top of the pinned VAD control. Nothing here — or in
 * the Live view/controller — may set `track.enabled` or `muted`.
 * ==========================================================================
 *
 * Behavior:
 * 1. Calls opts.getUserMedia(LIVE_CAPTURE_CONSTRAINTS).
 *    - resolves            -> permission 'granted' (four-value model: caller
 *      maps this to micPermission 'granted').
 *    - rejects with an error whose .name === 'NotAllowedError'
 *                          -> { status: 'denied', reason: 'blocked' }
 *    - rejects with any other error (NotFoundError, NotReadableError, ...)
 *                          -> { status: 'denied', reason: 'unavailable' }
 *      ('unavailable' is the DISTINCT reason for non-NotAllowed failures.)
 *    On denial nothing else happens: audioContextFactory and pipeline are
 *    never invoked.
 * 2. On grant: context = audioContextFactory(); teardown =
 *    pipeline({ context, stream, emit }). For every Float32 frame passed to
 *    `emit`, startCapture:
 *      - calls opts.onLevel(rmsToBars(rms(frame))) — level computed on the
 *        raw (pre-resample) frame;
 *      - resamples the frame from context.sampleRate to 24 kHz
 *        (resampleTo24k), converts via floatTo16, and feeds a
 *        makeChunker(480); every complete 480-sample Int16Array frame is
 *        delivered to opts.onChunk. Remainders carry across emits.
 * 3. Returns { status: 'granted', handle } where handle.stop():
 *      - calls stop() on every track from stream.getTracks(),
 *      - runs the pipeline teardown,
 *      - closes the context if it has close(),
 *      - and guarantees NO further onChunk/onLevel calls, even if the fake
 *        pipeline keeps calling emit after teardown.
 *    stop() is idempotent.
 * ==========================================================================
 */

import { floatTo16, makeChunker, resampleTo24k, rms, rmsToBars } from './pcm';

export interface MediaTrackLike {
  stop(): void;
}

export interface MediaStreamLike {
  getTracks(): MediaTrackLike[];
}

/** Minimal context surface capture needs: just the input sample rate. */
export interface CaptureAudioContextLike {
  sampleRate: number;
  close?(): Promise<void> | void;
}

export type CapturePipeline = (args: {
  context: CaptureAudioContextLike;
  stream: MediaStreamLike;
  emit: (samples: Float32Array) => void;
}) => () => void;

export interface CaptureHandle {
  stop(): void;
}

export type CaptureResult =
  | { status: 'granted'; handle: CaptureHandle }
  | { status: 'denied'; reason: 'blocked' | 'unavailable' };

/**
 * The shape of the constraint object handed to the getUserMedia seam. Widened
 * from `{ audio: true }` (ticket 047) so the audio constraints travel with the
 * request; injected fakes ignore the argument and keep working.
 */
export interface CaptureConstraints {
  audio: {
    echoCancellation: boolean;
    noiseSuppression: boolean;
    autoGainControl: boolean;
  };
}

/**
 * TICKET 047 — the microphone control, declared rather than inherited from a
 * browser default. See the module header: Live keeps the mic open while the
 * translation plays, and echo cancellation is what keeps the model from
 * transcribing its own output. Frozen so nothing can mutate the shared object.
 */
export const LIVE_CAPTURE_CONSTRAINTS: CaptureConstraints = Object.freeze({
  audio: Object.freeze({
    echoCancellation: true,
    noiseSuppression: true,
    autoGainControl: true,
  }),
});

export interface StartCaptureOptions {
  getUserMedia: (constraints: CaptureConstraints) => Promise<MediaStreamLike>;
  audioContextFactory: () => CaptureAudioContextLike;
  pipeline: CapturePipeline;
  /** Receives exact 480-sample Int16 frames at 24 kHz. */
  onChunk: (frame: Int16Array) => void;
  /** Receives mic level bars 0..5, once per emitted pipeline frame. */
  onLevel: (bars: number) => void;
}

export async function startCapture(opts: StartCaptureOptions): Promise<CaptureResult> {
  let stream: MediaStreamLike;
  try {
    stream = await opts.getUserMedia(LIVE_CAPTURE_CONSTRAINTS);
  } catch (err) {
    const name = err instanceof Error ? err.name : '';
    return {
      status: 'denied',
      reason: name === 'NotAllowedError' ? 'blocked' : 'unavailable',
    };
  }

  const context = opts.audioContextFactory();
  const chunker = makeChunker(480);
  let stopped = false;

  const emit = (samples: Float32Array): void => {
    if (stopped) return;
    opts.onLevel(rmsToBars(rms(samples)));
    const resampled = resampleTo24k(samples, context.sampleRate);
    const frames = chunker.push(floatTo16(resampled));
    for (const frame of frames) {
      if (stopped) return;
      opts.onChunk(frame);
    }
  };

  const teardown = opts.pipeline({ context, stream, emit });

  const handle: CaptureHandle = {
    stop(): void {
      if (stopped) return;
      stopped = true;
      for (const track of stream.getTracks()) track.stop();
      teardown();
      if (context.close) void context.close();
    },
  };

  return { status: 'granted', handle };
}
