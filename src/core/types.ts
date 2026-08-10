/**
 * Core provider interfaces and error vocabulary.
 * Isomorphic TypeScript — MUST NOT import node or DOM-only modules.
 */

/** Options passed to every provider call. */
export interface ProviderCallOpts {
  signal?: AbortSignal;
  /**
   * TICKET 053 — where a provider hands back the usage ITS VENDOR REPORTED,
   * when the vendor reports any. Never an estimate: a provider that is told
   * nothing calls this never, and the stage prices as `no-usage-reported`
   * rather than as a stage that cost nothing.
   *
   * It is a CALLBACK rather than a return value because `translate` yields a
   * token stream — the usage frame arrives after the last content delta, so
   * there is no return slot left to put it in.
   */
  onUsage?: (usage: { inputTokens: number; outputTokens: number }) => void;
  /**
   * TICKET 062 — the human-readable language THIS CALL must produce ('Spanish').
   * A per-CALL fact, not a construction one: the registry builds every MT
   * adapter from `{ model }` alone, so an adapter that could only read its
   * construction default put "into Spanish" in the system prompt for every pair
   * and both directions — an ES→EN run asked for Spanish translated into
   * Spanish, and an EN→YUE run produced Spanish.
   *
   * ABSENT MEANS ABSENT. A session that named no target language must not be
   * given an invented one here; the pipeline passes nothing and the adapter's
   * own default applies, which is a fact the run can be judged on rather than a
   * confident wrong answer manufactured mid-pipeline.
   */
  targetLanguage?: string;
}

/**
 * STT stream event. `type: 'final'` means TURN-final: the single closing
 * event for an utterance/turn (not a segment-final).
 *
 * TICKET 051 — `'speech_stopped'` is the endpointer announcing that the
 * speaker has stopped, which happens BEFORE the closing transcript arrives.
 * It is the cascade twin of realtime's `server_speech_stopped`, and it is the
 * only mark from which "detected end of speech -> transcript" can be measured;
 * without it `vad_fired` is a synthetic copy of `stt_final` and that stage is
 * identically zero. It carries no text. A provider whose API exposes no such
 * signal simply never emits it, and the orchestrator falls back to the
 * turn-final instant — which is exactly today's behaviour.
 */
export interface SttEvent {
  type: 'partial' | 'final' | 'speech_stopped';
  text: string;
  tStart: number;
  tEnd: number;
}

export interface SttProvider {
  readonly name: string;
  transcribe(
    audio: AsyncIterable<Int16Array>,
    opts?: ProviderCallOpts,
  ): AsyncGenerator<SttEvent, void, void>;
}

export interface MtProvider {
  readonly name: string;
  /** true if the provider yields the translation in multiple token chunks. */
  readonly streaming: boolean;
  translate(
    text: string,
    opts?: ProviderCallOpts,
  ): AsyncGenerator<string, void, void>;
}

export interface TtsProvider {
  readonly name: string;
  /** true if the provider can start yielding audio before its text input completes. */
  readonly streamingInput: boolean;
  synthesize(
    text: AsyncIterable<string>,
    opts?: ProviderCallOpts,
  ): AsyncGenerator<Int16Array, void, void>;
}

export class ProviderError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = 'ProviderError';
  }
}

export class RateLimitError extends ProviderError {
  readonly status: number = 429;
  constructor(message = 'rate limited', options?: ErrorOptions) {
    super(message, options);
    this.name = 'RateLimitError';
  }
}

export class TimeoutError extends ProviderError {
  constructor(message = 'timed out', options?: ErrorOptions) {
    super(message, options);
    this.name = 'TimeoutError';
  }
}
