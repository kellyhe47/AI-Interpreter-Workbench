/**
 * Cascade orchestrator: audio chunks -> STT -> (turn-final) MT -> TTS.
 *
 * ============================ API DESIGN (normative) =======================
 * Emission API: ASYNC ITERATOR. `runCascade` returns an AsyncGenerator of
 * CascadeEvent; the caller (WS layer or test) drives it with for-await.
 * Events are emitted in the real-time order they happen — MT deltas and TTS
 * audio for the same utterance INTERLEAVE (streaming bridge, see below).
 *
 * TURN SEGMENTATION: the orchestrator loops `stt.transcribe(...)` calls over
 * the single ongoing audio source (one transcribe call == one turn; SttEvent
 * 'final' is TURN-final and ends the call — see FixtureStt). Contract:
 *  - The source is wrapped in ONE shared iterator for the whole session.
 *  - Before starting each turn, the orchestrator PULLS one chunk from the
 *    shared iterator (the "peek"). If the source is exhausted (done), the
 *    session ends and the event stream completes cleanly.
 *  - The turn's transcribe call receives an AsyncIterable that replays the
 *    peeked chunk followed by further chunks pulled from the shared iterator
 *    on demand. Chunks the STT provider did not consume during the turn are
 *    NOT replayed into the next turn (the next peek pulls fresh from the
 *    shared iterator).
 *  => With FixtureStt (which never reads its audio arg), a source of N chunks
 *     produces exactly N turns.
 *
 * PER-TURN PIPELINE (utt = 0-based utterance sequence number; a turn is
 * assigned its utt when its STT TURN-final arrives — turns that never
 * produce a final, e.g. the 'empty' fault, consume NO utt number):
 *  - STT partials are forwarded as {type:'stt.partial'} as they arrive,
 *    before the final.
 *  - On STT TURN-final: emit {type:'stt.final'}; set timings.stt_final =
 *    Date.now() and timings.vad_fired = the same instant (semantically weak
 *    but acceptable for now; speech_end may later be supplied by the client
 *    and is left unset by the orchestrator).
 *  - An STT turn that produces NO final (e.g. fixture failWith:'empty')
 *    is SKIPPED: no MT/TTS, no utterance.complete, no error — the loop just
 *    proceeds to the next turn.
 *  - MT runs once per turn-final (translate(finalText)). Each token is
 *    emitted as {type:'mt.delta'} AND pushed immediately into the TTS input
 *    AsyncIterable (a push-queue bridge) WITHOUT waiting for MT completion;
 *    tts.synthesize(bridge) is started concurrently as soon as MT starts.
 *    timings.mt_first_token = Date.now() at the first token.
 *    When MT completes, emit {type:'mt.final'} with the concatenation.
 *  - TTS audio chunks are emitted as {type:'tts.audio'} events.
 *    timings.tts_first_byte = Date.now() at the first chunk;
 *    timings.audio_queued = Date.now() at the LAST chunk (updated per chunk).
 *  - When the turn's MT and TTS both complete, emit
 *    {type:'utterance.complete', utt, record} with a filled UtteranceRecord
 *    (sourcePartials/sourceFinal/targetPartials(=deltas)/targetFinal, the
 *    timings above, providers = provider `name`s, mode 'cascade').
 *
 * FAILURE ISOLATION: if any stage's generator throws, the CURRENT utterance
 * is abandoned: its in-flight stage generators are closed/aborted and a
 * single {type:'error', utt, stage, message} event is emitted with message
 * EXACTLY:  `<stage> stage <reason> for this utterance — session still running`
 * where reason is 'timed out' when the error is a TimeoutError instance and
 * 'failed' otherwise. The session loop then continues with the next turn.
 *
 * ABORT: opts.signal tears the whole session down mid-stage: all stage
 * generators are closed (their finally blocks run), no further events are
 * emitted, and the event stream returns promptly (clean end, no throw).
 * The orchestrator MUST pass an AbortSignal (derived from opts.signal, also
 * aborted on per-utterance failure teardown) in the ProviderCallOpts of every
 * stage call — providers rely on it to unblock hung awaits.
 * ==========================================================================
 */

