/**
 * Fixture (fake) providers with configurable delays and fault injection.
 *
 * Pinned semantics (encoded in tests):
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
import { ProviderError, RateLimitError } from '../types';

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

/**
 * Abortable delay. Resolves 'ok' after ms, or 'aborted' promptly on abort
 * (clearing the pending timer so no timers leak).
 */
function delay(ms: number, signal?: AbortSignal): Promise<'ok' | 'aborted'> {
  return new Promise((resolve) => {
    if (signal?.aborted) {
      resolve('aborted');
      return;
    }
    const onAbort = (): void => {
      clearTimeout(timer);
      resolve('aborted');
    };
    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort);
      resolve('ok');
    }, ms);
    signal?.addEventListener('abort', onAbort, { once: true });
  });
}

/** Resolves only when the signal aborts; never resolves without a signal. */
function hangUntilAbort(signal?: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    if (!signal) return;
    if (signal.aborted) {
      resolve();
      return;
    }
    signal.addEventListener('abort', () => resolve(), { once: true });
  });
}

/**
 * Handle failWith at stream start. Returns 'return' when the generator should
 * end with no output; throws for the throwing faults; returns 'continue' when
 * normal output should proceed.
 */
async function applyFault(
  fault: FixtureFault | undefined,
  signal?: AbortSignal,
): Promise<'continue' | 'return'> {
  switch (fault) {
    case undefined:
      return 'continue';
    case 'timeout':
      await hangUntilAbort(signal);
      return 'return';
    case 'rate-limit':
      throw new RateLimitError();
    case 'empty':
      return 'return';
    case 'error':
      throw new ProviderError('fixture: injected error');
  }
}

/** Split text into >=2 chunks whose concatenation equals the input. */
function splitIntoChunks(text: string): string[] {
  if (text.length < 2) return [text, ''];
  const mid = Math.ceil(text.length / 2);
  return [text.slice(0, mid), text.slice(mid)];
}

export class FixtureStt implements SttProvider {
  readonly name = 'fixture';
  constructor(readonly options: FixtureSttOptions = {}) {}

  async *transcribe(
    audio: AsyncIterable<Int16Array>,
    opts?: ProviderCallOpts,
  ): AsyncGenerator<SttEvent, void, void> {
    void audio;
    const signal = opts?.signal;
    if (signal?.aborted) return;
    if ((await applyFault(this.options.failWith, signal)) === 'return') return;

    const delayMs = this.options.delayMs ?? 0;
    const partials = this.options.partials ?? ['hel', 'hello'];
    const finalText = this.options.finalText ?? 'hello world';

    let t = 0;
    for (const text of partials) {
      if ((await delay(delayMs, signal)) === 'aborted') return;
      yield { type: 'partial', text, tStart: t, tEnd: t + delayMs };
      t += delayMs;
    }
    if ((await delay(delayMs, signal)) === 'aborted') return;
    yield { type: 'final', text: finalText, tStart: 0, tEnd: t + delayMs };
  }
}

export class FixtureMt implements MtProvider {
  readonly name = 'fixture';
  readonly streaming = true;
  constructor(readonly options: FixtureMtOptions = {}) {}

  async *translate(
    text: string,
    opts?: ProviderCallOpts,
  ): AsyncGenerator<string, void, void> {
    void text;
    const signal = opts?.signal;
    if (signal?.aborted) return;
    if ((await applyFault(this.options.failWith, signal)) === 'return') return;

    const delayMs = this.options.delayMs ?? 0;
    const translation = this.options.translation ?? 'hola mundo';
    for (const chunk of splitIntoChunks(translation)) {
      if ((await delay(delayMs, signal)) === 'aborted') return;
      yield chunk;
    }
  }
}

export class FixtureTts implements TtsProvider {
  readonly name = 'fixture';
  readonly streamingInput = true;
  constructor(readonly options: FixtureTtsOptions = {}) {}

  async *synthesize(
    text: AsyncIterable<string>,
    opts?: ProviderCallOpts,
  ): AsyncGenerator<Int16Array, void, void> {
    const signal = opts?.signal;
    if (signal?.aborted) return;
    if ((await applyFault(this.options.failWith, signal)) === 'return') return;

    const delayMs = this.options.delayMs ?? 0;
    const samplesPerChar = this.options.samplesPerChar ?? 40;

    // Pull-driven: synthesize audio for each input chunk as it arrives,
    // never draining the whole input first.
    for await (const chunk of text) {
      if ((await delay(delayMs, signal)) === 'aborted') return;
      yield new Int16Array(Math.max(1, chunk.length * samplesPerChar));
    }
  }
}
