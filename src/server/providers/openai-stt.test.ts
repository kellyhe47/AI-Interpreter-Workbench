/**
 * Ticket 006 — OpenAI Realtime transcription adapter (STT).
 *
 * All transports are fakes replaying the GA transcription-session event
 * sequence verified in the 2026-08-04 live spike; no network.
 */

import { afterEach, describe, expect, it, vi } from 'vitest';
import { collect, describeSttContract } from '../../core/contracts/index';
import { resolveTriple } from '../../core/models';
import { ProviderError } from '../../core/types';
import { OpenAiStt } from './openai-stt';
import {
  FakeWsBase,
  asyncIterableOf,
  int16ToBase64,
  recordingWsFactory,
} from './test-support';

/**
 * Fake OpenAI realtime transcription socket. Acks session.update with
 * session.updated, then after the FIRST input_audio_buffer.append replays the
 * scripted server events one macrotask apart (stops emitting once closed).
 */
class FakeOpenAiRealtimeWs extends FakeWsBase {
  private started = false;

  constructor(
    url: string,
    opts: { headers?: Record<string, string> } | undefined,
    private readonly script: readonly unknown[],
  ) {
    super(url, opts);
  }

  protected override onClientMessage(msg: unknown): void {
    const m = msg as { type?: string };
    if (m.type === 'session.update') {
      queueMicrotask(() => this.serverMessage({ type: 'session.updated' }));
    }
    if (m.type === 'input_audio_buffer.append' && !this.started) {
      this.started = true;
      this.playScript();
    }
  }

  private playScript(): void {
    let i = 0;
    const step = (): void => {
      if (this.closed || i >= this.script.length) return;
      this.serverMessage(this.script[i]);
      i += 1;
      setTimeout(step, 0);
    };
    setTimeout(step, 0);
  }

  get appends(): Array<{ type: string; audio: string }> {
    return this.sentJson.filter(
      (m): m is { type: string; audio: string } => m.type === 'input_audio_buffer.append',
    );
  }
}

/** GA event sequence for one spoken turn ("hello world"), per the live spike. */
const FULL_TURN_SCRIPT: readonly unknown[] = [
  { type: 'input_audio_buffer.speech_started' },
  { type: 'conversation.item.input_audio_transcription.delta', delta: 'hel' },
  { type: 'conversation.item.input_audio_transcription.delta', delta: 'lo' },
  { type: 'input_audio_buffer.speech_stopped' },
  { type: 'input_audio_buffer.committed' },
  {
    type: 'conversation.item.input_audio_transcription.completed',
    transcript: 'hello world',
  },
];

function makeSetup(script: readonly unknown[] = FULL_TURN_SCRIPT) {
  return recordingWsFactory(
    (url, opts) => new FakeOpenAiRealtimeWs(url, opts, script),
  );
}

function twoChunkAudio(): AsyncIterable<Int16Array> {
  return asyncIterableOf([new Int16Array(480), new Int16Array(480)]);
}

afterEach(() => {
  vi.unstubAllEnvs();
});

// ---------------------------------------------------------------------------
// Shared STT contract suite, registered UNCHANGED against the adapter with a
// mocked transport (ticket 006 AC 1).
// ---------------------------------------------------------------------------
describeSttContract('OpenAiStt (mocked WS)', () => {
  const { wsFactory } = makeSetup();
  return new OpenAiStt({ apiKey: 'test-key' }, { wsFactory });
});

