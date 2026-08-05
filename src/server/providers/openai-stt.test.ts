/**
 * Ticket 006 — OpenAI Realtime transcription adapter (STT).
 *
 * All transports are fakes replaying the GA transcription-session event
 * sequence verified in the 2026-08-04 live spike; no network.
 */

import { afterEach, describe, expect, it, vi } from 'vitest';
import { collect, describeSttContract } from '../../core/contracts/index';
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

  it('maps transcription deltas to accumulated partials and completed to ONE turn-final', async () => {
    const { wsFactory } = makeSetup();
    const stt = new OpenAiStt({ apiKey: 'test-key' }, { wsFactory });
    const events = await collect(stt.transcribe(twoChunkAudio()));

    // Deltas 'hel' + 'lo' -> accumulated partial texts; completed -> final.
    expect(events.map((e) => e.type)).toEqual(['partial', 'partial', 'final']);
    expect(events.map((e) => e.text)).toEqual(['hel', 'hello', 'hello world']);
    expect(events.filter((e) => e.type === 'final')).toHaveLength(1);
    expect(events[events.length - 1]!.type).toBe('final');
  });

  it('ignores speech_started/speech_stopped/committed/unknown event types', async () => {
    const { wsFactory } = makeSetup([
      { type: 'input_audio_buffer.speech_started' },
      { type: 'some.future.event', payload: 42 },
      { type: 'conversation.item.input_audio_transcription.delta', delta: 'hi' },
      { type: 'input_audio_buffer.speech_stopped' },
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
