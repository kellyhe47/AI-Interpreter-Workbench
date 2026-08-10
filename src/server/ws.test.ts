/**
 * TDD tests for the cascade WebSocket transport (Ticket 005).
 * attachCascadeWs / bufferToPcm are stubs — every test starts RED.
 */
import { afterEach, describe, expect, it } from 'vitest';
import http from 'node:http';
import { AddressInfo } from 'node:net';
import WebSocket from 'ws';
import { app } from './index';
import { attachCascadeWs, bufferToPcm, CASCADE_WS_PATH } from './ws';
import type { AttachCascadeWsOptions, OrchestratorFactory } from './ws';
import { decodeTtsFrame } from '../core/protocol';
import type { RunOrigin, ServerToClientMessage } from '../core/protocol';
import { deriveCascadeIntervals } from '../core/timing';
import type { CascadeTimestamps, UtteranceRecord } from '../core/timing';

type Received =
  | { kind: 'json'; msg: ServerToClientMessage }
  | { kind: 'binary'; data: Uint8Array };

const cleanups: Array<() => Promise<void> | void> = [];
afterEach(async () => {
  while (cleanups.length) await cleanups.pop()!();
});

async function startServer(
  opts?: AttachCascadeWsOptions,
): Promise<{ port: number; server: http.Server }> {
  const server = http.createServer(app);
  attachCascadeWs(server, opts);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const port = (server.address() as AddressInfo).port;
  cleanups.push(
    () => new Promise<void>((resolve) => server.close(() => resolve())),
  );
  return { port, server };
}

async function connect(port: number): Promise<{ ws: WebSocket; received: Received[] }> {
  const ws = new WebSocket(`ws://127.0.0.1:${port}${CASCADE_WS_PATH}`);
  const received: Received[] = [];
  ws.on('message', (data: Buffer | ArrayBuffer | Buffer[], isBinary: boolean) => {
    const buf = Array.isArray(data)
      ? Buffer.concat(data)
      : Buffer.from(data as ArrayBuffer);
    if (isBinary) received.push({ kind: 'binary', data: new Uint8Array(buf) });
    else received.push({ kind: 'json', msg: JSON.parse(buf.toString('utf8')) });
  });
  await new Promise<void>((resolve, reject) => {
    ws.once('open', resolve);
    ws.once('error', reject);
  });
  cleanups.push(() => {
    if (ws.readyState === WebSocket.OPEN || ws.readyState === WebSocket.CONNECTING) {
      ws.terminate();
    }
  });
  return { ws, received };
}

async function waitFor<T>(
  fn: () => T | undefined | false,
  what: string,
  timeoutMs = 4000,
): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const v = fn();
    if (v) return v;
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
    await new Promise((r) => setTimeout(r, 10));
  }
}

function jsonOf(received: Received[]): ServerToClientMessage[] {
  return received.filter((r): r is Extract<Received, { kind: 'json' }> => r.kind === 'json').map((r) => r.msg);
}

/**
 * Run identity (ticket 003) rides on session.start and is OPTIONAL: Live sends
 * none of the three fields, a replay/sweep leg stamps them on the same frame.
 */
interface RunIdentity {
  recordingId?: string;
  runId?: string;
  origin?: RunOrigin;
}

function sessionStart(
  providers = { stt: 'fixture', mt: 'fixture', tts: 'fixture' },
  identity: RunIdentity = {},
): string {
  return JSON.stringify({
    type: 'session.start',
    mode: 'cascade',
    languagePair: 'en-es',
    direction: 'en->es',
    providers,
    ...identity,
  });
}

/** The emitted record, widened with the run `origin` the WS layer stamps on it. */
type EmittedRecord = UtteranceRecord & { origin?: RunOrigin };

async function completeOneUtterance(identity: RunIdentity = {}): Promise<EmittedRecord> {
  const { port } = await startServer();
  const { ws, received } = await connect(port);
  ws.send(sessionStart(undefined, identity));
  ws.send(pcmChunk());
  const complete = await waitFor(
    () =>
      jsonOf(received).find(
        (m): m is Extract<ServerToClientMessage, { type: 'utterance.complete' }> =>
          m.type === 'utterance.complete',
      ),
    'utterance.complete',
  );
  return complete.record as EmittedRecord;
}

