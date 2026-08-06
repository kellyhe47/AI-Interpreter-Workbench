/**
 * Ticket 011 — CascadeTransport acceptance tests, driven by a fake WebSocket
 * factory. Wire shapes come straight from src/core/protocol.ts.
 */
import { describe, expect, it, vi } from 'vitest';
import { encodeTtsFrame } from '../../core/protocol';
import type { UtteranceRecord } from '../../core/timing';
import { CASCADE_WS_PATH, CascadeTransport, type WsLike } from './cascade';
import type {
  SourceTextEvent,
  TargetTextEvent,
  TimingMark,
  TransportConfig,
  TransportError,
  UtteranceCompletion,
} from './types';

class FakeWs implements WsLike {
  binaryType = '';
  sent: (string | ArrayBufferLike | Uint8Array)[] = [];
  onopen: (() => void) | null = null;
  onmessage: ((ev: { data: string | ArrayBuffer }) => void) | null = null;
  onclose: (() => void) | null = null;
  onerror: ((ev: unknown) => void) | null = null;
  closedByClient = false;
  constructor(readonly url: string) {}
  send(data: string | ArrayBufferLike | Uint8Array): void {
    this.sent.push(data);
  }
  close(): void {
    this.closedByClient = true;
  }
  emitOpen(): void {
    this.onopen?.();
  }
  emitJson(obj: unknown): void {
    this.onmessage?.({ data: JSON.stringify(obj) });
  }
  emitBinary(bytes: Uint8Array): void {
    const buf = new ArrayBuffer(bytes.byteLength);
    new Uint8Array(buf).set(bytes);
    this.onmessage?.({ data: buf });
  }
  emitClose(): void {
    this.onclose?.();
  }
  /** JSON-parsed string frames sent by the client. */
  get sentJson(): unknown[] {
    return this.sent
      .filter((d): d is string => typeof d === 'string')
      .map((d) => JSON.parse(d) as unknown);
  }
}

function makeHarness(baseUrl = 'ws://test.local') {
  const sockets: FakeWs[] = [];
  const wsFactory = vi.fn((url: string) => {
    const ws = new FakeWs(url);
    sockets.push(ws);
    return ws;
  });
  const clock = { t: 9000 };
  const transport = new CascadeTransport(
    { armId: 'arm-casc', baseUrl },
    { wsFactory, now: () => clock.t },
  );

  const source: SourceTextEvent[] = [];
  const target: TargetTextEvent[] = [];
  const audio: { pcm: Int16Array; utt: number }[] = [];
  const timings: TimingMark[] = [];
  const completes: UtteranceCompletion[] = [];
  const errors: TransportError[] = [];
  const states: { state: string; attempt?: number }[] = [];

  transport.setHandlers({
    onSourceText: (e) => source.push(e),
    onTargetText: (e) => target.push(e),
    onAudio: (pcm, utt) => audio.push({ pcm, utt }),
    onTiming: (mark) => timings.push(mark),
    onUtteranceComplete: (r) => completes.push(r),
    onError: (e) => errors.push(e),
    onConnectionState: (state, attempt) => states.push({ state, attempt }),
  });

  const config: TransportConfig = {
    languagePair: 'EN↔ES',
    direction: 'en→es',
    targetLanguage: 'Spanish',
    providers: { stt: 'gpt-4o-transcribe', mt: 'gpt', tts: 'elevenlabs' },
  };

  return { transport, config, wsFactory, sockets, clock, source, target, audio, timings, completes, errors, states };
}

type Harness = ReturnType<typeof makeHarness>;

async function startConnected(h: Harness): Promise<FakeWs> {
  const p = h.transport.start(h.config);
  const ws = h.sockets[0];
  if (!ws) throw new Error('no socket was created');
  ws.emitOpen();
  await p;
  return ws;
}

