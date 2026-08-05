/**
 * ElevenLabs streaming-input TTS adapter. STUB — tests first (TDD).
 *
 * The ONE provider with true streaming text input (streamingInput = TRUE).
 *
 * Design decisions pinned by elevenlabs-tts.test.ts:
 * - Transport: WebSocket to
 *   wss://api.elevenlabs.io/v1/text-to-speech/<voiceId>/stream-input
 *     ?model_id=eleven_flash_v2_5&output_format=pcm_24000&auto_mode=true
 *   with header `xi-api-key: <key>`, created through injected `deps.wsFactory`.
 * - API key resolved AT CONSTRUCTION: `config.apiKey ?? process.env.ELEVENLABS_API_KEY`.
 * - Default voiceId '21m00Tcm4TlvDq8ikWAM' (config.voiceId overrides the URL).
 * - Frame protocol:
 *   1. init frame after open: {text: ' ', voice_settings: {stability,
 *      similarity_boost}} (numbers; defaults 0.5 / 0.75, config overrides).
 *   2. one {text: <chunk>} frame PER input chunk, sent AS THE CHUNK ARRIVES —
 *      never concatenated, in input order.
 *   3. on input end: {text: ''}.
 * - IMPORTANT for the streaming contract: the adapter must NOT drain the input
 *   iterable ahead of yielding — it interleaves sending text frames with
 *   yielding audio that has already arrived, so the first audio chunk is
 *   yielded BEFORE the input iterable completes.
 * - Server messages (JSON):
 *   {audio: <base64 PCM16 LE @24kHz>} -> decode and yield Int16Array. Byte
 *     payloads may not be sample-aligned per message: a trailing odd byte is
 *     CARRIED into the next audio message (odd-byte guard, regression-locked).
 *   {isFinal: true} -> generator completes (socket closed).
 *   {error: ...} -> throws ProviderError whose message mentions 'elevenlabs'.
 * - Abort: already-aborted yields nothing and opens no connection; abort
 *   mid-synthesis closes the socket and the generator RETURNS cleanly.
 */

import type { ProviderCallOpts, TtsProvider } from '../../core/types';
import { envVar, type WsFactory } from './transport';

export const ELEVENLABS_DEFAULT_VOICE_ID = '21m00Tcm4TlvDq8ikWAM';

export interface ElevenLabsTtsConfig {
  apiKey?: string;
  /** Voice id used in the stream-input URL. Default ELEVENLABS_DEFAULT_VOICE_ID. */
  voiceId?: string;
  /** voice_settings.stability. Default 0.5. */
  stability?: number;
  /** voice_settings.similarity_boost. Default 0.75. */
  similarityBoost?: number;
}

export interface ElevenLabsTtsDeps {
  wsFactory?: WsFactory;
}

export class ElevenLabsTts implements TtsProvider {
  readonly name = 'elevenlabs';
  readonly streamingInput = true;
  readonly config: ElevenLabsTtsConfig;
  /** Resolved at construction (config first, then ELEVENLABS_API_KEY). */
  readonly apiKey: string | undefined;

  constructor(config: ElevenLabsTtsConfig = {}, deps: ElevenLabsTtsDeps = {}) {
    this.config = config;
    this.apiKey = config.apiKey ?? envVar('ELEVENLABS_API_KEY');
    void deps;
  }

  synthesize(
    _text: AsyncIterable<string>,
    _opts?: ProviderCallOpts,
  ): AsyncGenerator<Int16Array, void, void> {
    throw new Error('not implemented');
  }
}