function pcmChunk(samples = 2400): Buffer {
  const pcm = new Int16Array(samples);
  for (let i = 0; i < pcm.length; i += 1) pcm[i] = (i * 31) % 32768;
  return Buffer.from(pcm.buffer, pcm.byteOffset, pcm.byteLength);
}

describe('bufferToPcm (AC2: byte-exact upstream decode)', () => {
  it('honors Buffer byteOffset/byteLength (view into a larger allocation)', () => {
    const samples = Int16Array.from([100, -200, 300, -32768]);
    const pool = Buffer.alloc(samples.byteLength + 6);
    Buffer.from(samples.buffer, 0, samples.byteLength).copy(pool, 4);
    const view = pool.subarray(4, 4 + samples.byteLength); // byteOffset 4
    expect(Array.from(bufferToPcm(view))).toEqual(Array.from(samples));
  });

  it('decodes a plain ArrayBuffer', () => {
    const samples = Int16Array.from([1, 2, -3]);
    expect(Array.from(bufferToPcm(samples.buffer.slice(0)))).toEqual([1, 2, -3]);
  });

  it('concatenates Buffer[] fragments in order', () => {
    const a = Int16Array.from([10, 20]);
    const b = Int16Array.from([30]);
    const frag = (arr: Int16Array): Buffer =>
      Buffer.from(arr.buffer, arr.byteOffset, arr.byteLength);
    expect(Array.from(bufferToPcm([frag(a), frag(b)]))).toEqual([10, 20, 30]);
  });

  it('throws on odd byte length', () => {
    expect(() => bufferToPcm(Buffer.alloc(3))).toThrow();
  });
});

