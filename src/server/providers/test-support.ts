/**
 * Shared fakes/helpers for the provider adapter tests. NO network anywhere.
 *
 * Not a test file itself (name deliberately does not match *.test.ts) and
 * never imported by production code.
 */

import type { WsFactory, WsLike } from './transport';

type Listener = (...args: unknown[]) => void;

/**
 * ws-style fake socket. Emits 'open' on a microtask after construction (and
 * replays it for late listeners). `send` records the raw frame and dispatches
 * the parsed JSON to `onClientMessage` synchronously. Server->client messages
 * go out through `serverMessage` as JSON strings; nothing is emitted after
 * close.
 */
export class FakeWsBase implements WsLike {
  readonly url: string;
  readonly headers: Record<string, string>;
  /** Raw frames received from the adapter, in order. */
  readonly sent: string[] = [];
  closed = false;

  private listeners = new Map<string, Listener[]>();
  private openFired = false;

  constructor(url: string, opts?: { headers?: Record<string, string> }) {
    this.url = url;
    this.headers = opts?.headers ?? {};
    queueMicrotask(() => {
      this.openFired = true;
      this.emit('open');
    });
  }

  on(event: 'open' | 'message' | 'close' | 'error', listener: Listener): void {
    if (event === 'open' && this.openFired) {
      listener();
      return;
    }
    const arr = this.listeners.get(event) ?? [];
    arr.push(listener);
    this.listeners.set(event, arr);
  }

  send(data: string): void {
    this.sent.push(data);
    this.onClientMessage(JSON.parse(data));
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    this.emit('close');
  }

  /** Emit a server->client JSON message (string payload, ws-style). */
  serverMessage(obj: unknown): void {
    if (this.closed) return;
    this.emit('message', JSON.stringify(obj));
  }

  serverError(err: unknown): void {
    if (this.closed) return;
    this.emit('error', err);
  }

  /** Parsed JSON frames received from the adapter. */
  get sentJson(): Array<Record<string, unknown>> {
    return this.sent.map((s) => JSON.parse(s) as Record<string, unknown>);
  }

  protected emit(event: string, ...args: unknown[]): void {
    for (const fn of this.listeners.get(event) ?? []) fn(...args);
  }

  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  protected onClientMessage(_msg: unknown): void {}
}

/** Wrap a FakeWsBase subclass constructor into a recording WsFactory. */
export function recordingWsFactory<T extends FakeWsBase>(
  make: (url: string, opts: { headers: Record<string, string> }) => T,
): { created: T[]; wsFactory: WsFactory } {
  const created: T[] = [];
  const wsFactory: WsFactory = (url, opts) => {
    const ws = make(url, opts);
    created.push(ws);
    return ws;
  };
  return { created, wsFactory };
}

// ---------------------------------------------------------------------------
// fetch fakes
// ---------------------------------------------------------------------------

export interface RecordedFetchCall {
  url: string;
  init: RequestInit | undefined;
}

export function recordingFetch(
  handler: (url: string, init?: RequestInit) => Response | Promise<Response>,
): {
  calls: RecordedFetchCall[];
  fetchImpl: (url: string, init?: RequestInit) => Promise<Response>;
} {
  const calls: RecordedFetchCall[] = [];
  return {
    calls,
    fetchImpl: async (url, init) => {
      calls.push({ url, init });
      return handler(url, init);
    },
  };
}

/** Response whose body streams the given chunks (strings are UTF-8 encoded). */
export function chunkedBodyResponse(
  chunks: ReadonlyArray<Uint8Array | string>,
  init?: ResponseInit,
): Response {
  const enc = new TextEncoder();
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      for (const c of chunks) {
        controller.enqueue(typeof c === 'string' ? enc.encode(c) : c);
      }
      controller.close();
    },
  });
  return new Response(stream, { status: 200, ...init });
}

/**
 * Response whose body emits the given chunks then stays open forever (for
 * abort-mid-stream tests).
 */
export function hangingBodyResponse(chunks: ReadonlyArray<Uint8Array | string>): Response {
  const enc = new TextEncoder();
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      for (const c of chunks) {
        controller.enqueue(typeof c === 'string' ? enc.encode(c) : c);
      }
      // never close
    },
  });
  return new Response(stream, { status: 200 });
}

/** SSE body text for a sequence of already-serialized data payloads. */
export function sseBody(payloads: readonly string[]): string {
  return payloads.map((p) => `data: ${p}\n\n`).join('');
}

// ---------------------------------------------------------------------------
// PCM16 byte helpers
// ---------------------------------------------------------------------------

export function int16ToBytes(samples: Int16Array): Uint8Array {
  return new Uint8Array(samples.buffer, samples.byteOffset, samples.byteLength).slice();
}

export function toBase64(bytes: Uint8Array): string {
  return Buffer.from(bytes).toString('base64');
}

export function int16ToBase64(samples: Int16Array): string {
  return toBase64(int16ToBytes(samples));
}

export function concatSamples(chunks: readonly Int16Array[]): Int16Array {
  const total = chunks.reduce((n, c) => n + c.length, 0);
  const out = new Int16Array(total);
  let off = 0;
  for (const c of chunks) {
    out.set(c, off);
    off += c.length;
  }
  return out;
}

/** Async iterable over the given items (each yielded on its own tick). */
export function asyncIterableOf<T>(items: readonly T[]): AsyncIterable<T> {
  return (async function* () {
    for (const it of items) yield it;
  })();
}
