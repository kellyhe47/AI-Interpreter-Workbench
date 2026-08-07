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
  type RemoteAudioSink,
  type RtcDataChannelLike,
  type RtcMediaStreamLike,
  type RtcPeerConnectionLike,
  type RtcSessionDescriptionLike,
  type RtcTrackEventLike,
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

/**
 * TICKET 040 — a peer-connection fake that DOES implement `ontrack`, used only
 * by the media-track tests. `FakePc` above is deliberately left implementing
 * neither `ontrack` nor any media API, because the ticket requires such fakes
 * to keep working untouched (see the REGRESSION GUARD tests).
 */
class FakeTrackPc extends FakePc {
  ontrack: ((ev: RtcTrackEventLike) => void) | null = null;
  /** Was a handler installed by the time the answer landed? */
  ontrackAtAnswer: boolean | null = null;
  /**
   * When set, this event is fired from INSIDE setRemoteDescription — i.e.
   * while connect() is still in flight and has not yet assigned its `pc`
   * field. That is when a real RTCPeerConnection raises `ontrack`: applying
   * the answer is what creates the receiver.
   */
  trackDuringAnswer: RtcTrackEventLike | null = null;
  override async setRemoteDescription(desc: RtcSessionDescriptionLike): Promise<void> {
    this.ontrackAtAnswer = typeof this.ontrack === 'function';
    if (this.trackDuringAnswer !== null) this.emitTrack(this.trackDuringAnswer);
    await super.setRemoteDescription(desc);
  }
  emitTrack(ev: RtcTrackEventLike): void {
    this.ontrack?.(ev);
  }
}

/** A minimal remote MediaStream, tagged so assertions can name which one. */
function fakeStream(tag: string): RtcMediaStreamLike & { tag: string } {
  return { tag, getAudioTracks: () => [{ kind: 'audio' }] };
}

function audioTrackEvent(stream: RtcMediaStreamLike): RtcTrackEventLike {
  return { track: { kind: 'audio' }, streams: [stream] };
}

