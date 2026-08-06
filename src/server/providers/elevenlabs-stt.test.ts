/**
 * Ticket 004 — ElevenLabs Scribe v2 Realtime STT adapter.
 *
 * NO NETWORK: every socket here is a `FakeWsBase` subclass driven from this
 * file through `recordingWsFactory`.
 *
 * ---------------------------------------------------------------------------
 * ASSUMED SCRIBE WIRE FORMAT (authoritative for the adapter and for ticket 006)
 * ---------------------------------------------------------------------------
 * The live Scribe v2 Realtime event names are not knowable from here without a
 * real call; the operator's smoke test resolves them. The adapter is therefore
 * written to accept BOTH encodings below, and these tests drive the fake socket
 * with both:
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
 * `text` carries the FULL transcript so far for the CURRENT turn (Scribe sends
 * running transcripts, not OpenAI-style deltas), so the adapter passes `text`
 * through rather than accumulating it, and a new turn starts from scratch after
 * each committed message.
 *
 * ---------------------------------------------------------------------------
 * THE MAPPING (PRD §6, §8, §13 test 6) — the point of this ticket
 * ---------------------------------------------------------------------------
 * **committed** is the TURN-FINAL signal -> SttEvent {type:'final'}.
 * **partial** is NOT -> SttEvent {type:'partial'}.
 * Ticket 006 runs this adapter through the shared STT contract suite unchanged,
 * so the mapping asserted here must satisfy `checkTurnFinalMapping`: zero or
 * more partials, then EXACTLY ONE final, and the final is LAST in the turn.
 *
 * Outbound frames are asserted by CONTAINMENT (the config frame carries 24000
 * and silence_duration_ms: 500 somewhere; one frame per audio chunk carrying
 * that chunk's base64) rather than by deep equality on a whole frame object —
 * an over-pinned frame shape would reject a correct implementation.
 */

import { afterEach, describe, expect, it, vi } from 'vitest';
import { checkTurnFinalMapping, collect } from '../../core/contracts/index';
import { ProviderError } from '../../core/types';
import { ElevenLabsStt } from './elevenlabs-stt';
import {
  FakeWsBase,
  asyncIterableOf,
  int16ToBase64,
  recordingWsFactory,
} from './test-support';

// ---------------------------------------------------------------------------
// Fake Scribe socket
// ---------------------------------------------------------------------------

/**
 * Fake ElevenLabs Scribe realtime socket. Deliberately shape-agnostic about the
 * adapter's frames: frame #1 is the connection/config frame, and the arrival of
 * the first frame AFTER it (i.e. the first audio frame) makes the server start
 * replaying the scripted messages, one macrotask apart. With `closeAtEnd` the
 * socket closes once the script is exhausted; nothing is emitted after close.
 */
class FakeScribeWs extends FakeWsBase {
  private started = false;

  constructor(
    url: string,
    opts: { headers?: Record<string, string> } | undefined,
    private readonly script: readonly unknown[],
    private readonly closeAtEnd: boolean,
  ) {
    super(url, opts);
  }

  protected override onClientMessage(): void {
    if (this.started || this.sent.length < 2) return;
    this.started = true;
    this.playScript();
  }

  private playScript(): void {
    let i = 0;
    const step = (): void => {
      if (this.closed) return;
      if (i >= this.script.length) {
        if (this.closeAtEnd) this.close();
        return;
      }
      this.serverMessage(this.script[i]);
      i += 1;
      setTimeout(step, 0);
    };
    setTimeout(step, 0);
  }
}

// ---------------------------------------------------------------------------
// Scripts / helpers
// ---------------------------------------------------------------------------

interface Encoding {
  readonly name: string;
  readonly partial: (text: string) => unknown;
  readonly committed: (text: string) => unknown;
}

const ENCODINGS: readonly Encoding[] = [
  {
    name: 'type-discriminator',
    partial: (text) => ({ type: 'partial_transcript', text }),
    committed: (text) => ({ type: 'committed_transcript', text }),
  },
  {
    name: 'is_final-flag',
    partial: (text) => ({ type: 'transcript', text, is_final: false }),
    committed: (text) => ({ type: 'transcript', text, is_final: true }),
  },
];

const DEFAULT_ENCODING = ENCODINGS[0]!;