import type { MtProvider, SttProvider, TtsProvider } from '../../core/types';
import { TimeoutError } from '../../core/types';
import type { CascadeTimestamps, UtteranceRecord } from '../../core/timing';
import type { CascadeStage } from '../../core/protocol';
import { SAMPLE_RATE } from '../../core/protocol';
import type { TimingMark, TimingSink } from '../../core/decorators/index';
import { withRetry, withTimeout, withTiming } from '../../core/decorators/index';
import { createMt, createStt, createTts } from '../../core/registry';

export interface CascadeProviders {
  stt: SttProvider;
  mt: MtProvider;
  tts: TtsProvider;
}

/** Events emitted by runCascade, in real-time order. */
export type CascadeEvent =
  | { type: 'stt.partial'; utt: number; text: string }
  | { type: 'stt.final'; utt: number; text: string }
  | { type: 'mt.delta'; utt: number; text: string }
  | { type: 'mt.final'; utt: number; text: string }
  | { type: 'tts.audio'; utt: number; pcm: Int16Array }
  | { type: 'utterance.complete'; utt: number; record: UtteranceRecord }
  | { type: 'error'; utt: number; stage: CascadeStage; message: string };

/** Session-level metadata copied onto each UtteranceRecord. */
export interface CascadeSessionInfo {
  languagePair?: string;
  direction?: string;
  arm?: string;
  corpusId?: string;
  runId?: string;
}

export interface RunCascadeOptions {
  signal?: AbortSignal;
  session?: CascadeSessionInfo;
  /**
   * Optional hook: when provided, per-utterance CascadeTimestamps are also
   * reported here right before utterance.complete (test/observability seam).
   */
  onTimings?: (utt: number, timings: CascadeTimestamps) => void;
}

/**
 * Minimal single-consumer async push-queue (channel). `push` enqueues,
 * `close` ends the stream after queued items drain. Used for the MT->TTS
 * token bridge and by the WS layer for the socket audio source.
 */
export interface PushChannel<T> {
  push(value: T): void;
  close(): void;
  iterable: AsyncIterable<T>;
}

export function pushChannel<T>(): PushChannel<T> {
  const items: T[] = [];
  let closed = false;
  let wake: (() => void) | undefined;
  const kick = (): void => {
    const w = wake;
    wake = undefined;
    w?.();
  };
  return {
    push(value: T): void {
      if (closed) return;
      items.push(value);
      kick();
    },
    close(): void {
      closed = true;
      kick();
    },
    iterable: {
      async *[Symbol.asyncIterator](): AsyncGenerator<T, void, void> {
        for (;;) {
          if (items.length > 0) {
            yield items.shift()!;
            continue;
          }
          if (closed) return;
          await new Promise<void>((resolve) => {
            wake = resolve;
          });
        }
      },
    },
  };
}

/** The exact per-stage error copy (see FAILURE ISOLATION above). */
function stageErrorMessage(stage: CascadeStage, err: unknown): string {
  const reason = err instanceof TimeoutError ? 'timed out' : 'failed';
  return `${stage} stage ${reason} for this utterance — session still running`;
}

/**
 * Run the cascade pipeline over `source` until the source is exhausted or
 * `opts.signal` aborts. See the module doc-comment for the full contract.
 */
