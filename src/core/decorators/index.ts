/**
 * Provider decorators: withTimeout / withRetry / withTiming.
 *
 * STUB — behavior not implemented yet. Types/signatures are the contract.
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

import type { MtProvider, SttProvider, TtsProvider } from '../types';

export type ProviderLike = SttProvider | MtProvider | TtsProvider;

export type TimingEvent = 'call_start' | 'first_yield' | 'complete';

export interface TimingMark {
  stage: string;
  event: TimingEvent;
  t: number;
}

export type TimingSink = (mark: TimingMark) => void;

export function withTimeout<P extends ProviderLike>(provider: P, ms: number): P {
  void provider;
  void ms;
  throw new Error('not implemented');
}

export function withRetry<P extends ProviderLike>(
  provider: P,
  opts: { retries: number; backoffMs: number },
): P {
  void provider;
  void opts;
  throw new Error('not implemented');
}

export function withTiming<P extends ProviderLike>(
  stage: string,
  provider: P,
  sink: TimingSink,
): P {
  void stage;
  void provider;
  void sink;
  throw new Error('not implemented');
}
