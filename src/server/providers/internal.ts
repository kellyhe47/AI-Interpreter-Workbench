/**
 * Internal runtime helpers shared by the provider adapters.
 *
 * Isomorphic: this file is pulled (via the registry) into BOTH the client and
 * server TypeScript programs, so it must not reference node-only modules or
 * globals (`Buffer`, `process`, top-level `import 'ws'`). Base64 is
 * hand-rolled for that reason; the default ws transport is loaded lazily via
 * a computed dynamic import.
 */

import type { FetchLike, WsFactory, WsLike } from './transport';

// ---------------------------------------------------------------------------
// base64 (matches Buffer/atob semantics, standard alphabet with padding)
// ---------------------------------------------------------------------------

const B64_ALPHABET =
  'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';

const B64_LOOKUP: Int8Array = (() => {
  const table = new Int8Array(128).fill(-1);
  for (let i = 0; i < B64_ALPHABET.length; i += 1) {
    table[B64_ALPHABET.charCodeAt(i)] = i;
  }
  return table;
})();

export function bytesToBase64(bytes: Uint8Array): string {
  let out = '';
  for (let i = 0; i < bytes.length; i += 3) {
    const b0 = bytes[i]!;
    const b1 = i + 1 < bytes.length ? bytes[i + 1]! : undefined;
    const b2 = i + 2 < bytes.length ? bytes[i + 2]! : undefined;
    out += B64_ALPHABET[b0 >> 2]!;
    out += B64_ALPHABET[((b0 & 0x03) << 4) | ((b1 ?? 0) >> 4)]!;
    out += b1 === undefined ? '=' : B64_ALPHABET[((b1 & 0x0f) << 2) | ((b2 ?? 0) >> 6)]!;
    out += b2 === undefined ? '=' : B64_ALPHABET[b2 & 0x3f]!;
  }
  return out;
}

export function base64ToBytes(b64: string): Uint8Array {
  const out = new Uint8Array(Math.ceil((b64.length * 3) / 4));
  let acc = 0;
  let bits = 0;
  let j = 0;
  for (let i = 0; i < b64.length; i += 1) {
    const code = b64.charCodeAt(i);
    const val = code < 128 ? B64_LOOKUP[code]! : -1;
    if (val < 0) continue; // skip '=', whitespace, anything non-alphabet
    acc = (acc << 6) | val;
    bits += 6;
    if (bits >= 8) {
      bits -= 8;
      out[j] = (acc >> bits) & 0xff;
      j += 1;
    }
  }
  return out.slice(0, j);
}

/** Little-endian PCM16 byte view of an Int16Array (LE platforms). */
export function int16ToLeBytes(samples: Int16Array): Uint8Array {
  return new Uint8Array(samples.buffer, samples.byteOffset, samples.byteLength);
}

// ---------------------------------------------------------------------------
// PCM16 reassembly with odd-byte carry
// ---------------------------------------------------------------------------

/**
 * Accumulates raw PCM16-LE byte chunks whose boundaries may not be
 * sample-aligned; a trailing odd byte is carried into the next chunk so
 * Int16 alignment is never lost.
 */
export class Pcm16Assembler {
  private carry: Uint8Array | null = null;

  /** Returns the samples completed by this chunk, or null if none yet. */
  push(bytes: Uint8Array): Int16Array | null {
    let data = bytes;
    if (this.carry !== null) {
      const merged = new Uint8Array(this.carry.length + bytes.length);
      merged.set(this.carry, 0);
      merged.set(bytes, this.carry.length);
      this.carry = null;
      data = merged;
    }
    const evenLength = data.length - (data.length % 2);
    if (evenLength < data.length) this.carry = data.slice(evenLength);
    if (evenLength === 0) return null;
    const aligned = data.slice(0, evenLength); // fresh buffer, offset 0
    return new Int16Array(aligned.buffer, 0, evenLength / 2);
  }
}

// ---------------------------------------------------------------------------
// Async queue bridging event listeners -> async generators
// ---------------------------------------------------------------------------

interface Waiter<T> {
  resolve: (r: IteratorResult<T, undefined>) => void;
  reject: (e: unknown) => void;
}

/**
 * Unbounded push queue consumable with `for await`. `end()` finishes after
 * draining anything buffered; `abort()` discards the buffer and finishes
 * immediately; `fail(err)` rejects the consumer.
 */
