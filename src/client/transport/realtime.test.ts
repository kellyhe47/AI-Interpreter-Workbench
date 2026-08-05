/**
 * Ticket 011 — RealtimeTransport acceptance tests. Everything is faked:
 * fetch (token mint + SDP exchange), the RTCPeerConnection factory, and the
 * clock. GA event sequences are pushed through the fake data channel.
 */
import { describe, expect, it, vi } from 'vitest';
import {
  OPENAI_REALTIME_CALLS_URL,
  REALTIME_OPAQUE_ERROR_MESSAGE,
  RealtimeTransport,
  TOKEN_ENDPOINT,
  type RtcDataChannelLike,
  type RtcPeerConnectionLike,
  type RtcSessionDescriptionLike,
} from './realtime';
import type {
  SourceTextEvent,
  TargetTextEvent,
  TimingMark,
  TransportConfig,
  TransportError,
  UtteranceCompletion,
} from './types';

const OFFER_SDP = 'v=0 fake-offer';
const ANSWER_SDP = 'v=0 fake-answer';

class FakeDataChannel implements RtcDataChannelLike {
  sent: string[] = [];
  onopen: (() => void) | null = null;
  onmessage: ((ev: { data: string }) => void) | null = null;
  onclose: (() => void) | null = null;
  closed = false;
  constructor(readonly label: string) {}
  send(data: string): void {
    this.sent.push(data);
  }
  close(): void {
    this.closed = true;
  }
  emitOpen(): void {
    this.onopen?.();
  }
  emitEvent(obj: unknown): void {
    this.onmessage?.({ data: JSON.stringify(obj) });
  }
  emitClose(): void {
    this.onclose?.();
  }
}

class FakePc implements RtcPeerConnectionLike {
  channels: FakeDataChannel[] = [];
  localDescription: RtcSessionDescriptionLike | null = null;
  remoteDescription: RtcSessionDescriptionLike | null = null;
  closed = false;
  createDataChannel(label: string): FakeDataChannel {
    const ch = new FakeDataChannel(label);
    this.channels.push(ch);
    return ch;
  }
  async createOffer(): Promise<RtcSessionDescriptionLike> {
    return { type: 'offer', sdp: OFFER_SDP };
  }
  async setLocalDescription(desc: RtcSessionDescriptionLike): Promise<void> {
    this.localDescription = desc;
  }
  async setRemoteDescription(desc: RtcSessionDescriptionLike): Promise<void> {
    this.remoteDescription = desc;
  }
  close(): void {
    this.closed = true;
  }
}

interface FetchCall {
  url: string;
  init: RequestInit;
}

function okJson(body: unknown): Response {
  return {
    ok: true,
    status: 200,
    json: async () => body,
    text: async () => JSON.stringify(body),
  } as unknown as Response;
}

function okText(body: string): Response {
  return {
    ok: true,
    status: 200,
    json: async () => ({}),
    text: async () => body,
  } as unknown as Response;
}

function makeHarness() {
  const fetchCalls: FetchCall[] = [];
  const behavior = { tokenFails: false };
  const fetchImpl = (async (url: RequestInfo | URL, init?: RequestInit) => {
    const u = String(url);
    fetchCalls.push({ url: u, init: init ?? {} });
    if (u.includes(TOKEN_ENDPOINT)) {
      if (behavior.tokenFails) throw new Error('network down');
      return okJson({ value: 'ephemeral-test-token' });
    }
    return okText(ANSWER_SDP);
  }) as typeof fetch;

  const pcs: FakePc[] = [];
  const rtcFactory = vi.fn(() => {
    const pc = new FakePc();
    pcs.push(pc);
    return pc;
  });

  const clock = { t: 5000 };

  const transport = new RealtimeTransport(
    { armId: 'arm-rt' },
    { fetchImpl, rtcFactory, now: () => clock.t },
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
  };

  return {
    transport,
    config,
    fetchCalls,
    behavior,
    pcs,
    clock,
    source,
    target,
    audio,
    timings,
    completes,
    errors,
    states,
  };
}

type Harness = ReturnType<typeof makeHarness>;

/** start() + open the data channel; returns the channel for event injection. */
async function startConnected(h: Harness): Promise<FakeDataChannel> {
  await h.transport.start(h.config);
  const pc = h.pcs[0];
  if (!pc) throw new Error('no peer connection was created');
  const ch = pc.channels[0];
  if (!ch) throw new Error('no data channel was created');
  ch.emitOpen();
  return ch;
}

function pcmToBase64(pcm: Int16Array): string {
  const bytes = new Uint8Array(pcm.buffer, pcm.byteOffset, pcm.byteLength);
  let s = '';
  for (const b of bytes) s += String.fromCharCode(b);
  return btoa(s);
}

