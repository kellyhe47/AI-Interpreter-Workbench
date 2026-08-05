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
 */
export interface SttEvent {
  type: 'partial' | 'final';
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
