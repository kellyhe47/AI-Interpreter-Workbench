/**
 * ElevenLabs Scribe v2 Realtime STT adapter.
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
 *   `silence_duration_ms: ENDPOINTING_MS` (PRD §8 — the same VAD every arm uses).
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
 *
 * CONCRETE WIRE THIS FILE SPEAKS (all of it ASSUMED — reconcile against the
 * real API during the operator's live smoke test; everything below is one
 * edit away from the truth because nothing here is duplicated elsewhere):
 *
 *   URL     wss://api.elevenlabs.io/v1/speech-to-text/realtime
 *             ?model_id=<model>[&language_code=<lang>]
 *   header  xi-api-key: <key>
 *   frame 0 { type: 'conversation_config',
 *             audio_format: { encoding: 'pcm_s16le', sample_rate: 24000 },
 *             vad: { silence_duration_ms: ENDPOINTING_MS }[, language_code] }
 *   frame n { type: 'audio', audio: '<base64 PCM16-LE>' }   (one per chunk)
 *
 * The model id appears ONLY in the URL, never in a frame, so overriding
 * `config.model` leaves no trace of the default anywhere on the wire.
 *
 * - tStart/tEnd: milliseconds since transcription start (wall-clock based);
 *   tStart is the start of the CURRENT turn. The contract only requires
 *   numbers.
 */

import { ENDPOINTING_MS } from '../../core/protocol';
import { ProviderError } from '../../core/types';
import type { ProviderCallOpts, SttEvent, SttProvider } from '../../core/types';
import {
  AsyncQueue,
  bytesToBase64,
  int16ToLeBytes,
  loadDefaultWsFactory,
  waitForOpen,
} from './internal';
import { envVar, type WsFactory } from './transport';

export const ELEVENLABS_DEFAULT_STT_MODEL = 'scribe_v2_realtime';

const REALTIME_BASE_URL = 'wss://api.elevenlabs.io/v1/speech-to-text/realtime';

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

/** Server messages this adapter understands (both assumed encodings). */
interface ScribeMessage {
  type?: unknown;
  text?: unknown;
  is_final?: unknown;
  error?: unknown;
}

/** null = ignore; otherwise the turn-relative role of the message. */
function classify(msg: ScribeMessage): 'partial' | 'final' | null {
  const type = typeof msg.type === 'string' ? msg.type : undefined;
  if (type === 'partial_transcript') return 'partial';
  if (type === 'committed_transcript') return 'final';
  // Encoding B: a single 'transcript' type discriminated by the boolean flag.
  if (type === 'transcript') return msg.is_final === true ? 'final' : 'partial';
  return null;
}

export class ElevenLabsStt implements SttProvider {
  readonly name = 'elevenlabs';
  readonly config: ElevenLabsSttConfig;
  /** Resolved at construction (config first, then ELEVENLABS_API_KEY). */
  readonly apiKey: string | undefined;

  protected readonly deps: ElevenLabsSttDeps;

  constructor(config: ElevenLabsSttConfig = {}, deps: ElevenLabsSttDeps = {}) {
    this.config = config;
    this.apiKey = config.apiKey ?? envVar('ELEVENLABS_API_KEY');
    this.deps = deps;
  }

  async *transcribe(
    audio: AsyncIterable<Int16Array>,
    opts?: ProviderCallOpts,
  ): AsyncGenerator<SttEvent, void, void> {
    const signal = opts?.signal;
    if (signal?.aborted) return;

    const wsFactory = this.deps.wsFactory ?? (await loadDefaultWsFactory());
    if (signal?.aborted) return;

    const model = this.config.model ?? ELEVENLABS_DEFAULT_STT_MODEL;
    const lang = this.config.languageCode;
    const url =
      `${REALTIME_BASE_URL}?model_id=${encodeURIComponent(model)}` +
      (lang === undefined ? '' : `&language_code=${encodeURIComponent(lang)}`);
    const ws = wsFactory(url, { headers: { 'xi-api-key': this.apiKey ?? '' } });

    const queue = new AsyncQueue<SttEvent>();
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

    const t0 = Date.now();
    /** Start of the CURRENT turn; reset by every committed message. */
    let turnStart: number | null = null;
    let sawFinal = false;
    let pumpDone = false;
    const maybeEnd = (): void => {
      if (pumpDone && sawFinal) queue.end();
    };

    ws.on('message', (data) => {
      let msg: ScribeMessage;
      try {
        msg = JSON.parse(String(data)) as ScribeMessage;
      } catch {
        return;
      }
      // Both error shapes: {type:'error', error:{message}} and {error:'...'}.
      if (msg.type === 'error' || (msg.error !== undefined && msg.error !== null)) {
        queue.fail(
          new ProviderError(`elevenlabs stt error: ${JSON.stringify(msg.error ?? msg)}`),
        );
        return;
      }
      const role = classify(msg);
      if (role === null) return; // unknown/lifecycle messages are ignored
      const now = Date.now() - t0;
      if (turnStart === null) turnStart = now;
      // Scribe sends the FULL running transcript per message — pass it through,
      // never accumulate (accumulating would double the text).
      queue.push({
        type: role,
        text: typeof msg.text === 'string' ? msg.text : '',
        tStart: turnStart,
        tEnd: now,
      });
      if (role === 'final') {
        turnStart = null; // next turn starts fresh
        sawFinal = true;
        maybeEnd();
      }
    });
    ws.on('error', (err) => {
      queue.fail(new ProviderError(`elevenlabs stt transport error: ${String(err)}`));
    });
    ws.on('close', () => queue.end());

    // Pump: config frame first, then one base64 audio frame per chunk AS THE
    // CHUNK ARRIVES (the input iterable is never drained ahead of sending).
    void (async () => {
      await waitForOpen(ws);
      if (wsClosed || queue.isDone) return;
      ws.send(
        JSON.stringify({
          type: 'conversation_config',
          audio_format: {
            encoding: 'pcm_s16le',
            // 24 kHz is pinned project-wide (PRD §8).
            sample_rate: 24000,
          },
          // Endpointing pinned identically across every arm (PRD §8).
          vad: { silence_duration_ms: ENDPOINTING_MS },
          ...(lang === undefined ? {} : { language_code: lang }),
        }),
      );
      for await (const chunk of audio) {
        if (wsClosed || queue.isDone) return;
        ws.send(
          JSON.stringify({
            type: 'audio',
            audio: bytesToBase64(int16ToLeBytes(chunk)),
          }),
        );
      }
      pumpDone = true;
      maybeEnd();
    })().catch((err: unknown) => {
      queue.fail(
        err instanceof ProviderError
          ? err
          : new ProviderError(`elevenlabs stt input error: ${String(err)}`),
      );
    });

    try {
      for await (const event of queue) yield event;
    } finally {
      signal?.removeEventListener('abort', onAbort);
      queue.abort();
      closeWs();
    }
  }
}