export async function* runCascade(
  source: AsyncIterable<Int16Array>,
  providers: CascadeProviders,
  opts?: RunCascadeOptions,
): AsyncGenerator<CascadeEvent, void, void> {
  const sessionSignal = opts?.signal;
  const shared = source[Symbol.asyncIterator]();
  let uttCounter = 0;

  while (!sessionSignal?.aborted) {
    // Peek one chunk; source exhaustion ends the session cleanly.
    const peeked = await shared.next();
    if (peeked.done) return;
    if (sessionSignal?.aborted) return;

    // Per-utterance abort: fires on session abort AND on failure teardown.
    const uttAc = new AbortController();
    const onSessionAbort = (): void => uttAc.abort();
    sessionSignal?.addEventListener('abort', onSessionAbort, { once: true });

    try {
      // ---- STT phase -----------------------------------------------------
      const peekedChunk = peeked.value;
      const turnAudio: AsyncGenerator<Int16Array, void, void> = (async function* () {
        yield peekedChunk;
        for (;;) {
          const r = await shared.next();
          if (r.done) return;
          yield r.value;
        }
      })();

      const sourcePartials: string[] = [];
      let sourceFinal: string | undefined;
      let sttError: unknown;
      let sttFailed = false;

      const sttStream = providers.stt.transcribe(turnAudio, { signal: uttAc.signal });
      try {
        for await (const ev of sttStream) {
          if (uttAc.signal.aborted) break;
          if (ev.type === 'partial') {
            sourcePartials.push(ev.text);
            yield { type: 'stt.partial', utt: uttCounter, text: ev.text };
          } else {
            sourceFinal = ev.text;
            break; // TURN-final ends the transcribe call
          }
        }
      } catch (err) {
        sttError = err;
        sttFailed = true;
      } finally {
        await sttStream.return(undefined).catch(() => {});
        await turnAudio.return(undefined).catch(() => {});
      }

      if (sessionSignal?.aborted) return;
      if (sttFailed) {
        yield {
          type: 'error',
          utt: uttCounter,
          stage: 'stt',
          message: stageErrorMessage('stt', sttError),
        };
        continue; // abandon this turn; session loop continues
      }
      if (sourceFinal === undefined) continue; // empty turn: consumes no utt

      // ---- utt assigned at TURN-final ------------------------------------
      const utt = uttCounter;
      uttCounter += 1;
      const timings: CascadeTimestamps = {};
      const tFinal = Date.now();
      timings.vad_fired = tFinal; // semantically weak; see doc-comment
      timings.stt_final = tFinal;
      const finalText = sourceFinal;
      yield { type: 'stt.final', utt, text: finalText };

      // ---- MT + TTS phase (streaming bridge, merged emission) ------------
      const bridge = pushChannel<string>();
      const queue: CascadeEvent[] = [];
      let wake: (() => void) | undefined;
      const kick = (): void => {
        const w = wake;
        wake = undefined;
        w?.();
      };
      const push = (e: CascadeEvent): void => {
        if (!uttAc.signal.aborted) queue.push(e);
        kick();
      };

      let failure: { stage: CascadeStage; err: unknown } | undefined;
      let settledCount = 0;
      const targetPartials: string[] = [];
      let totalSamples = 0;

      const mtStream = providers.mt.translate(finalText, { signal: uttAc.signal });
      const ttsStream = providers.tts.synthesize(bridge.iterable, { signal: uttAc.signal });

      const mtTask = (async () => {
        try {
          for await (const token of mtStream) {
            if (uttAc.signal.aborted) return;
            if (timings.mt_first_token === undefined) timings.mt_first_token = Date.now();
            targetPartials.push(token);
            bridge.push(token); // into TTS before MT completes
            push({ type: 'mt.delta', utt, text: token });
          }
          if (!uttAc.signal.aborted) {
            push({ type: 'mt.final', utt, text: targetPartials.join('') });
          }
        } catch (err) {
          failure ??= { stage: 'mt', err };
          uttAc.abort(); // tear down the utterance's other stages
        } finally {
          bridge.close();
          settledCount += 1;
          kick();
        }
      })();

      const ttsTask = (async () => {
        try {
          for await (const pcm of ttsStream) {
            if (uttAc.signal.aborted) return;
            if (timings.tts_first_byte === undefined) timings.tts_first_byte = Date.now();
            timings.audio_queued = Date.now(); // updated per chunk => last chunk wins
            totalSamples += pcm.length;
            push({ type: 'tts.audio', utt, pcm });
          }
        } catch (err) {
          failure ??= { stage: 'tts', err };
          uttAc.abort();
        } finally {
          settledCount += 1;
          kick();
        }
      })();

      // Drain merged events in arrival order until both stage tasks settle.
      for (;;) {
        if (sessionSignal?.aborted) {
          uttAc.abort();
          await Promise.allSettled([mtTask, ttsTask]); // finally blocks run
          return; // clean end, no further events
        }
        if (queue.length > 0) {
          yield queue.shift()!;
          continue;
        }
        if (settledCount === 2) break;
        await new Promise<void>((resolve) => {
          wake = resolve;
        });
      }
      await Promise.allSettled([mtTask, ttsTask]);
      if (sessionSignal?.aborted) return;

      if (failure) {
        yield {
          type: 'error',
          utt,
          stage: failure.stage,
          message: stageErrorMessage(failure.stage, failure.err),
        };
        continue; // utterance abandoned; session loop continues
      }

      opts?.onTimings?.(utt, timings);
      const session = opts?.session;
      const record: UtteranceRecord = {
        id: `utt-${utt}`,
        arm: session?.arm ?? '',
        mode: 'cascade',
        languagePair: session?.languagePair ?? '',
        direction: session?.direction ?? '',
        sourcePartials,
        sourceFinal: finalText,
        targetPartials,
        targetFinal: targetPartials.join(''),
        audioState: 'queued',
        audioDurationMs: (totalSamples / SAMPLE_RATE) * 1000,
        timings,
        speechEndSource: 'vad',
        providers: {
          stt: providers.stt.name,
          mt: providers.mt.name,
          tts: providers.tts.name,
        },
        costUnits: 0,
        corpusId: session?.corpusId ?? '',
        runId: session?.runId ?? '',
      };
      yield { type: 'utterance.complete', utt, record };
    } finally {
      uttAc.abort(); // close any in-flight stage generators for this turn
      sessionSignal?.removeEventListener('abort', onSessionAbort);
    }
  }
}

