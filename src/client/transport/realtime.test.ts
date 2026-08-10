/**
 * Ticket 011 — RealtimeTransport acceptance tests. Everything is faked:
 * fetch (token mint + SDP exchange), the RTCPeerConnection factory, and the
 * clock. GA event sequences are pushed through the fake data channel.
 */
import { describe, expect, it, vi } from 'vitest';
import { OUTBOUND_SAMPLE_RATE } from '../audio/outboundAudio';
import { ENDPOINTING_MS } from '../../core/protocol';
import {
  OPENAI_REALTIME_CALLS_URL,
  REALTIME_OPAQUE_ERROR_MESSAGE,
  RealtimeTransport,
  TOKEN_ENDPOINT,
  type InboundAudioTap,
  type OutboundAudioSink,
  type RemoteAudioSink,
  type RtcDataChannelLike,
  type RtcMediaStreamLike,
  type RtcPeerConnectionLike,
  type RtcSessionDescriptionLike,
  type RtcTrackEventLike,
} from './realtime';
import type {
  InterpreterTransport,
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

/**
 * TICKET 043 — a peer connection with the FULL production media surface
 * (`addTrack` AND `addTransceiver`), which is what a real RTCPeerConnection
 * has. `FakePc` and `FakeTrackPc` above are deliberately left without it.
 */
class FakeMediaPc extends FakeTrackPc {
  added: { track: unknown; stream: unknown }[] = [];
  transceivers: { kind: string; direction: string | undefined }[] = [];
  /** How much had been negotiated by the time createOffer ran (must be >0). */
  addedAtOffer: number | null = null;
  addTrack(track: unknown, stream?: unknown): unknown {
    this.added.push({ track, stream });
    return { sender: true };
  }
  addTransceiver(kind: string, init?: { direction: string }): unknown {
    this.transceivers.push({ kind, direction: init?.direction });
    return { transceiver: true };
  }
  override async createOffer(): Promise<RtcSessionDescriptionLike> {
    this.addedAtOffer = this.added.length;
    return super.createOffer();
  }
}

/** A peer connection that can only negotiate directions, never carry a track. */
class FakeTransceiverPc extends FakePc {
  transceivers: { kind: string; direction: string | undefined }[] = [];
  addTransceiver(kind: string, init?: { direction: string }): unknown {
    this.transceivers.push({ kind, direction: init?.direction });
    return { transceiver: true };
  }
}

/**
 * TICKET 043 — records every paced frame the transport hands the outbound
 * sink, plus the clock at which it arrived, so "the bytes really got there"
 * and "delivery was not accelerated" are both falsifiable.
 */
function makeFakeOutboundSink(tag = 'outbound') {
  const track = { kind: 'audio', tag };
  const writes: Int16Array[] = [];
  const writeTimes: number[] = [];
  const state = { built: 0, closed: 0 };
  /** ROUND 3 (R3-6) — the sink's context close, held open by a test. */
  const closeGate = makeGate();
  const sink: OutboundAudioSink = {
    track,
    write: (pcm) => {
      writes.push(pcm);
      writeTimes.push(Date.now());
    },
    close: () => {
      state.closed += 1;
      return closeGate.promise;
    },
  };
  return {
    track,
    sink,
    writes,
    writeTimes,
    state,
    closeGate,
    factory: (): OutboundAudioSink => {
      state.built += 1;
      return sink;
    },
  };
}

/** A minimal remote MediaStream, tagged so assertions can name which one. */
function fakeStream(tag: string): RtcMediaStreamLike & { tag: string } {
  return { tag, getAudioTracks: () => [{ kind: 'audio' }] };
}

function audioTrackEvent(stream: RtcMediaStreamLike): RtcTrackEventLike {
  return { track: { kind: 'audio' }, streams: [stream] };
}

/**
 * TICKET 046 — records every stream the INBOUND tap was handed, and lets a test
 * feed it the samples a real media track would have carried. `feed` is the
 * falsifiability control: the transport reports audio only because the tap
 * captured some, never because a connect happened.
 */
function makeFakeInboundTap(calls: string[] = []) {
  const attached: RtcMediaStreamLike[] = [];
  const captured: number[] = [];
  /** R3-7 — samples the gate refused, so `stats()` is drivable from a test. */
  const refused = { count: 0 };
  const state = { built: 0, closed: 0 };
  /**
   * ROUND 2 (R2-7) — the tap's close is a real AudioContext close, and a run
   * that never waits for it can leave Chrome's ~6 concurrent contexts exhausted
   * part-way through a 60-run sweep. The gate lets a test hold it open.
   */
  const closeGate = makeGate();
  const tap: InboundAudioTap = {
    attach: (stream) => {
      calls.push('tap.attach');
      attached.push(stream);
    },
    // ROUND 2 (R2-4) — the capture gate. The TAP decides what to keep; the
    // transport only reports the model's speaking windows to it.
    startWindow: () => calls.push('tap.startWindow'),
    endWindow: () => calls.push('tap.endWindow'),
    stats: () => ({ admitted: captured.length, dropped: refused.count }),
    take: () => Int16Array.from(captured),
    close: () => {
      state.closed += 1;
      return closeGate.promise;
    },
  };
  return {
    tap,
    calls,
    attached,
    state,
    closeGate,
    /** Just the capture-gate calls, in order. */
    windows: (): string[] => calls.filter((c) => c.endsWith('Window')),
    /** Pretend the media track delivered these samples. */
    feed: (...samples: number[]) => captured.push(...samples),
    /** Pretend the track delivered `n` samples the GATE refused. */
    refuse: (n: number) => {
      refused.count += n;
    },
    factory: (): InboundAudioTap => {
      state.built += 1;
      return tap;
    },
  };
}

/** A promise whose settlement a test controls. */
function makeGate() {
  let resolve!: () => void;
  const promise = new Promise<void>((res) => {
    resolve = res;
  });
  return { promise, resolve };
}

/** Records every call the transport makes on the output sink, in order. */
function makeFakeSink(calls: string[] = []) {
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
  /** TICKET 043 — a peer connection with addTrack AND addTransceiver. */
  mediaCapable?: boolean;
  /** TICKET 043 — a peer connection with addTransceiver ONLY. */
  transceiverOnly?: boolean;
  /** TICKET 043 — the Live mic stream seam. Omitted by default (no mic). */
  getMediaStream?: () => RtcMediaStreamLike | null;
  /** TICKET 043 — the outbound sink factory. Omitted by default. */
  createOutboundAudioSink?: () => OutboundAudioSink;
  /** TICKET 046 — the inbound capture tap factory. Omitted by default. */
  createInboundAudioTap?: () => InboundAudioTap;
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
    const pc =
      opts.mediaCapable === true
        ? new FakeMediaPc()
        : opts.transceiverOnly === true
          ? new FakeTransceiverPc()
          : opts.trackCapable === true
            ? new FakeTrackPc()
            : new FakePc();
    if (pc instanceof FakeTrackPc && opts.trackDuringAnswer !== undefined) {
      pc.trackDuringAnswer = opts.trackDuringAnswer;
    }
    pcs.push(pc);
    return pc;
  });

  const clock = { t: 5000 };

  const transport = new RealtimeTransport(
    { armId: 'arm-rt' },
    {
      fetchImpl,
      rtcFactory,
      now: () => clock.t,
      remoteAudioSink: opts.remoteAudioSink,
      getMediaStream: opts.getMediaStream,
      createOutboundAudioSink: opts.createOutboundAudioSink,
      createInboundAudioTap: opts.createInboundAudioTap,
    },
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

  it('sends session.update on channel open: server_vad at the pinned window, transcription on, instructions name the target language', async () => {
    const h = makeHarness();
    const ch = await startConnected(h);
    expect(ch.sent.length).toBeGreaterThanOrEqual(1);
    const raw = ch.sent[0]!;
    const msg = JSON.parse(raw) as { type: string };
    expect(msg.type).toBe('session.update');
    expect(raw).toContain('server_vad');
    expect(raw).toContain(`"silence_duration_ms":${ENDPOINTING_MS}`);
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

// ---------------------------------------------------------------------------
// TICKET 043 — REPLAY HAS NO MICROPHONE.
//
// Live's mic rides the WebRTC media track, so `sendAudio` had nothing to do and
// was a no-op. But the Replay runner paces the recorded clip and calls
// `sendAudio(frame)` 50 times a second — every frame went into that no-op, the
// model received silence, VAD never fired, and Arm A produced ZERO utterances
// and a null `audio_queued`. The other half: with no mic the transport
// negotiated a `recvonly` transceiver, which cannot send at all, so even a
// working `sendAudio` had nowhere to put the samples.
// ---------------------------------------------------------------------------

/** The FakeMediaPc the harness built (addTrack + addTransceiver). */
function mediaPc(h: Harness, index = 0): FakeMediaPc {
  const pc = h.pcs[index];
  if (!(pc instanceof FakeMediaPc)) throw new Error('harness was not built mediaCapable');
  return pc;
}

/** The FakeTransceiverPc the harness built (addTransceiver only). */
function transceiverPc(h: Harness, index = 0): FakeTransceiverPc {
  const pc = h.pcs[index];
  if (!(pc instanceof FakeTransceiverPc)) throw new Error('harness was not built transceiverOnly');
  return pc;
}

/** A 480-sample paced frame whose contents identify it. */
function pacedFrame(seed: number, n = 480): Int16Array {
  return Int16Array.from({ length: n }, (_, i) => ((seed * 1013 + i * 7919) % 65536) - 32768);
}

/** A mic MediaStream carrying named tracks, so "which track" is falsifiable. */
function micStream(...tags: string[]): RtcMediaStreamLike & { tracks: unknown[] } {
  const tracks = tags.map((tag) => ({ kind: 'audio', tag }));
  return { tracks, getAudioTracks: () => tracks };
}

describe('RealtimeTransport outbound audio negotiation (ticket 043)', () => {
  it('no mic + an outbound sink: the SINK TRACK is added, and no recvonly transceiver is negotiated', async () => {
    const out = makeFakeOutboundSink();
    const h = makeHarness({ mediaCapable: true, createOutboundAudioSink: out.factory });
    await h.transport.start(h.config);

    const pc = mediaPc(h);
    expect(pc.added.map((a) => a.track)).toEqual([out.track]);
    // `recvonly` CANNOT SEND. Its presence here is the bug, in either form:
    // as the only m-line, or as a second one competing with the sink's.
    expect(pc.transceivers.map((t) => t.direction)).not.toContain('recvonly');
    // Attached BEFORE createOffer, or the offer describes no sendable audio.
    expect(pc.addedAtOffer).toBe(1);
    expect(out.state.built).toBe(1);
  });

  it('a transceiver-only peer connection negotiates SENDRECV when a sink is present', async () => {
    const out = makeFakeOutboundSink();
    const h = makeHarness({ transceiverOnly: true, createOutboundAudioSink: out.factory });
    await h.transport.start(h.config);

    expect(transceiverPc(h).transceivers).toEqual([{ kind: 'audio', direction: 'sendrecv' }]);
  });

  it('TICKET 040 PIN: with NO sink and no mic, the recvonly fallback is unchanged', async () => {
    // Nothing here may move: without an outbound sink there is nothing to send,
    // and recvonly is still how the model's inbound track is asked for.
    const h = makeHarness({ transceiverOnly: true });
    await h.transport.start(h.config);

    expect(transceiverPc(h).transceivers).toEqual([{ kind: 'audio', direction: 'recvonly' }]);
  });

  it('the sink is rebuilt per connect: a reconnect closes the old one and attaches a fresh track', async () => {
    const built: { track: unknown; closed: number }[] = [];
    const factory = (): OutboundAudioSink => {
      const entry = { track: { kind: 'audio', tag: `outbound-${built.length}` }, closed: 0 };
      built.push(entry);
      return {
        track: entry.track,
        write: () => {},
        close: () => {
          entry.closed += 1;
        },
      };
    };
    const h = makeHarness({ mediaCapable: true, createOutboundAudioSink: factory });
    const ch = await startConnected(h);
    ch.emitClose();
    await vi.waitFor(() => {
      expect(h.states.at(-1)?.state).toBe('connected');
    });

    expect(built).toHaveLength(2);
    expect(built[0]!.closed).toBe(1); // the abandoned context is released
    expect(mediaPc(h, 1).added.map((a) => a.track)).toEqual([built[1]!.track]);
  });
});

describe('RealtimeTransport sendAudio delivers paced PCM (ticket 043)', () => {
  it('delivers the EXACT samples to the outbound sink, frame for frame, in order', async () => {
    const out = makeFakeOutboundSink();
    const h = makeHarness({ mediaCapable: true, createOutboundAudioSink: out.factory });
    const ch = await startConnected(h);
    const sentBefore = ch.sent.length;

    const frames = [pacedFrame(1), pacedFrame(2), pacedFrame(3)];
    for (const f of frames) h.transport.sendAudio(f);

    expect(out.writes).toHaveLength(3);
    // THE BYTES, not "a function was called".
    for (let i = 0; i < frames.length; i++) {
      expect(Array.from(out.writes[i]!)).toEqual(Array.from(frames[i]!));
    }
    // ...and still nothing on the data channel: this is a MEDIA path.
    expect(ch.sent.length).toBe(sentBefore);
  });

  it('24 kHz END TO END: frames pass through unresampled, and the rate is never 16 kHz', async () => {
    const out = makeFakeOutboundSink();
    const h = makeHarness({ mediaCapable: true, createOutboundAudioSink: out.factory });
    await startConnected(h);

    // 480 samples IS one 20 ms frame at 24 kHz (protocol SAMPLE_RATE). A
    // resample to 16 kHz would arrive as 320 and quietly corrupt every latency
    // figure derived downstream — AGENTS.md: OpenAI rejects 16 kHz outright.
    expect(OUTBOUND_SAMPLE_RATE).toBe(24_000);
    expect(OUTBOUND_SAMPLE_RATE).not.toBe(16_000);

    h.transport.sendAudio(pacedFrame(9, 480));
    expect(out.writes[0]!.length).toBe(480);
  });

  it('PACING STAYS 1x: one write per frame, at the instant it was handed over — never batched or flushed ahead', async () => {
    // A transport that accumulated frames and released them in a burst would
    // still deliver every sample and would still LOOK like it worked, while
    // invalidating VAD and every latency number the run reports.
    vi.useFakeTimers();
    vi.setSystemTime(0);
    try {
      const out = makeFakeOutboundSink();
      const h = makeHarness({ mediaCapable: true, createOutboundAudioSink: out.factory });
      await h.transport.start(h.config);

      const expectedTimes: number[] = [];
      for (let k = 0; k < 5; k++) {
        if (k > 0) await vi.advanceTimersByTimeAsync(20);
        h.transport.sendAudio(pacedFrame(k));
        expectedTimes.push(k * 20);
        // The count after EVERY frame: no frame may be withheld for later.
        expect(out.writes).toHaveLength(k + 1);
      }
      // Let any hidden drain timer fire; nothing extra may appear.
      await vi.advanceTimersByTimeAsync(1_000);

      expect(out.writes).toHaveLength(5);
      expect(out.writeTimes).toEqual(expectedTimes);
    } finally {
      vi.useRealTimers();
    }
  });

  it('frames sent before start() and after stop() reach no sink', async () => {
    const out = makeFakeOutboundSink();
    const h = makeHarness({ mediaCapable: true, createOutboundAudioSink: out.factory });

    h.transport.sendAudio(pacedFrame(0)); // no connection yet
    expect(out.writes).toHaveLength(0);

    await startConnected(h);
    h.transport.sendAudio(pacedFrame(1));
    h.transport.stop();
    h.transport.sendAudio(pacedFrame(2));

    expect(out.writes).toHaveLength(1);
  });

  it('stop() RELEASES the outbound sink, exactly once', async () => {
    const out = makeFakeOutboundSink();
    const h = makeHarness({ mediaCapable: true, createOutboundAudioSink: out.factory });
    await startConnected(h);

    expect(out.state.closed).toBe(0);
    h.transport.stop();
    expect(out.state.closed).toBe(1);
    h.transport.stop(); // idempotent
    expect(out.state.closed).toBe(1);
  });
});

describe('RealtimeTransport ticket 043 REGRESSION GUARDS', () => {
  it('REGRESSION GUARD (LIVE): a real mic stream still supplies the tracks, and NO synthesized track competes', async () => {
    // Live must be byte-for-byte what it was: the mic rides the media track.
    // A second, silent, synthesized track on the same connection would be sent
    // alongside it — and `sendAudio`, which the Live controller fans mic frames
    // into, would double the microphone onto the wire.
    const out = makeFakeOutboundSink();
    const mic = micStream('mic-a', 'mic-b');
    const h = makeHarness({
      mediaCapable: true,
      getMediaStream: () => mic,
      createOutboundAudioSink: out.factory,
    });
    await startConnected(h);

    const pc = mediaPc(h);
    expect(pc.added.map((a) => a.track)).toEqual(mic.tracks);
    expect(pc.added.map((a) => a.stream)).toEqual([mic, mic]);
    expect(pc.added.map((a) => a.track)).not.toContain(out.track);
    expect(pc.transceivers).toEqual([]);
    // The sink is never even BUILT under a mic: no context, no track, no writes.
    expect(out.state.built).toBe(0);

    h.transport.sendAudio(pacedFrame(1));
    expect(out.writes).toHaveLength(0);
  });

  it('REGRESSION GUARD: a fake implementing NEITHER addTrack NOR addTransceiver still connects and maps events', async () => {
    // The default FakePc is untouched by this ticket, sink or no sink.
    const out = makeFakeOutboundSink();
    const h = makeHarness({ createOutboundAudioSink: out.factory });
    const ch = await startConnected(h);

    expect(h.pcs[0]).not.toBeInstanceOf(FakeMediaPc);
    expect(h.states.map((s) => s.state)).toContain('connected');
    expect(() => h.transport.sendAudio(pacedFrame(1))).not.toThrow();

    ch.emitEvent({ type: 'response.output_audio_transcript.done', transcript: 'Hola' });
    ch.emitEvent({ type: 'response.done', response: { usage: {} } });
    expect(h.target).toHaveLength(1);
    expect(h.completes).toHaveLength(1);
    expect(h.errors).toHaveLength(0);
  });

  it('REGRESSION GUARD (040): the inbound track path is untouched when an outbound sink is present', async () => {
    const inbound = makeFakeSink();
    const out = makeFakeOutboundSink();
    const h = makeHarness({
      mediaCapable: true,
      remoteAudioSink: inbound.sink,
      createOutboundAudioSink: out.factory,
    });
    const ch = await startConnected(h);

    const stream = fakeStream('remote');
    mediaPc(h).emitTrack(audioTrackEvent(stream));
    h.clock.t = 9100;
    ch.emitEvent({ type: 'output_audio_buffer.started' });

    expect(inbound.attached).toEqual([stream]);
    expect(h.timings).toContainEqual(
      expect.objectContaining({ event: 'audio_queued', t: 9100, utt: 0 }),
    );
  });
});

/* ===========================================================================
 * TICKET 046 — the INBOUND tap. Arm A's output audio exists only on the media
 * track, so without a tap `takeOutputAudio()` is empty, ticket 045's upload has
 * nothing to upload, and blind compare has nothing to play for any pair
 * involving Arm A.
 *
 * THE ONE THING THIS MUST NOT DO IS MOVE THE MEASUREMENT. `audio_queued` comes
 * from `output_audio_buffer.started` (040) and not from bytes; the tap's samples
 * must never reach `onAudio`, which is what the runner stamps from.
 * ======================================================================== */

describe('RealtimeTransport inbound audio tap (ticket 046)', () => {
  it('captures the model media track: takeOutputAudio() returns the tap’s 24 kHz PCM16', async () => {
    const inbound = makeFakeInboundTap();
    const h = makeHarness({ trackCapable: true, createInboundAudioTap: inbound.factory });
    await startConnected(h);

    const stream = fakeStream('remote');
    trackPc(h).emitTrack(audioTrackEvent(stream));
    expect(inbound.state.built).toBe(1);
    expect(inbound.attached).toEqual([stream]);

    inbound.feed(7, -8, 9);
    expect(Array.from(h.transport.takeOutputAudio())).toEqual([7, -8, 9]);
  });

  it('FALSIFIABILITY CONTROL: a connected session whose track carried NO audio reports none', async () => {
    // The tap is built and attached exactly as above; the only difference is
    // that nothing was ever captured. If this ever returns samples, the tests
    // above are measuring a connect rather than the audio.
    const inbound = makeFakeInboundTap();
    const h = makeHarness({ trackCapable: true, createInboundAudioTap: inbound.factory });
    await startConnected(h);
    trackPc(h).emitTrack(audioTrackEvent(fakeStream('remote')));

    expect(inbound.attached).toHaveLength(1);
    expect(h.transport.takeOutputAudio()).toHaveLength(0);
  });

  it('captured audio NEVER reaches onAudio, and audio_queued does not shift', async () => {
    // THE constraint. `onAudio` is what the runner stamps `audio_queued` from;
    // routing tapped samples there would move Arm A's headline latency off
    // `output_audio_buffer.started` and quietly invalidate every figure.
    const inbound = makeFakeInboundTap();
    const h = makeHarness({ trackCapable: true, createInboundAudioTap: inbound.factory });
    const ch = await startConnected(h);
    trackPc(h).emitTrack(audioTrackEvent(fakeStream('remote')));
    inbound.feed(1, 2, 3, 4);

    h.clock.t = 8123;
    ch.emitEvent({ type: 'output_audio_buffer.started' });
    h.clock.t = 8999;
    inbound.feed(5, 6);

    expect(h.audio).toHaveLength(0);
    expect(h.timings.filter((t) => t.event === 'audio_queued')).toEqual([
      expect.objectContaining({ event: 'audio_queued', t: 8123, utt: 0 }),
    ]);
    expect(h.transport.takeOutputAudio()).toHaveLength(6);
  });

  it('does not delay or reorder the inbound path: the PLAYBACK sink is attached first, from ONE stream', async () => {
    // 040's sink is what Live hears. Capture is bolted onto the same event and
    // the same stream — never a second negotiation, and never ahead of playback.
    const calls: string[] = [];
    const sink = makeFakeSink(calls);
    const inbound = makeFakeInboundTap(calls);
    const h = makeHarness({
      trackCapable: true,
      remoteAudioSink: sink.sink,
      createInboundAudioTap: inbound.factory,
    });
    await startConnected(h);

    const stream = fakeStream('remote');
    trackPc(h).emitTrack(audioTrackEvent(stream));

    expect(calls).toEqual(['attach', 'tap.attach']);
    expect(sink.attached).toEqual([stream]);
    expect(inbound.attached).toEqual([stream]);
    expect(inbound.attached[0]).toBe(sink.attached[0]);
  });

  it('the tap is built LAZILY and ONCE: a non-audio or streamless event builds nothing', async () => {
    const inbound = makeFakeInboundTap();
    const h = makeHarness({ trackCapable: true, createInboundAudioTap: inbound.factory });
    await startConnected(h);
    // Connecting alone must construct no AudioContext.
    expect(inbound.state.built).toBe(0);

    trackPc(h).emitTrack({ track: { kind: 'video' }, streams: [fakeStream('video')] });
    trackPc(h).emitTrack({ track: { kind: 'audio' }, streams: [] });
    expect(inbound.state.built).toBe(0);
    expect(inbound.attached).toEqual([]);
  });

  it('a RECONNECT re-attaches the SAME tap, so one run stays one recording', async () => {
    const inbound = makeFakeInboundTap();
    const h = makeHarness({ trackCapable: true, createInboundAudioTap: inbound.factory });
    const ch = await startConnected(h);
    trackPc(h).emitTrack(audioTrackEvent(fakeStream('first')));
    inbound.feed(1, 2);

    ch.emitClose();
    await vi.waitFor(() => {
      expect(h.states.at(-1)?.state).toBe('connected');
    });
    trackPc(h, 1).emitTrack(audioTrackEvent(fakeStream('second')));
    inbound.feed(3, 4);

    // ONE tap (one AudioContext) for the whole transport, two attaches.
    expect(inbound.state.built).toBe(1);
    expect(inbound.attached).toHaveLength(2);
    expect(Array.from(h.transport.takeOutputAudio())).toEqual([1, 2, 3, 4]);
  });

  it('stop() closes the tap ONCE and the captured audio survives, because the runner reads it after', async () => {
    const inbound = makeFakeInboundTap();
    const h = makeHarness({ trackCapable: true, createInboundAudioTap: inbound.factory });
    await startConnected(h);
    const pc = trackPc(h);
    pc.emitTrack(audioTrackEvent(fakeStream('remote')));
    inbound.feed(11, -12);

    h.transport.stop();
    expect(inbound.state.closed).toBe(1);
    h.transport.stop();
    expect(inbound.state.closed).toBe(1);
    expect(Array.from(h.transport.takeOutputAudio())).toEqual([11, -12]);

    // A late track event after stop() attaches nothing.
    pc.emitTrack(audioTrackEvent(fakeStream('late')));
    expect(inbound.attached).toHaveLength(1);
  });
});

/* ===========================================================================
 * ROUND 2, R2-4 — the transport GATES the tap to the model's speaking windows.
 *
 * A tap that runs from track-attach to stop() records the whole ~45 s run:
 * leading silence, inter-utterance gaps, comfort noise. Cascade's stored audio
 * is the concatenation of TTS chunks — gapless speech, a few seconds. Blind
 * compare plays the WHOLE stored WAV, so an evaluator would tell the arms apart
 * in the first second: AC2's wording met, its PURPOSE defeated (and ~130 MB per
 * 60-run arm).
 *
 * The transport already RECEIVES `output_audio_buffer.started` / `.stopped`. It
 * now REPORTS them to the tap — and that is all it does with them. AC3 is the
 * constraint: the gate must not change when, whether, or in what order
 * `audio_queued` is stamped.
 * ======================================================================== */

describe('RealtimeTransport gates the tap to the speaking window (round 2, R2-4)', () => {
  it('opens the window on output_audio_buffer.started and closes it on .stopped', async () => {
    const inbound = makeFakeInboundTap();
    const h = makeHarness({ trackCapable: true, createInboundAudioTap: inbound.factory });
    const ch = await startConnected(h);
    trackPc(h).emitTrack(audioTrackEvent(fakeStream('remote')));

    expect(inbound.windows()).toEqual([]);
    ch.emitEvent({ type: 'output_audio_buffer.started' });
    expect(inbound.windows()).toEqual(['tap.startWindow']);
    ch.emitEvent({ type: 'output_audio_buffer.stopped' });
    expect(inbound.windows()).toEqual(['tap.startWindow', 'tap.endWindow']);

    // Two utterances, two windows — the tap concatenates them into one file.
    ch.emitEvent({ type: 'response.done', response: { usage: {} } });
    ch.emitEvent({ type: 'output_audio_buffer.started' });
    ch.emitEvent({ type: 'output_audio_buffer.stopped' });
    expect(inbound.windows()).toEqual([
      'tap.startWindow',
      'tap.endWindow',
      'tap.startWindow',
      'tap.endWindow',
    ]);
  });

  it('AC3 IS UNTOUCHED: the measurement is stamped BEFORE the gate moves, and only once', async () => {
    // The gate READS the two events; it must not change when, whether or in
    // what order `audio_queued` is stamped. A DUPLICATE `.started` (which 040
    // suppresses for the measurement) must still open the capture window —
    // otherwise a re-armed utterance would record nothing.
    const calls: string[] = [];
    const inbound = makeFakeInboundTap(calls);
    const h = makeHarness({ trackCapable: true, createInboundAudioTap: inbound.factory });
    const ch = await startConnected(h);
    trackPc(h).emitTrack(audioTrackEvent(fakeStream('remote')));
    calls.length = 0;

    const timings: TimingMark[] = [];
    h.transport.setHandlers({
      onTiming: (mark) => {
        timings.push(mark);
        calls.push(`timing:${mark.event}`);
      },
    });

    h.clock.t = 8123;
    ch.emitEvent({ type: 'output_audio_buffer.started' });
    ch.emitEvent({ type: 'output_audio_buffer.started' }); // duplicate

    // The mark is stamped once, at the original instant, ahead of the gate.
    expect(timings.filter((t) => t.event === 'audio_queued')).toEqual([
      expect.objectContaining({ event: 'audio_queued', t: 8123, utt: 0 }),
    ]);
    expect(calls).toEqual(['timing:audio_queued', 'tap.startWindow', 'tap.startWindow']);
    // ...and no byte ever reached the runner's `onAudio` stamp.
    expect(h.audio).toHaveLength(0);
  });

  it('a track that arrives MID-WINDOW is captured, not lost until the next utterance', async () => {
    // A reconnect during the model's answer builds the tap AFTER `.started` has
    // gone by. The window state belongs to the SESSION, not to the connection.
    const inbound = makeFakeInboundTap();
    const h = makeHarness({ trackCapable: true, createInboundAudioTap: inbound.factory });
    const ch = await startConnected(h);

    ch.emitEvent({ type: 'output_audio_buffer.started' });
    expect(inbound.state.built).toBe(0); // no track yet: nothing to build

    trackPc(h).emitTrack(audioTrackEvent(fakeStream('remote')));
    expect(inbound.state.built).toBe(1);
    expect(inbound.windows()).toEqual(['tap.startWindow']);
  });

  it('a reconnect AFTER the model finished does NOT reopen the window (round 3, R3-4)', async () => {
    // The mirror of the test above, and the direction that is a real bug: the
    // transport remembers whether a window is open so a reconnect MID-answer
    // resumes capture. If `.stopped` failed to clear that memory, a reconnect
    // during the inter-utterance gap would `startWindow()` on attach and record
    // the gap — exactly the unblinding R2-4 exists to prevent. Verified: removing
    // the reset left the whole suite green.
    const inbound = makeFakeInboundTap();
    const h = makeHarness({ trackCapable: true, createInboundAudioTap: inbound.factory });
    const ch = await startConnected(h);
    trackPc(h).emitTrack(audioTrackEvent(fakeStream('first')));

    ch.emitEvent({ type: 'output_audio_buffer.started' });
    ch.emitEvent({ type: 'output_audio_buffer.stopped' });
    ch.emitEvent({ type: 'response.done', response: { usage: {} } });
    expect(inbound.windows()).toEqual(['tap.startWindow', 'tap.endWindow']);

    // The connection blinks during the SILENCE between utterances.
    ch.emitClose();
    await vi.waitFor(() => {
      expect(h.states.at(-1)?.state).toBe('connected');
    });
    trackPc(h, 1).emitTrack(audioTrackEvent(fakeStream('second')));

    // Same tap, re-attached — and NO third window.
    expect(inbound.state.built).toBe(1);
    expect(inbound.attached).toHaveLength(2);
    expect(inbound.windows()).toEqual(['tap.startWindow', 'tap.endWindow']);
  });

  it('with NO tap wired, the same events are inert — Live captures nothing (§17 19h)', async () => {
    const sink = makeFakeSink();
    const h = makeHarness({ trackCapable: true, remoteAudioSink: sink.sink });
    const ch = await startConnected(h);
    trackPc(h).emitTrack(audioTrackEvent(fakeStream('remote')));

    h.clock.t = 7000;
    expect(() => {
      ch.emitEvent({ type: 'output_audio_buffer.started' });
      ch.emitEvent({ type: 'output_audio_buffer.stopped' });
    }).not.toThrow();
    expect(h.timings).toContainEqual(
      expect.objectContaining({ event: 'audio_queued', t: 7000, utt: 0 }),
    );
    expect(h.transport.takeOutputAudio()).toHaveLength(0);
  });
});

/* ===========================================================================
 * ROUND 3, R3-7 — the capture path's account reaches the TRANSPORT.
 *
 * `stats()` sitting on the tap is reachable only from a debugger. AC1 is the one
 * criterion vitest cannot prove and the ticket concedes it to an operator smoke
 * test — so the numbers have to travel to where a run can report them.
 * ======================================================================== */

/** Read through the CONTRACT: `outputAudioStats` is optional on the interface. */
function asTransport(t: RealtimeTransport): InterpreterTransport {
  return t;
}

describe('RealtimeTransport publishes the capture gate’s account (round 3, R3-7)', () => {
  it('reports the tap’s stats, and they agree with takeOutputAudio()', async () => {
    const inbound = makeFakeInboundTap();
    const h = makeHarness({ trackCapable: true, createInboundAudioTap: inbound.factory });
    await startConnected(h);
    trackPc(h).emitTrack(audioTrackEvent(fakeStream('remote')));

    inbound.feed(1, 2, 3);
    inbound.refuse(9_000);

    expect(asTransport(h.transport).outputAudioStats?.()).toEqual({ admitted: 3, dropped: 9_000 });
    // The published `admitted` IS the recording's length, or the diagnostic is
    // a second thing that can be wrong.
    expect(asTransport(h.transport).outputAudioStats?.()?.admitted).toBe(
      h.transport.takeOutputAudio().length,
    );
  });

  it('THE SYMPTOM: a full track with no window opened reports seen-but-none-admitted', async () => {
    const inbound = makeFakeInboundTap();
    const h = makeHarness({ trackCapable: true, createInboundAudioTap: inbound.factory });
    await startConnected(h);
    trackPc(h).emitTrack(audioTrackEvent(fakeStream('remote')));
    inbound.refuse(288_000); // 12 s of 24 kHz track, none of it admitted

    expect(asTransport(h.transport).outputAudioStats?.()).toEqual({ admitted: 0, dropped: 288_000 });
    expect(h.transport.takeOutputAudio()).toHaveLength(0);
  });

  it('is UNDEFINED with no tap wired — absent is not the same as "saw nothing"', async () => {
    // Live and cascade have no capture path at all. Reporting `{0, 0}` there
    // would make every Live session look like a dead track.
    const h = makeHarness({ trackCapable: true, remoteAudioSink: makeFakeSink().sink });
    await startConnected(h);
    trackPc(h).emitTrack(audioTrackEvent(fakeStream('remote')));

    expect(asTransport(h.transport).outputAudioStats?.()).toBeUndefined();
  });
});

/* ===========================================================================
 * ROUND 2, R2-7 — stop() SEQUENCES the tap's context close.
 * ======================================================================== */

describe('RealtimeTransport stop() waits for the audio context (round 2, R2-7)', () => {
  it('returns a promise that settles only once the tap has really closed', async () => {
    const inbound = makeFakeInboundTap();
    const h = makeHarness({ trackCapable: true, createInboundAudioTap: inbound.factory });
    await startConnected(h);
    trackPc(h).emitTrack(audioTrackEvent(fakeStream('remote')));
    inbound.feed(1, 2, 3);

    let settled = false;
    const stopped = Promise.resolve(h.transport.stop()).then(() => {
      settled = true;
    });
    expect(inbound.state.closed).toBe(1);
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();
    // Fire-and-forget would already be done here, and a 60-run sweep would keep
    // stacking AudioContexts against Chrome's ~6-context cap.
    expect(settled).toBe(false);

    inbound.closeGate.resolve();
    await stopped;
    expect(settled).toBe(true);
    // The recording still outlives the close — the runner reads it after.
    expect(Array.from(h.transport.takeOutputAudio())).toEqual([1, 2, 3]);
  });

  it('a transport with neither sink nor tap still stops synchronously', async () => {
    const h = makeHarness();
    await startConnected(h);
    expect(h.transport.stop()).toBeUndefined();
  });

  it('waits for BOTH contexts, not just the tap (round 3, R3-6)', async () => {
    // A realtime Replay run holds TWO AudioContexts — the outbound sink and the
    // inbound tap — and `runner.ts` justifies its await by saying exactly that.
    // Round 2 awaited only one of them, so the comment claimed protection the
    // code did not give.
    const out = makeFakeOutboundSink();
    const inbound = makeFakeInboundTap();
    const h = makeHarness({
      mediaCapable: true,
      createOutboundAudioSink: out.factory,
      createInboundAudioTap: inbound.factory,
    });
    await startConnected(h);
    trackPc(h).emitTrack(audioTrackEvent(fakeStream('remote')));
    expect(out.state.built).toBe(1);

    let settled = false;
    const stopped = Promise.resolve(h.transport.stop()).then(() => {
      settled = true;
    });
    // Both were ASKED to close, at once — neither waits on the other.
    expect(out.state.closed).toBe(1);
    expect(inbound.state.closed).toBe(1);

    const turn = async (): Promise<void> => {
      await Promise.resolve();
      await Promise.resolve();
      await Promise.resolve();
    };

    await turn();
    expect(settled).toBe(false);
    // The tap alone is not enough: the outbound context is still open.
    inbound.closeGate.resolve();
    await turn();
    expect(settled).toBe(false);

    out.closeGate.resolve();
    await stopped;
    expect(settled).toBe(true);
  });

  it('an OUTBOUND sink with no tap is still waited for (round 3, R3-6)', async () => {
    // Replay always has both, but the seam has to be honest on its own: a
    // transport that closes ONE context must hand that one back.
    const out = makeFakeOutboundSink();
    const h = makeHarness({ mediaCapable: true, createOutboundAudioSink: out.factory });
    await startConnected(h);

    let settled = false;
    const stopped = Promise.resolve(h.transport.stop()).then(() => {
      settled = true;
    });
    expect(out.state.closed).toBe(1);
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();
    expect(settled).toBe(false);

    out.closeGate.resolve();
    await stopped;
    expect(settled).toBe(true);
  });
});

describe('RealtimeTransport ticket 046 REGRESSION GUARDS', () => {
  it('REGRESSION GUARD (LIVE): with NO tap factory nothing is captured and the 040 sink is untouched', async () => {
    // Live's bag wires `remoteAudioSink` and no tap, and must persist no audio
    // at all (§17 19h). Adding the seam must not make Live start storing.
    const sink = makeFakeSink();
    const h = makeHarness({ trackCapable: true, remoteAudioSink: sink.sink });
    await startConnected(h);

    const stream = fakeStream('remote');
    trackPc(h).emitTrack(audioTrackEvent(stream));

    expect(sink.calls).toEqual(['attach']);
    expect(sink.attached).toEqual([stream]);
    expect(h.transport.takeOutputAudio()).toHaveLength(0);
  });

  it('REGRESSION GUARD: a fake implementing NEITHER ontrack NOR media APIs still connects with a tap wired', async () => {
    const inbound = makeFakeInboundTap();
    const h = makeHarness({ createInboundAudioTap: inbound.factory }); // default FakePc
    const ch = await startConnected(h);

    expect(h.states.map((s) => s.state)).toContain('connected');
    expect(inbound.state.built).toBe(0);

    ch.emitEvent({ type: 'response.output_audio_transcript.done', transcript: 'Hola' });
    ch.emitEvent({ type: 'output_audio_buffer.started' });
    ch.emitEvent({ type: 'response.done', response: { usage: {} } });
    expect(h.target).toHaveLength(1);
    expect(h.completes).toHaveLength(1);
    expect(h.errors).toHaveLength(0);
    expect(h.transport.takeOutputAudio()).toHaveLength(0);
  });

  it('REGRESSION GUARD: the tap does not reintroduce a PCM-delta expectation', async () => {
    // There is no `response.output_audio.delta` on this transport (040). The
    // data-channel path stays exactly as it was, and is NOT the tap's business.
    const inbound = makeFakeInboundTap();
    const h = makeHarness({ trackCapable: true, createInboundAudioTap: inbound.factory });
    const ch = await startConnected(h);
    const pcm = new Int16Array([5, -6, 7]);
    h.clock.t = 4242;
    ch.emitEvent({ type: 'response.output_audio.delta', delta: pcmToBase64(pcm) });

    expect(Array.from(h.audio[0]!.pcm)).toEqual(Array.from(pcm));
    expect(h.timings).toContainEqual(
      expect.objectContaining({ event: 'first_audio_delta', t: 4242, utt: 0 }),
    );
    // ...and the tap captured nothing, because nothing came off a track.
    expect(h.transport.takeOutputAudio()).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// TICKET 062 — the selected language pair must reach the WIRE.
//
// Run dbeb6d94 (armTag A, status complete, the only complete Realtime run in
// the repository) translated an English source into GERMAN on an English↔Spanish
// project, and recorded `languagePair: ''`. The selector rendered and switched
// correctly the whole time; what shipped was a session whose `targetLanguage`
// was the empty string, so the instruction the model received read
// "Translate everything the user says into ." — an instruction that names no
// language at all, which the model resolved however it liked.
//
// Every assertion below therefore reads the SERIALIZED session.update that
// leaves the data channel. A test that read `transport.config` — or a rendered
// selector label — is exactly the test that let this ship.
// ---------------------------------------------------------------------------

/** Every session.update the transport has put on the wire, in order. */
function sessionUpdates(ch: FakeDataChannel): { raw: string; instructions: string }[] {
  return ch.sent
    .map((raw) => ({ raw, msg: JSON.parse(raw) as { type?: string; session?: { instructions?: string } } }))
    .filter((m) => m.msg.type === 'session.update')
    .map((m) => ({ raw: m.raw, instructions: String(m.msg.session?.instructions ?? '') }));
}

const LANGUAGE_CASES = [
  { pair: 'EN↔ES', direction: 'en→es', target: 'Spanish', other: 'English' },
  { pair: 'EN↔ES', direction: 'es→en', target: 'English', other: 'Spanish' },
  { pair: 'EN↔YUE', direction: 'en→yue', target: 'Cantonese', other: 'English' },
  { pair: 'EN↔YUE', direction: 'yue→en', target: 'English', other: 'Cantonese' },
] as const;

describe('TICKET 062 — the requested target language reaches the data channel', () => {
  it.each(LANGUAGE_CASES)(
    'REGRESSION PIN $pair $direction: the session.update instructs $target and never $other',
    async ({ pair, direction, target, other }) => {
      const h = makeHarness();
      h.config.languagePair = pair;
      h.config.direction = direction;
      h.config.targetLanguage = target;
      const ch = await startConnected(h);

      const updates = sessionUpdates(ch);
      expect(updates).toHaveLength(1);
      expect(updates[0]!.instructions).toContain(target);
      // The OTHER end of the pair must not appear: an instruction naming both
      // languages is an instruction naming neither direction.
      expect(updates[0]!.instructions).not.toContain(other);
    },
  );

  it('a direction swap changes the PAYLOAD, not merely a label', async () => {
    const forward = makeHarness();
    forward.config.direction = 'en→es';
    forward.config.targetLanguage = 'Spanish';
    const forwardCh = await startConnected(forward);

    const reverse = makeHarness();
    reverse.config.direction = 'es→en';
    reverse.config.targetLanguage = 'English';
    const reverseCh = await startConnected(reverse);

    const a = sessionUpdates(forwardCh)[0]!.raw;
    const b = sessionUpdates(reverseCh)[0]!.raw;
    expect(a).not.toBe(b);
    expect(sessionUpdates(forwardCh)[0]!.instructions).toContain('Spanish');
    expect(sessionUpdates(reverseCh)[0]!.instructions).toContain('English');
  });

  it('a session with NO target language is REFUSED — the nameless instruction never reaches the wire', async () => {
    // THE dbeb6d94 MECHANISM, verbatim: Replay hands `runOnce` a config with no
    // language fields at all, `runOnce` fills them with '', and the transport
    // interpolates the empty string into its instructions. The model then chose
    // German, the run stored `languagePair: ''`, and nothing anywhere failed.
    //
    // A run whose output language cannot be confirmed must not run at all
    // (AC4). Post-hoc language detection is explicitly ruled out by the ticket:
    // the instruction has to be correct at the source.
    const h = makeHarness();
    h.config.languagePair = '';
    h.config.direction = '';
    h.config.targetLanguage = '';

    await h.transport.start(h.config);
    const ch = h.pcs[0]?.channels[0];
    ch?.emitOpen();

    // Nothing that names no language is ever serialized onto the channel.
    expect(ch === undefined ? [] : sessionUpdates(ch)).toHaveLength(0);
    // ...and the refusal is LOUD: the session is reported down, so the runner
    // marks the run failed instead of storing an aggregatable German answer.
    expect(h.errors.length).toBeGreaterThanOrEqual(1);
    expect(h.states.map((s) => s.state)).toContain('disconnected');
    expect(h.states.map((s) => s.state)).not.toContain('connected');
  });

  it('a whitespace-only target language is refused on the same footing', async () => {
    const h = makeHarness();
    h.config.targetLanguage = '   ';
    await h.transport.start(h.config);
    const ch = h.pcs[0]?.channels[0];
    ch?.emitOpen();
    expect(ch === undefined ? [] : sessionUpdates(ch)).toHaveLength(0);
    expect(h.states.map((s) => s.state)).not.toContain('connected');
  });
});