/** One spoken turn ("hola mundo") in the default encoding. */
const FULL_TURN_SCRIPT: readonly unknown[] = [
  DEFAULT_ENCODING.partial('hola'),
  DEFAULT_ENCODING.partial('hola mundo'),
  DEFAULT_ENCODING.committed('hola mundo'),
];

function makeSetup(
  script: readonly unknown[] = FULL_TURN_SCRIPT,
  opts: { closeAtEnd?: boolean } = {},
) {
  const closeAtEnd = opts.closeAtEnd ?? true;
  return recordingWsFactory(
    (url, o) => new FakeScribeWs(url, o, script, closeAtEnd),
  );
}

function twoChunkAudio(): AsyncIterable<Int16Array> {
  return asyncIterableOf([new Int16Array(480), new Int16Array(480)]);
}

/** Audio that never ends — a live mic. Only the server can end such a stream. */
function openMicAudio(): AsyncIterable<Int16Array> {
  return (async function* () {
    yield new Int16Array(480);
    yield new Int16Array(480);
    await new Promise<never>(() => {});
  })();
}

const tick = (ms = 20): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, ms));

async function waitFor(pred: () => boolean, timeoutMs = 500): Promise<void> {
  const start = Date.now();
  while (!pred()) {
    if (Date.now() - start > timeoutMs) throw new Error('waitFor timed out');
    await tick(1);
  }
}

/** Depth-first lookup of the first value stored under `key`, at any nesting. */
function deepFind(node: unknown, key: string): unknown {
  if (Array.isArray(node)) {
    for (const v of node) {
      const hit = deepFind(v, key);
      if (hit !== undefined) return hit;
    }
    return undefined;
  }
  if (node !== null && typeof node === 'object') {
    const obj = node as Record<string, unknown>;
    if (obj[key] !== undefined) return obj[key];
    for (const v of Object.values(obj)) {
      const hit = deepFind(v, key);
      if (hit !== undefined) return hit;
    }
  }
  return undefined;
}

afterEach(() => {
  vi.unstubAllEnvs();
});

// ---------------------------------------------------------------------------
// Identity, connection, config frame
// ---------------------------------------------------------------------------