export class AsyncQueue<T> implements AsyncIterable<T> {
  private buffer: T[] = [];
  private ended = false;
  private failure: unknown;
  private failed = false;
  private waiters: Waiter<T>[] = [];
  private consumerGates: Array<() => void> = [];

  /** True once end/abort/fail was called (no further pushes accepted). */
  get isDone(): boolean {
    return this.ended;
  }

  push(value: T): void {
    if (this.ended) return;
    const w = this.waiters.shift();
    if (w) w.resolve({ value, done: false });
    else this.buffer.push(value);
  }

  end(): void {
    if (this.ended) return;
    this.ended = true;
    for (const w of this.waiters.splice(0)) {
      w.resolve({ value: undefined, done: true });
    }
    this.releaseGates();
  }

  abort(): void {
    this.buffer.length = 0;
    this.end();
  }

  fail(error: unknown): void {
    if (this.ended) return;
    this.ended = true;
    this.failed = true;
    this.failure = error;
    this.buffer.length = 0;
    for (const w of this.waiters.splice(0)) w.reject(error);
    this.releaseGates();
  }

  /**
   * Resolves once the consumer is actively waiting for the next item (or the
   * queue is finished). Lets a producer pace itself so already-produced items
   * are consumed before it pulls more input (true interleaving).
   */
  whenConsumerWaiting(): Promise<void> {
    if (this.ended || (this.waiters.length > 0 && this.buffer.length === 0)) {
      return Promise.resolve();
    }
    return new Promise((resolve) => this.consumerGates.push(resolve));
  }

  private releaseGates(): void {
    for (const g of this.consumerGates.splice(0)) g();
  }

  private next(): Promise<IteratorResult<T, undefined>> {
    if (this.buffer.length > 0) {
      return Promise.resolve({ value: this.buffer.shift() as T, done: false });
    }
    if (this.failed) return Promise.reject(this.failure);
    if (this.ended) return Promise.resolve({ value: undefined, done: true });
    return new Promise<IteratorResult<T, undefined>>((resolve, reject) => {
      this.waiters.push({ resolve, reject });
      this.releaseGates();
    });
  }

  [Symbol.asyncIterator](): AsyncIterator<T, undefined> {
    return { next: () => this.next() };
  }
}

// ---------------------------------------------------------------------------
// Abort watching
// ---------------------------------------------------------------------------

export const ABORTED: unique symbol = Symbol('aborted');

export interface AbortWatch {
  /** Resolves with ABORTED when the signal fires; never resolves without a signal. */
  readonly promise: Promise<typeof ABORTED>;
  dispose(): void;
}

export function watchAbort(signal: AbortSignal | undefined): AbortWatch {
  if (!signal) {
    return { promise: new Promise<never>(() => {}), dispose: () => {} };
  }
  let dispose = (): void => {};
  const promise = new Promise<typeof ABORTED>((resolve) => {
    if (signal.aborted) {
      resolve(ABORTED);
      return;
    }
    const onAbort = (): void => resolve(ABORTED);
    signal.addEventListener('abort', onAbort, { once: true });
    dispose = () => signal.removeEventListener('abort', onAbort);
  });
  return { promise, dispose };
}

// ---------------------------------------------------------------------------
// Default transports (lazily resolved; never imported at module top level)
// ---------------------------------------------------------------------------

/** Global fetch bound safely for both DOM and node programs. */
export const defaultFetch: FetchLike = (url, init) => fetch(url, init);

interface WsCtor {
  new (url: string, opts: { headers: Record<string, string> }): WsLike;
}

/**
 * Lazily load the real `ws` WebSocket as a WsFactory. The computed specifier
 * keeps TypeScript from resolving node-only module types into the client
 * program (and keeps bundlers from following the import).
 */
export async function loadDefaultWsFactory(): Promise<WsFactory> {
  const specifier = 'ws';
  const mod = (await import(/* @vite-ignore */ specifier)) as {
    default?: unknown;
    WebSocket?: unknown;
  };
  const Ctor = (mod.default ?? mod.WebSocket) as WsCtor;
  return (url, opts) => new Ctor(url, opts);
}

/** Wait for a ws-style socket to open. */
export function waitForOpen(ws: WsLike): Promise<void> {
  return new Promise((resolve) => ws.on('open', () => resolve()));
}