describe('cascade WS endpoint', () => {
  it('AC1: full session — start, binary PCM in, events + binary TTS out, complete record', async () => {
    const { port } = await startServer();
    const { ws, received } = await connect(port);

    ws.send(sessionStart());
    ws.send(pcmChunk()); // one chunk == one fixture turn

    const complete = await waitFor(
      () =>
        jsonOf(received).find(
          (m): m is Extract<ServerToClientMessage, { type: 'utterance.complete' }> =>
            m.type === 'utterance.complete',
        ),
      'utterance.complete',
    );

    const msgs = jsonOf(received);
    const partials = msgs.filter((m) => m.type === 'stt.partial');
    const finals = msgs.filter(
      (m): m is Extract<ServerToClientMessage, { type: 'stt.final' }> => m.type === 'stt.final',
    );
    const deltas = msgs.filter(
      (m): m is Extract<ServerToClientMessage, { type: 'mt.delta' }> => m.type === 'mt.delta',
    );
    const mtFinals = msgs.filter(
      (m): m is Extract<ServerToClientMessage, { type: 'mt.final' }> => m.type === 'mt.final',
    );

    expect(partials.length).toBeGreaterThanOrEqual(1);
    expect(finals).toHaveLength(1);
    expect(finals[0]!.text).toBe('hello world'); // FixtureStt default
    expect(deltas.length).toBeGreaterThanOrEqual(2);
    expect(deltas.map((d) => d.text).join('')).toBe('hola mundo'); // FixtureMt default
    expect(mtFinals).toHaveLength(1);
    expect(mtFinals[0]!.text).toBe('hola mundo');

    // Binary TTS frames: 4-byte LE utt header + PCM16, attributable to utt 0.
    const binaries = received.filter(
      (r): r is Extract<Received, { kind: 'binary' }> => r.kind === 'binary',
    );
    expect(binaries.length).toBeGreaterThanOrEqual(1);
    for (const b of binaries) {
      const { utt, pcm } = decodeTtsFrame(b.data);
      expect(utt).toBe(0);
      expect(pcm.length).toBeGreaterThanOrEqual(1);
    }

    // Record + timings: the intervals that must exist.
    expect(complete.utt).toBe(0);
    const record = complete.record;
    expect(record.sourceFinal).toBe('hello world');
    expect(record.targetFinal).toBe('hola mundo');
    const t = record.timings as CascadeTimestamps;
    expect(t.stt_final!).toBeLessThanOrEqual(t.mt_first_token!);
    expect(t.mt_first_token!).toBeLessThanOrEqual(t.tts_first_byte!);
    const intervals = deriveCascadeIntervals(t);
    expect(intervals.mt).not.toBeNull();
    expect(intervals.tts).not.toBeNull();
    expect(intervals.mt!).toBeGreaterThanOrEqual(0);
    expect(intervals.tts!).toBeGreaterThanOrEqual(0);

    ws.send(JSON.stringify({ type: 'session.end' }));
  });

  it('AC3: unknown provider name -> error JSON, socket stays open, valid restart works', async () => {
    const { port } = await startServer();
    const { ws, received } = await connect(port);

    ws.send(sessionStart({ stt: 'nope', mt: 'fixture', tts: 'fixture' }));
    const err = await waitFor(
      () =>
        jsonOf(received).find(
          (m): m is Extract<ServerToClientMessage, { type: 'error' }> => m.type === 'error',
        ),
      'error message',
    );
    expect(err.message).toContain('nope');
    expect(ws.readyState).toBe(WebSocket.OPEN);

    // Same socket, valid session now works end-to-end.
    ws.send(sessionStart());
    ws.send(pcmChunk());
    const final = await waitFor(
      () => jsonOf(received).find((m) => m.type === 'stt.final'),
      'stt.final after valid restart',
    );
    expect(final).toBeTruthy();
  });

  it('AC4: socket close mid-utterance aborts the orchestrator within 100ms', async () => {
    let started = false;
    let abortedAt: number | undefined;
    const fake: OrchestratorFactory = (_source, _providers, opts) =>
      (async function* () {
        started = true;
        const signal = opts?.signal;
        expect(signal).toBeDefined();
        await new Promise<void>((resolve) => {
          if (signal!.aborted) {
            abortedAt = Date.now();
            resolve();
            return;
          }
          signal!.addEventListener(
            'abort',
            () => {
              abortedAt = Date.now();
              resolve();
            },
            { once: true },
          );
        });
      })();

    const { port } = await startServer({ createOrchestrator: fake });
    const { ws } = await connect(port);
    ws.send(sessionStart());
    ws.send(pcmChunk());
    await waitFor(() => started, 'orchestrator start');

    const closeSentAt = Date.now();
    ws.terminate();
    await waitFor(() => abortedAt !== undefined, 'abort');
    expect(abortedAt! - closeSentAt).toBeLessThanOrEqual(100);
  });
});

/**
 * Ticket 003, AC13. The cascade path itself is unchanged — the only new
 * behaviour is that run identity carried on session.start reaches the record
 * the server emits. `recordingId` lands on the record's `corpusId` (a corpus
 * clip IS a Recording — PRD §7), `runId` on `runId`, and `origin` on `origin`.
 */
describe('run identity on session.start (Ticket 003)', () => {
  it('AC13: recordingId / runId / origin appear on the emitted record', async () => {
    const record = await completeOneUtterance({
      recordingId: 'rec_abc_12345678',
      runId: 'run_xyz_87654321',
      origin: 'sweep',
    });

    expect(record.corpusId).toBe('rec_abc_12345678');
    expect(record.runId).toBe('run_xyz_87654321');
    expect(record.origin).toBe('sweep');

    // Everything else about the cascade turn is untouched.
    expect(record.mode).toBe('cascade');
    expect(record.sourceFinal).toBe('hello world');
    expect(record.targetFinal).toBe('hola mundo');
    expect(record.languagePair).toBe('en-es');
  });

  it('AC13: session.start WITHOUT run identity still works exactly as before (Live)', async () => {
    const record = await completeOneUtterance();

    expect(record.sourceFinal).toBe('hello world');
    expect(record.targetFinal).toBe('hola mundo');
    expect(record.corpusId).toBe('');
    expect(record.runId).toBe('');
    expect(record.origin).toBeUndefined();
  });
});

