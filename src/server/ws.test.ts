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
