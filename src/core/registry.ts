/**
 * Provider registry.
 *
 * - createStt: 'fixture' -> FixtureStt, 'openai' -> OpenAiStt,
 *              'elevenlabs' -> ElevenLabsStt.
 * - createMt:  'fixture' -> FixtureMt,  'openai' -> OpenAiMt,
 *              'anthropic' -> AnthropicMt.
 * - createTts: 'fixture' -> FixtureTts, 'openai' -> OpenAiTts,
 *              'elevenlabs' -> ElevenLabsTts.
 * - options argument is optional and forwarded to the constructor.
 * - Unknown name throws an Error whose message contains the unknown name AND
 *   lists ALL known provider names for that kind.
 *
 * Same-vendor model swaps are config-only and get NO registry name of their
 * own: 'gpt-4o-mini-transcribe' is createStt('openai', {model}), and
 * Multilingual v2 is createTts('elevenlabs', {modelId}).
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
import {
  ElevenLabsStt,
  type ElevenLabsSttConfig,
} from '../server/providers/elevenlabs-stt';
import { AnthropicMt, type AnthropicMtConfig } from '../server/providers/anthropic-mt';

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
  if (name === 'elevenlabs') return new ElevenLabsStt(options as ElevenLabsSttConfig);
  throw unknownProvider('STT', name, ['fixture', 'openai', 'elevenlabs']);
}

export function createMt(
  name: string,
  options?: Record<string, unknown>,
): MtProvider {
  if (name === 'fixture') return new FixtureMt(options as FixtureMtOptions);
  if (name === 'openai') return new OpenAiMt(options as OpenAiMtConfig);
  if (name === 'anthropic') return new AnthropicMt(options as AnthropicMtConfig);
  throw unknownProvider('MT', name, ['fixture', 'openai', 'anthropic']);
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