describe('RealtimeTransport start() handshake', () => {
  it('POSTs the token endpoint with the model, then the SDP offer with the ephemeral key', async () => {
    const h = makeHarness();
    await h.transport.start(h.config);

    const tokenCall = h.fetchCalls[0];
    expect(tokenCall).toBeDefined();
    expect(tokenCall!.url).toContain(TOKEN_ENDPOINT);
    expect(tokenCall!.init.method).toBe('POST');
    const tokenHeaders = new Headers(tokenCall!.init.headers);
    expect(tokenHeaders.get('content-type')).toContain('application/json');
    expect(JSON.parse(String(tokenCall!.init.body))).toMatchObject({
      model: 'gpt-realtime-mini',
    });

    const sdpCall = h.fetchCalls[1];
    expect(sdpCall).toBeDefined();
    expect(sdpCall!.url.startsWith(OPENAI_REALTIME_CALLS_URL)).toBe(true);
    expect(sdpCall!.init.method).toBe('POST');
    const sdpHeaders = new Headers(sdpCall!.init.headers);
    expect(sdpHeaders.get('authorization')).toBe('Bearer ephemeral-test-token');
    expect(sdpHeaders.get('content-type')).toBe('application/sdp');
    expect(sdpCall!.init.body).toBe(OFFER_SDP);
  });

  it('creates the offer, applies the answer, opens "oai-events", and reports connected', async () => {
    const h = makeHarness();
    await h.transport.start(h.config);
    const pc = h.pcs[0]!;
    expect(pc.localDescription?.sdp).toBe(OFFER_SDP);
    expect(pc.remoteDescription).toEqual({ type: 'answer', sdp: ANSWER_SDP });
    expect(pc.channels).toHaveLength(1);
    expect(pc.channels[0]!.label).toBe('oai-events');
    expect(h.states.map((s) => s.state)).toContain('connected');
  });

  it('sends session.update on channel open: server_vad @500ms, transcription on, instructions name the target language', async () => {
    const h = makeHarness();
    const ch = await startConnected(h);
    expect(ch.sent.length).toBeGreaterThanOrEqual(1);
    const raw = ch.sent[0]!;
    const msg = JSON.parse(raw) as { type: string };
    expect(msg.type).toBe('session.update');
    expect(raw).toContain('server_vad');
    expect(raw).toContain('"silence_duration_ms":500');
    expect(raw).toContain('transcription'); // input audio transcription enabled
    expect(raw).toContain('Spanish'); // interpreter instructions mention target
  });

  it('token fetch failure: start() settles without unhandled rejection and surfaces onError + disconnected', async () => {
    const h = makeHarness();
    h.behavior.tokenFails = true;
    await expect(h.transport.start(h.config)).resolves.toBeUndefined();
    expect(h.errors).toHaveLength(1);
    expect(h.errors[0]!.opaque).toBe(true);
    expect(h.states.map((s) => s.state)).toContain('disconnected');
  });
});

describe('RealtimeTransport GA event mapping', () => {
  it('accumulates input transcription deltas into source partials, then finals on completed', async () => {
    const h = makeHarness();
    const ch = await startConnected(h);
    ch.emitEvent({ type: 'conversation.item.input_audio_transcription.delta', delta: 'Hel' });
    ch.emitEvent({ type: 'conversation.item.input_audio_transcription.delta', delta: 'lo' });
    ch.emitEvent({
      type: 'conversation.item.input_audio_transcription.completed',
      transcript: 'Hello there',
    });
    expect(h.source).toEqual([
      { kind: 'partial', text: 'Hel', utt: 0 },
      { kind: 'partial', text: 'Hello', utt: 0 }, // ACCUMULATED, not the raw delta
      { kind: 'final', text: 'Hello there', utt: 0 },
    ]);
  });

  it('maps output transcript delta/done to target delta/final', async () => {
    const h = makeHarness();
    const ch = await startConnected(h);
    ch.emitEvent({ type: 'response.output_audio_transcript.delta', delta: 'Hola' });
    ch.emitEvent({ type: 'response.output_audio_transcript.done', transcript: 'Hola amigo' });
    expect(h.target).toEqual([
      { kind: 'delta', text: 'Hola', utt: 0 },
      { kind: 'final', text: 'Hola amigo', utt: 0 },
    ]);
  });

  it('maps speech_stopped to a server_speech_stopped timing mark at now()', async () => {
    const h = makeHarness();
    const ch = await startConnected(h);
    h.clock.t = 7777;
    ch.emitEvent({ type: 'input_audio_buffer.speech_stopped' });
    expect(h.timings).toContainEqual(
      expect.objectContaining({ event: 'server_speech_stopped', t: 7777, utt: 0 }),
    );
  });

  it('decodes base64 audio deltas to Int16 PCM; only the FIRST delta marks first_audio_delta', async () => {
    const h = makeHarness();
    const ch = await startConnected(h);
    const pcm1 = new Int16Array([100, -200, 300, -32768, 32767]);
    const pcm2 = new Int16Array([7, 8, 9]);
    h.clock.t = 6001;
    ch.emitEvent({ type: 'response.output_audio.delta', delta: pcmToBase64(pcm1) });
    h.clock.t = 6002;
    ch.emitEvent({ type: 'response.output_audio.delta', delta: pcmToBase64(pcm2) });

    expect(h.audio).toHaveLength(2);
    expect(Array.from(h.audio[0]!.pcm)).toEqual(Array.from(pcm1));
    expect(h.audio[0]!.utt).toBe(0);
    expect(Array.from(h.audio[1]!.pcm)).toEqual(Array.from(pcm2));

    const firstDeltas = h.timings.filter((t) => t.event === 'first_audio_delta');
    expect(firstDeltas).toHaveLength(1);
    expect(firstDeltas[0]).toMatchObject({ event: 'first_audio_delta', t: 6001, utt: 0 });
  });

  it('response.done settles the utterance with usage, then increments utt', async () => {
    const h = makeHarness();
    const ch = await startConnected(h);
    ch.emitEvent({ type: 'response.done', response: { usage: { total_tokens: 42 } } });
    expect(h.completes).toHaveLength(1);
    expect(h.completes[0]).toMatchObject({ utt: 0, usage: { total_tokens: 42 } });

    // Next utterance's events carry utt 1.
    ch.emitEvent({ type: 'conversation.item.input_audio_transcription.delta', delta: 'Hi' });
    expect(h.source.at(-1)).toEqual({ kind: 'partial', text: 'Hi', utt: 1 });
    const pcm = new Int16Array([1, 2]);
    ch.emitEvent({ type: 'response.output_audio.delta', delta: pcmToBase64(pcm) });
    expect(h.audio.at(-1)!.utt).toBe(1);
    // first_audio_delta re-arms per utterance
    expect(h.timings.filter((t) => t.event === 'first_audio_delta' && t.utt === 1)).toHaveLength(1);
  });

  it('error events surface the EXACT opaque copy', async () => {
    const h = makeHarness();
    const ch = await startConnected(h);
    ch.emitEvent({ type: 'error', error: { type: 'server_error', message: 'internal boom' } });
    expect(h.errors).toHaveLength(1);
    expect(h.errors[0]).toMatchObject({
      opaque: true,
      message: 'opaque failure — no stage attribution · session still running',
    });
    expect(h.errors[0]!.message).toBe(REALTIME_OPAQUE_ERROR_MESSAGE);
  });
});

