/**
 * Provider registry.
 *
 * - createStt('fixture', opts) -> FixtureStt instance (opts forwarded to ctor).
 * - createMt('fixture', opts)  -> FixtureMt instance.
 * - createTts('fixture', opts) -> FixtureTts instance.
 * - options argument is optional.
 * - Unknown name throws an Error whose message contains the unknown name AND
 *   lists the known provider names (e.g. "fixture").
 */

import type { MtProvider, SttProvider, TtsProvider } from './types';
import { FixtureMt, FixtureStt, FixtureTts } from './fixtures/index';
import type {
  FixtureMtOptions,
  FixtureSttOptions,
  FixtureTtsOptions,
} from './fixtures/index';

function unknownProvider(kind: string, name: string, known: readonly string[]): Error {
  return new Error(
    `Unknown ${kind} provider "${name}". Known providers: ${known.join(', ')}`,
  );
}

export function createStt(
  name: string,
  options?: Record<string, unknown>,
): SttProvider {
  if (name === 'fixture') return new FixtureStt(options as FixtureSttOptions);
  throw unknownProvider('STT', name, ['fixture']);
}

export function createMt(
  name: string,
  options?: Record<string, unknown>,
): MtProvider {
  if (name === 'fixture') return new FixtureMt(options as FixtureMtOptions);
  throw unknownProvider('MT', name, ['fixture']);
}

export function createTts(
  name: string,
  options?: Record<string, unknown>,
): TtsProvider {
  if (name === 'fixture') return new FixtureTts(options as FixtureTtsOptions);
  throw unknownProvider('TTS', name, ['fixture']);
}
