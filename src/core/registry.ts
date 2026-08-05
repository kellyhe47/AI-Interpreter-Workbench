/**
 * Provider registry.
 *
 * STUB — behavior not implemented yet.
 *
 * Pinned semantics (encoded in tests):
 * - createStt('fixture', opts) -> FixtureStt instance (opts forwarded to ctor).
 * - createMt('fixture', opts)  -> FixtureMt instance.
 * - createTts('fixture', opts) -> FixtureTts instance.
 * - options argument is optional.
 * - Unknown name throws an Error whose message contains the unknown name AND
 *   lists the known provider names (e.g. "fixture").
 */

import type { MtProvider, SttProvider, TtsProvider } from './types';

export function createStt(
  name: string,
  options?: Record<string, unknown>,
): SttProvider {
  void name;
  void options;
  throw new Error('not implemented');
}

export function createMt(
  name: string,
  options?: Record<string, unknown>,
): MtProvider {
  void name;
  void options;
  throw new Error('not implemented');
}

export function createTts(
  name: string,
  options?: Record<string, unknown>,
): TtsProvider {
  void name;
  void options;
  throw new Error('not implemented');
}