describe('OpenAiStt adapter specifics', () => {
  it('connects to the realtime transcription endpoint with a Bearer auth header', async () => {
    const { created, wsFactory } = makeSetup();
    const stt = new OpenAiStt({ apiKey: 'test-key' }, { wsFactory });
    await collect(stt.transcribe(twoChunkAudio()));

    expect(created).toHaveLength(1);
    const ws = created[0]!;
    expect(ws.url).toMatch(/^wss:\/\/api\.openai\.com\/v1\/realtime/);
    expect(ws.url).toMatch(/[?&]intent=transcription/);
    expect(ws.headers['Authorization']).toBe('Bearer test-key');
  });

  it('resolves the API key from OPENAI_API_KEY at construction when config omits it', async () => {
    vi.stubEnv('OPENAI_API_KEY', 'env-key');
    const { created, wsFactory } = makeSetup();
    const stt = new OpenAiStt({}, { wsFactory });
    // Key must be captured at construction, not at call time.
    vi.unstubAllEnvs();
    await collect(stt.transcribe(twoChunkAudio()));

    expect(created[0]!.headers['Authorization']).toBe('Bearer env-key');
  });

  it('first frame is session.update with pcm rate 24000, gpt-4o-transcribe and server_vad @500ms', async () => {
    const { created, wsFactory } = makeSetup();
    const stt = new OpenAiStt({ apiKey: 'test-key' }, { wsFactory });
    await collect(stt.transcribe(twoChunkAudio()));

    const first = created[0]!.sentJson[0] as {
      type: string;
      session: {
        type: string;
        audio: {
          input: {
            format: { type: string; rate: number };
            transcription: { model: string };
            turn_detection: { type: string; silence_duration_ms: number };
          };
        };
      };
    };
    expect(first.type).toBe('session.update');
    expect(first.session.type).toBe('transcription');
    expect(first.session.audio.input.format.type).toBe('audio/pcm');
    // REGRESSION LOCK: the API rejects rate 16000 — the adapter must always
    // send 24000 (2026-08-04 live spike).
    expect(first.session.audio.input.format.rate).toBe(24000);
    expect(first.session.audio.input.transcription.model).toBe('gpt-4o-transcribe');
    expect(first.session.audio.input.turn_detection.type).toBe('server_vad');
    expect(first.session.audio.input.turn_detection.silence_duration_ms).toBe(500);
  });

  it('sends one base64 input_audio_buffer.append per audio chunk (little-endian PCM16)', async () => {
    const { created, wsFactory } = makeSetup();
    const stt = new OpenAiStt({ apiKey: 'test-key' }, { wsFactory });
    const chunk1 = new Int16Array([1, -1, 256, -32768]);
    const chunk2 = new Int16Array([0, 32767]);
    await collect(stt.transcribe(asyncIterableOf([chunk1, chunk2])));

    const appends = created[0]!.appends;
    expect(appends).toHaveLength(2);
    expect(appends[0]!.audio).toBe(int16ToBase64(chunk1));
    expect(appends[1]!.audio).toBe(int16ToBase64(chunk2));
  });

  /**
   * TICKET 051 — `input_audio_buffer.speech_stopped` was previously dropped
   * with the other housekeeping events. It is the ONLY signal that says when
   * the endpointer decided the speaker had stopped, and without it the cascade
   * orchestrator has nothing to stamp `vad_fired` from but the closing
   * transcript's own instant — making "detected end of speech -> transcript"
   * identically zero on every Live utterance.
   */
  it('maps transcription deltas to accumulated partials, speech_stopped, and ONE turn-final', async () => {
    const { wsFactory } = makeSetup();
    const stt = new OpenAiStt({ apiKey: 'test-key' }, { wsFactory });
    const events = await collect(stt.transcribe(twoChunkAudio()));

    // Deltas 'hel' + 'lo' -> accumulated partials; speech_stopped -> the
    // endpointer's mark; completed -> the turn-final.
    expect(events.map((e) => e.type)).toEqual(['partial', 'partial', 'speech_stopped', 'final']);
    expect(events.map((e) => e.text)).toEqual(['hel', 'hello', '', 'hello world']);
    expect(events.filter((e) => e.type === 'final')).toHaveLength(1);
    expect(events[events.length - 1]!.type).toBe('final');
    // It arrives BEFORE the transcript — that gap is the thing being measured.
    const stopped = events.findIndex((e) => e.type === 'speech_stopped');
    expect(stopped).toBeLessThan(events.length - 1);
  });

  it('ignores speech_started/committed/unknown event types', async () => {
    const { wsFactory } = makeSetup([
      { type: 'input_audio_buffer.speech_started' },
      { type: 'some.future.event', payload: 42 },
      { type: 'conversation.item.input_audio_transcription.delta', delta: 'hi' },
      { type: 'input_audio_buffer.committed' },
      { type: 'conversation.item.input_audio_transcription.completed', transcript: 'hi' },
    ]);
    const stt = new OpenAiStt({ apiKey: 'test-key' }, { wsFactory });
    const events = await collect(stt.transcribe(twoChunkAudio()));
    expect(events.map((e) => e.type)).toEqual(['partial', 'final']);
    expect(events.map((e) => e.text)).toEqual(['hi', 'hi']);
  });

  it('abort mid-stream closes the socket and the generator returns cleanly', async () => {
    // Script never reaches completed, so only abort can end the stream.
    const { created, wsFactory } = makeSetup([
      { type: 'input_audio_buffer.speech_started' },
      { type: 'conversation.item.input_audio_transcription.delta', delta: 'hel' },
    ]);
    const stt = new OpenAiStt({ apiKey: 'test-key' }, { wsFactory });
    const ac = new AbortController();
    const gen = stt.transcribe(twoChunkAudio(), { signal: ac.signal });

    const first = await gen.next();
    expect(first.done).toBe(false);
    expect((first.value as { type: string }).type).toBe('partial');

    ac.abort();
    const after = await gen.next();
    expect(after.done).toBe(true);
    expect(created[0]!.closed).toBe(true);
  });

  it('opens no connection at all for an already-aborted signal', async () => {
    const { created, wsFactory } = makeSetup();
    const stt = new OpenAiStt({ apiKey: 'test-key' }, { wsFactory });
    const ac = new AbortController();
    ac.abort();
    const events = await collect(stt.transcribe(twoChunkAudio(), { signal: ac.signal }));
    expect(events).toEqual([]);
    expect(created).toHaveLength(0);
  });

  it('server error events reject the stream with ProviderError', async () => {
    const { wsFactory } = makeSetup([
      { type: 'error', error: { message: 'boom' } },
    ]);
    const stt = new OpenAiStt({ apiKey: 'test-key' }, { wsFactory });
    await expect(collect(stt.transcribe(twoChunkAudio()))).rejects.toBeInstanceOf(
      ProviderError,
    );
  });

  it('is named "openai"', () => {
    const { wsFactory } = makeSetup();
    expect(new OpenAiStt({ apiKey: 'k' }, { wsFactory }).name).toBe('openai');
  });
});

