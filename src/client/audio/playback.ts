/**
 * Ticket 010 — Per-arm TTS playback queue.
 *
 * ============================ API DESIGN (normative) =======================
 * Locked by playback.test.ts:
 *
 * new ArmPlayback({ audioContextFactory, autoplay, now? })
 *   - audioContextFactory: lazily invoked on first enqueue (not in the
 *     constructor) so a paused/never-used arm allocates nothing.
 *   - now: injectable clock (performance.now-style, ms); defaults to
 *     () => performance.now().
 *
 * FAKE AUDIOCONTEXT SURFACE (the minimal set this class touches — tests fake
 * exactly this):
 *   createBuffer(numChannels, length, sampleRate) ->
 *     { getChannelData(0): Float32Array }
 *   createBufferSource() ->
 *     { buffer, connect(node), start(when?), stop(), onended }
 *   destination        (opaque node; sources connect to it)
 *   currentTime        (seconds; used to schedule gapless back-to-back starts)
 *   resume()           (called by play() so autoplay-policy-suspended
 *                       contexts start audible)
 *   suspend()          (called by pause())
 *
 * Behavior:
 * - enqueue(pcm: Int16Array): pcm is 24 kHz mono PCM16. The FIRST enqueue
 *   after construction (or after reset()) captures `audioQueuedAt = now()`
 *   EXACTLY ONCE — later enqueues never overwrite it — and this happens
 *   regardless of the autoplay setting (audio_queued is a timing mark, not a
 *   playback event). Samples are converted to Float32 (/32768) into a buffer
 *   created with createBuffer(1, pcm.length, 24000).
 * - autoplay === true: each enqueued chunk is wrapped in a buffer source,
 *   connected to destination, and start()ed as it arrives.
 * - autoplay === false: chunks are buffered; NO source is created/started
 *   until play(). play() then starts the buffered chunks from chunk 0, in
 *   enqueue order, and subsequent enqueues (while playing) start immediately.
 * - play(): also calls context.resume(). pause(): calls context.suspend().
 * - onEnded(cb): cb fires once when every started source has fired its
 *   onended and no more chunks are pending. reset()/new utterance re-arms it.
 * - durationMs: total enqueued audio duration, accumulated from sample
 *   counts (pcm.length / 24000 * 1000). Independent of playback state.
 * - reset(): clears the queue and counters for the next utterance —
 *   audioQueuedAt back to null, durationMs 0; the next enqueue captures a
 *   fresh audioQueuedAt.
 * ==========================================================================
 */

export interface PlaybackBufferLike {
  getChannelData(channel: number): Float32Array;
}

export interface PlaybackSourceLike {
  buffer: PlaybackBufferLike | null;
  connect(node: unknown): void;
  start(when?: number): void;
  stop(): void;
  onended: (() => void) | null;
}

export interface PlaybackAudioContextLike {
  createBuffer(numChannels: number, length: number, sampleRate: number): PlaybackBufferLike;
  createBufferSource(): PlaybackSourceLike;
  destination: unknown;
  currentTime: number;
  resume(): Promise<void> | void;
  suspend(): Promise<void> | void;
}

export interface ArmPlaybackOptions {
  audioContextFactory: () => PlaybackAudioContextLike;
  autoplay: boolean;
  /** Injectable performance.now-style clock (ms). */
  now?: () => number;
}

export class ArmPlayback {
  constructor(_opts: ArmPlaybackOptions) {
    throw new Error('not implemented');
  }

  /** Captured at the FIRST enqueue (per utterance); null before any audio. */
  get audioQueuedAt(): number | null {
    throw new Error('not implemented');
  }

  /** Total enqueued audio in ms, from sample counts at 24 kHz. */
  get durationMs(): number {
    throw new Error('not implemented');
  }

  enqueue(_pcm: Int16Array): void {
    throw new Error('not implemented');
  }

  play(): void {
    throw new Error('not implemented');
  }

  pause(): void {
    throw new Error('not implemented');
  }

  onEnded(_cb: () => void): void {
    throw new Error('not implemented');
  }

  reset(): void {
    throw new Error('not implemented');
  }
}
