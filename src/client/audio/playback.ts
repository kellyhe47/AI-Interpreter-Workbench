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
 *
 * TICKET 049 — A HOSTILE AudioContext DEGRADES PLAYBACK, IT NEVER KILLS IT.
 * `new AudioContext()` throws for real, and because the factory is invoked
 * LAZILY from enqueue that throw used to escape from inside the transport's
 * onAudio callback, where nothing catches it. Now:
 * - the factory is attempted AT MOST ONCE, ever;
 * - enqueue still does ALL of its measurement work (audioQueuedAt,
 *   durationMs — sound is not a measurement), drops the chunk, and REPORTS via
 *   `onPlaybackUnavailable` exactly once per instance, across chunks and
 *   across reset()s;
 * - play() never reports (see its own comment).
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
   * TICKET 049 — reported ONCE when a chunk could not be sounded because the
   * AudioContext could not be built. Never called from play(): a failed resume
   * with nothing queued has cost the operator no sound (realtime enqueues
   * nothing at all).
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
  /**
   * TICKET 049 — the factory is attempted AT MOST ONCE. `new AudioContext()`
   * throws for real (Chrome at its ~6-per-document limit; Safari under some
   * policy states) and a context limit does not un-fill itself mid-session, so
   * re-attempting per chunk is one throw per 20 ms frame.
   */
  private contextFailed = false;
  private contextError: unknown = null;
  /** Survives reset(): a notice that flickers off per utterance is no notice. */
  private unavailable = false;
  private reported = false;

  constructor(opts: ArmPlaybackOptions) {
    this.opts = opts;
    this.now = opts.now ?? (() => performance.now());
    this.playing = opts.autoplay;
  }

  /** null once the factory has thrown — never retried (see contextFailed). */
  private getContext(): PlaybackAudioContextLike | null {
    if (this.context) return this.context;
    if (this.contextFailed) return null;
    try {
      this.context = this.opts.audioContextFactory();
    } catch (err) {
      this.contextFailed = true;
      this.contextError = err;
      return null;
    }
    return this.context;
  }

  /**
   * TICKET 049 — the sound was actually LOST, so say so exactly once. Called
   * only from enqueue: a failed play() with nothing queued cost nothing, and a
   * realtime session (whose audio rides the remoteAudioSink element) never
   * enqueues a chunk at all.
   */
  private reportUnavailable(): void {
    this.unavailable = true;
    if (this.reported) return;
    this.reported = true;
    this.opts.onPlaybackUnavailable?.(this.contextError);
  }

  /** TICKET 049 — true once a chunk was dropped for want of a context. */
  get playbackUnavailable(): boolean {
    return this.unavailable;
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

    // TICKET 049 — MEASUREMENT FIRST, and unconditionally: audioQueuedAt and
    // durationMs above are timing marks, not playback events, so a context
    // that cannot be built costs the sound and nothing else. Dropping the
    // chunk here (rather than letting the constructor throw) is what keeps the
    // transport's onAudio callback — which catches nothing — from wedging Live.
    const ctx = this.getContext();
    if (ctx === null) {
      this.reportUnavailable();
      return;
    }
    const buffer = ctx.createBuffer(1, pcm.length, 24000);
    const data = buffer.getChannelData(0);
    for (let i = 0; i < pcm.length; i++) data[i] = pcm[i]! / 32768;

    if (this.playing) {
      this.startBuffer(ctx, buffer, pcm.length);
    } else {
      this.buffered.push({ buffer, length: pcm.length });
    }
  }

  private startBuffer(
    ctx: PlaybackAudioContextLike,
    buffer: PlaybackBufferLike,
    length: number,
  ): void {
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
    this.playing = true;
    // TICKET 049 — DELIBERATELY SILENT on failure. The controller calls this
    // once inside the Start gesture (047 R2-3) purely to resume a possibly
    // suspended context; a realtime session then enqueues nothing, so saying
    // "no audio output" here would slander a perfectly audible session. The
    // first chunk that is actually dropped reports instead.
    const ctx = this.getContext();
    if (ctx === null) {
      this.buffered = [];
      return;
    }
    void ctx.resume();
    const pending = this.buffered;
    this.buffered = [];
    for (const { buffer, length } of pending) this.startBuffer(ctx, buffer, length);
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
    // TICKET 049 — `unavailable` / `contextFailed` / `reported` are NOT
    // cleared. reset() means "next utterance", and the context limit that
    // caused this has not un-filled itself between utterances.
  }
}
