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
  /**
   * TICKET 049 (STUB — see playback.degraded.test.ts) — reported ONCE when a
   * chunk could not be sounded because the AudioContext could not be built.
   * Never called from play(): a failed resume with nothing queued has cost the
   * operator no sound (realtime enqueues nothing at all).
   */
  onPlaybackUnavailable?: (error: unknown) => void;
}

export class ArmPlayback {
  private readonly opts: ArmPlaybackOptions;
  private readonly now: () => number;
  private context: PlaybackAudioContextLike | null = null;
  private queuedAt: number | null = null;
  private totalSamples = 0;
  private buffered: { buffer: PlaybackBufferLike; length: number }[] = [];
  private playing: boolean;
  private startedCount = 0;
  private endedCount = 0;
  private endedCb: (() => void) | null = null;
  private endedFired = false;
  private nextStartTime = 0;

  constructor(opts: ArmPlaybackOptions) {
    this.opts = opts;
    this.now = opts.now ?? (() => performance.now());
    this.playing = opts.autoplay;
  }

  private getContext(): PlaybackAudioContextLike {
    if (!this.context) this.context = this.opts.audioContextFactory();
    return this.context;
  }

  /** TICKET 049 (STUB) — true once a chunk was dropped for want of a context. */
  get playbackUnavailable(): boolean {
    return false;
  }

  /** Captured at the FIRST enqueue (per utterance); null before any audio. */
  get audioQueuedAt(): number | null {
    return this.queuedAt;
  }

  /** Total enqueued audio in ms, from sample counts at 24 kHz. */
  get durationMs(): number {
    return (this.totalSamples / 24000) * 1000;
  }

  enqueue(pcm: Int16Array): void {
    if (this.queuedAt === null) this.queuedAt = this.now();
    this.totalSamples += pcm.length;

    const ctx = this.getContext();
    const buffer = ctx.createBuffer(1, pcm.length, 24000);
    const data = buffer.getChannelData(0);
    for (let i = 0; i < pcm.length; i++) data[i] = pcm[i]! / 32768;

    if (this.playing) {
      this.startBuffer(buffer, pcm.length);
    } else {
      this.buffered.push({ buffer, length: pcm.length });
    }
  }

  private startBuffer(buffer: PlaybackBufferLike, length: number): void {
    const ctx = this.getContext();
    const src = ctx.createBufferSource();
    src.buffer = buffer;
    src.connect(ctx.destination);
    this.startedCount++;
    src.onended = () => {
      this.endedCount++;
      this.maybeFireEnded();
    };
    const when = Math.max(ctx.currentTime, this.nextStartTime);
    src.start(when);
    this.nextStartTime = when + length / 24000;
  }

  private maybeFireEnded(): void {
    if (
      !this.endedFired &&
      this.startedCount > 0 &&
      this.endedCount === this.startedCount &&
      this.buffered.length === 0
    ) {
      this.endedFired = true;
      this.endedCb?.();
    }
  }

  play(): void {
    const ctx = this.getContext();
    void ctx.resume();
    this.playing = true;
    const pending = this.buffered;
    this.buffered = [];
    for (const { buffer, length } of pending) this.startBuffer(buffer, length);
  }

  pause(): void {
    if (this.context) void this.context.suspend();
  }

  onEnded(cb: () => void): void {
    this.endedCb = cb;
  }

  reset(): void {
    this.queuedAt = null;
    this.totalSamples = 0;
    this.buffered = [];
    this.startedCount = 0;
    this.endedCount = 0;
    this.endedFired = false;
    this.nextStartTime = 0;
    this.playing = this.opts.autoplay;
  }
}
