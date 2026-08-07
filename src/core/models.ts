/**
 * Model id -> (vendor, adapter options) resolution. STUB (ticket 039).
 *
 * `registry.ts` is keyed by VENDOR ('openai' | 'elevenlabs' | 'anthropic' |
 * 'fixture'); `arms.ts` MENUS are MODEL ids. This module is the single mapping
 * between the two, in `src/core/` so client and server agree on one answer.
 *
 * The option KEY is part of the mapping, not a constant: ElevenLabs TTS takes
 * `modelId` while every other adapter takes `model`.
 */
import type { ProviderTriple } from './arms';

export type ProviderKind = 'stt' | 'mt' | 'tts';

export interface ResolvedProvider {
  /** Registry key for createStt/createMt/createTts. */
  vendor: string;
  /** Options forwarded verbatim to the adapter constructor. */
  options: Record<string, unknown>;
}

export interface ResolvedTriple {
  stt: ResolvedProvider;
  mt: ResolvedProvider;
  tts: ResolvedProvider;
}

export function resolveModel(_kind: ProviderKind, _model: string): ResolvedProvider {
  throw new Error('not implemented');
}

export function resolveTriple(_triple: ProviderTriple): ResolvedTriple {
  throw new Error('not implemented');
}
