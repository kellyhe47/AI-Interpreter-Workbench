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

import { ProviderError } from '../../core/types';
import type { ProviderCallOpts, TtsProvider } from '../../core/types';
import {
  AsyncQueue,
  Pcm16Assembler,
  base64ToBytes,
  loadDefaultWsFactory,
  waitForOpen,
} from './internal';
import { envVar, type WsFactory } from './transport';

export const ELEVENLABS_DEFAULT_VOICE_ID = '21m00Tcm4TlvDq8ikWAM';

export interface ElevenLabsTtsConfig {
  apiKey?: string;
  /** Voice id used in the stream-input URL. Default ELEVENLABS_DEFAULT_VOICE_ID. */
  voiceId?: string;
  /** model_id used in the stream-input URL. Default 'eleven_flash_v2_5'. */
  modelId?: string;
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

  private readonly deps: ElevenLabsTtsDeps;

  constructor(config: ElevenLabsTtsConfig = {}, deps: ElevenLabsTtsDeps = {}) {
    this.config = config;
    this.apiKey = config.apiKey ?? envVar('ELEVENLABS_API_KEY');
    this.deps = deps;
  }

  async *synthesize(
    text: AsyncIterable<string>,
    opts?: ProviderCallOpts,
  ): AsyncGenerator<Int16Array, void, void> {
    const signal = opts?.signal;
    if (signal?.aborted) return;

    const wsFactory = this.deps.wsFactory ?? (await loadDefaultWsFactory());
    if (signal?.aborted) return;
    const voiceId = this.config.voiceId ?? ELEVENLABS_DEFAULT_VOICE_ID;
    const url =
      `wss://api.elevenlabs.io/v1/text-to-speech/${voiceId}/stream-input` +
      '?model_id=eleven_flash_v2_5&output_format=pcm_24000&auto_mode=true';
    const ws = wsFactory(url, { headers: { 'xi-api-key': this.apiKey ?? '' } });

    const queue = new AsyncQueue<Int16Array>();
    const assembler = new Pcm16Assembler();
    let wsClosed = false;
    const closeWs = (): void => {
      if (wsClosed) return;
      wsClosed = true;
      try {
        ws.close();
      } catch {
        // socket may already be gone
      }
    };
    const onAbort = (): void => {
      queue.abort();
      closeWs();
    };
    signal?.addEventListener('abort', onAbort, { once: true });

    ws.on('message', (data) => {
      let msg: { audio?: unknown; isFinal?: unknown; error?: unknown };
      try {
        msg = JSON.parse(String(data)) as typeof msg;
      } catch {
        return;
      }
      if (msg.error !== undefined && msg.error !== null) {
        queue.fail(
          new ProviderError(`elevenlabs tts error: ${JSON.stringify(msg.error)}`),
        );
        return;
      }
      if (typeof msg.audio === 'string' && msg.audio.length > 0) {
        const samples = assembler.push(base64ToBytes(msg.audio));
        if (samples !== null && samples.length > 0) queue.push(samples);
      }
      if (msg.isFinal === true) queue.end();
    });
    ws.on('error', (err) => {
      queue.fail(new ProviderError(`elevenlabs tts transport error: ${String(err)}`));
    });
    ws.on('close', () => queue.end());

    // Pump: init frame, then one {text} frame per input chunk AS IT ARRIVES
    // (never concatenated), then {text:''} on input end. Runs concurrently
    // with the consumer loop below so audio is yielded while input streams in.
    void (async () => {
      await waitForOpen(ws);
      if (wsClosed || queue.isDone) return;
      ws.send(
        JSON.stringify({
          text: ' ',
          voice_settings: {
            stability: this.config.stability ?? 0.5,
            similarity_boost: this.config.similarityBoost ?? 0.75,
          },
        }),
      );
      const inputIterator = text[Symbol.asyncIterator]();
      while (true) {
        // Pace on the consumer: only pull more input once already-yielded
        // audio has been taken, so text frames interleave with audio output
        // instead of draining the input first. Also keeps us off a hung input
        // after an abort (the gate releases when the queue finishes).
        await queue.whenConsumerWaiting();
        if (wsClosed || queue.isDone) return;
        const step = await inputIterator.next();
        if (wsClosed || queue.isDone) return;
        if (step.done) break;
        if (step.value === '') continue; // empty frame would signal end-of-input
        ws.send(JSON.stringify({ text: step.value }));
      }
      ws.send(JSON.stringify({ text: '' }));
    })().catch((err: unknown) => {
      queue.fail(
        err instanceof ProviderError
          ? err
          : new ProviderError(`elevenlabs tts input error: ${String(err)}`),
      );
    });

    try {
      for await (const audio of queue) yield audio;
    } finally {
      signal?.removeEventListener('abort', onAbort);
      queue.abort();
      closeWs();
    }
  }
}