// ---------------------------------------------------------------------------
// TICKET 069 — the language hint, ON THE WIRE.
//
// `OpenAiSttConfig` is `{ apiKey, model }`: there is no language field at all,
// so every transcription session this adapter has ever opened told the model
// nothing about what language it was about to hear. Handed no language and the
// clip's opening silence, a Whisper-family model invents a sentence in one —
// "그러나.", "żeśmy.", "Yardımımın", "Hallo." opened 7 of the operator's 17
// sweep runs, each one consuming segment 0 and shifting every real utterance
// one slot later.
//
// The field is asserted on the SESSION PAYLOAD rather than on the config object
// because a config that is stored and never sent is exactly the state ElevenLabs
// was already in.
// ---------------------------------------------------------------------------

describe('TICKET 069 — the source-language hint reaches the transcription session (AC2, AC3, AC4)', () => {
  /** The `session.update` frame, which is always frame 0. */
  function sessionUpdate(ws: FakeWsBase): {
    session: { audio: { input: { transcription: Record<string, unknown> } } };
  } {
    return ws.sentJson[0] as unknown as {
      session: { audio: { input: { transcription: Record<string, unknown> } } };
    };
  }

  /** The field `OpenAiSttConfig` gains — not yet declared in production. */
  type OpenAiSttConfigWithLanguage = { apiKey?: string; model?: string; languageCode?: string };

  const directions = [
    { name: 'en→es', sourceCode: 'en' },
    { name: 'es→en', sourceCode: 'es' },
    { name: 'en→yue', sourceCode: 'yue' },
  ] as const;

  it.each(directions)(
    'a $name session names $sourceCode on the transcription-session payload',
    async ({ sourceCode }) => {
      const { created, wsFactory } = makeSetup();
      const config: OpenAiSttConfigWithLanguage = {
        apiKey: 'test-key',
        languageCode: sourceCode,
      };
      const stt = new OpenAiStt(config, { wsFactory });
      await collect(stt.transcribe(twoChunkAudio()));

      const transcription = sessionUpdate(created[0]!).session.audio.input.transcription;
      expect(transcription.language).toBe(sourceCode);
      // Beside the model, never instead of it.
      expect(transcription.model).toBe('gpt-4o-transcribe');
    },
  );

  it('the two directions of a pair are DISTINGUISHABLE on the wire', async () => {
    const forward = makeSetup();
    await collect(
      new OpenAiStt(
        { apiKey: 'k', languageCode: 'en' } as OpenAiSttConfigWithLanguage,
        forward,
      ).transcribe(twoChunkAudio()),
    );
    const reverse = makeSetup();
    await collect(
      new OpenAiStt(
        { apiKey: 'k', languageCode: 'es' } as OpenAiSttConfigWithLanguage,
        reverse,
      ).transcribe(twoChunkAudio()),
    );
    const forwardLang = sessionUpdate(forward.created[0]!).session.audio.input.transcription
      .language;
    const reverseLang = sessionUpdate(reverse.created[0]!).session.audio.input.transcription
      .language;
    expect(forwardLang).toBe('en');
    expect(reverseLang).toBe('es');
    expect(forwardLang).not.toBe(reverseLang);
  });

  it('NO configured language sends NO `language` key at all — absent, never a guessed "en"', async () => {
    const { created, wsFactory } = makeSetup();
    const stt = new OpenAiStt({ apiKey: 'test-key' }, { wsFactory });
    await collect(stt.transcribe(twoChunkAudio()));

    const transcription = sessionUpdate(created[0]!).session.audio.input.transcription;
    // `in`, not `=== undefined`: an explicit `language: null` on the wire is a
    // claim, and the absence rule says make no claim.
    expect('language' in transcription).toBe(false);
    expect(transcription.model).toBe('gpt-4o-transcribe');
  });

  it('the hint changes NOTHING else about the session frame — the 24000 lock and server_vad@500 stand', async () => {
    const { created, wsFactory } = makeSetup();
    const stt = new OpenAiStt(
      { apiKey: 'test-key', languageCode: 'es' } as OpenAiSttConfigWithLanguage,
      { wsFactory },
    );
    const chunk = new Int16Array([1, -1, 256, -32768]);
    await collect(stt.transcribe(asyncIterableOf([chunk])));

    const first = created[0]!.sentJson[0] as unknown as {
      type: string;
      session: {
        type: string;
        audio: {
          input: {
            format: { type: string; rate: number };
            turn_detection: { type: string; silence_duration_ms: number };
          };
        };
      };
    };
    expect(first.type).toBe('session.update');
    expect(first.session.type).toBe('transcription');
    expect(first.session.audio.input.format.type).toBe('audio/pcm');
    // REGRESSION LOCK: the API rejects 16000.
    expect(first.session.audio.input.format.rate).toBe(24000);
    expect(first.session.audio.input.turn_detection.type).toBe('server_vad');
    expect(first.session.audio.input.turn_detection.silence_duration_ms).toBe(500);
    // ...and the audio still goes out one append per chunk.
    expect(created[0]!.appends).toHaveLength(1);
    expect(created[0]!.appends[0]!.audio).toBe(int16ToBase64(chunk));
  });
});

