/**
 * Ticket 012 — TransportRouter: a SWITCH, not a fan-out.
 *
 * Live runs exactly ONE architecture per session (PRD §17 19g · 24a), so the
 * router holds one active transport at a time. Fan-out existed to guarantee
 * identical live input across arms; a saved Recording does that better and
 * without concurrent-network contention, so comparison moved to Replay and
 * the router went back to being a switch.
 *
 * ============================ API DESIGN (normative) =======================
 * Locked by router.test.ts:
 *
 * new TransportRouter()
 * - setTransport(transport): makes it the active transport, wiring
 *   transport.setHandlers with wrappers that delegate to the CURRENT router
 *   handlers. Setting a new transport calls stop() on the previous one and
 *   detaches it: late events from a replaced transport never reach the
 *   handlers.
 *   setTransport does NOT start the transport — lifecycle stays with the
 *   caller.
 * - active: the current transport or null.
 * - sendAudio(chunk): forwards the SAME chunk reference to the active
 *   transport. With no active transport it is a NO-OP, never a throw — mic
 *   frames can arrive before the transport is up or after it is torn down.
 * - setHandlers(handlers): router-level handlers; may be called before or
 *   after setTransport and replaces the previous set.
 * - stop(): stops the active transport and clears it.
 *
 * EVENTS CARRY NO `armId`. There is one transport, so there is nothing to
 * disambiguate; the field is gone from the handler payloads and from
 * InterpreterTransport.
 * ==========================================================================
 */

import type {
  ConnectionState,
  InterpreterTransport,
  SourceTextEvent,
  TargetTextEvent,
  TimingMark,
  TransportError,
  UtteranceCompletion,
} from './types';

export interface RouterHandlers {
  onSourceText?: (e: SourceTextEvent) => void;
  onTargetText?: (e: TargetTextEvent) => void;
  onAudio?: (e: { pcm: Int16Array; utt: number }) => void;
  onTiming?: (e: TimingMark) => void;
  onUtteranceComplete?: (e: { record: UtteranceCompletion }) => void;
  onError?: (e: TransportError) => void;
  onConnectionState?: (e: { state: ConnectionState; attempt?: number }) => void;
}

export class TransportRouter {
  private current: InterpreterTransport | null = null;
  private handlers: RouterHandlers = {};

  get active(): InterpreterTransport | null {
    return this.current;
  }

  setTransport(transport: InterpreterTransport): void {
    const previous = this.current;
    // Point `current` at the newcomer FIRST: the guard below reads it, so a
    // late event from `previous` — including anything its stop() flushes
    // synchronously — is already detached by the time it fires.
    this.current = transport;
    if (previous && previous !== transport) previous.stop();
    this.wire(transport);
  }

  sendAudio(chunk: Int16Array): void {
    // NO-OP when idle: mic frames legitimately arrive before the transport is
    // up and after it is torn down, and neither is an error.
    this.current?.sendAudio(chunk);
  }

  setHandlers(handlers: RouterHandlers): void {
    this.handlers = handlers;
  }

  stop(): void {
    const transport = this.current;
    this.current = null;
    transport?.stop();
  }

  /**
   * Wraps the router handlers so the transport calls a stable set that reads
   * `this.handlers` at fire time (setHandlers may run before or after
   * setTransport) and drops anything from a transport that is no longer the
   * active one.
   */
  private wire(transport: InterpreterTransport): void {
    const live = (): boolean => this.current === transport;
    transport.setHandlers({
      onSourceText: (e: SourceTextEvent) => {
        if (live()) this.handlers.onSourceText?.(e);
      },
      onTargetText: (e: TargetTextEvent) => {
        if (live()) this.handlers.onTargetText?.(e);
      },
      onAudio: (pcm: Int16Array, utt: number) => {
        if (live()) this.handlers.onAudio?.({ pcm, utt });
      },
      onTiming: (mark: TimingMark) => {
        if (live()) this.handlers.onTiming?.(mark);
      },
      onUtteranceComplete: (record: UtteranceCompletion) => {
        if (live()) this.handlers.onUtteranceComplete?.({ record });
      },
      onError: (e: TransportError) => {
        if (live()) this.handlers.onError?.(e);
      },
      onConnectionState: (state: ConnectionState, attempt?: number) => {
        if (live()) this.handlers.onConnectionState?.({ state, attempt });
      },
    });
  }
}
