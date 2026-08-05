/**
 * Provider registry.
 *
 * - createStt: 'fixture' -> FixtureStt, 'openai' -> OpenAiStt.
 * - createMt:  'fixture' -> FixtureMt,  'openai' -> OpenAiMt.
 * - createTts: 'fixture' -> FixtureTts, 'openai' -> OpenAiTts,
 *              'elevenlabs' -> ElevenLabsTts.
 * - options argument is optional and forwarded to the constructor.
 * - Unknown name throws an Error whose message contains the unknown name AND
 *   lists ALL known provider names for that kind.
 */

import type { MtProvider, SttProvider, TtsProvider } from './types';
import { FixtureMt, FixtureStt, FixtureTts } from './fixtures/index';
import type {
  FixtureMtOptions,
  FixtureSttOptions,
  FixtureTtsOptions,
} from './fixtures/index';
import { OpenAiStt, type OpenAiSttConfig } from '../server/providers/openai-stt';
import { OpenAiMt, type OpenAiMtConfig } from '../server/providers/openai-mt';
import { OpenAiTts, type OpenAiTtsConfig } from '../server/providers/openai-tts';
import {
  ElevenLabsTts,
  type ElevenLabsTtsConfig,
} from '../server/providers/elevenlabs-tts';

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
  if (name === 'openai') return new OpenAiStt(options as OpenAiSttConfig);
  throw unknownProvider('STT', name, ['fixture', 'openai']);
}

export function createMt(
  name: string,
  options?: Record<string, unknown>,
): MtProvider {
  if (name === 'fixture') return new FixtureMt(options as FixtureMtOptions);
  if (name === 'openai') return new OpenAiMt(options as OpenAiMtConfig);
  throw unknownProvider('MT', name, ['fixture', 'openai']);
}

export function createTts(
  name: string,
  options?: Record<string, unknown>,
): TtsProvider {
  if (name === 'fixture') return new FixtureTts(options as FixtureTtsOptions);
  if (name === 'openai') return new OpenAiTts(options as OpenAiTtsConfig);
  if (name === 'elevenlabs') return new ElevenLabsTts(options as ElevenLabsTtsConfig);
  throw unknownProvider('TTS', name, ['fixture', 'openai', 'elevenlabs']);
}
