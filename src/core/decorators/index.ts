/**
 * Provider decorators: withTimeout / withRetry / withTiming.
 *
 * Pinned semantics (encoded in tests):
 * - Decorators are interface-generic: they accept any of SttProvider /
 *   MtProvider / TtsProvider and return the SAME interface shape, so they
 *   compose: withTiming('stt', withRetry(withTimeout(p, 5000), {...}), sink).
 * - withTimeout(provider, ms): ms is a per-next() inactivity timeout. If the
 *   underlying stream produces nothing within ms, it throws TimeoutError AND
 *   aborts the AbortSignal it passed to the underlying provider. Timers are
 *   cleaned up on completion/abort (no leaks).
 * - withRetry(provider, {retries, backoffMs}): retries the CALL only when it
 *   fails with RateLimitError, waiting a fixed backoffMs (setTimeout) between
 *   attempts. Any other error propagates immediately with no retry.
 *   `retries` = number of retries after the first attempt.
 * - withTiming(stage, provider, sink): emits marks via sink with
 *   t = Date.now(): {stage, event:'call_start', t} when the method is called,
 *   {stage, event:'first_yield', t} at the first yielded item, and
 *   {stage, event:'complete', t} when the stream ends.
 * - Caller AbortSignal propagates through all decorators; on abort the
 *   stream returns promptly (clean end) with no timer leaks.
 */

import type {
  MtProvider,
  ProviderCallOpts,
  SttProvider,
  TtsProvider,
} from '../types';
import { RateLimitError, TimeoutError } from '../types';

export type ProviderLike = SttProvider | MtProvider | TtsProvider;

export type TimingEvent = 'call_start' | 'first_yield' | 'complete';

export interface TimingMark {
  stage: string;
  event: TimingEvent;
  t: number;
}

export type TimingSink = (mark: TimingMark) => void;

type StreamMethodName = 'transcribe' | 'translate' | 'synthesize';

type AnyStream = AsyncGenerator<unknown, void, void>;

/** Re-invoke the underlying provider call with (possibly rewritten) opts. */
type Invoke = (opts: ProviderCallOpts | undefined) => AnyStream;

type WrapCall = (invoke: Invoke, opts: ProviderCallOpts | undefined) => AnyStream;

function streamMethodName(provider: ProviderLike): StreamMethodName {
  if ('transcribe' in provider) return 'transcribe';
  if ('translate' in provider) return 'translate';
  return 'synthesize';
}

/**
 * Produce a provider of the same interface shape whose streaming method is
 * replaced by wrapCall around the original. Non-method own properties
 * (name, streaming, streamingInput, options, ...) are carried over.
 */
function wrapProvider<P extends ProviderLike>(provider: P, wrapCall: WrapCall): P {
  const method = streamMethodName(provider);
  const original = (
    provider as unknown as Record<string, (input: unknown, opts?: ProviderCallOpts) => AnyStream>
  )[method];
  if (typeof original !== 'function') {
    throw new Error(`provider has no streaming method "${method}"`);
  }
  const wrapped = {
    ...provider,
    [method]: (input: unknown, opts?: ProviderCallOpts): AnyStream =>
      wrapCall((o) => original.call(provider, input, o), opts),
  };
  return wrapped as P;
}

export function withTimeout<P extends ProviderLike>(provider: P, ms: number): P {
  return wrapProvider(provider, (invoke, opts) => {
    async function* run(): AnyStream {
      const ac = new AbortController();
      const outerSignal = opts?.signal;
      const onOuterAbort = (): void => ac.abort();
      if (outerSignal) {
        if (outerSignal.aborted) ac.abort();
        else outerSignal.addEventListener('abort', onOuterAbort, { once: true });
      }
      const inner = invoke({ ...opts, signal: ac.signal });
      try {
        for (;;) {
          let timer: ReturnType<typeof setTimeout> | undefined;
          const timeout = new Promise<never>((_, reject) => {
            timer = setTimeout(() => {
              ac.abort();
              reject(new TimeoutError(`provider produced no activity within ${ms}ms`));
            }, ms);
          });
          let result: IteratorResult<unknown, void>;
          try {
            result = await Promise.race([inner.next(), timeout]);
          } finally {
            clearTimeout(timer);
          }
          if (result.done) return;
          yield result.value;
        }
      } finally {
        outerSignal?.removeEventListener('abort', onOuterAbort);
      }
    }
    return run();
  });
}

export function withRetry<P extends ProviderLike>(
  provider: P,
  opts: { retries: number; backoffMs: number },
): P {
  const { retries, backoffMs } = opts;
  return wrapProvider(provider, (invoke, callOpts) => {
    async function* run(): AnyStream {
      let attempt = 0;
      for (;;) {
        try {
          yield* invoke(callOpts);
          return;
        } catch (err) {
          if (!(err instanceof RateLimitError) || attempt >= retries) throw err;
          attempt += 1;
          await new Promise<void>((resolve) => setTimeout(resolve, backoffMs));
        }
      }
    }
    return run();
  });
}

export function withTiming<P extends ProviderLike>(
  stage: string,
  provider: P,
  sink: TimingSink,
): P {
  return wrapProvider(provider, (invoke, callOpts) => {
    async function* run(): AnyStream {
      sink({ stage, event: 'call_start', t: Date.now() });
      let sawFirst = false;
      try {
        for await (const value of invoke(callOpts)) {
          if (!sawFirst) {
            sawFirst = true;
            sink({ stage, event: 'first_yield', t: Date.now() });
          }
          yield value;
        }
      } finally {
        sink({ stage, event: 'complete', t: Date.now() });
      }
    }
    return run();
  });
}
