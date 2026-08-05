/**
 * Fixture (fake) providers with configurable delays and fault injection.
 *
 * STUB — behavior not implemented yet. Types/signatures are the contract.
 *
 * Pinned semantics the implementation must satisfy (encoded in tests):
 * - delayMs: wait delayMs (setTimeout) BEFORE each yielded item, including the first.
 * - failWith:
 *     'timeout'    -> hang (yield nothing) until aborted
 *     'rate-limit' -> throw RateLimitError (status 429)
 *     'empty'      -> complete with no output
 *     'error'      -> throw ProviderError
 * - AbortSignal (opts.signal): on abort the generator RETURNS promptly
 *   (clean end, no throw), cancels pending timers (no timer leaks), and
 *   yields nothing further. An already-aborted signal yields nothing.
 */

import type {
  MtProvider,
  ProviderCallOpts,
  SttEvent,
  SttProvider,
  TtsProvider,
} from '../types';

export type FixtureFault = 'timeout' | 'rate-limit' | 'empty' | 'error';

export interface FixtureBaseOptions {
  delayMs?: number;
  failWith?: FixtureFault;
}

export interface FixtureSttOptions extends FixtureBaseOptions {
  /** Canned partial transcripts, emitted in order before the final. */
  partials?: string[];
  /** Canned TURN-final transcript. */
  finalText?: string;
}

export interface FixtureMtOptions extends FixtureBaseOptions {
  /** Canned translation; yielded as >=2 token chunks whose concatenation equals it. */
  translation?: string;
}

export interface FixtureTtsOptions extends FixtureBaseOptions {
  /** Number of Int16 samples of audio synthesized per input character. */
  samplesPerChar?: number;
}

export class FixtureStt implements SttProvider {
  readonly name = 'fixture';
  constructor(readonly options: FixtureSttOptions = {}) {}

  // eslint-disable-next-line require-yield
  async *transcribe(
    audio: AsyncIterable<Int16Array>,
    opts?: ProviderCallOpts,
  ): AsyncGenerator<SttEvent, void, void> {
    void audio;
    void opts;
    throw new Error('not implemented');
  }
}

export class FixtureMt implements MtProvider {
  readonly name = 'fixture';
  readonly streaming = true;
  constructor(readonly options: FixtureMtOptions = {}) {}

  // eslint-disable-next-line require-yield
  async *translate(
    text: string,
    opts?: ProviderCallOpts,
  ): AsyncGenerator<string, void, void> {
    void text;
    void opts;
    throw new Error('not implemented');
  }
}

export class FixtureTts implements TtsProvider {
  readonly name = 'fixture';
  readonly streamingInput = true;
  constructor(readonly options: FixtureTtsOptions = {}) {}

  // eslint-disable-next-line require-yield
  async *synthesize(
    text: AsyncIterable<string>,
    opts?: ProviderCallOpts,
  ): AsyncGenerator<Int16Array, void, void> {
    void text;
    void opts;
    throw new Error('not implemented');
  }
}
