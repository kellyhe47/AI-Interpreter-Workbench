/**
 * ElevenLabs Scribe v2 Realtime STT adapter. STUB — tests first (TDD).
 *
 * Structurally mirrors `openai-stt.ts` (the exemplar WS-based STT adapter):
 * WebSocket transport injected through `deps.wsFactory`, an `AsyncQueue`
 * bridging socket listeners to the generator, lazy default ws factory, and the
 * project-wide abort contract.
 *
 * Design decisions pinned by elevenlabs-stt.test.ts:
 * - Transport: WebSocket to an `wss://api.elevenlabs.io/...` speech-to-text
 *   realtime endpoint whose URL carries the model id, with header
 *   `xi-api-key: <key>` (same header as elevenlabs-tts.ts), created through the
 *   injected `deps.wsFactory`.
 * - API key resolved AT CONSTRUCTION: `config.apiKey ?? envVar('ELEVENLABS_API_KEY')`.
 * - Default model `scribe_v2_realtime`; `config.model` overrides it. The model
 *   is never hardcoded anywhere else on the wire.
 * - First frame is the connection/config frame: it declares the sample rate
 *   **24000** (24 kHz is pinned project-wide) and endpointing
 *   `silence_duration_ms: 500` (PRD §8 — the same VAD every arm uses).
 * - Audio input: ONE frame per `Int16Array` chunk pulled from the input
 *   iterable, sent AS THE CHUNK ARRIVES (the adapter never drains the input
 *   first), carrying base64 of little-endian PCM16.
 *
 * ASSUMED SCRIBE SERVER WIRE FORMAT — the live event names are not knowable
 * without a real call, so the adapter accepts BOTH of these encodings and the
 * operator's smoke test resolves which one Scribe actually speaks:
 *
 *   partial    { type: 'partial_transcript',   text: 'hola' }
 *          OR  { type: 'transcript', text: 'hola',       is_final: false }
 *
 *   committed  { type: 'committed_transcript', text: 'hola mundo' }
 *          OR  { type: 'transcript', text: 'hola mundo', is_final: true }
 *
 *   error      { type: 'error', error: { message: 'boom' } }
 *          OR  { error: 'quota_exceeded' }   (the shape elevenlabs-tts.ts uses)
 *
 * `text` carries the FULL transcript so far for the CURRENT turn (running
 * transcripts, not OpenAI-style deltas): it is passed through unchanged, and a
 * new turn starts from scratch after each committed message.
 *
 * THE MAPPING (PRD §6, §8, §13 test 6): **committed is the TURN-FINAL signal**
 * -> `SttEvent {type:'final'}`; a **partial is not** -> `{type:'partial'}`. A
 * turn is therefore zero or more partials followed by exactly one final, the
 * final being the last event of the turn — the rule `checkTurnFinalMapping`
 * enforces for every STT provider.
 *
 * - Abort: an already-aborted signal yields nothing and opens NO connection;
 *   abort mid-stream closes the socket and the generator RETURNS cleanly.
 * - A socket close ends the generator cleanly.
 */

import { ProviderError } from '../../core/types';
import type { ProviderCallOpts, SttEvent, SttProvider } from '../../core/types';
import type { WsFactory } from './transport';

export interface ElevenLabsSttConfig {
  apiKey?: string;
  /** Scribe model id. Default 'scribe_v2_realtime'. */
  model?: string;
  /** Optional source-language hint passed on the config frame. */
  languageCode?: string;
}

export interface ElevenLabsSttDeps {
  wsFactory?: WsFactory;
}

export class ElevenLabsStt implements SttProvider {
  readonly name = 'elevenlabs';
  readonly config: ElevenLabsSttConfig;

  protected readonly deps: ElevenLabsSttDeps;

  constructor(config: ElevenLabsSttConfig = {}, deps: ElevenLabsSttDeps = {}) {
    this.config = config;
    this.deps = deps;
  }

  async *transcribe(
    _audio: AsyncIterable<Int16Array>,
    _opts?: ProviderCallOpts,
  ): AsyncGenerator<SttEvent, void, void> {
    throw new ProviderError('stub: not implemented (ticket 004)');
  }
}