describe('RealtimeTransport reconnect', () => {
  it('unexpected close retries 1..5 (re-running token+offer) then reports disconnected', async () => {
    const h = makeHarness();
    const ch = await startConnected(h);
    const tokenCallsBefore = h.fetchCalls.filter((c) => c.url.includes(TOKEN_ENDPOINT)).length;

    h.behavior.tokenFails = true; // every reconnect attempt fails at the token step
    ch.emitClose();

    await vi.waitFor(() => {
      expect(h.states.at(-1)?.state).toBe('disconnected');
    });

    const attempts = h.states.filter((s) => s.state === 'reconnecting').map((s) => s.attempt);
    expect(attempts).toEqual([1, 2, 3, 4, 5]);
    const tokenCallsAfter = h.fetchCalls.filter((c) => c.url.includes(TOKEN_ENDPOINT)).length;
    expect(tokenCallsAfter - tokenCallsBefore).toBe(5); // token re-fetched per attempt
  });

  it('a successful reconnect attempt re-establishes and reports connected', async () => {
    const h = makeHarness();
    const ch = await startConnected(h);
    ch.emitClose();

    await vi.waitFor(() => {
      expect(h.states.at(-1)?.state).toBe('connected');
    });
    const attempts = h.states.filter((s) => s.state === 'reconnecting').map((s) => s.attempt);
    expect(attempts).toEqual([1]);
    expect(h.pcs.length).toBe(2); // a fresh peer connection per attempt
    expect(h.pcs[1]!.remoteDescription).toEqual({ type: 'answer', sdp: ANSWER_SDP });
  });
});

describe('RealtimeTransport stop() and sendAudio()', () => {
  it('stop() closes the peer connection and silences ALL subsequent events', async () => {
    const h = makeHarness();
    const ch = await startConnected(h);
    h.transport.stop();
    expect(h.pcs[0]!.closed).toBe(true);

    const before = {
      source: h.source.length,
      errors: h.errors.length,
      states: h.states.length,
    };
    ch.emitEvent({ type: 'conversation.item.input_audio_transcription.delta', delta: 'x' });
    ch.emitEvent({ type: 'error', error: { message: 'late' } });
    ch.emitClose(); // must NOT trigger reconnect
    await Promise.resolve();
    await Promise.resolve();
    expect(h.source.length).toBe(before.source);
    expect(h.errors.length).toBe(before.errors);
    expect(h.states.length).toBe(before.states);
    expect(h.pcs.length).toBe(1); // no reconnect pc
  });

  it('sendAudio is a harmless no-op (mic rides the WebRTC media track)', async () => {
    const h = makeHarness();
    const ch = await startConnected(h);
    const sentBefore = ch.sent.length;
    expect(() => h.transport.sendAudio(new Int16Array([1, 2, 3]))).not.toThrow();
    expect(ch.sent.length).toBe(sentBefore); // nothing goes over the data channel
  });
});