describe('ElevenLabsStt connection', () => {
  it('is named "elevenlabs"', () => {
    const { wsFactory } = makeSetup();
    expect(new ElevenLabsStt({ apiKey: 'k' }, { wsFactory }).name).toBe('elevenlabs');
  });

  it('connects through deps.wsFactory to an ElevenLabs STT socket carrying the default model, with an xi-api-key header', async () => {
    const { created, wsFactory } = makeSetup();
    const stt = new ElevenLabsStt({ apiKey: 'el-key' }, { wsFactory });
    await collect(stt.transcribe(twoChunkAudio()));

    expect(created).toHaveLength(1);
    const ws = created[0]!;
    expect(ws.url).toMatch(/^wss:\/\/api\.elevenlabs\.io\//);
    expect(ws.url).toContain('scribe_v2_realtime');
    expect(ws.headers['xi-api-key']).toBe('el-key');
  });

  it('resolves the API key from ELEVENLABS_API_KEY at construction when config omits it', async () => {
    vi.stubEnv('ELEVENLABS_API_KEY', 'env-el-key');
    const { created, wsFactory } = makeSetup();
    const stt = new ElevenLabsStt({}, { wsFactory });
    // Key must be captured at construction, not at call time.
    vi.unstubAllEnvs();
    await collect(stt.transcribe(twoChunkAudio()));

    expect(created[0]!.headers['xi-api-key']).toBe('env-el-key');
  });

  it('uses config.model instead of the scribe_v2_realtime default — the model is never hardcoded', async () => {
    const { created, wsFactory } = makeSetup();
    const stt = new ElevenLabsStt(
      { apiKey: 'k', model: 'scribe_v2_realtime_experimental' },
      { wsFactory },
    );
    await collect(stt.transcribe(twoChunkAudio()));

    const ws = created[0]!;
    expect(ws.url).toContain('scribe_v2_realtime_experimental');
    // Nothing on the wire (URL or any frame) still names the bare default.
    const wire = [ws.url, ...ws.sent].join('\n');
    expect(wire).not.toMatch(/scribe_v2_realtime(?!_experimental)/);
  });

  it('the connection/config frame pins 24 kHz and silence_duration_ms 500', async () => {
    const { created, wsFactory } = makeSetup();
    const stt = new ElevenLabsStt({ apiKey: 'k' }, { wsFactory });
    await collect(stt.transcribe(twoChunkAudio()));

    const ws = created[0]!;
    const configFrame = ws.sentJson[0];
    expect(configFrame).toBeDefined();
    // 24 kHz is pinned project-wide (PRD §8); assert by containment so the
    // frame may declare it as 24000, 'pcm_24000', sample_rate, whatever.
    expect(ws.sent[0]).toContain('24000');
    // VAD/endpointing is pinned to 500 ms across every arm (PRD §8).
    expect(deepFind(configFrame, 'silence_duration_ms')).toBe(500);
  });
});

// ---------------------------------------------------------------------------
// Audio input framing
// ---------------------------------------------------------------------------

describe('ElevenLabsStt audio input', () => {
  it('sends exactly one audio frame per input chunk, in order, as base64 little-endian PCM16', async () => {
    const { created, wsFactory } = makeSetup();
    const stt = new ElevenLabsStt({ apiKey: 'k' }, { wsFactory });
    const chunks = [
      new Int16Array([1, -1, 256, -32768]),
      new Int16Array([0, 32767]),
      new Int16Array([7]),
    ];
    await collect(stt.transcribe(asyncIterableOf(chunks)));

    const frames = created[0]!.sent;
    const payloads = chunks.map(int16ToBase64);
    // Every chunk appears in exactly one frame, and the frames follow the
    // config frame in input order (no batching, no reordering, no re-sends).
    payloads.forEach((b64, i) => {
      expect(frames.filter((f) => f.includes(b64))).toHaveLength(1);
      expect(frames.findIndex((f) => f.includes(b64))).toBe(i + 1);
    });
    expect(frames.filter((f) => payloads.some((b) => f.includes(b)))).toHaveLength(
      chunks.length,
    );
  });

  it('sends each chunk AS IT ARRIVES rather than draining the input first', async () => {
    const { created, wsFactory } = makeSetup([], { closeAtEnd: false });
    const stt = new ElevenLabsStt({ apiKey: 'k' }, { wsFactory });
    const c1 = new Int16Array([1, 2]);
    const c2 = new Int16Array([3, 4]);
    let release = (): void => {};
    const gate = new Promise<void>((r) => {
      release = r;
    });
    let secondChunkPulled = false;
    async function* input(): AsyncGenerator<Int16Array, void, void> {
      yield c1;
      await gate;
      secondChunkPulled = true;
      yield c2;
    }

    const ac = new AbortController();
    const gen = stt.transcribe(input(), { signal: ac.signal });
    const pending = gen.next(); // start the machinery
    void pending.catch(() => {}); // keep a mid-test failure from firing unhandled

    await waitFor(() => (created[0]?.sent.length ?? 0) >= 2);
    expect(created[0]!.sent[1]).toContain(int16ToBase64(c1));
    expect(secondChunkPulled).toBe(false);

    release();
    await waitFor(() => created[0]!.sent.length >= 3);
    expect(created[0]!.sent[2]).toContain(int16ToBase64(c2));

    ac.abort();
    expect((await pending).done).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Turn-final mapping — the load-bearing behavior of this ticket
// ---------------------------------------------------------------------------

for (const enc of ENCODINGS) {
  describe(`ElevenLabsStt turn-final mapping (${enc.name} encoding)`, () => {
    it('maps partials to partial events and committed to exactly ONE turn-final, last in the turn', async () => {
      const { wsFactory } = makeSetup([
        enc.partial('hola'),
        enc.partial('hola mundo'),
        enc.committed('hola mundo'),
      ]);
      const stt = new ElevenLabsStt({ apiKey: 'k' }, { wsFactory });
      const events = await collect(stt.transcribe(twoChunkAudio()));

      expect(events.map((e) => e.type)).toEqual(['partial', 'partial', 'final']);
      expect(events.map((e) => e.text)).toEqual(['hola', 'hola mundo', 'hola mundo']);
      // The exact rule the shared contract suite (ticket 006) will apply.
      const verdict = checkTurnFinalMapping(events);
      expect(verdict.ok, verdict.reason).toBe(true);
      for (const e of events) {
        expect(typeof e.tStart).toBe('number');
        expect(typeof e.tEnd).toBe('number');
      }
    });

    it('emits one final per turn across two consecutive turns, and partials reset after each final', async () => {
      const { wsFactory } = makeSetup([
        enc.partial('ho'),
        enc.partial('hola'),
        enc.committed('hola'),
        enc.partial('bue'),
        enc.committed('buenos dias'),
      ]);
      const stt = new ElevenLabsStt({ apiKey: 'k' }, { wsFactory });
      // Open mic: only the socket close (end of script) ends this stream, so a
      // committed message must NOT be able to double up or terminate early.
      const events = await collect(stt.transcribe(openMicAudio()));

      expect(events.map((e) => e.type)).toEqual([
        'partial',
        'partial',
        'final',
        'partial',
        'final',
      ]);
      // Turn 2's text is turn 2's alone — no bleed-through from turn 1.
      expect(events.map((e) => e.text)).toEqual([
        'ho',
        'hola',
        'hola',
        'bue',
        'buenos dias',
      ]);
      expect(events.filter((e) => e.type === 'final')).toHaveLength(2);
      for (const turn of [events.slice(0, 3), events.slice(3)]) {
        const verdict = checkTurnFinalMapping(turn);
        expect(verdict.ok, verdict.reason).toBe(true);
      }
    });
  });
}

describe('ElevenLabsStt partials do not end the turn', () => {
  it('keeps the stream open after partials with no committed message', async () => {
    const { created, wsFactory } = makeSetup(
      [DEFAULT_ENCODING.partial('ho'), DEFAULT_ENCODING.partial('hola')],
      { closeAtEnd: false },
    );
    const stt = new ElevenLabsStt({ apiKey: 'k' }, { wsFactory });
    const ac = new AbortController();
    const gen = stt.transcribe(twoChunkAudio(), { signal: ac.signal });

    const a = await gen.next();
    const b = await gen.next();
    expect([a, b].map((r) => (r.value as { type: string }).type)).toEqual([
      'partial',
      'partial',
    ]);

    // No final was produced, and the turn is still running.
    const pending = gen.next();
    const outcome = await Promise.race([
      pending.then(() => 'ended'),
      tick().then(() => 'still-open'),
    ]);
    expect(outcome).toBe('still-open');
    expect(created[0]!.closed).toBe(false);

    ac.abort();
    expect((await pending).done).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Errors, abort, close
// ---------------------------------------------------------------------------

const ERROR_MESSAGES: ReadonlyArray<{ name: string; msg: unknown }> = [
  { name: 'typed error event', msg: { type: 'error', error: { message: 'boom' } } },
  { name: 'bare error field', msg: { error: 'quota_exceeded' } },
];

describe('ElevenLabsStt failure and lifecycle', () => {
  for (const { name, msg } of ERROR_MESSAGES) {
    it(`rejects the stream with a ProviderError mentioning elevenlabs (${name})`, async () => {
      const { wsFactory } = makeSetup([msg], { closeAtEnd: false });
      const stt = new ElevenLabsStt({ apiKey: 'k' }, { wsFactory });
      const err = await collect(stt.transcribe(twoChunkAudio())).then(
        () => null,
        (e: unknown) => e,
      );
      expect(err).toBeInstanceOf(ProviderError);
      expect((err as ProviderError).message).toMatch(/elevenlabs/i);
    });
  }

  it('abort mid-stream closes the socket and the generator returns cleanly', async () => {
    // Script never reaches committed, so only abort can end the stream.
    const { created, wsFactory } = makeSetup([DEFAULT_ENCODING.partial('hol')], {
      closeAtEnd: false,
    });
    const stt = new ElevenLabsStt({ apiKey: 'k' }, { wsFactory });
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
    const stt = new ElevenLabsStt({ apiKey: 'k' }, { wsFactory });
    const ac = new AbortController();
    ac.abort();
    const events = await collect(
      stt.transcribe(twoChunkAudio(), { signal: ac.signal }),
    );
    expect(events).toEqual([]);
    expect(created).toHaveLength(0);
  });

  it('a socket close ends the generator cleanly', async () => {
    const { created, wsFactory } = makeSetup([DEFAULT_ENCODING.partial('hola')], {
      closeAtEnd: true,
    });
    const stt = new ElevenLabsStt({ apiKey: 'k' }, { wsFactory });
    // Open mic + no committed: the close is the only thing that can end this.
    const events = await collect(stt.transcribe(openMicAudio()));
    expect(events.map((e) => e.type)).toEqual(['partial']);
    expect(created[0]!.closed).toBe(true);
  });
});