describe('CascadeTransport start()', () => {
  it('opens the injected base + /ws/cascade with arraybuffer binaryType', async () => {
    const h = makeHarness('ws://test.local');
    const ws = await startConnected(h);
    expect(h.wsFactory).toHaveBeenCalledWith(`ws://test.local${CASCADE_WS_PATH}`);
    expect(ws.binaryType).toBe('arraybuffer');
  });

  it('sends session.start with the providers config on open, then reports connected', async () => {
    const h = makeHarness();
    const ws = await startConnected(h);
    expect(ws.sentJson[0]).toEqual({
      type: 'session.start',
      mode: 'cascade',
      languagePair: 'EN↔ES',
      direction: 'en→es',
      providers: { stt: 'gpt-4o-transcribe', mt: 'gpt', tts: 'elevenlabs' },
    });
    expect(h.states.map((s) => s.state)).toContain('connected');
  });
});

describe('CascadeTransport sendAudio()', () => {
  it('sends one byte-exact raw little-endian PCM16 binary frame (no header)', async () => {
    const h = makeHarness();
    const ws = await startConnected(h);
    const pcm = new Int16Array([1, -2, 0x0102, -32768, 32767]);
    h.transport.sendAudio(pcm);

    const binary = ws.sent.filter((d) => typeof d !== 'string');
    expect(binary).toHaveLength(1);
    const sent = binary[0]!;
    const bytes =
      sent instanceof Uint8Array
        ? sent
        : new Uint8Array(sent as ArrayBufferLike);
    const expected = new Uint8Array(pcm.buffer.slice(0), pcm.byteOffset, pcm.byteLength);
    expect(bytes.byteLength).toBe(pcm.byteLength); // exactly 2 bytes/sample, headerless
    expect(Array.from(bytes)).toEqual(Array.from(expected));
  });
});

describe('CascadeTransport inbound mapping', () => {
  it('maps stt.partial/final to onSourceText and mt.delta/final to onTargetText', async () => {
    const h = makeHarness();
    const ws = await startConnected(h);
    ws.emitJson({ type: 'stt.partial', utt: 0, text: 'hel' });
    ws.emitJson({ type: 'stt.final', utt: 0, text: 'hello' });
    ws.emitJson({ type: 'mt.delta', utt: 0, text: 'ho' });
    ws.emitJson({ type: 'mt.final', utt: 0, text: 'hola' });
    expect(h.source).toEqual([
      { kind: 'partial', text: 'hel', utt: 0 },
      { kind: 'final', text: 'hello', utt: 0 },
    ]);
    expect(h.target).toEqual([
      { kind: 'delta', text: 'ho', utt: 0 },
      { kind: 'final', text: 'hola', utt: 0 },
    ]);
  });

  it('passes all 5 stage.timing marks through with event, t, utt, stage', async () => {
    const h = makeHarness();
    const ws = await startConnected(h);
    const marks = [
      { stage: 'stt', event: 'speech_end', t: 100 },
      { stage: 'stt', event: 'vad_fired', t: 130 },
      { stage: 'stt', event: 'stt_final', t: 300 },
      { stage: 'mt', event: 'mt_first_token', t: 450 },
      { stage: 'tts', event: 'tts_first_byte', t: 700 },
    ];
    for (const m of marks) ws.emitJson({ type: 'stage.timing', utt: 2, ...m });
    expect(h.timings).toHaveLength(5);
    marks.forEach((m, i) => {
      expect(h.timings[i]).toMatchObject({ event: m.event, t: m.t, utt: 2, stage: m.stage });
    });
  });

  it('delivers utterance.complete records intact', async () => {
    const h = makeHarness();
    const ws = await startConnected(h);
    const record: UtteranceRecord = {
      id: 'u-1',
      arm: 'arm-casc',
      mode: 'cascade',
      languagePair: 'EN↔ES',
      direction: 'en→es',
      sourcePartials: ['hel'],
      sourceFinal: 'hello',
      targetPartials: ['ho'],
      targetFinal: 'hola',
      audioState: 'queued',
      audioDurationMs: 640,
      timings: { speech_end: 100, audio_queued: 900 },
      speechEndSource: 'vad',
      providers: { stt: 'gpt-4o-transcribe', mt: 'gpt', tts: 'elevenlabs' },
      costUnits: 0.004,
      corpusId: 'c-1',
      runId: 'r-1',
    };
    ws.emitJson({ type: 'utterance.complete', utt: 0, record });
    expect(h.completes).toHaveLength(1);
    expect(h.completes[0]).toMatchObject(record);
  });

  it('passes cascade error copy through VERBATIM with opaque:false and the stage', async () => {
    const h = makeHarness();
    const ws = await startConnected(h);
    const message = 'TTS failed — retrying with fallback voice · stage: tts';
    ws.emitJson({ type: 'error', stage: 'tts', message });
    expect(h.errors).toHaveLength(1);
    expect(h.errors[0]).toMatchObject({ opaque: false, message, stage: 'tts' });
  });

  it('decodes binary frames via the 4-byte LE utt header into onAudio', async () => {
    const h = makeHarness();
    const ws = await startConnected(h);
    const pcm = new Int16Array([5, -6, 7, -32768, 32767]);
    ws.emitBinary(encodeTtsFrame(3, pcm));
    expect(h.audio).toHaveLength(1);
    expect(h.audio[0]!.utt).toBe(3);
    expect(Array.from(h.audio[0]!.pcm)).toEqual(Array.from(pcm));
  });
});