/**
 * TICKET 069 — THE MISSING LINK ITSELF, end to end.
 *
 * The block above pins what the adapter does with a language it is given; this
 * pins that `resolveTriple` — the ONE place a model id becomes adapter options —
 * gives it one. The adapter is constructed from the resolver's own output, so a
 * resolver that drops the hint opens a session with no `language`, exactly as
 * production does today.
 */
describe('TICKET 069 — resolveTriple’s options are what actually open the session', () => {
  type TripleOptions = { sourceLanguage?: string };
  const resolveTripleWithSource = resolveTriple as unknown as (
    triple: { stt: string; mt: string; tts: string },
    opts?: TripleOptions,
  ) => ReturnType<typeof resolveTriple>;

  const languageOf = (ws: FakeWsBase): unknown => {
    const frame = ws.sentJson[0] as unknown as {
      session: { audio: { input: { transcription: Record<string, unknown> } } };
    };
    return frame.session.audio.input.transcription.language;
  };

  it.each([
    { direction: 'en→es', sourceCode: 'en' },
    { direction: 'es→en', sourceCode: 'es' },
  ])('a $direction run resolves to a session naming $sourceCode', async ({ sourceCode }) => {
    const resolved = resolveTripleWithSource(
      { stt: 'gpt-4o-transcribe', mt: 'gpt-4o-mini', tts: 'gpt-4o-mini-tts' },
      { sourceLanguage: sourceCode },
    );
    const { created, wsFactory } = makeSetup();
    const stt = new OpenAiStt(
      { ...(resolved.stt.options as { model?: string }), apiKey: 'k' },
      { wsFactory },
    );
    await collect(stt.transcribe(twoChunkAudio()));
    expect(languageOf(created[0]!)).toBe(sourceCode);
    // The model resolution is unchanged — the hint rides beside it.
    expect(resolved.stt).toMatchObject({ vendor: 'openai' });
  });

  it('a run whose session named no direction resolves to a session with no language', async () => {
    const resolved = resolveTripleWithSource({
      stt: 'gpt-4o-transcribe',
      mt: 'gpt-4o-mini',
      tts: 'gpt-4o-mini-tts',
    });
    const { created, wsFactory } = makeSetup();
    const stt = new OpenAiStt(
      { ...(resolved.stt.options as { model?: string }), apiKey: 'k' },
      { wsFactory },
    );
    await collect(stt.transcribe(twoChunkAudio()));
    expect(languageOf(created[0]!)).toBeUndefined();
  });
});