/**
 * TICKET 062 — the language pair has to survive the socket.
 *
 * `session.start` is everything the server learns about a session's languages.
 * Today `resolveTriple` builds the MT adapter from `{ model }` alone, so
 * `OpenAiMt`/`AnthropicMt` fall back to their construction default (Spanish)
 * for every pair and both directions: an ES→EN cascade run asks the model to
 * translate Spanish into Spanish, and an EN→YUE run produces Spanish. The
 * frame's language fields reach the RECORD (they are copied onto it verbatim)
 * and nowhere else — which is exactly how a wrong-language run still looks
 * well-formed in storage.
 */
describe('TICKET 062 — the requested target language reaches the pipeline', () => {
  interface Seen {
    session?: Record<string, unknown>;
    models?: Record<string, unknown>;
  }

  function capturingServer(seen: Seen): AttachCascadeWsOptions {
    const fake: OrchestratorFactory = (_source, _providers, opts) =>
      (async function* () {
        seen.session = opts?.session as unknown as Record<string, unknown>;
        seen.models = opts?.models as unknown as Record<string, unknown>;
      })();
    return { createOrchestrator: fake };
  }

  const cases = [
    { languagePair: 'EN↔ES', direction: 'en→es', targetLanguage: 'Spanish' },
    { languagePair: 'EN↔ES', direction: 'es→en', targetLanguage: 'English' },
    { languagePair: 'EN↔YUE', direction: 'en→yue', targetLanguage: 'Cantonese' },
  ] as const;

  it.each(cases)('$direction reaches the orchestrator as $targetLanguage', async (c) => {
    const seen: Seen = {};
    const { port } = await startServer(capturingServer(seen));
    const { ws } = await connect(port);
    ws.send(
      JSON.stringify({
        type: 'session.start',
        mode: 'cascade',
        languagePair: c.languagePair,
        direction: c.direction,
        targetLanguage: c.targetLanguage,
        providers: { stt: 'fixture', mt: 'fixture', tts: 'fixture' },
      }),
    );
    await waitFor(() => seen.session !== undefined, 'orchestrator session info');

    expect(seen.session).toMatchObject({
      languagePair: c.languagePair,
      direction: c.direction,
      // THE MISSING LINK. Without it the MT stage has nothing to instruct with
      // and every cascade run translates into the adapter's default.
      targetLanguage: c.targetLanguage,
    });
  });
});

/**
 * TICKET 069 — the SOURCE language has to survive the socket too.
 *
 * 062 fixed the target and left the source: `resolveTriple` still builds the STT
 * adapter from `{ model }` alone, so `OpenAiStt` opens a transcription session
 * with no language field at all and `ElevenLabsStt.languageCode` — a knob that
 * already reaches both the URL query and the config frame — is populated by
 * nothing. Handed no language and a moment of leading silence, a Whisper-family
 * model invents a sentence in one: 7 of the operator's 17 sweep runs opened with
 * "Turn right." / "그러나." / "Hallo." / "żeśmy." / "Yardımımın" / "Telephone" /
 * "Ok.", each one consuming segment 0 and shifting every real utterance late.
 *
 * The session already knows: `direction` IS the answer, and `en→es` means the
 * source is English. Nothing new is declared on the frame — a second field could
 * disagree with the direction, and disagreeing silently is the whole defect.
 */
