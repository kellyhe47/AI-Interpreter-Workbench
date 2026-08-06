/**
 * Ticket 007 — ElevenLabs stream-input TTS adapter (the ONE provider with
 * true streaming text input).
 *
 * Fake stream-input socket echoes one audio message per received text frame
 * (auto_mode behavior verified in the 2026-08-04 live spike); no network.
 */

import { afterEach, describe, expect, it, vi } from 'vitest';
import { collect, describeTtsContract } from '../../core/contracts/index';
import { ProviderError } from '../../core/types';
import { ELEVENLABS_DEFAULT_VOICE_ID, ElevenLabsTts } from './elevenlabs-tts';
import {
  FakeWsBase,
  asyncIterableOf,
  concatSamples,
  int16ToBase64,
  int16ToBytes,
  recordingWsFactory,
  toBase64,
} from './test-support';

const DEFAULT_AUDIO = new Int16Array([1, 2, 3, 4]);

/** Server messages to emit in response to the index-th CONTENT text frame. */
type Respond = (text: string, index: number) => readonly unknown[];

const echoOneAudioPerFrame: Respond = () => [{ audio: int16ToBase64(DEFAULT_AUDIO) }];

/**
 * Fake ElevenLabs stream-input socket.
 * - a frame carrying voice_settings is the INIT frame (recorded, no reply);
 * - {text:''} is end-of-input -> replies {isFinal:true};
 * - any other {text} frame is content -> recorded, replies via `respond`
 *   SYNCHRONOUSLY (one audio per frame by default), so a correctly
 *   interleaving adapter can yield audio before pulling more input.
 */
class FakeElevenLabsWs extends FakeWsBase {
  readonly initFrames: Array<{ text: string; voice_settings: Record<string, unknown> }> = [];
  readonly contentTexts: string[] = [];
  endReceived = false;

  constructor(
    url: string,
    opts: { headers?: Record<string, string> } | undefined,
    private readonly respond: Respond,
  ) {
    super(url, opts);
  }

  protected override onClientMessage(msg: unknown): void {
    const m = msg as { text?: unknown; voice_settings?: Record<string, unknown> };
    if (m.voice_settings !== undefined) {
      this.initFrames.push(m as { text: string; voice_settings: Record<string, unknown> });
      return;
    }
    if (m.text === '') {
      this.endReceived = true;
      this.serverMessage({ isFinal: true });
      return;
    }
    if (typeof m.text === 'string') {
      const idx = this.contentTexts.length;
      this.contentTexts.push(m.text);
      for (const s of this.respond(m.text, idx)) this.serverMessage(s);
    }
  }
}

function makeSetup(respond: Respond = echoOneAudioPerFrame) {
  return recordingWsFactory((url, opts) => new FakeElevenLabsWs(url, opts, respond));
}

afterEach(() => {
  vi.unstubAllEnvs();
});

// ---------------------------------------------------------------------------
// Ticket 007 AC 1: the SAME shared TTS contract suite, registered UNCHANGED
// with a mocked transport. streamingInput=true, so the suite itself asserts
// the first audio chunk precedes input-iterable completion.
// ---------------------------------------------------------------------------
describeTtsContract('ElevenLabsTts (mocked WS)', () => {
  const { wsFactory } = makeSetup();
  return new ElevenLabsTts({ apiKey: 'test-key' }, { wsFactory });
});

