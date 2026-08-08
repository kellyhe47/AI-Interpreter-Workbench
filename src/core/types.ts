/**
 * Core provider interfaces and error vocabulary.
 * Isomorphic TypeScript — MUST NOT import node or DOM-only modules.
 */

/** Options passed to every provider call. */
export interface ProviderCallOpts {
  signal?: AbortSignal;
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