describe('TICKET 069 — the source language is derived from `direction` and reaches the STT', () => {
  interface SeenProviders {
    stt?: { config?: Record<string, unknown> };
  }

  function capturingProviders(seen: SeenProviders): AttachCascadeWsOptions {
    const fake: OrchestratorFactory = (_source, providers) =>
      (async function* () {
        seen.stt = providers.stt as unknown as { config?: Record<string, unknown> };
      })();
    return { createOrchestrator: fake };
  }

  async function sttConfigFor(frame: Record<string, unknown>): Promise<Record<string, unknown>> {
    const seen: SeenProviders = {};
    const { port } = await startServer(capturingProviders(seen));
    const { ws } = await connect(port);
    ws.send(JSON.stringify({ type: 'session.start', mode: 'cascade', ...frame }));
    await waitFor(() => seen.stt !== undefined, 'constructed STT provider');
    return seen.stt!.config ?? {};
  }

  const cases = [
    { direction: 'en→es', stt: 'scribe_v2_realtime', sourceCode: 'en' },
    { direction: 'es→en', stt: 'scribe_v2_realtime', sourceCode: 'es' },
    { direction: 'en→yue', stt: 'gpt-4o-transcribe', sourceCode: 'en' },
    { direction: 'yue→en', stt: 'gpt-4o-transcribe', sourceCode: 'yue' },
  ] as const;

  it.each(cases)(
    '$direction builds the $stt adapter with the SOURCE language $sourceCode',
    async (c) => {
      const config = await sttConfigFor({
        languagePair: 'EN↔ES',
        direction: c.direction,
        targetLanguage: 'Spanish',
        providers: { stt: c.stt, mt: 'fixture', tts: 'fixture' },
      });
      expect(config.languageCode).toBe(c.sourceCode);
      // The model is still carried — the hint is added beside it, never instead.
      expect(config.model).toBe(c.stt);
    },
  );

  it('the two directions of ONE pair do NOT collapse — es→en is Spanish, not English', async () => {
    const forward = await sttConfigFor({
      languagePair: 'EN↔ES',
      direction: 'en→es',
      targetLanguage: 'Spanish',
      providers: { stt: 'scribe_v2_realtime', mt: 'fixture', tts: 'fixture' },
    });
    const reverse = await sttConfigFor({
      languagePair: 'EN↔ES',
      direction: 'es→en',
      targetLanguage: 'English',
      providers: { stt: 'scribe_v2_realtime', mt: 'fixture', tts: 'fixture' },
    });
    expect(forward.languageCode).toBe('en');
    expect(reverse.languageCode).toBe('es');
    expect(forward.languageCode).not.toBe(reverse.languageCode);
    // ...and neither of them is the TARGET. Sending the target language to the
    // STT would be the same class of defect wearing the fix's clothes.
    expect(forward.languageCode).not.toBe('es');
    expect(reverse.languageCode).not.toBe('en');
  });

  it('DERIVED, never declared: a frame that names its own source language is ignored in favour of `direction`', async () => {
    const config = await sttConfigFor({
      languagePair: 'EN↔ES',
      direction: 'en→es',
      targetLanguage: 'Spanish',
      // A field the protocol does not have. If one is ever added it must not be
      // able to disagree with the direction — that is the 062 defect's shape.
      sourceLanguage: 'de',
      providers: { stt: 'scribe_v2_realtime', mt: 'fixture', tts: 'fixture' },
    });
    expect(config.languageCode).toBe('en');
  });

  it('a session that names NO direction sends NO hint — absent, never a guessed "en"', async () => {
    const config = await sttConfigFor({
      languagePair: '',
      direction: '',
      targetLanguage: 'Spanish',
      providers: { stt: 'scribe_v2_realtime', mt: 'fixture', tts: 'fixture' },
    });
    expect(config.languageCode).toBeUndefined();
    expect(config.model).toBe('scribe_v2_realtime');
  });

  it('an UNPARSEABLE direction sends no hint either — a guess is worse than silence', async () => {
    const config = await sttConfigFor({
      languagePair: 'EN↔ES',
      direction: 'gibberish',
      targetLanguage: 'Spanish',
      providers: { stt: 'gpt-4o-transcribe', mt: 'fixture', tts: 'fixture' },
    });
    expect(config.languageCode).toBeUndefined();
  });

  it('the MT and TTS stages are untouched — the hint is an STT concern', async () => {
    const seen: { mt?: { config?: Record<string, unknown> }; tts?: { config?: Record<string, unknown> } } = {};
    const fake: OrchestratorFactory = (_source, providers) =>
      (async function* () {
        seen.mt = providers.mt as unknown as { config?: Record<string, unknown> };
        seen.tts = providers.tts as unknown as { config?: Record<string, unknown> };
      })();
    const { port } = await startServer({ createOrchestrator: fake });
    const { ws } = await connect(port);
    ws.send(
      JSON.stringify({
        type: 'session.start',
        mode: 'cascade',
        languagePair: 'EN↔ES',
        direction: 'es→en',
        targetLanguage: 'English',
        providers: { stt: 'scribe_v2_realtime', mt: 'gpt-4o-mini', tts: 'gpt-4o-mini-tts' },
      }),
    );
    await waitFor(() => seen.mt !== undefined, 'constructed MT provider');
    expect(seen.mt!.config?.languageCode).toBeUndefined();
    expect(seen.tts!.config?.languageCode).toBeUndefined();
  });
});

