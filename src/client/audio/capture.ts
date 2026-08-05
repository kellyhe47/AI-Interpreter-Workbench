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
 * Behavior:
 * 1. Calls opts.getUserMedia({ audio: true }).
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

export interface StartCaptureOptions {
  getUserMedia: (constraints: { audio: true }) => Promise<MediaStreamLike>;
  audioContextFactory: () => CaptureAudioContextLike;
  pipeline: CapturePipeline;
  /** Receives exact 480-sample Int16 frames at 24 kHz. */
  onChunk: (frame: Int16Array) => void;
  /** Receives mic level bars 0..5, once per emitted pipeline frame. */
  onLevel: (bars: number) => void;
}

export async function startCapture(_opts: StartCaptureOptions): Promise<CaptureResult> {
  throw new Error('not implemented');
}