describe('CascadeTransport reconnect', () => {
  it('unexpected close -> reconnecting(1), reopen, re-send session.start, connected', async () => {
    const h = makeHarness();
    const ws = await startConnected(h);
    ws.emitClose();

    await vi.waitFor(() => {
      expect(h.sockets.length).toBe(2);
    });
    expect(h.states.filter((s) => s.state === 'reconnecting').map((s) => s.attempt)).toEqual([1]);

    const ws2 = h.sockets[1]!;
    ws2.emitOpen();
    await vi.waitFor(() => {
      expect(h.states.at(-1)?.state).toBe('connected');
    });
    expect(ws2.sentJson[0]).toMatchObject({ type: 'session.start', mode: 'cascade' });
  });

  it('numbers attempts 1..5 then reports disconnected when every socket dies', async () => {
    const h = makeHarness();
    const ws = await startConnected(h);
    ws.emitClose();

    // Kill each reconnect socket before it opens; attempts are capped at 5.
    for (let count = 2; count <= 6; count++) {
      await vi.waitFor(() => {
        expect(h.sockets.length).toBe(count);
      });
      h.sockets[count - 1]!.emitClose();
    }

    await vi.waitFor(() => {
      expect(h.states.at(-1)?.state).toBe('disconnected');
    });
    expect(h.states.filter((s) => s.state === 'reconnecting').map((s) => s.attempt)).toEqual([
      1, 2, 3, 4, 5,
    ]);
    expect(h.sockets.length).toBe(6); // 1 original + 5 attempts, never a 7th
  });
});

describe('CascadeTransport stop()', () => {
  it('sends session.end, closes the socket, and silences ALL subsequent events', async () => {
    const h = makeHarness();
    const ws = await startConnected(h);
    h.transport.stop();
    expect(ws.closedByClient).toBe(true);
    expect(ws.sentJson.at(-1)).toEqual({ type: 'session.end' });

    const before = {
      source: h.source.length,
      errors: h.errors.length,
      states: h.states.length,
      audio: h.audio.length,
    };
    ws.emitJson({ type: 'stt.partial', utt: 0, text: 'late' });
    ws.emitJson({ type: 'error', message: 'late boom' });
    ws.emitBinary(encodeTtsFrame(0, new Int16Array([1])));
    ws.emitClose(); // must NOT trigger reconnect
    await Promise.resolve();
    await Promise.resolve();
    expect(h.source.length).toBe(before.source);
    expect(h.errors.length).toBe(before.errors);
    expect(h.states.length).toBe(before.states);
    expect(h.audio.length).toBe(before.audio);
    expect(h.sockets.length).toBe(1); // no reconnect socket
  });
});
