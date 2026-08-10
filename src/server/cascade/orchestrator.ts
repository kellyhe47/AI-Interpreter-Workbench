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
 *  - An SttEvent {type:'speech_stopped'} is the ENDPOINTER'S ANNOUNCEMENT: it
 *    stamps timings.vad_fired and does NOT end the turn (it carries no text).
 *  - On STT TURN-final: emit {type:'stt.final'}; set timings.stt_final =
 *    Date.now() and timings.vad_fired = the announcement's instant, falling
 *    back to the turn-final's own when the provider announced nothing
 *    (speech_end may later be supplied by the client and is left unset here).
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
import {
  TTS_AUDIO_TOKENS_PER_SECOND,
  elevenLabsRequestCharCounts,
  priceCascade,
  rateFor,
  type CascadeCost,
  type StageUsage,
} from '../../core/pricing';
import type { ProviderTriple } from '../../core/arms';

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
  /**
   * TICKET 062 — what the MT stage must translate INTO ('Spanish'). The pair and
   * direction on this object are copied onto the emitted record and read by
   * nothing else, which is exactly how a record could say `direction: 'es→en'`
   * above a Spanish translation of Spanish with nothing in the pipeline
   * disagreeing. Optional, and passed through UNINVENTED: see ProviderCallOpts.
   */
  targetLanguage?: string;
  arm?: string;
  corpusId?: string;
  runId?: string;
}

