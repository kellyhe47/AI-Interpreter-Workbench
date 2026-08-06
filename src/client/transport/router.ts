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
  /** STUB (ticket 012 red phase). */
  get active(): InterpreterTransport | null {
    return null;
  }

  setTransport(_transport: InterpreterTransport): void {
    // STUB (ticket 012 red phase).
  }

  sendAudio(_chunk: Int16Array): void {
    // STUB (ticket 012 red phase).
  }

  setHandlers(_handlers: RouterHandlers): void {
    // STUB (ticket 012 red phase).
  }

  stop(): void {
    // STUB (ticket 012 red phase).
  }
}