/**
 * TICKET 074 — and the TTS stage has to be told how to PRONOUNCE it.
 *
 * 062 routed the target to the MT and 069 the source to the STT; the TTS was
 * still built from `{ model }` alone. Mandarin and Cantonese share written
 * characters, so an EN→YUE cascade produced correct Cantonese text and read it
 * in Mandarin — PRD §10's trap, in Arm B/C rather than in Realtime.
 *
 * Falsifiable per direction, on the wire: `en→yue` carries an instruction that
 * names Cantonese, `en→es` carries none at all, and Arm C carries neither an
 * instruction nor any Chinese language code.
 */
describe('TICKET 074 — the pronunciation instruction reaches the constructed TTS', () => {
  interface SeenTts {
    tts?: { config?: Record<string, unknown> };
  }

  function capturingTts(seen: SeenTts): AttachCascadeWsOptions {
    const fake: OrchestratorFactory = (_source, providers) =>
      (async function* () {
        seen.tts = providers.tts as unknown as { config?: Record<string, unknown> };
      })();
    return { createOrchestrator: fake };
  }

  async function ttsConfigFor(frame: Record<string, unknown>): Promise<Record<string, unknown>> {
    const seen: SeenTts = {};
    const { port } = await startServer(capturingTts(seen));
    const { ws } = await connect(port);
    ws.send(JSON.stringify({ type: 'session.start', mode: 'cascade', ...frame }));
    await waitFor(() => seen.tts !== undefined, 'constructed TTS provider');
    return seen.tts!.config ?? {};
  }

  const armB = { stt: 'fixture', mt: 'fixture', tts: 'gpt-4o-mini-tts' };
  const armC = { stt: 'fixture', mt: 'fixture', tts: 'eleven_flash_v2_5' };

  it('en→yue on Arm B builds the TTS with an instruction naming Cantonese', async () => {
    const config = await ttsConfigFor({
      languagePair: 'EN↔YUE',
      direction: 'en→yue',
      targetLanguage: 'Cantonese',
      providers: armB,
    });
    expect(String(config.instructions)).toMatch(/Cantonese/);
    expect(String(config.instructions)).toMatch(/Mandarin/); // names what it must NOT do
    expect(config.model).toBe('gpt-4o-mini-tts');
  });

  it('en→es on Arm B builds the TTS with NO instruction — the two directions differ', async () => {
    const es = await ttsConfigFor({
      languagePair: 'EN↔ES',
      direction: 'en→es',
      targetLanguage: 'Spanish',
      providers: armB,
    });
    const yue = await ttsConfigFor({
      languagePair: 'EN↔YUE',
      direction: 'en→yue',
      targetLanguage: 'Cantonese',
      providers: armB,
    });
    expect(es.instructions).toBeUndefined();
    expect('instructions' in es).toBe(false);
    expect(yue.instructions).not.toEqual(es.instructions);
  });

  it('en→yue on ARM C gets no instruction and NO Chinese language code — `zh` is Mandarin', async () => {
    const config = await ttsConfigFor({
      languagePair: 'EN↔YUE',
      direction: 'en→yue',
      targetLanguage: 'Cantonese',
      providers: armC,
    });
    expect(config).toEqual({ modelId: 'eleven_flash_v2_5' });
    expect(JSON.stringify(config)).not.toMatch(/zh|language_?[Cc]ode|Cantonese/);
  });
});