/** Config for buildPipeline: provider names resolved via the registry. */
export interface PipelineConfig {
  providers: { stt: string; mt: string; tts: string };
  /** Options forwarded to the registry factories (fixture knobs, etc.). */
  providerOptions?: {
    stt?: Record<string, unknown>;
    mt?: Record<string, unknown>;
    tts?: Record<string, unknown>;
  };
  /** When set, each provider is wrapped in withTimeout(provider, timeoutMs). */
  timeoutMs?: number;
  /** When set, each provider is wrapped in withRetry(provider, retry). */
  retry?: { retries: number; backoffMs: number };
}

export interface Pipeline {
  providers: CascadeProviders;
  /** Every TimingMark emitted by the withTiming decorators, in order. */
  marks: TimingMark[];
  /** The sink wired into withTiming (pushes into `marks`). */
  sink: TimingSink;
}

/**
 * Compose registry + decorators into a ready provider set.
 * Order (inside-out): createX -> [withTimeout] -> [withRetry] ->
 * withTiming(stage, ..., sink), with stage 'stt' | 'mt' | 'tts'.
 * withTiming is ALWAYS applied; its sink pushes into Pipeline.marks (this is
 * the feed for the timing record). Unknown provider names propagate the
 * registry's Error (message names the unknown provider).
 */
export function buildPipeline(config: PipelineConfig): Pipeline {
  const marks: TimingMark[] = [];
  const sink: TimingSink = (mark) => {
    marks.push(mark);
  };

  const decorate = <P extends SttProvider | MtProvider | TtsProvider>(
    stage: CascadeStage,
    provider: P,
  ): P => {
    let out = provider;
    if (config.timeoutMs !== undefined) out = withTimeout(out, config.timeoutMs);
    if (config.retry !== undefined) out = withRetry(out, config.retry);
    return withTiming(stage, out, sink);
  };

  const providers: CascadeProviders = {
    stt: decorate('stt', createStt(config.providers.stt, config.providerOptions?.stt)),
    mt: decorate('mt', createMt(config.providers.mt, config.providerOptions?.mt)),
    tts: decorate('tts', createTts(config.providers.tts, config.providerOptions?.tts)),
  };

  return { providers, marks, sink };
}
