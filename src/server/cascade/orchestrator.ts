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
import type { CascadeTimestamps, UtteranceRecord } from '../../core/timing';
import type { CascadeStage } from '../../core/protocol';
import type { TimingMark, TimingSink } from '../../core/decorators/index';

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
 * Run the cascade pipeline over `source` until the source is exhausted or
 * `opts.signal` aborts. See the module doc-comment for the full contract.
 */
export function runCascade(
  source: AsyncIterable<Int16Array>,
  providers: CascadeProviders,
  opts?: RunCascadeOptions,
): AsyncGenerator<CascadeEvent, void, void> {
  void source;
  void providers;
  void opts;
  throw new Error('not implemented');
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
  void config;
  throw new Error('not implemented');
}