export interface RunCascadeOptions {
  signal?: AbortSignal;
  session?: CascadeSessionInfo;
  /**
   * TICKET 052 — the MODEL ids behind the three stages (`arms.ts` MENUS ids,
   * exactly what `session.start` carries). The registry is keyed by VENDOR and
   * `provider.name` is therefore a vendor name, which no rate card can price:
   * `gpt-4o-mini-tts` and `eleven_flash_v2_5` are both "openai"/"elevenlabs"
   * at that level and they bill on DIFFERENT METERS.
   *
   * Absent → every stage prices as `unknown-model`, i.e. NOT MEASURED. Never
   * a zero: a cascade run nobody could price reports `not measured`.
   */
  models?: ProviderTriple;
  /**
   * Optional hook: when provided, per-utterance CascadeTimestamps are also
   * reported here right before utterance.complete (test/observability seam).
   */
  onTimings?: (utt: number, timings: CascadeTimestamps) => void;
  /**
   * TICKET 052 R2 — the COST twin of `onTimings`, reported for every completed
   * utterance right before `utterance.complete`.
   *
   * The record carries ONE number (`costUnits`), and one number cannot say
   * WHICH stage was unmetered. "The cascade total is null because MT reports no
   * usage" and "it is null because nobody metered the audio" are materially
   * different findings, and the per-stage attribution is precisely what
   * Experiment 2 exists to produce. The observability seam is where that lives —
   * a record field would put a per-stage breakdown on every stored utterance.
   */
  onCost?: (utt: number, cost: CascadeCost) => void;
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
 * TICKET 052 — the cascade's METERED spend for one utterance, PER STAGE.
 * `total` is measured only when every stage is; `costUnits` takes `total.usd`,
 * which is `null` when it is not.
 *
 * THREE VENDORS, THREE RATE CARDS (PRD §5). What this pipeline can honestly
 * meter today, and what it cannot:
 *
 *   STT  · per MINUTE of audio — metered exactly: the samples handed to the
 *          provider, at SAMPLE_RATE.
 *   TTS  · per CHARACTER, for a vendor that bills that way (ElevenLabs) —
 *          metered as ONE REQUEST PER STREAMED CHUNK, which is precisely the
 *          PRD §5 trap: the 1,000-char minimum applies per request, so twelve
 *          100-char chunks cost twelve times a naive character count.
 *   MT   · per TOKEN — NOT metered. `MtProvider.translate` yields text and
 *          reports no usage, and there is no token count to be had without
 *          widening the provider protocol. Estimating tokens from characters
 *          would be an INVENTED number wearing a measured number's clothes.
 *   TTS  · per TOKEN (gpt-4o-mini-tts) — NOT metered, for the same reason:
 *          audio-out TOKENS are not derivable from PCM sample counts.
 *
 * So today this returns `null` for both cascade arms, and `null` renders as
 * `not measured`. That is the POINT: a hole that says so is honest, and the
 * `$0.00` it replaces was not. The per-stage attribution is already wired, so
 * the moment a provider reports usage the stage prices with no further change.
 */
function cascadeCost(
  models: ProviderTriple | undefined,
  sttSamples: number,
  ttsDeltas: readonly string[],
  mtUsage: { inputTokens: number; outputTokens: number } | undefined,
  ttsSamples: number,
): CascadeCost {
  // NO MODEL IDS, NO PRICES. `provider.name` is a VENDOR name and prices
  // nothing, so an un-forwarded triple must reach `priceCascade` as three
  // holes — never as a zero. Deliberately NOT an early `return null`: the
  // per-stage breakdown still has to say WHICH stage is unmetered, and here the
  // honest answer is "all three, because nobody said what they were".
  if (models === undefined) return priceCascade({});

  const stt: StageUsage | undefined =
    sttSamples > 0
      ? { model: models.stt, shape: 'per-minute', audioMs: (sttSamples / SAMPLE_RATE) * 1000 }
      : undefined;

  // R2-6 — THE METER IS ON THE TEXT SYNTHESIZED, NOT ON THE MT TOKEN STREAM.
  // `ttsDeltas` is how the TRANSLATOR punctuated its output; billing one
  // request per delta makes a 40-token sentence forty floored requests ($2.00
  // against ~$0.01) and means re-chopping the same sentence changes the vendor's
  // bill. `elevenLabsRequestCharCounts` re-frames the concatenated text on the
  // vendor's own documented chunk schedule, which is positional — so the figure
  // depends on WHAT was said and not on HOW it arrived.
  const synthesized = ttsDeltas.join('');
  const ttsShape = rateFor(models.tts)?.shape;
  const perCharacter = ttsShape === 'per-character';

  // TICKET 053 — THE TOKEN-BILLED TTS PRICES FROM THE AUDIO IT PRODUCED.
  //
  // `gpt-4o-mini-tts` bills audio-out TOKENS and `/v1/audio/speech` reports
  // none, so the count comes from the one quantity we measure exactly: the
  // samples that actually arrived, counted as they arrived. The conversion is
  // the assumed part (see TTS_AUDIO_TOKENS_PER_SECOND), the duration is not.
  //
  // A turn that produced NO audio prices as `no-usage-reported`, not as a
  // stage that cost nothing — a TTS call that returned silence still has an
  // unknown bill, and 0 tokens would assert it was free.
  const ttsSeconds = ttsSamples / SAMPLE_RATE;
  const tokenBilled = ttsShape === 'token';
  const tts: StageUsage | undefined = perCharacter
    ? synthesized.length > 0
      ? {
          model: models.tts,
          shape: 'per-character',
          // ONE ENTRY PER REQUEST, never a total — a total cannot express the
          // difference the 1k-char floor makes.
          requestCharCounts: elevenLabsRequestCharCounts(synthesized),
        }
      : undefined
    : tokenBilled && ttsSamples > 0
      ? {
          model: models.tts,
          shape: 'token',
          // The card prices this model's text input at 0 (PRD §5 publishes an
          // audio-out rate only), so a text-token estimate would change no
          // figure while inventing a count nobody measured. 0 is what the card
          // already asserts; the OPEN QUESTION of whether input is billed at
          // all is carried by the pricing assumption, where it can be checked.
          inputTokens: 0,
          // NOT ROUNDED, deliberately. This is a DERIVED estimate, not a
          // vendor's integer count, and rounding it to one biases every short
          // utterance toward zero: a 0.4 s answer is 8.7 tokens, which
          // `Math.round` turns into 9 and a 0.02 s one into 0 — a MEASURED
          // $0.00, the exact fabrication this module exists to prevent. Cost is
          // linear in tokens, so carrying the fraction is both more accurate
          // and the only form that cannot manufacture a free stage.
          outputTokens: ttsSeconds * TTS_AUDIO_TOKENS_PER_SECOND,
        }
      : undefined;

  // TICKET 053 — MT NOW METERS, from the vendor's own usage frame (see
  // `onUsage`). Absent usage stays absent: a turn whose provider reported
  // nothing prices as `no-usage-reported`, never as a free translation.
  //
  // This completes ARM C's total — stt (per-minute) + mt (token) + tts
  // (per-character) are now all metered. ARM B's stays holed regardless,
  // because `gpt-4o-mini-tts` bills audio-out TOKENS and returns raw PCM with
  // no usage anywhere in the response; tokens are not derivable from a sample
  // count. That asymmetry is a finding about provider observability, not a gap
  // to paper over with an invented number.
  const mt: StageUsage | undefined =
    mtUsage === undefined
      ? undefined
      : {
          model: models.mt,
          shape: 'token',
          inputTokens: mtUsage.inputTokens,
          outputTokens: mtUsage.outputTokens,
        };

  return priceCascade({ stt, mt, tts });
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
      // TICKET 052 — the STT stage bills PER MINUTE OF AUDIO, so the meter is
      // the audio actually handed to it. Counted here, at the one place every
      // sample of the turn passes through, rather than inferred from a
      // wall-clock span that includes think time.
      let sttSamples = peekedChunk.length;
      const turnAudio: AsyncGenerator<Int16Array, void, void> = (async function* () {
        yield peekedChunk;
        for (;;) {
          const r = await shared.next();
          if (r.done) return;
          sttSamples += r.value.length;
          yield r.value;
        }
      })();

      const sourcePartials: string[] = [];
      let sourceFinal: string | undefined;
      /** TICKET 051 — the instant the STT provider announced the endpointer. */
      let vadFired: number | undefined;
      let sttError: unknown;
      let sttFailed = false;

      const sttStream = providers.stt.transcribe(turnAudio, { signal: uttAc.signal });
      try {
        for await (const ev of sttStream) {
          if (uttAc.signal.aborted) break;
          if (ev.type === 'partial') {
            sourcePartials.push(ev.text);
            yield { type: 'stt.partial', utt: uttCounter, text: ev.text };
          } else if (ev.type === 'speech_stopped') {
            // The endpointer's decision, NOT the turn-final: it carries no text
            // and must not finalise the turn (an empty final is dropped as an
            // empty turn, which would lose the utterance entirely).
            vadFired ??= Date.now();
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
      // TICKET 051 — `vad_fired` is the ENDPOINTER'S ANNOUNCEMENT when the
      // provider makes one (openai-stt maps input_audio_buffer.speech_stopped).
      // A provider that announces nothing falls back to the turn-final's own
      // instant, exactly as before, so no prior run and no other adapter moves.
      timings.vad_fired = vadFired ?? tFinal;
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

      // TICKET 062 — the session's target language reaches the stage that needs
      // it. Spread rather than assigned: a session that named none must leave
      // the key ABSENT, so the adapter's own default applies visibly instead of
      // the pipeline inventing 'Spanish' for a run nobody told anything.
      // TICKET 053 — the vendor's OWN token count for this turn, or nothing.
      // Declared per turn so one utterance's meter can never be attributed to
      // the next, the shape of the bug ticket 068 caught in the audio path.
      let mtUsage: { inputTokens: number; outputTokens: number } | undefined;
      const mtStream = providers.mt.translate(finalText, {
        signal: uttAc.signal,
        onUsage: (u) => {
          mtUsage = u;
        },
        ...(opts?.session?.targetLanguage === undefined
          ? {}
          : { targetLanguage: opts.session.targetLanguage }),
      });
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
      const cost = cascadeCost(opts?.models, sttSamples, targetPartials, mtUsage, totalSamples);
      opts?.onCost?.(utt, cost);
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
        // TICKET 051 R2-4 — the orchestrator stamps NO `speech_end` (option (c)
        // is precisely the decision not to back-derive one), so claiming a
        // VAD-derived one was a falsehood in an exported field.
        speechEndSource: timings.speech_end === undefined ? 'none' : 'vad',
        providers: {
          stt: providers.stt.name,
          mt: providers.mt.name,
          tts: providers.tts.name,
        },
        costUnits: cost.total.usd,
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