describe('ElevenLabsTts adapter specifics', () => {
  it('is a streaming-input provider named "elevenlabs"', () => {
    const { wsFactory } = makeSetup();
    const tts = new ElevenLabsTts({ apiKey: 'k' }, { wsFactory });
    expect(tts.name).toBe('elevenlabs');
    expect(tts.streamingInput).toBe(true);
  });

  it('connects to the stream-input endpoint with default voice, flash model, pcm_24000, auto_mode and xi-api-key', async () => {
    const { created, wsFactory } = makeSetup();
    const tts = new ElevenLabsTts({ apiKey: 'el-key' }, { wsFactory });
    await collect(tts.synthesize(asyncIterableOf(['hi'])));

    expect(created).toHaveLength(1);
    const ws = created[0]!;
    expect(ws.url).toMatch(
      new RegExp(
        `^wss://api\\.elevenlabs\\.io/v1/text-to-speech/${ELEVENLABS_DEFAULT_VOICE_ID}/stream-input\\?`,
      ),
    );
    expect(ws.url).toMatch(/[?&]model_id=eleven_flash_v2_5/);
    expect(ws.url).toMatch(/[?&]output_format=pcm_24000/);
    expect(ws.url).toMatch(/[?&]auto_mode=true/);
    expect(ws.headers['xi-api-key']).toBe('el-key');
  });

  it('uses config.voiceId in the URL when provided', async () => {
    const { created, wsFactory } = makeSetup();
    const tts = new ElevenLabsTts({ apiKey: 'k', voiceId: 'customVoice123' }, { wsFactory });
    await collect(tts.synthesize(asyncIterableOf(['hi'])));
    expect(created[0]!.url).toContain('/text-to-speech/customVoice123/stream-input');
  });

  it('uses config.modelId in the URL when provided, leaving voice and output_format untouched', async () => {
    const { created, wsFactory } = makeSetup();
    const tts = new ElevenLabsTts(
      { apiKey: 'k', modelId: 'eleven_multilingual_v2' },
      { wsFactory },
    );
    await collect(tts.synthesize(asyncIterableOf(['hi'])));

    const url = created[0]!.url;
    expect(url).toMatch(/[?&]model_id=eleven_multilingual_v2/);
    expect(url).not.toMatch(/eleven_flash_v2_5/);
    // Only the model becomes configurable — everything else is unchanged.
    expect(url).toContain(`/text-to-speech/${ELEVENLABS_DEFAULT_VOICE_ID}/stream-input`);
    expect(url).toMatch(/[?&]output_format=pcm_24000/);
    expect(url).toMatch(/[?&]auto_mode=true/);
  });

  it('resolves the API key from ELEVENLABS_API_KEY at construction when config omits it', async () => {
    vi.stubEnv('ELEVENLABS_API_KEY', 'env-el-key');
    const { created, wsFactory } = makeSetup();
    const tts = new ElevenLabsTts({}, { wsFactory });
    vi.unstubAllEnvs();
    await collect(tts.synthesize(asyncIterableOf(['hi'])));
    expect(created[0]!.headers['xi-api-key']).toBe('env-el-key');
  });

  it('sends the init frame first: single-space text with numeric voice_settings', async () => {
    const { created, wsFactory } = makeSetup();
    const tts = new ElevenLabsTts({ apiKey: 'k' }, { wsFactory });
    await collect(tts.synthesize(asyncIterableOf(['hi'])));

    const ws = created[0]!;
    // Init frame is the very first frame on the wire.
    const first = ws.sentJson[0] as {
      text: string;
      voice_settings?: { stability: unknown; similarity_boost: unknown };
    };
    expect(first.text).toBe(' ');
    expect(typeof first.voice_settings?.stability).toBe('number');
    expect(typeof first.voice_settings?.similarity_boost).toBe('number');
    expect(ws.initFrames).toHaveLength(1);
  });

  it('forwards each input chunk AS IT ARRIVES, in order, with no concatenation, then {text:""} on input end', async () => {
    const { created, wsFactory } = makeSetup();
    const tts = new ElevenLabsTts({ apiKey: 'k' }, { wsFactory });
    const audio = await collect(tts.synthesize(asyncIterableOf(['Hola ', 'mun', 'do'])));

    const ws = created[0]!;
    expect(ws.contentTexts).toEqual(['Hola ', 'mun', 'do']);
    expect(ws.endReceived).toBe(true);
    const last = ws.sentJson[ws.sentJson.length - 1];
    expect(last).toEqual({ text: '' });
    // One echoed audio message per text frame -> one Int16Array per frame.
    expect(audio).toHaveLength(3);
  });

  it('yields the first audio chunk BEFORE the input iterable completes (true streaming input)', async () => {
    const { wsFactory } = makeSetup();
    const tts = new ElevenLabsTts({ apiKey: 'k' }, { wsFactory });
    let inputCompleted = false;
    async function* input(): AsyncGenerator<string, void, void> {
      yield 'uno ';
      yield 'dos ';
      yield 'tres';
      inputCompleted = true;
    }

    const gen = tts.synthesize(input());
    const first = await gen.next();
    expect(first.done).toBe(false);
    expect(first.value).toBeInstanceOf(Int16Array);
    expect(inputCompleted).toBe(false);
    let step = await gen.next();
    while (!step.done) step = await gen.next();
  });

  it('completes the generator when the server sends isFinal', async () => {
    const { created, wsFactory } = makeSetup();
    const tts = new ElevenLabsTts({ apiKey: 'k' }, { wsFactory });
    // collect() resolving at all proves isFinal terminated the stream.
    const audio = await collect(tts.synthesize(asyncIterableOf(['hi'])));
    expect(audio).toHaveLength(1);
    expect(created[0]!.endReceived).toBe(true);
  });

  it('abort mid-synthesis closes the socket and the generator returns cleanly', async () => {
    const { created, wsFactory } = makeSetup();
    const tts = new ElevenLabsTts({ apiKey: 'k' }, { wsFactory });
    // Input yields one chunk then hangs; only abort can end the stream.
    async function* oneChunkThenHang(): AsyncGenerator<string, void, void> {
      yield 'first';
      await new Promise<never>(() => {});
    }
    const ac = new AbortController();
    const gen = tts.synthesize(oneChunkThenHang(), { signal: ac.signal });

    const first = await gen.next();
    expect(first.done).toBe(false);
    expect(first.value).toBeInstanceOf(Int16Array);

    ac.abort();
    const after = await gen.next();
    expect(after.done).toBe(true);
    expect(created[0]!.closed).toBe(true);
  });

  it('opens no connection at all for an already-aborted signal', async () => {
    const { created, wsFactory } = makeSetup();
    const tts = new ElevenLabsTts({ apiKey: 'k' }, { wsFactory });
    const ac = new AbortController();
    ac.abort();
    const audio = await collect(
      tts.synthesize(asyncIterableOf(['hi']), { signal: ac.signal }),
    );
    expect(audio).toEqual([]);
    expect(created).toHaveLength(0);
  });

  it('server {error} messages reject with a ProviderError mentioning elevenlabs', async () => {
    const { wsFactory } = makeSetup(() => [{ error: 'quota_exceeded' }]);
    const tts = new ElevenLabsTts({ apiKey: 'k' }, { wsFactory });
    const err = await collect(tts.synthesize(asyncIterableOf(['hi']))).then(
      () => null,
      (e: unknown) => e,
    );
    expect(err).toBeInstanceOf(ProviderError);
    expect((err as ProviderError).message).toMatch(/elevenlabs/i);
  });

  it('carries the remainder byte across audio messages split at an odd byte offset', async () => {
    const samples = new Int16Array([100, -200, 300, -400, 500]); // 10 bytes LE
    const bytes = int16ToBytes(samples);
    // Two audio messages: 3 bytes (1.5 samples!), then the remaining 7 bytes.
    const { wsFactory } = makeSetup(() => [
      { audio: toBase64(bytes.slice(0, 3)) },
      { audio: toBase64(bytes.slice(3)) },
    ]);
    const tts = new ElevenLabsTts({ apiKey: 'k' }, { wsFactory });
    const audio = await collect(tts.synthesize(asyncIterableOf(['hello'])));

    for (const c of audio) expect(c).toBeInstanceOf(Int16Array);
    const all = concatSamples(audio);
    expect(all.length).toBe(samples.length);
    expect(Array.from(all)).toEqual(Array.from(samples));
  });
});
