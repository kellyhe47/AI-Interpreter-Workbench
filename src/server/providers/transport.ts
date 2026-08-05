/**
 * Transport seams shared by the real provider adapters.
 *
 * Design decision (testability): every adapter takes an optional `deps`
 * injection parameter carrying its transport factory so tests can substitute
 * fakes and NO test ever touches the network:
 *
 *   new OpenAiStt(config, { wsFactory })      // WebSocket-based adapters
 *   new OpenAiMt(config, { fetchImpl })       // HTTP-based adapters
 *
 * Default transports (real `ws` WebSocket / global fetch) are resolved by the
 * implementations, NOT here: this module is imported (transitively, via the
 * registry) by the isomorphic core tsconfig, so it must stay free of
 * node-only imports and globals. Implementations should lazily import 'ws'
 * (or read `globalThis`) inside the adapter, never at module top level.
 */

/**
 * Minimal ws-style socket surface the adapters rely on. The `message` event
 * may deliver a Buffer or a string; adapters must `String(data)` before
 * parsing JSON (test fakes deliver strings).
 */
export interface WsLike {
  on(event: 'open' | 'message' | 'close' | 'error', listener: (...args: unknown[]) => void): void;
  send(data: string): void;
  close(code?: number, reason?: string): void;
}

/** Creates a connected-or-connecting socket. Headers carry authentication. */
export type WsFactory = (url: string, opts: { headers: Record<string, string> }) => WsLike;

/** fetch-compatible seam; adapters only ever pass string URLs. */
export type FetchLike = (url: string, init?: RequestInit) => Promise<Response>;

/**
 * Read an environment variable without referencing the `process` global
 * directly (keeps this file compiling under the DOM/client tsconfig, which
 * has no node types).
 */
export function envVar(name: string): string | undefined {
  const proc = (globalThis as { process?: { env?: Record<string, string | undefined> } }).process;
  return proc?.env?.[name];
}