/** Records every call the transport makes on the output sink, in order. */
function makeFakeSink() {
  const calls: string[] = [];
  const attached: RtcMediaStreamLike[] = [];
  const sink: RemoteAudioSink = {
    attach: (stream) => {
      calls.push('attach');
      attached.push(stream);
    },
    play: () => calls.push('play'),
    pause: () => calls.push('pause'),
  };
  return { sink, calls, attached };
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

interface HarnessOptions {
  /**
   * TICKET 040 — use the `ontrack`-capable peer-connection fake. DEFAULT
   * false, so every pre-040 test keeps running against a fake that implements
   * neither `ontrack` nor any media API.
   */
  trackCapable?: boolean;
  /** TICKET 040 — the injected output sink. Omitted by default. */
  remoteAudioSink?: RemoteAudioSink;
  /**
   * TICKET 040 — fire this track event from inside setRemoteDescription, so
   * it lands while connect() is still running (see FakeTrackPc).
   */
  trackDuringAnswer?: RtcTrackEventLike;
}

function makeHarness(opts: HarnessOptions = {}) {
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
    const pc = opts.trackCapable === true ? new FakeTrackPc() : new FakePc();
    if (pc instanceof FakeTrackPc && opts.trackDuringAnswer !== undefined) {
      pc.trackDuringAnswer = opts.trackDuringAnswer;
    }
    pcs.push(pc);
    return pc;
  });

  const clock = { t: 5000 };

  const transport = new RealtimeTransport(
    { armId: 'arm-rt' },
    { fetchImpl, rtcFactory, now: () => clock.t, remoteAudioSink: opts.remoteAudioSink },
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

// ---------------------------------------------------------------------------
// TICKET 040 — over WebRTC the model's audio arrives on the MEDIA TRACK ONLY.
// `response.output_audio.delta` never fires (settled empirically on a real
// session), so nothing consumed the audio and `audio_queued` was never stamped.
// ---------------------------------------------------------------------------

/** The one `FakeTrackPc` the harness built, for track injection. */
function trackPc(h: Harness, index = 0): FakeTrackPc {
  const pc = h.pcs[index];
  if (!(pc instanceof FakeTrackPc)) throw new Error('harness was not built trackCapable');
  return pc;
}

describe('RealtimeTransport inbound media track (ticket 040)', () => {
  it('routes an inbound AUDIO track to the remote audio sink', async () => {
    const fake = makeFakeSink();
    const h = makeHarness({ trackCapable: true, remoteAudioSink: fake.sink });
    await startConnected(h);

    const stream = fakeStream('remote');
    trackPc(h).emitTrack(audioTrackEvent(stream));

    expect(fake.calls).toEqual(['attach']);
    expect(fake.attached).toEqual([stream]);
  });

  it('installs ontrack BEFORE the SDP answer is applied, so an early track is never missed', async () => {
    const fake = makeFakeSink();
    const h = makeHarness({ trackCapable: true, remoteAudioSink: fake.sink });
    await h.transport.start(h.config);
    // The handler must already be in place on the connection start() built.
    expect(typeof trackPc(h).ontrack).toBe('function');
    expect(trackPc(h).ontrackAtAnswer).toBe(true);
  });

  it('a track that arrives DURING setRemoteDescription — before connect() has adopted the connection — is still routed', async () => {
    // The real ordering: applying the answer is what creates the receiver, so
    // `ontrack` fires inside setRemoteDescription, BEFORE connect() assigns
    // its `pc` field. A handler that only accepts events once the field
    // matches (`this.pc !== pc`) discards the model's only audio and the
    // session is silent — intermittently, which is the worst kind.
    const fake = makeFakeSink();
    const stream = fakeStream('during-answer');
    const h = makeHarness({
      trackCapable: true,
      remoteAudioSink: fake.sink,
      trackDuringAnswer: audioTrackEvent(stream),
    });
    await h.transport.start(h.config);

    expect(trackPc(h).ontrackAtAnswer).toBe(true); // it really did fire early
    expect(fake.attached).toEqual([stream]);
    expect(fake.calls).toEqual(['attach']);
  });

  it('ignores a non-audio track and a streamless event', async () => {
    const fake = makeFakeSink();
    const h = makeHarness({ trackCapable: true, remoteAudioSink: fake.sink });
    await startConnected(h);

    trackPc(h).emitTrack({ track: { kind: 'video' }, streams: [fakeStream('video')] });
    trackPc(h).emitTrack({ track: { kind: 'audio' }, streams: [] });

    expect(fake.calls).toEqual([]);
  });

  it('a RECONNECTED session routes the NEW peer connection\'s track', async () => {
    const fake = makeFakeSink();
    const h = makeHarness({ trackCapable: true, remoteAudioSink: fake.sink });
    const ch = await startConnected(h);
    ch.emitClose();
    await vi.waitFor(() => {
      expect(h.states.at(-1)?.state).toBe('connected');
    });

    const stream = fakeStream('after-reconnect');
    trackPc(h, 1).emitTrack(audioTrackEvent(stream));
    expect(fake.attached).toEqual([stream]);
  });

  it('after stop() an ontrack event routes nothing', async () => {
    const fake = makeFakeSink();
    const h = makeHarness({ trackCapable: true, remoteAudioSink: fake.sink });
    await startConnected(h);
    const pc = trackPc(h);
    h.transport.stop();

    pc.emitTrack(audioTrackEvent(fakeStream('late')));
    expect(fake.calls).toEqual([]);
  });

  it('with NO sink injected, an inbound track is harmless', async () => {
    const h = makeHarness({ trackCapable: true });
    await startConnected(h);
    expect(() => trackPc(h).emitTrack(audioTrackEvent(fakeStream('x')))).not.toThrow();
  });
});

describe('RealtimeTransport audio_queued from output_audio_buffer.started (ticket 040)', () => {
  it('stamps audio_queued at now(), NOT from a PCM enqueue', async () => {
    const h = makeHarness({ trackCapable: true, remoteAudioSink: makeFakeSink().sink });
    const ch = await startConnected(h);

    h.clock.t = 8123;
    ch.emitEvent({ type: 'output_audio_buffer.started' });

    expect(h.timings).toContainEqual(
      expect.objectContaining({ event: 'audio_queued', t: 8123, utt: 0 }),
    );
    // The stamp is a TIMING mark only: no PCM was decoded or delivered.
    expect(h.audio).toHaveLength(0);
  });

  it('stamps it ONCE per utterance and re-arms at response.done', async () => {
    const h = makeHarness({ trackCapable: true });
    const ch = await startConnected(h);

    h.clock.t = 100;
    ch.emitEvent({ type: 'output_audio_buffer.started' });
    h.clock.t = 200;
    ch.emitEvent({ type: 'output_audio_buffer.started' }); // duplicate — ignored
    ch.emitEvent({ type: 'output_audio_buffer.stopped' }); // inert
    ch.emitEvent({ type: 'response.done', response: { usage: {} } });
    h.clock.t = 300;
    ch.emitEvent({ type: 'output_audio_buffer.started' });

    const queued = h.timings.filter((t) => t.event === 'audio_queued');
    expect(queued).toEqual([
      expect.objectContaining({ event: 'audio_queued', t: 100, utt: 0 }),
      expect.objectContaining({ event: 'audio_queued', t: 300, utt: 1 }),
    ]);
  });

  it('the media-track path emits NO onAudio — audio never reaches the data channel', async () => {
    const h = makeHarness({ trackCapable: true, remoteAudioSink: makeFakeSink().sink });
    const ch = await startConnected(h);

    // Exactly the empirically observed WebRTC event set: transcript deltas +
    // buffer started/stopped, and no response.output_audio.delta at all.
    ch.emitEvent({ type: 'output_audio_buffer.started' });
    ch.emitEvent({ type: 'response.output_audio_transcript.delta', delta: 'Hola' });
    ch.emitEvent({ type: 'response.output_audio_transcript.done', transcript: 'Hola amigo' });
    ch.emitEvent({ type: 'output_audio_buffer.stopped' });

    expect(h.audio).toHaveLength(0);
    expect(h.target.map((e) => e.text)).toEqual(['Hola', 'Hola amigo']);
    expect(h.timings.filter((t) => t.event === 'audio_queued')).toHaveLength(1);
  });

  it('the failure copy stays OPAQUE — nothing about the media track names a stage', async () => {
    const h = makeHarness({ trackCapable: true, remoteAudioSink: makeFakeSink().sink });
    const ch = await startConnected(h);
    ch.emitEvent({ type: 'output_audio_buffer.started' });
    ch.emitEvent({ type: 'error', error: { type: 'server_error', message: 'boom' } });

    expect(h.errors[0]!.message).toBe(REALTIME_OPAQUE_ERROR_MESSAGE);
    expect(h.errors[0]!.opaque).toBe(true);
    expect(h.errors[0]!.stage).toBeUndefined();
    for (const word of ['track', 'webrtc', 'audio_queued', 'stt', 'mt', 'tts']) {
      expect(h.errors[0]!.message.toLowerCase()).not.toContain(word);
    }
  });
});

describe('RealtimeTransport ticket 040 REGRESSION GUARDS', () => {
  it('REGRESSION GUARD: a fake implementing NEITHER ontrack NOR any media API still connects and maps every event', async () => {
    const h = makeHarness(); // default FakePc: no ontrack, no addTrack/addTransceiver
    const ch = await startConnected(h);
    expect(h.pcs[0]).not.toBeInstanceOf(FakeTrackPc);
    expect(h.states.map((s) => s.state)).toContain('connected');

    ch.emitEvent({ type: 'conversation.item.input_audio_transcription.delta', delta: 'Hi' });
    ch.emitEvent({ type: 'response.output_audio_transcript.done', transcript: 'Hola' });
    ch.emitEvent({ type: 'input_audio_buffer.speech_stopped' });
    ch.emitEvent({ type: 'output_audio_buffer.started' });
    ch.emitEvent({ type: 'response.done', response: { usage: { total_tokens: 1 } } });

    expect(h.source).toHaveLength(1);
    expect(h.target).toHaveLength(1);
    expect(h.completes).toHaveLength(1);
    expect(h.errors).toHaveLength(0);
  });

  it('REGRESSION GUARD: the data-channel PCM path is untouched — a delta still decodes and marks first_audio_delta', async () => {
    const h = makeHarness();
    const ch = await startConnected(h);
    const pcm = new Int16Array([5, -6, 7]);
    h.clock.t = 4242;
    ch.emitEvent({ type: 'response.output_audio.delta', delta: pcmToBase64(pcm) });

    expect(h.audio).toHaveLength(1);
    expect(Array.from(h.audio[0]!.pcm)).toEqual(Array.from(pcm));
    expect(h.timings).toContainEqual(
      expect.objectContaining({ event: 'first_audio_delta', t: 4242, utt: 0 }),
    );
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
